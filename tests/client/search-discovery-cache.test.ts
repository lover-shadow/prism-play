// @vitest-environment jsdom
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelsResponse, ContentItem } from '../../edge/src/types/api';
import { createLocalSearchApi, createSearchIndex, MemoryCacheDisk, PublicCache } from '../../src/core/storage';
import type { SqliteLike } from '../../src/core/storage';

const loaded = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSync };
const item = (id: string, title = '发现新剧', over: Partial<ContentItem> = {}): ContentItem =>
  ({ id, title, channelId: 'drama', category: '都市', isPrivate: false, synopsis: '', ...over } as ContentItem);
const channels: ChannelsResponse = { version: 1, channels: [] };
function database(): SqliteLike {
  const db = new loaded.DatabaseSync(':memory:');
  return {
    isConnected: async () => true, open: async () => undefined, close: async () => db.close(),
    executeSet: async (_name, set, transaction) => {
      if (transaction) db.exec('BEGIN');
      try {
        for (const row of set) db.prepare(row.statement).run(...row.values);
        if (transaction) db.exec('COMMIT');
      } catch (error) { if (transaction) db.exec('ROLLBACK'); throw error; }
    },
    queryResult: async (_name, sql, values) => db.prepare(sql).all(...values) as never
  };
}
async function bundle(cache: PublicCache, revision: number, items: ContentItem[]) {
  await cache.importBundle({ revision, channels, items });
}

describe('公共在线搜索发现：持久化与目录事实', () => {
  it('仅发现缓存也可重启恢复；整包更新不会删除未收录发现', async () => {
    const disk = new MemoryCacheDisk(), cache = new PublicCache(disk);
    await cache.mergeDiscoveries([item('d_new')]);
    const restored = new PublicCache(disk);
    await restored.hydrate();
    expect(restored.getItem('d_new')?.title).toBe('发现新剧');
    await bundle(restored, 3, [item('d_base')]);
    const restarted = new PublicCache(disk);
    await restarted.hydrate();
    expect(restarted.list().map((row) => row.id).sort()).toEqual(['d_base', 'd_new']);
    expect(restarted.list('drama')).toHaveLength(2);
    expect(restarted.bytesUsed().catalog).toBeGreaterThan(0);
  });

  it('并发在线发现合并不会互相覆盖内存，磁盘与内存一致', async () => {
    const disk = new MemoryCacheDisk(), cache = new PublicCache(disk);
    await Promise.all([cache.mergeDiscoveries([item('d_one')]), cache.mergeDiscoveries([item('d_two')])]);
    expect(cache.list().map((row) => row.id).sort()).toEqual(['d_one', 'd_two']);
    const restored = new PublicCache(disk); await restored.hydrate();
    expect(restored.list().map((row) => row.id).sort()).toEqual(['d_one', 'd_two']);
  });

  it('正式事实优先并清除补充副本，后续整包撤去该正式记录不会复活旧发现', async () => {
    const disk = new MemoryCacheDisk(), cache = new PublicCache(disk);
    await cache.mergeDiscoveries([item('d_new', '在线旧名')]);
    await bundle(cache, 2, [item('d_new', '正式新名')]);
    await cache.mergeDiscoveries([item('d_new', '在线旧名')]);
    expect(cache.list()).toHaveLength(1);
    expect(cache.getItem('d_new')?.title).toBe('正式新名');
    await bundle(cache, 3, []);
    const restored = new PublicCache(disk); await restored.hydrate();
    expect(restored.getItem('d_new')).toBeNull();
  });

  it('正式2集在线更新3集可重启；旧整包保留覆盖，新整包4集收回覆盖', async () => {
    const disk = new MemoryCacheDisk(), cache = new PublicCache(disk);
    const base = item('d_base', '连载', { episodeCount: 2, enabled: true });
    const online = { ...base, episodeCount: 3, synopsis: '新集摘要' };
    await bundle(cache, 1, [base]);
    expect(await cache.mergeDiscoveries([online])).toEqual([online]);
    expect(cache.getItem(base.id)).toEqual(online);
    expect(cache.list('drama')).toEqual([online]);
    const restored = new PublicCache(disk); await restored.hydrate();
    expect(restored.getItem(base.id)).toEqual(online);
    await bundle(restored, 2, [base]);
    const restarted = new PublicCache(disk); await restarted.hydrate();
    expect(restarted.list()).toEqual([online]);
    const official = { ...base, episodeCount: 4, synopsis: '正式新摘要' };
    await bundle(restarted, 3, [official]);
    expect(restarted.getItem(base.id)).toEqual(official);
    expect(await disk.list('cache/search-discoveries/')).toEqual([]);
    const final = new PublicCache(disk); await final.hydrate();
    expect(final.list()).toEqual([official]);
  });

  it('相同集数允许元数据更新；正式追平后回收且不误删非base发现', async () => {
    const disk = new MemoryCacheDisk(), cache = new PublicCache(disk);
    const base = item('d_base', '连载', { episodeCount: 2 });
    await bundle(cache, 1, [base]);
    const online = { ...base, synopsis: '已核验摘要' };
    await cache.mergeDiscoveries([online, item('d_extra')]);
    const restored = new PublicCache(disk); await restored.hydrate();
    expect(restored.getItem(base.id)).toEqual(online);
    await bundle(restored, 2, [base]);
    expect(restored.getItem(base.id)).toEqual(base);
    expect(restored.getItem('d_extra')).not.toBeNull();
    expect(await disk.list('cache/search-discoveries/')).toHaveLength(1);
  });

  it('同步upsert同样持久更新且拒绝更少集数，正式撤片物理清理覆盖', async () => {
    const disk = new MemoryCacheDisk(), cache = new PublicCache(disk);
    const base = item('d_base', '连载', { episodeCount: 2 });
    await bundle(cache, 1, [base]);
    const online = { ...base, episodeCount: 3 };
    await cache.applyDiscoveryChanges([{ workId: base.id, operation: 'upsert', card: online }], 0);
    expect(await cache.mergeDiscoveries([{ ...base, episodeCount: 1 }, base])).toEqual([]);
    await cache.applyDiscoveryChanges([{ workId: base.id, operation: 'upsert', card: base }], 0);
    const restored = new PublicCache(disk); await restored.hydrate();
    expect(restored.getItem(base.id)).toEqual(online);
    await restored.applyChanges({ nextRevision: 2, hasMore: false, changes: [{ operation: 'delete', contentId: base.id, revision: 2 }] });
    expect(restored.getItem(base.id)).toBeNull();
    expect(await disk.list('cache/search-discoveries/')).toEqual([]);
    const restarted = new PublicCache(disk); await restarted.hydrate();
    expect(restarted.getItem(base.id)).toBeNull();
  });

  it('覆盖拒绝改名、换频道、disabled与私密；冷启动严格校验base身份', async () => {
    const base = item('d_base', '连载', { episodeCount: 2 });
    for (const over of [{ title: '另一部' }, { channelId: 'movie' as const }, { enabled: false }, { episodeCount: 1 }]) {
      const disk = new MemoryCacheDisk(), cache = new PublicCache(disk);
      await bundle(cache, 1, [base]);
      const invalid = { ...base, episodeCount: 3, ...over };
      expect(await cache.mergeDiscoveries([invalid])).toEqual([]);
      await cache.applyDiscoveryChanges([{ workId: base.id, operation: 'upsert', card: invalid }], 0);
      expect(cache.getItem(base.id)).toEqual(base);
      expect(await disk.list('cache/search-discoveries/')).toEqual([]);
      // 残存文件也必须按正式身份校验，不能靠重启绕过在线校验。
      await disk.writeBatch([{ key: 'cache/search-discoveries/d_base.json', bytes: new TextEncoder().encode(JSON.stringify(invalid)) }], []);
      const restored = new PublicCache(disk); await restored.hydrate();
      expect(restored.getItem(base.id)).toEqual(base);
      expect(await disk.list('cache/search-discoveries/')).toEqual([]);
    }
    const disk = new MemoryCacheDisk(), cache = new PublicCache(disk);
    await bundle(cache, 1, [{ ...base, enabled: false }]);
    expect(await cache.mergeDiscoveries([{ ...base, episodeCount: 3 }])).toEqual([]);
  });

  it('同ID私密更新整批拒绝，已有合法覆盖保持不变', async () => {
    const disk = new MemoryCacheDisk(), cache = new PublicCache(disk);
    const base = item('d_base', '连载', { episodeCount: 2 });
    await bundle(cache, 1, [base]);
    const online = { ...base, episodeCount: 3 };
    await cache.mergeDiscoveries([online]);
    for (const secret of [{ ...online, isPrivate: true }, { ...online, channelId: 'private' as const }]) {
      await expect(cache.mergeDiscoveries([item('d_extra'), secret])).rejects.toThrow();
      await expect(cache.applyDiscoveryChanges([{ workId: base.id, operation: 'upsert', card: secret }], 0)).rejects.toThrow();
    }
    const restored = new PublicCache(disk); await restored.hydrate();
    expect(restored.list()).toEqual([online]);
  });

  it('明确撤片删除发现；clearCache 清除全部发现磁盘与内存', async () => {
    const disk = new MemoryCacheDisk(), cache = new PublicCache(disk);
    await cache.mergeDiscoveries([item('d_new'), item('d_keep')]);
    await cache.applyChanges({ nextRevision: 2, hasMore: false, changes: [{ operation: 'delete', contentId: 'd_new', revision: 2 }] });
    const restored = new PublicCache(disk); await restored.hydrate();
    expect(restored.getItem('d_new')).toBeNull();
    expect(restored.getItem('d_keep')).not.toBeNull();
    await restored.clearCache();
    expect(restored.list()).toEqual([]);
    expect(await disk.list('cache/')).toEqual([]);
  });

  it('清缓存等待已提交的在线发现，不留残存文件或内存', async () => {
    const disk = new MemoryCacheDisk(), cache = new PublicCache(disk);
    const merging = cache.mergeDiscoveries([item('d_new')]);
    await cache.clearCache();
    await merging;
    expect(cache.list()).toEqual([]);
    expect(await disk.list('cache/')).toEqual([]);
  });

  it('私密标记与私密频道均拒绝，混合批次不留下半批公共记录', async () => {
    for (const privateItem of [item('d_secret', '秘密', { isPrivate: true }), item('d_secret', '秘密', { channelId: 'private' })]) {
      const disk = new MemoryCacheDisk(), cache = new PublicCache(disk);
      await expect(cache.mergeDiscoveries([item('d_ok'), privateItem])).rejects.toThrow();
      expect(cache.list()).toEqual([]);
      expect(await disk.list('cache/')).toEqual([]);
    }
  });

  it('落盘失败拒绝且不宣称保存，不更新内存或索引', async () => {
    const disk = new MemoryCacheDisk(), cache = new PublicCache(disk);
    const index = createSearchIndex({ sqlite: database() });
    await index.sync({ revision: 1, items: [] });
    vi.spyOn(disk, 'writeBatch').mockRejectedValue(new Error('disk full'));
    const api = createLocalSearchApi({ index, localItems: () => cache.list(),
      remote: { search: async () => ({ items: [{ item: item('d_new'), matchType: 'exact' }], page: 1 }), suggestions: async () => ({ query: '', suggestions: [] }) },
      onOnlineItems: async (items) => { await cache.mergeDiscoveries(items); await index.sync({ revision: cache.snapshotRevision(), items: [], discoveries: items }); }
    });
    await expect(api.searchOnline?.({ q: '发现' })).rejects.toThrow('disk full');
    expect(cache.list()).toEqual([]);
    expect(await index.search('发现')).toEqual([]);
  });
});

describe('搜索门面与真实 SQLite 分页', () => {
  it('clear 排在已提交的索引写入之后，不复活发现且归零状态', async () => {
    const index = createSearchIndex({ sqlite: database() });
    await index.sync({ revision: 7, items: [item('d_base')] });
    const queued = index.sync({ revision: 7, items: [], discoveries: [item('d_new')] });
    await index.clear();
    await queued;
    expect(await index.search('发现')).toEqual([]);
    expect(index.status()).toMatchObject({ docs: 0, revision: 0 });
  });

  it('在线公共结果持久合并并在相同目录 revision 增量喂索引，读取等待落地', async () => {
    const disk = new MemoryCacheDisk(), cache = new PublicCache(disk);
    await bundle(cache, 7, [item('d_base', '正式目录')]);
    const index = createSearchIndex({ sqlite: database() });
    await index.sync({ revision: 7, items: cache.list() });
    const remote = { search: vi.fn(async () => ({ items: [{ item: item('d_new'), matchType: 'exact' as const }, { item: item('p_secret', '秘密', { isPrivate: true }), matchType: 'exact' as const }], page: 1 })), suggestions: vi.fn(async () => ({ query: '', suggestions: [] })) };
    const api = createLocalSearchApi({ index, localItems: () => cache.list(), remote,
      onOnlineItems: async (items) => { await cache.mergeDiscoveries(items); void index.sync({ revision: cache.snapshotRevision(), items: [], discoveries: items }); }
    });
    expect((await api.searchOnline?.({ q: '发现' }))?.items.map((row) => row.item.id)).toEqual(['d_new']);
    expect((await api.search({ q: '发现' })).items.map((row) => row.item.id)).toEqual(['d_new']);
    const restored = new PublicCache(disk); await restored.hydrate();
    expect(restored.getItem('d_new')).not.toBeNull();
    expect(restored.getItem('p_secret')).toBeNull();
    expect(index.status().revision).toBe(7);
    expect(remote.search).toHaveBeenCalledTimes(1);
  });

  it('整包落地后按合并读面重建索引，补充发现仍可搜索', async () => {
    const cache = new PublicCache(new MemoryCacheDisk());
    const index = createSearchIndex({ sqlite: database() });
    await cache.mergeDiscoveries([item('d_new')]);
    await bundle(cache, 8, [item('d_base', '正式目录')]);
    await index.sync({ revision: cache.snapshotRevision(), items: cache.list() });
    const api = createLocalSearchApi({ index, localItems: () => cache.list() });
    expect((await api.search({ q: '发现' })).items.map((row) => row.item.id)).toEqual(['d_new']);
    await cache.clearCache(); await index.clear();
    expect((await api.search({ q: '发现' })).items).toEqual([]);
  });

  it('pageSize 默认20，第三页跨50，FTS召回跨120，末页 hasMore 为假', async () => {
    const items = Array.from({ length: 165 }, (_, at) => item(`d_${at}`, `剧目 ${at}`, { category: '都市' }));
    const index = createSearchIndex({ sqlite: database() });
    const pending = index.sync({ revision: 4, items });
    const api = createLocalSearchApi({ index, localItems: () => items });
    const pages = [];
    for (let page = 1; page <= 9; page += 1) pages.push(await api.search({ q: '都市', page }));
    await pending;
    expect(pages[0]?.items).toHaveLength(20);
    expect(pages[2]?.items).toHaveLength(20);
    expect(pages[7]?.items).toHaveLength(20);
    expect(pages[7]?.hasMore).toBe(true);
    expect(pages[8]?.items).toHaveLength(5);
    expect(pages[8]?.hasMore).toBe(false);
    expect(new Set(pages.flatMap((page) => page.items.map((row) => row.item.id))).size).toBe(165);
    expect(await index.search('剧目 0', 1)).toHaveLength(1);
  });

  it('无 SQLite 本地 search 立即空且不自动远端重复；suggestions 保留回落', async () => {
    const fail = async (): Promise<never> => { throw new Error('本机无端侧 SQLite'); };
    const index = createSearchIndex({ sqlite: { isConnected: async () => false, open: fail, close: fail, executeSet: fail, queryResult: fail } });
    const remote = { search: vi.fn(async () => ({ items: [], page: 1 })), suggestions: vi.fn(async () => ({ query: '发现', suggestions: [] })) };
    const api = createLocalSearchApi({ index, localItems: () => [], remote });
    expect(await api.search({ q: '发现' })).toMatchObject({ items: [], page: 1, hasMore: false });
    expect(remote.search).not.toHaveBeenCalled();
    await api.suggestions('发现');
    expect(remote.suggestions).toHaveBeenCalledTimes(1);
    await api.searchOnline?.({ q: '发现' });
    expect(remote.search).toHaveBeenCalledTimes(1);
  });
});
