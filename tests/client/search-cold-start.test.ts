// @vitest-environment jsdom
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelsResponse, ContentItem } from '../../edge/src/types/api';
import { PrismApiClient } from '../../src/core/api/client';
import { createCatalogCacheService } from '../../src/core/catalog-cache';
import { createLocalSearchApi, createSearchIndex, MemoryCacheDisk, PublicCache } from '../../src/core/storage';
import type { SnapshotFeed, SqliteLike } from '../../src/core/storage/search-index';

const loaded = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSync };
const item: ContentItem = { id: 'drama_cold', channelId: 'drama', title: '冷启动战神', category: '都市', isPrivate: false } as ContentItem;
const channels: ChannelsResponse = { version: 1, channels: [{ id: 'drama', name: '短剧精选', order: 1, requiresTier: [], categories: ['都市'] }] };
const bundle = { revision: 9, channels, items: [item] };
const response = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const remote = () => ({
  search: vi.fn(async () => ({ items: [], page: 1 })),
  suggestions: vi.fn(async (query: string) => ({ query, suggestions: [] }))
});
function sqliteOf(db: DatabaseSync): SqliteLike {
  return {
    isConnected: async () => true,
    open: async () => undefined,
    close: async () => undefined,
    executeSet: async (_database, set, transaction) => {
      if (transaction) db.exec('BEGIN');
      try {
        for (const entry of set) db.prepare(entry.statement).run(...entry.values);
        if (transaction) db.exec('COMMIT');
      } catch (error) {
        if (transaction) db.exec('ROLLBACK');
        throw error;
      }
    },
    queryResult: async (_database, sql, values) => db.prepare(sql).all(...values) as never
  };
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe('客户端搜索冷启动', () => {
  it('磁盘快照 + 同修订空增量仍全量 feed，并修复同修订缺行索引，不发额外请求或同步通知', async () => {
    const disk = new MemoryCacheDisk();
    await new PublicCache(disk).importBundle(bundle);
    const cache = new PublicCache(disk);
    const index = createSearchIndex({ sqlite: sqliteOf(new loaded.DatabaseSync(':memory:')) });
    await index.sync({ items: [], changes: [], revision: bundle.revision });
    const feeds: SnapshotFeed[] = [];
    const network = vi.fn(async () => response({ changes: [], nextRevision: bundle.revision, hasMore: false }));
    const download = vi.fn(async () => response(bundle));
    const service = createCatalogCacheService({
      cache, client: new PrismApiClient({ baseUrl: 'https://example.test', fetchImpl: network }), fetchImpl: download,
      onSnapshotEntries: (feed) => { feeds.push(feed); void index.sync(feed); }
    });
    const synced = vi.fn();
    service.onSynced(synced);
    expect(await service.hydrate()).toBe(true);
    expect(network).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    expect(synced).not.toHaveBeenCalled();
    await service.syncIncremental();
    expect((await index.search('冷启动')).map((hit) => hit.contentId)).toEqual([item.id]);
    expect(feeds).toEqual([{ items: [item], revision: bundle.revision }]);
    expect(network).toHaveBeenCalledTimes(1);
    expect(download).not.toHaveBeenCalled();
  });

  it.each(['search', 'suggestions'] as const)('种子写索引被延迟时立即 %s 等待已排队 sync，不调用 remote', async (method) => {
    const sqlite = sqliteOf(new loaded.DatabaseSync(':memory:'));
    const gate = deferred();
    const started = deferred();
    const execute = sqlite.executeSet;
    sqlite.executeSet = async (database, set, transaction) => {
      if (set.some((entry) => entry.statement.startsWith('INSERT INTO local_search_doc'))) {
        started.release();
        await gate.promise;
      }
      await execute(database, set, transaction);
    };
    const index = createSearchIndex({ sqlite });
    const cache = new PublicCache(new MemoryCacheDisk());
    const service = createCatalogCacheService({
      cache, client: new PrismApiClient({ baseUrl: 'https://example.test', fetchImpl: async () => response({ changes: [], nextRevision: 9, hasMore: false }) }),
      fetchImpl: async () => response(bundle), onSnapshotEntries: (feed) => { void index.sync(feed); }
    });
    await service.bootstrap();
    await started.promise;
    const cloud = remote();
    const api = createLocalSearchApi({ index, localItems: () => cache.list(), remote: cloud });
    let settled = false;
    const result = (method === 'search' ? api.search({ q: '冷启动' }) : api.suggestions('冷启动')).then((value) => { settled = true; return value; });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(cloud.search).not.toHaveBeenCalled();
      expect(cloud.suggestions).not.toHaveBeenCalled();
      expect(settled).toBe(false);
    } finally { gate.release(); }
    expect(await result).toMatchObject(method === 'search'
      ? { items: [{ item: { id: item.id } }] }
      : { suggestions: [{ text: item.title, type: 'title' }, { text: item.category, type: 'category' }] });
  });

  it.each(['search', 'suggestions'] as const)('磁盘索引未 init 时 %s 先读回状态，缺失命中不自动联网', async (method) => {
    const sqlite = sqliteOf(new loaded.DatabaseSync(':memory:'));
    await createSearchIndex({ sqlite }).sync({ items: [item], revision: 9 });
    const index = createSearchIndex({ sqlite });
    const cloud = remote();
    const api = createLocalSearchApi({ index, localItems: () => [item], remote: cloud });
    const result = method === 'search' ? await api.search({ q: '不存在词' }) : await api.suggestions('不存在词');
    expect(result).toMatchObject(method === 'search' ? { items: [] } : { suggestions: [] });
    expect(index.status()).toMatchObject({ available: true, docs: 1 });
    expect(cloud.search).not.toHaveBeenCalled();
    expect(cloud.suggestions).not.toHaveBeenCalled();
  });

  it('SQLite 不可用时本机搜索返回空，由独立联网补充接续；补全仍可回落', async () => {
    const sqlite = sqliteOf(new loaded.DatabaseSync(':memory:'));
    sqlite.isConnected = async () => false;
    const open = vi.fn(async () => { throw new Error('本机无端侧 SQLite'); });
    sqlite.open = open;
    const cloud = remote();
    const api = createLocalSearchApi({ index: createSearchIndex({ sqlite }), localItems: () => [item], remote: cloud });
    expect(await api.search({ q: '战神' })).toEqual({ items: [], page: 1, hasMore: false });
    expect(await api.suggestions('战神')).toEqual({ query: '战神', suggestions: [] });
    expect(open).toHaveBeenCalledTimes(2);
    expect(cloud.search).not.toHaveBeenCalled();
    expect(cloud.suggestions).toHaveBeenCalledTimes(1);
  });

  it('冷启读回旧索引私密候选，门面仍剔除搜索结果与补全且不联网', async () => {
    const sqlite = sqliteOf(new loaded.DatabaseSync(':memory:'));
    await createSearchIndex({ sqlite }).sync({ items: [item], revision: 9 });
    const cloud = remote();
    const api = createLocalSearchApi({ index: createSearchIndex({ sqlite }), localItems: () => [{ ...item, isPrivate: true }], remote: cloud });
    expect((await api.search({ q: '冷启动' })).items).toEqual([]);
    expect((await api.suggestions('冷启动')).suggestions).toEqual([]);
    expect(cloud.search).not.toHaveBeenCalled();
    expect(cloud.suggestions).not.toHaveBeenCalled();
  });
});
