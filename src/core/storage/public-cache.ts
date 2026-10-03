/**
 * Domain 3 — 公开缓存域 (SPEC §6.1 row 3, AC-18; ARCHITECTURE §3.5/§3.6.3).
 *
 * Two byte-budgeted LRU stores behind one `cache/` namespace: the revision-keyed catalog snapshot
 * (20 MiB) and poster blobs (128 MiB, keyed by content id + `coverVersion`, so an unchanged cover is
 * never re-fetched). Catalog keys carry their revision and a snapshot becomes visible only when its
 * meta key flips inside one disk batch — 同修订完整快照原子替换. A rejected page, an over-full cache or
 * a process death leaves the previous complete snapshot readable and never mixes two revisions
 * (AC-18, SPEC §12.1.3). `clearCache()` enumerates only this namespace, so credentials and history are
 * unreachable from 【清理缓存】 by construction.
 */

import type { CatalogChangesResponse, CatalogResponse, ChannelsResponse, ChannelItem, ContentItem } from '../../../edge/src/types/api';
import { PUBLIC_CHANNEL_IDS } from '../../../edge/src/types/api';
import { assertWritable, CATALOG_CACHE_LIMIT_BYTES, CLEARED_BY_CLEAR_CACHE, POSTER_CACHE_LIMIT_BYTES, PRESERVED_BY_CLEAR_CACHE, type WriteGuardSubject } from './storage-domains';
import {
  CACHE_KEY_NAMESPACE, CATALOG_CHUNK_ITEMS, CATALOG_META_KEY, CATALOG_REVISION_PREFIX, CHANNELS_KEY,
  decodeJson, guardItem, jsonBytes, Ledger, POSTER_PREFIX, chunkKey, posterKey
} from './cache-internals';

export { CACHE_KEY_NAMESPACE, CATALOG_META_KEY, CHANNELS_KEY } from './cache-internals';

export type CacheWrite = { key: string; bytes: Uint8Array };
export type CatalogSnapshotMeta = { revision: number; chunks: number; updatedAt: number; partial: boolean };
export type CacheRejectReason = 'stale-revision' | 'mixed-revision' | 'incomplete-pages' | 'not-newer' | 'channel-mismatch';
export interface CacheReceipt { accepted: boolean; revision: number; appliedEntries: number; reason?: CacheRejectReason }
export interface PosterReceipt { stored: boolean; key: string; bytes: number; evictedPosters: number }
export interface CacheClearReport { removedKeys: number; freedBytes: number; clearedDomains: readonly string[]; preservedDomains: readonly string[] }
type StagedChannel = { expectedPages: number; pages: Map<number, ContentItem[]> };

/** The cache domain's only disk surface. The Filesystem/SQLite mapping is the lead's wiring file. */
export interface CacheDisk {
  read(key: string): Promise<Uint8Array | null>;
  /** One all-or-nothing unit: removals apply before writes, and nothing lands if the batch throws. */
  writeBatch(writes: CacheWrite[], removes: string[]): Promise<void>;
  list(prefix: string): Promise<Array<{ key: string; bytes: number }>>;
}

/** Reference adapter for web builds and tests; the Android file half is device-only and replaces it. */
export class MemoryCacheDisk implements CacheDisk {
  private files = new Map<string, Uint8Array>();
  async read(key: string): Promise<Uint8Array | null> {
    return this.files.get(key) ?? null;
  }
  async writeBatch(writes: CacheWrite[], removes: string[]): Promise<void> {
    const next = new Map(this.files);
    for (const key of removes) next.delete(key);
    for (const write of writes) next.set(write.key, write.bytes);
    this.files = next;
  }
  async list(prefix: string): Promise<Array<{ key: string; bytes: number }>> {
    return [...this.files.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, bytes]) => ({ key, bytes: bytes.byteLength }));
  }
}

/**
 * 拓扑快照的形态校验：磁盘文件可能被旧版本或被撕写污染，读回时必须逐字段验明，
 * 校验失败一律降级为"没有快照"（AC-01 冷启动不得因缓存损坏而崩溃）。
 */
function readTopology(bytes: Uint8Array | null): ChannelsResponse | null {
  const parsed = decodeJson<Partial<ChannelsResponse>>(bytes);
  if (parsed === null || typeof parsed.version !== 'number' || !Array.isArray(parsed.channels)) return null;
  const channels = parsed.channels.filter((entry): entry is ChannelItem =>
    entry !== undefined && (PUBLIC_CHANNEL_IDS as readonly string[]).includes(entry.id)
    && typeof entry.name === 'string' && Number.isInteger(entry.order)
    && Array.isArray(entry.requiresTier) && Array.isArray(entry.categories));
  return channels.length === 0 ? null : { version: parsed.version, channels };
}

export class PublicCache {
  private meta: CatalogSnapshotMeta = { revision: 0, chunks: 0, updatedAt: 0, partial: false };
  private readonly items = new Map<string, ContentItem>();
  private readonly catalogLedger: Ledger;
  private readonly posterLedger: Ledger;
  private staged: { revision: number; channels: Map<string, StagedChannel> } | null = null;
  private topology: ChannelsResponse | null = null;

  constructor(
    private readonly disk: CacheDisk,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
    catalogCap = CATALOG_CACHE_LIMIT_BYTES,
    posterCap = POSTER_CACHE_LIMIT_BYTES
  ) {
    this.catalogLedger = new Ledger(catalogCap);
    this.posterLedger = new Ledger(posterCap);
  }

  snapshotRevision = (): number => this.meta.revision;
  snapshotIsPartial = (): boolean => this.meta.partial;
  bytesUsed = (): { catalog: number; posters: number } => ({ catalog: this.catalogLedger.bytes, posters: this.posterLedger.bytes });
  hasPoster = (contentId: string, coverVersion: string): boolean => this.posterLedger.has(posterKey(contentId, coverVersion));
  list = (channelId?: string): ContentItem[] => [...this.items.values()].filter((item) => channelId === undefined || item.channelId === channelId);

  getItem(contentId: string): ContentItem | null {
    const item = this.items.get(contentId);
    if (item !== undefined) this.catalogLedger.hit(contentId);
    return item ?? null;
  }

  /** Cold start: rebuild the last committed revision, then collect keys an interrupted commit orphaned. */
  async hydrate(): Promise<void> {
    const meta = decodeJson<CatalogSnapshotMeta>(await this.disk.read(CATALOG_META_KEY));
    const usable = meta !== null && Number.isInteger(meta.revision) && meta.revision > 0 && Number.isInteger(meta.chunks) && meta.chunks >= 1;
    this.adopt(usable ? { ...meta, partial: meta.partial === true } : { revision: 0, chunks: 0, updatedAt: 0, partial: false });
    if (usable) {
      for (let index = 0; index < this.meta.chunks; index += 1) {
        const bytes = await this.disk.read(chunkKey(this.meta.revision, index));
        for (const item of bytes === null ? [] : decodeJson<ContentItem[]>(bytes) ?? []) this.track(item);
      }
      for (const entry of await this.disk.list(POSTER_PREFIX)) this.posterLedger.put(entry.key, entry.bytes);
    }
    const keep = `${CATALOG_REVISION_PREFIX}${this.meta.revision}/`;
    const orphans = (await this.disk.list(CATALOG_REVISION_PREFIX)).map((entry) => entry.key).filter((key) => !key.startsWith(keep));
    if (orphans.length > 0) await this.disk.writeBatch([], orphans);
    this.topology = readTopology(await this.disk.read(CHANNELS_KEY));
  }

  /**
   * 频道拓扑落盘前先按闭集剔除【个人探索】节点：AC-02-3 要求未获双重准入时它在磁盘上也不存在，
   * 而"缓存里存了私密频道"会让下一次冷启动的断网首屏把它显示出来，那正是契约要防的事故。
   */
  async putChannels(response: ChannelsResponse): Promise<void> {
    const publicOnly = response.channels.filter((entry) => (PUBLIC_CHANNEL_IDS as readonly string[]).includes(entry.id));
    for (const entry of publicOnly) assertWritable('public-cache.channels', { channelId: entry.id, contentId: entry.id });
    this.topology = { version: response.version, channels: publicOnly };
    await this.disk.writeBatch([{ key: CHANNELS_KEY, bytes: jsonBytes(this.topology) }], []);
  }

  /** 未 `hydrate()` 或从未落过快照时为 null；调用方必须按"无快照"走网络，而不是当作空频道表。 */
  getChannels(): ChannelsResponse | null { return this.topology }

  private adopt(meta: CatalogSnapshotMeta): void {
    this.meta = meta; this.items.clear(); this.catalogLedger.reset(); this.posterLedger.reset(); this.topology = null;
  }

  /** The catalog's LRU unit is one item, sized by its own JSON, so eviction is item-granular. */
  private track(item: ContentItem): void {
    this.items.set(item.id, item);
    this.catalogLedger.put(item.id, jsonBytes(item).byteLength);
  }

  /**
   * Paging is staged in memory and only the commit is durable, so half-pulled pages cannot contaminate
   * the snapshot. The declared `channelId` must match every item; an older revision, a second revision
   * mixed into the staging unit, or a private item is refused outright.
   */
  stagePage(channelId: string, page: CatalogResponse): CacheReceipt {
    for (const item of page.items) {
      guardItem('public-cache.catalog', item);
      if (item.channelId !== channelId) return this.rejectStaging('channel-mismatch');
    }
    if (page.revision < this.meta.revision) return this.rejectStaging('stale-revision');
    if (this.staged !== null && this.staged.revision !== page.revision) return this.rejectStaging('mixed-revision');
    if (this.staged === null) this.staged = { revision: page.revision, channels: new Map() };
    const channel = this.staged.channels.get(channelId) ?? { expectedPages: 0, pages: new Map<number, ContentItem[]>() };
    channel.expectedPages = Math.max(channel.expectedPages, Math.max(1, Math.ceil(page.total / Math.max(1, page.pageSize))));
    channel.pages.set(page.page, page.items);
    this.staged.channels.set(channelId, channel);
    return { accepted: true, revision: page.revision, appliedEntries: page.items.length };
  }

  private rejectStaging(reason: CacheRejectReason): CacheReceipt {
    this.staged = null;
    return { accepted: false, revision: this.meta.revision, reason, appliedEntries: 0 };
  }

  /** A commit is whole-snapshot or nothing: every staged channel needs contiguous, complete paging. */
  async commitSnapshot(): Promise<CacheReceipt> {
    const staged = this.staged;
    if (staged === null || staged.channels.size === 0) return this.rejectStaging('incomplete-pages');
    const replacement: ContentItem[] = [];
    for (const channel of staged.channels.values()) {
      for (let page = 1; page <= channel.expectedPages; page += 1) {
        const items = channel.pages.get(page);
        if (items === undefined) return this.rejectStaging('incomplete-pages');
        replacement.push(...items);
      }
    }
    this.staged = null;
    // Channels not re-pulled in this unit carry over only while they belong to the same revision.
    const carried = [...this.items.values()].filter((item) => !staged.channels.has(item.channelId));
    return await this.persist(staged.revision, [...carried, ...replacement]);
  }

  /**
   * Idempotent by the server's `nextRevision`, never incremented locally (API-SPEC §八): a replayed page
   * lands on `nextRevision <= revision` and changes nothing, so a retry after a torn sync can neither
   * double-apply nor rewind the cursor. A delete tombstone drops item and posters (SPEC §12.1.3).
   */
  async applyChanges(response: CatalogChangesResponse): Promise<CacheReceipt> {
    if (response.nextRevision <= this.meta.revision) return { accepted: false, revision: this.meta.revision, reason: 'not-newer', appliedEntries: 0 };
    const next = new Map(this.items);
    for (const change of response.changes) {
      if (change.operation === 'delete') {
        next.delete(change.contentId);
        await this.removePosterFor(change.contentId);
      } else {
        guardItem('public-cache.catalog', change.item);
        next.set(change.contentId, change.item);
      }
    }
    return await this.persist(response.nextRevision, [...next.values()]);
  }

  /** 整包导入（用于冷启动预置种子或单次大包快照同步）：避免数百次分页请求。 */
  async importBundle(bundle: { revision: number; channels: ChannelsResponse; items: ContentItem[] }): Promise<CacheReceipt> {
    if (bundle.revision < this.meta.revision) return { accepted: false, revision: this.meta.revision, reason: 'stale-revision', appliedEntries: 0 };
    await this.putChannels(bundle.channels);
    return await this.persist(bundle.revision, bundle.items.filter((item) => item.isPrivate !== true && item.channelId !== 'private'));
  }

  private async persist(revision: number, items: ContentItem[]): Promise<CacheReceipt> {
    await this.writeSnapshot(revision, items);
    if (this.catalogLedger.overCapacity) await this.shrinkToCapacity();
    return { accepted: true, revision, appliedEntries: this.items.size };
  }

  /** One batch: new chunks + meta flip + removal of every older key. Partial failure keeps the old set. */
  private async writeSnapshot(revision: number, items: ContentItem[]): Promise<void> {
    const staleKeys = [...(await this.disk.list(CATALOG_REVISION_PREFIX)).map((entry) => entry.key), CATALOG_META_KEY];
    const writes: CacheWrite[] = [];
    for (let start = 0, index = 0; start < items.length || index === 0; index += 1, start += CATALOG_CHUNK_ITEMS) {
      const chunk = items.slice(start, start + CATALOG_CHUNK_ITEMS);
      writes.push({ key: chunkKey(revision, index), bytes: jsonBytes(chunk) });
      if (chunk.length < CATALOG_CHUNK_ITEMS) break;
    }
    const meta: CatalogSnapshotMeta = { revision, chunks: writes.length, updatedAt: this.now(), partial: this.meta.partial };
    await this.disk.writeBatch([...writes, { key: CATALOG_META_KEY, bytes: jsonBytes(meta) }], staleKeys);
    this.meta = meta;
    this.items.clear();
    this.catalogLedger.reset();
    for (const item of items) this.track(item);
  }

  /** Capacity eviction drops least-recently-used entries, flags the snapshot partial and rewrites once. */
  private async shrinkToCapacity(): Promise<void> {
    while (this.catalogLedger.overCapacity && this.items.size > 1) {
      const oldest = this.catalogLedger.oldest();
      if (oldest === undefined) break;
      this.items.delete(oldest);
      this.catalogLedger.forget(oldest);
    }
    this.meta = { ...this.meta, partial: true };
    await this.writeSnapshot(this.meta.revision, [...this.items.values()]);
  }

  /** Posters are keyed by id + `coverVersion`: an unchanged version is reused, never re-downloaded. */
  async putPoster(contentId: string, coverVersion: string, bytes: Uint8Array, subject: WriteGuardSubject = {}): Promise<PosterReceipt> {
    assertWritable('public-cache.poster', { ...subject, contentId });
    const key = posterKey(contentId, coverVersion);
    await this.disk.writeBatch([{ key, bytes }], []);
    this.posterLedger.put(key, bytes.byteLength);
    let evictedPosters = 0;
    while (this.posterLedger.overCapacity) {
      const oldest = this.posterLedger.oldest();
      if (oldest === undefined) break;
      await this.disk.writeBatch([], [oldest]);
      this.posterLedger.forget(oldest);
      evictedPosters += 1;
    }
    return { stored: true, key, bytes: bytes.byteLength, evictedPosters };
  }

  async getPoster(contentId: string, coverVersion: string): Promise<Uint8Array | null> {
    const key = posterKey(contentId, coverVersion);
    if (!this.posterLedger.has(key)) return null;
    const bytes = await this.disk.read(key);
    if (bytes !== null) this.posterLedger.hit(key);
    return bytes;
  }

  /** Withdrawal tombstones and per-title eviction reach every stored version of one title. */
  async removePosterFor(contentId: string): Promise<number> {
    const doomed = this.posterLedger.keys().filter((key) => key.startsWith(`${POSTER_PREFIX}${contentId}@`));
    for (const key of doomed) { await this.disk.writeBatch([], [key]); this.posterLedger.forget(key); }
    return doomed.length;
  }

  /** The whole of 【清理缓存】. Nothing outside the `cache/` namespace is enumerated or removed. */
  async clearCache(): Promise<CacheClearReport> {
    const entries = await this.disk.list(CACHE_KEY_NAMESPACE);
    const freedBytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    await this.disk.writeBatch([], entries.map((entry) => entry.key));
    this.adopt({ revision: 0, chunks: 0, updatedAt: 0, partial: false });
    this.staged = null;
    return { removedKeys: entries.length, freedBytes, clearedDomains: CLEARED_BY_CLEAR_CACHE, preservedDomains: PRESERVED_BY_CLEAR_CACHE };
  }
}

export function createPublicCache(disk: CacheDisk, now?: () => number): PublicCache {
  return new PublicCache(disk, now);
}
