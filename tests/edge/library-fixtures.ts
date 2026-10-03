import type { ChannelId, ContentItem } from '../../edge/src/types/api';
import type { MemoryKv } from '../support/kv-mock';
import type { PrismTestEnv } from '../support/test-env';
import { createTestEnv } from '../support/test-env';
import { CATALOG_MANIFEST_KV_KEY, CATALOG_PAGE_SIZE, PRIVATE_MANIFEST_KV_KEY } from '../../edge/src/library/manifest';
import { chunkKey, privateChunkKey, privateTitleKey, titleKey } from '../../edge/src/library/paths';

/**
 * R2 + KV fixtures for the refactored read path (SPEC-CLOUD-REFACTOR v2 §3).
 *
 * The key builders are imported from production code instead of being repeated here: a fixture that
 * spells a path on its own could keep passing after the route and the CI writer drifted apart, which is
 * precisely the failure this refactor must not survive. Nothing in this module writes D1 — the browse
 * path is not allowed to read it (AC-C3-1), and {@link forbidD1Reads} makes that assertable.
 */

/** Minimal R2 stand-in: string keys, text bodies, prefix listing. Covers the read path's three calls. */
export class MemoryR2 {
  readonly objects = new Map<string, string>();

  putText(key: string, body: string): void {
    this.objects.set(key, body);
  }

  async get(key: string): Promise<{ key: string; text(): Promise<string> } | null> {
    const body = this.objects.get(key);
    if (body === undefined) return null;
    return { key, text: async () => body };
  }

  async head(key: string): Promise<{ key: string } | null> {
    return this.objects.has(key) ? { key } : null;
  }

  async list(options?: { prefix?: string; limit?: number }): Promise<{ keys: { key: string }[] }> {
    const prefix = options?.prefix ?? '';
    const limit = options?.limit ?? 1000;
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(prefix)).slice(0, limit);
    return { keys: keys.map((key) => ({ key })) };
  }

  storedBytes(key: string): string | undefined {
    return this.objects.get(key);
  }
}

export function asBucket(r2: MemoryR2): R2Bucket {
  return r2 as unknown as R2Bucket;
}

/**
 * A D1 binding that fails the moment it is touched. Wiring it into `env.DB` turns AC-C3-1 ("the browse
 * path reads zero D1 rows") into an assertion rather than a code-review promise.
 */
export function forbidD1Reads(): D1Database {
  const refuse = (): never => {
    throw new Error('AC-C3-1: the catalogue read path must not touch D1');
  };
  return { prepare: refuse, batch: refuse, exec: refuse } as unknown as D1Database;
}

export type LibraryEnv = PrismTestEnv & { r2: MemoryR2 };

/** The Worker environment with the existing `APK_BUCKET` binding pointed at an in-memory R2. */
export async function libraryEnv(): Promise<LibraryEnv> {
  const r2 = new MemoryR2();
  const env = (await createTestEnv({ APK_BUCKET: asBucket(r2) })) as LibraryEnv;
  env.r2 = r2;
  return env;
}

export interface LibraryWritable {
  kv: MemoryKv;
  r2: MemoryR2;
}

export function cardFixture(id: string, overrides: Partial<ContentItem> = {}): ContentItem {
  const card: ContentItem = {
    id,
    channelId: 'drama',
    title: `剧名 ${id}`,
    category: '逆袭',
    isPrivate: false,
    coverUrl: `/proxy/img/${id}`,
    coverVersion: 'v1',
    synopsis: '三十字以内短简介',
    episodeCount: 82,
    firstPublishedAt: 1_790_000_000,
    hitsTotal: 9_867,
    ...overrides
  };
  return card;
}

/** A channel of `count` cards, ids in order — the fixture behind the 60-per-shard boundary tests. */
export function cardRun(channelId: ChannelId, count: number, offset = 0): ContentItem[] {
  return Array.from({ length: count }, (_unused, index) =>
    cardFixture(`${channelId.slice(0, 1)}_${index + offset}`, { channelId, title: `剧目 ${index + offset}`, category: '都市' })
  );
}

export interface LibrarySeed {
  revision: number;
  channels: Record<string, readonly ContentItem[]>;
  /** Overrides the manifest's per-channel total, for a revision whose shard count and total disagree. */
  totals?: Record<string, number>;
  generatedAt?: number;
  taxonomyVersion?: string;
}

/**
 * Writes one revision exactly as §3.1 shapes it: `ceil(n/60)` shards per channel, page numbers from 1,
 * and a `catalog:manifest` whose inventory agrees with what is actually on the bucket.
 */
export async function seedLibraryAssets(writable: LibraryWritable, seed: LibrarySeed): Promise<number> {
  const channels: Record<string, { chunks: number; total: number }> = {};
  for (const [channelId, cards] of Object.entries(seed.channels)) {
    const chunks = Math.ceil(cards.length / CATALOG_PAGE_SIZE);
    for (let index = 0; index < chunks; index += 1) {
      const slice = cards.slice(index * CATALOG_PAGE_SIZE, (index + 1) * CATALOG_PAGE_SIZE);
      writable.r2.putText(
        chunkKey(seed.revision, channelId, index),
        // §3.1 `total` is the channel total, not the length of this shard, so paging arithmetic closes.
        JSON.stringify({ items: slice, page: index + 1, pageSize: CATALOG_PAGE_SIZE, total: seed.totals?.[channelId] ?? cards.length, revision: seed.revision })
      );
    }
    channels[channelId] = { chunks, total: seed.totals?.[channelId] ?? cards.length };
  }
  const manifest: Record<string, unknown> = {
    revision: seed.revision,
    pageSize: CATALOG_PAGE_SIZE,
    channels,
    generatedAt: seed.generatedAt ?? 1_790_000_000,
    taxonomyVersion: seed.taxonomyVersion ?? 'modu-2026-10-03'
  };
  await writable.kv.put(CATALOG_MANIFEST_KV_KEY, JSON.stringify(manifest));
  return seed.revision;
}

/** Writes a shard verbatim, bypassing the builder: how a malformed or leaking asset gets on the bucket. */
export function putRawShard(
  writable: LibraryWritable,
  revision: number,
  channelId: string,
  page: number,
  body: unknown
): string {
  const key = chunkKey(revision, channelId, page - 1);
  writable.r2.putText(key, typeof body === 'string' ? body : JSON.stringify(body));
  return key;
}

/** Drops the manifest while leaving the shards: the state between a prune and the next publish. */
export async function clearCatalogManifest(writable: LibraryWritable): Promise<void> {
  await writable.kv.delete(CATALOG_MANIFEST_KV_KEY);
}

export async function putRawManifest(writable: LibraryWritable, body: unknown): Promise<void> {
  await writable.kv.put(CATALOG_MANIFEST_KV_KEY, typeof body === 'string' ? body : JSON.stringify(body));
}

/**
 * §C-2b publishes no private directory, so this fixture exists to prove the route is ready for one:
 * shards under the private prefix plus `catalog:private-manifest`, in the shapes the route reads.
 */
export async function seedPrivateDirectory(writable: LibraryWritable, revision: number, cards: readonly ContentItem[]): Promise<void> {
  const chunks = Math.ceil(cards.length / CATALOG_PAGE_SIZE);
  for (let index = 0; index < chunks; index += 1) {
    const slice = cards.slice(index * CATALOG_PAGE_SIZE, (index + 1) * CATALOG_PAGE_SIZE);
    writable.r2.putText(
      privateChunkKey(revision, index),
      JSON.stringify({ items: slice, page: index + 1, pageSize: CATALOG_PAGE_SIZE, total: cards.length, revision })
    );
  }
  await seedPrivateManifest(writable, revision, { private: { chunks, total: cards.length } });
}

/** The private manifest on its own — the state §C-2b actually publishes (titles only, no directory). */
export async function seedPrivateManifest(
  writable: LibraryWritable,
  revision: number,
  channels?: Record<string, { chunks: number; total: number }>
): Promise<void> {
  const manifest: Record<string, unknown> = { revision, pageSize: CATALOG_PAGE_SIZE, generatedAt: 1_790_000_000 };
  if (channels !== undefined) manifest.channels = channels;
  await writable.kv.put(PRIVATE_MANIFEST_KV_KEY, JSON.stringify(manifest));
}

export async function clearPrivateManifest(writable: LibraryWritable): Promise<void> {
  await writable.kv.delete(PRIVATE_MANIFEST_KV_KEY);
}

export interface EpisodeSeed {
  episodeNumber: number;
  title?: string;
  durationSeconds?: number;
  lines?: { providerId: string; mediaUrl: string }[];
}

export interface TitleAssetSeed {
  revision: number;
  workId: string;
  title?: string;
  channelId?: string;
  isPrivate?: boolean;
  episodes?: EpisodeSeed[];
  category?: string;
  coverUrl?: string | null;
  synopsis?: string;
  hitsTotal?: number;
  firstPublishedAt?: number;
}

/** §3.2 episode manifest; `lines` default to one abstract provider so a test can name what it checks. */
export async function seedTitleAsset(writable: LibraryWritable, seed: TitleAssetSeed): Promise<string> {
  const isPrivate = seed.isPrivate ?? false;
  const episodes = seed.episodes ?? [{ episodeNumber: 1 }, { episodeNumber: 2 }];
  const body: Record<string, unknown> = {
    workId: seed.workId,
    title: seed.title ?? `剧名 ${seed.workId}`,
    channelId: seed.channelId ?? 'drama',
    isPrivate,
    episodes: episodes.map((episode) => ({
      episodeNumber: episode.episodeNumber,
      ...(episode.title === undefined ? {} : { title: episode.title }),
      ...(episode.durationSeconds === undefined ? {} : { durationSeconds: episode.durationSeconds }),
      lines: episode.lines ?? [{ providerId: 'provider_m1', mediaUrl: `https://play.invalid/${seed.workId}/e${episode.episodeNumber}.m3u8` }]
    })),
    generatedAt: 1_790_000_000
  };
  if (seed.category !== undefined) body.category = seed.category;
  if (seed.coverUrl !== null) body.coverUrl = seed.coverUrl ?? `/proxy/img/${seed.workId}`;
  if (seed.synopsis !== undefined) body.synopsis = seed.synopsis;
  if (seed.hitsTotal !== undefined) body.hitsTotal = seed.hitsTotal;
  if (seed.firstPublishedAt !== undefined) body.firstPublishedAt = seed.firstPublishedAt;
  const key = isPrivate ? privateTitleKey(seed.revision, seed.workId) : titleKey(seed.revision, seed.workId);
  writable.r2.putText(key, JSON.stringify(body));
  return key;
}

export function rawTitleAsset(writable: LibraryWritable, workId: string, revision: number, isPrivate = false): string | undefined {
  return writable.r2.storedBytes(isPrivate ? privateTitleKey(revision, workId) : titleKey(revision, workId));
}

/** A §3.2-shaped object with an arbitrary field replaced or removed, for the refusal cases. */
export function brokenTitleAsset(workId: string, patch: Record<string, unknown> | null): string {
  const base: Record<string, unknown> = {
    workId,
    title: `剧名 ${workId}`,
    channelId: 'drama',
    isPrivate: false,
    episodes: [{ episodeNumber: 1, lines: [{ providerId: 'provider_m1', mediaUrl: 'https://play.invalid/a.m3u8' }] }],
    generatedAt: 1_790_000_000
  };
  if (patch === null) return 'not json at all';
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return JSON.stringify(base);
}
