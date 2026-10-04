// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { PrismApiClient } from '../../src/core/api/client';
import { createCatalogCacheService } from '../../src/core/catalog-cache';
import { parseCatalogBundle } from '../../src/core/catalog-bundle-loader';
import { MemoryCacheDisk, PublicCache } from '../../src/core/storage/public-cache';
import type { SnapshotFeed } from '../../src/core/storage/search-index';

const EDGE = 'https://catalog.example';
const item = (id: string) => ({ id, channelId: 'drama', title: id, category: '都市', isPrivate: false });
const channels = [{ id: 'drama', name: '短剧精选', order: 1, requiresTier: [], categories: ['都市'] }];
const bundle = (revision = 3) => ({ revision, version: 1, channels, items: [item('new-a'), item('new-b')], total: 2 });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
async function setup(asset: (url: string, init?: RequestInit) => Promise<Response>, partial = false) {
  const disk = new MemoryCacheDisk(), cache = new PublicCache(disk, undefined, partial ? 1 : undefined);
  await cache.importBundle(parseCatalogBundle({ ...bundle(2), items: [item('old')], total: 1 }));
  const network: string[] = [], assets: Array<{ url: string; init?: RequestInit }> = [], feeds: SnapshotFeed[] = [];
  const client = new PrismApiClient({ baseUrl: EDGE, fetchImpl: async (url) => {
    network.push(url);
    if (url.includes('/changes')) return json({ code: 'CATALOG_CURSOR_EXPIRED', message: 'full window exceeds 20 chunks' }, 410);
    if (url.includes('/channels')) return json({ version: 3, channels });
    const query = new URL(url).searchParams;
    return json({ revision: 3, page: 1, pageSize: 60, total: 1, items: [{ ...item('network'), channelId: query.get('channel'), isPrivate: query.get('channel') === 'private' }] });
  } });
  const service = createCatalogCacheService({ client, cache, baseUrl: `${EDGE}/api/`, onSnapshotEntries: (feed) => feeds.push(feed),
    fetchImpl: async (url, init) => { assets.push({ url, init }); return asset(url, init); } });
  return { service, cache, disk, network, assets, feeds };
}

describe('整包同步与公开 local-first', () => {
  it('seed revision 2 的 410 只请求一个 generation 3 整包，不请求拓扑或337页目录，并替换/喂索引', async () => {
    const h = await setup(async () => json(bundle()));
    expect(await h.service.syncIncremental()).toEqual({ appliedEntries: 2, revision: 3, full: true, offline: false });
    expect(h.network).toHaveLength(1);
    expect(h.network[0]).toContain('/api/catalog/changes?after=2');
    expect(h.assets).toEqual([{ url: `${EDGE}/assets/catalog-bundle.json`, init: { cache: 'no-store' } }]);
    expect(h.cache.list().map((entry) => entry.id)).toEqual(['new-a', 'new-b']);
    expect(h.feeds).toHaveLength(1);
    expect(h.feeds[0]).toMatchObject({ revision: 3, items: [item('new-a'), item('new-b')] });
    const restored = new PublicCache(h.disk); await restored.hydrate();
    expect(restored.list()).toEqual(h.cache.list());
  });
  it.each([500, 503, 403])('整包 HTTP %s 失败保留旧快照且不分页', async (status) => {
    const h = await setup(async () => json({}, status));
    const outcome = await h.service.syncIncremental();
    expect(outcome).toMatchObject({ appliedEntries: 0, revision: 2, full: true });
    expect(outcome.reason).toContain(`HTTP ${status}`);
    expect(h.cache.list()).toEqual([item('old')]);
    expect(h.network).toHaveLength(1); expect(h.feeds).toEqual([]);
  });
  it('明确404未部署才允许旧分页兜底', async () => {
    const h = await setup(async () => json({}, 404));
    expect(await h.service.resyncFull()).toMatchObject({ revision: 3, appliedEntries: 1 });
    expect(h.assets).toHaveLength(1);
    expect(h.network.map((url) => new URL(url).pathname)).toEqual(['/api/channels', '/api/catalog']);
  });
  it.each([
    { ...bundle(), items: [item('a'), { ...item('private-id'), isPrivate: true }] },
    { ...bundle(), items: [item('a'), { ...item('private-id'), channelId: 'private' }] },
    { ...bundle(), channels: [...channels, { ...channels[0], id: 'private' }] },
    { ...bundle(), items: [] },
    { ...bundle(), total: 3 },
    { ...bundle(), items: [item('a'), item('a')] },
    { ...bundle(), revision: 0 },
    { ...bundle(), revision: 1.5 },
    { ...bundle(), items: [{ ...item('a'), isPrivate: undefined }, item('b')] },
    { ...bundle(), items: [{ id: 'incomplete' }, item('b')] },
    { ...bundle(), channels: { version: 0, channels } }
  ])('非法或私密整包整单拒绝且旧拓扑/条目/字节不变 %#', async (bad) => {
    const h = await setup(async () => json(bad));
    const before = await h.disk.list('cache/');
    expect(await h.service.resyncFull()).toMatchObject({ revision: 2, appliedEntries: 0, reason: expect.stringContaining('整包校验失败') });
    expect(h.cache.list()).toEqual([item('old')]);
    expect(await h.disk.list('cache/')).toEqual(before);
    expect(h.network).toEqual([]); expect(h.feeds).toEqual([]);
  });
  it('传输失败与损坏JSON均不分页、不默默零条成功', async () => {
    for (const asset of [async () => { throw new Error('offline'); }, async () => new Response('{broken')]) {
      const h = await setup(asset);
      expect(await h.service.resyncFull()).toMatchObject({ revision: 2, appliedEntries: 0, reason: expect.any(String) });
      expect(h.cache.list()).toEqual([item('old')]); expect(h.network).toEqual([]);
    }
  });
  it('完整公开快照查询优先本地分页和分类，即使请求携带旧server游标；private仍网络', async () => {
    const h = await setup(async () => json(bundle()));
    await h.service.resyncFull();
    expect(await h.service.api.catalog({ channel: 'drama', page: 2, pageSize: 1, revision: 2 })).toMatchObject({ revision: 3, total: 2, items: [item('new-b')] });
    expect(await h.service.api.catalog({ channel: 'drama', category: '不存在', pageSize: 1 })).toMatchObject({ revision: 3, total: 0, items: [] });
    expect(h.network).toEqual([]);
    expect((await h.service.api.catalog({ channel: 'private' })).items[0]?.isPrivate).toBe(true);
    expect(h.network).toHaveLength(1);
    expect(h.cache.list()).toEqual([item('new-a'), item('new-b')]);
  });
  it('容量裁剪的partial快照不会冒充完整本地目录', async () => {
    const h = await setup(async () => json(bundle()), true);
    expect(h.cache.snapshotIsPartial()).toBe(true);
    expect((await h.service.api.catalog({ channel: 'drama' })).items[0]?.id).toBe('network');
    expect(h.network).toHaveLength(1);
  });
});
