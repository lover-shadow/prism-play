// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { CatalogChangesResponse, CatalogResponse, ChannelId, ContentItem } from '../../edge/src/types/api';
import { createCredentialStore } from '../../src/core/storage/credentials';
import { createHistoryStore, type SqliteLike } from '../../src/core/storage/history-store';
import { CACHE_KEY_NAMESPACE, CATALOG_META_KEY, MemoryCacheDisk, PublicCache, type CacheDisk } from '../../src/core/storage/public-cache';
import { createPrivateVault } from '../../src/core/storage/private-vault';
import { createWebFallbackBridge, installNativeBridge } from '../../src/core/native/bridge';
import { CATALOG_CACHE_LIMIT_BYTES, POSTER_CACHE_LIMIT_BYTES } from '../../src/core/storage/storage-domains';

const KiB = 1024;
const MIB = KiB * KiB;

function item(id: string, channelId: ChannelId): ContentItem {
  return {
    id, channelId, title: `公开剧目 ${id}`, category: '都市', isPrivate: channelId === 'private',
    coverUrl: `https://play.prismos.org/proxy/cover/${id}`, coverVersion: 'v1', episodeCount: 12
  };
}

const pageOf = (channelId: ChannelId, ids: string[], pageNumber: number, total: number, revision: number): CatalogResponse => ({
  items: ids.map((id) => item(`${channelId}_${id}`, channelId)), page: pageNumber, pageSize: ids.length, total, revision
});

/** 短剧精选 on two pages, the other three public channels on one: the shape AC-01 pulls at cold start. */
function fullSnapshot(revision: number): CatalogResponse[] {
  return [
    pageOf('drama', ['a', 'b'], 1, 4, revision),
    pageOf('drama', ['c', 'd'], 2, 4, revision),
    pageOf('movie', ['m1'], 1, 1, revision),
    pageOf('anime', ['n1'], 1, 1, revision),
    pageOf('documentary', ['d1'], 1, 1, revision)
  ];
}

const stageAll = (cache: PublicCache, pages: CatalogResponse[]): void => pages.forEach((page) => cache.stagePage(page.items[0]?.channelId ?? 'drama', page));

const changes = (nextRevision: number, entries: CatalogChangesResponse['changes']): CatalogChangesResponse => ({ changes: entries, nextRevision, hasMore: false });

/** Failure injection on the durable half only, so an interrupted commit can be observed (AC-18). */
class FlakyDisk implements CacheDisk {
  readonly inner = new MemoryCacheDisk();
  failing = false;
  read = async (key: string): Promise<Uint8Array | null> => await this.inner.read(key);
  list = async (prefix: string): Promise<Array<{ key: string; bytes: number }>> => await this.inner.list(prefix);
  async writeBatch(writes: { key: string; bytes: Uint8Array }[], removes: string[]): Promise<void> {
    if (this.failing) throw new Error('磁盘空间不足');
    await this.inner.writeBatch(writes, removes);
  }
}

function spySqlite(): { sqlite: SqliteLike; writes: () => number } {
  let executed = 0;
  const noop = async (): Promise<void> => undefined;
  return {
    writes: () => executed,
    sqlite: { isConnected: async () => true, open: noop, close: noop, executeSet: async () => void (executed += 1), queryResult: async () => [] as never }
  };
}

function keystoreBridge(secure: Map<string, string>, clearedSlots: string[]): void {
  installNativeBridge({
    ...createWebFallbackBridge(),
    secureRead: async (key) => secure.get(key) ?? null,
    secureWrite: async (key, value) => void secure.set(key, value),
    secureClear: async (key) => void clearedSlots.push(key),
    isKeystoreBacked: async () => true
  }, 'native');
}

afterEach(() => installNativeBridge(createWebFallbackBridge(), 'web-fallback'));

describe('catalog snapshot staging and atomic replace (AC-18)', () => {
  it('commits only a complete snapshot and then serves all six public items', async () => {
    const cache = new PublicCache(new MemoryCacheDisk());
    const receipts = fullSnapshot(7).map((page) => cache.stagePage(page.items[0]?.channelId ?? 'drama', page));
    expect(receipts.every((receipt) => receipt.accepted)).toBe(true);
    expect(cache.snapshotRevision()).toBe(0);
    expect((await cache.commitSnapshot()).accepted).toBe(true);
    expect(cache.snapshotRevision()).toBe(7);
    expect(cache.list('drama')).toHaveLength(4);
    expect(cache.list()).toHaveLength(4 + 3);
  });

  it('refuses a page from an older revision and keeps the last complete snapshot', async () => {
    const disk = new MemoryCacheDisk();
    const cache = new PublicCache(disk);
    stageAll(cache, fullSnapshot(7));
    await cache.commitSnapshot();

    const stale = cache.stagePage('movie', pageOf('movie', ['ghost'], 1, 1, 6));
    expect(stale).toMatchObject({ accepted: false, reason: 'stale-revision', revision: 7 });
    expect(cache.getItem('movie_ghost')).toBeNull();
    expect(cache.snapshotRevision()).toBe(7);
    const meta = JSON.parse(new TextDecoder().decode((await disk.read(CATALOG_META_KEY)) ?? new Uint8Array())) as { revision: number };
    expect(meta.revision).toBe(7);
  });

  it('refuses to mix two revisions inside one snapshot unit', async () => {
    const cache = new PublicCache(new MemoryCacheDisk());
    cache.stagePage('drama', pageOf('drama', ['a'], 1, 1, 9));
    expect(cache.stagePage('movie', pageOf('movie', ['m1'], 1, 1, 10))).toMatchObject({ accepted: false, reason: 'mixed-revision' });
    expect(cache.snapshotRevision()).toBe(0);
  });

  it('refuses to commit a snapshot whose paging is incomplete, writing nothing at all', async () => {
    const disk = new MemoryCacheDisk();
    const cache = new PublicCache(disk);
    cache.stagePage('drama', pageOf('drama', ['a', 'b'], 1, 4, 7));
    expect(await cache.commitSnapshot()).toMatchObject({ accepted: false, reason: 'incomplete-pages' });
    expect(await disk.read(CATALOG_META_KEY)).toBeNull();
    expect(cache.list()).toHaveLength(0);
  });

  it('rejects a private item with the gate error instead of caching it', async () => {
    const cache = new PublicCache(new MemoryCacheDisk());
    const leaked: CatalogResponse = { items: [item('private_x', 'private')], page: 1, pageSize: 1, total: 1, revision: 3 };
    expect(() => cache.stagePage('private', leaked)).toThrow(/个人探索内容禁止落盘/);
    expect(cache.snapshotRevision()).toBe(0);
  });

  it('keeps the previous snapshot when the durable batch fails (同步中断保留旧版)', async () => {
    const disk = new FlakyDisk();
    const cache = new PublicCache(disk);
    stageAll(cache, fullSnapshot(7));
    await cache.commitSnapshot();

    disk.failing = true;
    stageAll(cache, fullSnapshot(8));
    await expect(cache.commitSnapshot()).rejects.toThrow(/磁盘空间不足/);
    expect(cache.snapshotRevision()).toBe(7);

    const reopened = new PublicCache(disk);
    await reopened.hydrate();
    expect(reopened.snapshotRevision()).toBe(7);
    expect(reopened.list()).toHaveLength(4 + 3);
  });

  it('serves the stored snapshot on the next cold start (二次启动先显快照)', async () => {
    const disk = new MemoryCacheDisk();
    const cache = new PublicCache(disk);
    stageAll(cache, fullSnapshot(7));
    await cache.commitSnapshot();

    const reopened = new PublicCache(disk);
    expect(reopened.snapshotRevision()).toBe(0);
    await reopened.hydrate();
    expect(reopened.snapshotRevision()).toBe(7);
    expect(reopened.getItem('anime_n1')?.channelId).toBe('anime');
    expect(reopened.list('documentary')).toHaveLength(1);
  });
});

describe('incremental changes, posters and capacity', () => {
  it('advances the cursor only to the server nextRevision and replays idempotently (never +1)', async () => {
    const cache = new PublicCache(new MemoryCacheDisk());
    const response = changes(11, [
      { revision: 10, contentId: 'movie_m9', operation: 'upsert', item: item('movie_m9', 'movie') },
      { revision: 11, contentId: 'drama_a', operation: 'upsert', item: item('drama_a2', 'drama') }
    ]);
    expect((await cache.applyChanges(response)).accepted).toBe(true);
    expect(cache.snapshotRevision()).toBe(11);
    expect(cache.getItem('movie_m9')).not.toBeNull();
    expect(cache.getItem('drama_a2')).not.toBeNull();

    expect(await cache.applyChanges(response)).toMatchObject({ accepted: false, reason: 'not-newer', revision: 11 });
    expect(cache.snapshotRevision()).toBe(11);
    expect(cache.getItem('movie_m9')?.title).toBe('公开剧目 movie_m9');
  });

  it('drops a withdrawn title together with every stored poster version of it', async () => {
    const cache = new PublicCache(new MemoryCacheDisk());
    await cache.applyChanges(changes(4, [{ revision: 4, contentId: 'movie_m1', operation: 'upsert', item: item('movie_m1', 'movie') }]));
    await cache.putPoster('movie_m1', 'v1', new Uint8Array([1, 2, 3]), { contentId: 'movie_m1', channelId: 'movie' });
    await cache.putPoster('movie_m1', 'v2', new Uint8Array([4, 5]), { contentId: 'movie_m1', channelId: 'movie' });

    await cache.applyChanges(changes(5, [{ revision: 5, contentId: 'movie_m1', operation: 'delete' }]));
    expect(cache.getItem('movie_m1')).toBeNull();
    expect(cache.hasPoster('movie_m1', 'v1')).toBe(false);
    expect(cache.hasPoster('movie_m1', 'v2')).toBe(false);
  });

  it('keys posters by content id plus coverVersion and reuses an unchanged version', async () => {
    const disk = new FlakyDisk();
    const cache = new PublicCache(disk);
    await cache.putPoster('drama_a', 'v1', new Uint8Array([9, 8, 7, 6]), { contentId: 'drama_a', channelId: 'drama' });
    expect(cache.hasPoster('drama_a', 'v1')).toBe(true);
    expect(cache.hasPoster('drama_a', 'v2')).toBe(false);
    expect(Array.from((await cache.getPoster('drama_a', 'v1')) ?? new Uint8Array())).toEqual([9, 8, 7, 6]);
    expect(await cache.getPoster('drama_a', 'v2')).toBeNull();

    const second = await cache.putPoster('drama_a', 'v2', new Uint8Array([1]), { contentId: 'drama_a', channelId: 'drama' });
    expect(second.key).toBe(`${CACHE_KEY_NAMESPACE}posters/drama_a@v2`);
    expect(await cache.removePosterFor('drama_a')).toBe(2);
    expect(await disk.inner.list(`${CACHE_KEY_NAMESPACE}posters/`)).toHaveLength(0);
  });

  it('holds the poster byte cap and evicts the least recently used image first', async () => {
    const disk = new MemoryCacheDisk();
    const cache = new PublicCache(disk, () => 1, CATALOG_CACHE_LIMIT_BYTES, 400);
    for (const id of ['a', 'b', 'c']) await cache.putPoster(id, 'v1', new Uint8Array(120), { contentId: id, channelId: 'drama' });
    expect(cache.bytesUsed().posters).toBe(360);

    const fourth = await cache.putPoster('d', 'v1', new Uint8Array(120), { contentId: 'd', channelId: 'drama' });
    expect(fourth.evictedPosters).toBe(1);
    expect(cache.bytesUsed().posters).toBeLessThanOrEqual(400);
    expect(cache.hasPoster('a', 'v1')).toBe(false);
    expect(cache.hasPoster('d', 'v1')).toBe(true);
    expect((await disk.list(`${CACHE_KEY_NAMESPACE}posters/`)).length).toBe(3);
  });

  it('shrinks an over-cap snapshot to least-recently-used items and flags it partial', async () => {
    const cache = new PublicCache(new MemoryCacheDisk(), () => 1, 400, POSTER_CACHE_LIMIT_BYTES);
    stageAll(cache, [pageOf('drama', ['a', 'b'], 1, 4, 7), pageOf('drama', ['c', 'd'], 2, 4, 7)]);
    await cache.commitSnapshot();
    expect(cache.snapshotIsPartial()).toBe(true);
    expect(cache.bytesUsed().catalog).toBeLessThanOrEqual(400);
    expect(cache.list('drama').length).toBeLessThan(4);
  });

  it('trims an over-cap snapshot lazily, on the next durable write', async () => {
    const writer = new MemoryCacheDisk();
    const roomy = new PublicCache(writer);
    stageAll(roomy, [pageOf('drama', ['a', 'b'], 1, 4, 7), pageOf('drama', ['c', 'd'], 2, 4, 7)]);
    await roomy.commitSnapshot();

    const tight = new PublicCache(writer, () => 9, 300, POSTER_CACHE_LIMIT_BYTES);
    await tight.hydrate();
    expect(tight.bytesUsed().catalog).toBeGreaterThan(300);
    expect(tight.snapshotIsPartial()).toBe(false);
    await tight.applyChanges(changes(8, []));
    expect(tight.bytesUsed().catalog).toBeLessThanOrEqual(300);
    expect(tight.snapshotIsPartial()).toBe(true);
  });

  it('ships the SPEC quotas and defaults to them', () => {
    expect(CATALOG_CACHE_LIMIT_BYTES).toBe(20 * MIB);
    expect(POSTER_CACHE_LIMIT_BYTES).toBe(128 * MIB);
    const fresh = new PublicCache(new MemoryCacheDisk());
    expect(fresh.bytesUsed()).toEqual({ catalog: 0, posters: 0 });
  });
});

describe('clearCache scope (清缓存不清凭证/续播)', () => {
  it('removes only the cache namespace, leaving credentials, history and the vault alone', async () => {
    const secure = new Map<string, string>();
    const clearedSlots: string[] = [];
    keystoreBridge(secure, clearedSlots);
    const token = 'eyJhbGciOiJFZERTQSJ9.eyJ0aWVyIjoiWSJ9.b25ldGFsbGllbnRhdHVhbGx5bG9uZ2VzaWdu';
    const credentials = createCredentialStore();
    await credentials.write('token', token);

    const sqlite = spySqlite();
    const history = createHistoryStore({ sqlite: sqlite.sqlite });
    const cache = new PublicCache(new MemoryCacheDisk());
    stageAll(cache, fullSnapshot(7));
    await cache.putPoster('drama_a', 'v1', new Uint8Array([1, 2]), { contentId: 'drama_a', channelId: 'drama' });
    const committed = await cache.commitSnapshot();
    expect(committed.accepted).toBe(true);
    await history.getWatch('drama_a');
    const writesBeforeClear = sqlite.writes();

    const vault = createPrivateVault();
    vault.putPoster('priv_1', new Uint8Array([7]));
    vault.session.write('opaque-private-session');

    const report = await cache.clearCache();
    expect(report.clearedDomains).toEqual(['public-cache']);
    expect(report.preservedDomains).toEqual(['credentials', 'history']);
    expect(report.removedKeys).toBeGreaterThan(0);
    expect(cache.snapshotRevision()).toBe(0);
    expect(cache.list()).toHaveLength(0);
    expect(cache.hasPoster('drama_a', 'v1')).toBe(false);
    expect(secure.get('auth.jwt.ed25519')).toBe(token);
    expect(clearedSlots).toEqual([]);
    // 清缓存 issues no SQLite write of any kind: the resume rows are exactly as they were.
    expect(sqlite.writes()).toBe(writesBeforeClear);
    expect(vault.size()).toBe(2);
  });

  it('is idempotent and frees nothing twice', async () => {
    const disk = new MemoryCacheDisk();
    const cache = new PublicCache(disk);
    stageAll(cache, fullSnapshot(7));
    await cache.commitSnapshot();
    const first = await cache.clearCache();
    const second = await cache.clearCache();
    expect(second.removedKeys).toBe(0);
    expect(second.freedBytes).toBe(0);
    expect(first.removedKeys).toBeGreaterThan(0);
    expect(await disk.list(CACHE_KEY_NAMESPACE)).toHaveLength(0);
  });
});
