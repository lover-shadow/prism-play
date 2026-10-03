// @vitest-environment jsdom
/**
 * A-6 接线验收：`commitSnapshot → 索引 → 视图`这条数据流（§A-6.2 / §A-6.4；AC-A6-1/2/3）。
 * 三段都用真实件：公开缓存域用真 `PublicCache + MemoryCacheDisk`，索引用真 `node:sqlite`，视图用真 DOM，
 * 只有网络侧是脚本化 fetch——所以"断网零请求"与"本机没有 SQLite 才回落云端"是被证出来的，不是被断言出来的。
 */
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { CatalogChangesResponse, CatalogResponse, ChannelItem, ChannelsResponse, ContentItem, SearchResult, SearchSuggestion } from '../../edge/src/types/api';
import { PrismApiClient } from '../../src/core/api/client';
import { createCatalogCacheService } from '../../src/core/catalog-cache';
import { createLocalSearchApi, createSearchIndex } from '../../src/core/storage';
import { MemoryCacheDisk, PublicCache } from '../../src/core/storage/public-cache';
import type { SearchIndex, SnapshotFeed, SqliteLike } from '../../src/core/storage/search-index';
import { createSearchView, type SearchApi } from '../../src/views/search-view';

const EDGE = 'https://play.prismos.org';
const requireFromHere = createRequire(import.meta.url);
const loaded = requireFromHere('node:sqlite') as { DatabaseSync: typeof DatabaseSync };
const item = (id: string, title: string, over: Partial<ContentItem> = {}): ContentItem =>
  ({ id, channelId: 'drama', title, category: '都市', isPrivate: false, synopsis: '', ...over } as ContentItem);
const CORPUS: ContentItem[] = [item('d_longwang', '战神之龙王归来'), item('d_changan', '长安十二时辰', { category: '古装' }), item('d_niangzi', '甜宠小娘子', { category: '甜宠' })];
const topology = (ids: string[] = ['drama']): ChannelsResponse =>
  ({ version: 1, channels: ids.map((id, order) => ({ id, name: `频道${id}`, order, requiresTier: [], categories: ['都市'] } as ChannelItem)) });
const catalogPage = (channelId: ContentItem['channelId'], items: ContentItem[], revision: number): CatalogResponse =>
  ({ items: items.map((entry) => ({ ...entry, channelId })), page: 1, pageSize: items.length, total: items.length, revision });
const changesAt = (nextRevision: number, entry: CatalogChangesResponse['changes'][number]): CatalogChangesResponse =>
  ({ nextRevision, hasMore: false, changes: [entry] });
const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function sqliteOf(db: DatabaseSync): SqliteLike {
  let opened = false;
  return {
    isConnected: async () => opened,
    open: async () => void (opened = true),
    close: async () => void (opened = false),
    executeSet: async (_database, set, transaction) => {
      if (transaction) db.exec('BEGIN');
      try {
        for (const statement of set) db.prepare(statement.statement).run(...statement.values);
        if (transaction) db.exec('COMMIT');
      } catch (error) {
        if (transaction) db.exec('ROLLBACK');
        throw error;
      }
    },
    queryResult: async (_database, statement, values) => db.prepare(statement).all(...values).map((row) => ({ ...row })) as never
  };
}
/** 网络侧脚本：按 pathname 路由并记录请求序列，用来证明某些路径上"一个请求都没发"。 */
function server(routes: Record<string, () => Response>) {
  const seen: string[] = [];
  const client = new PrismApiClient({ baseUrl: EDGE, fetchImpl: async (input: string) => {
    const url = new URL(input, EDGE);
    seen.push(`${url.pathname}${url.search}`);
    const handler = routes[url.pathname];
    if (handler === undefined) throw new TypeError('设备已离线');
    return handler();
  } });
  return { client, seen };
}
const newCache = (): PublicCache => new PublicCache(new MemoryCacheDisk());
/** 真机上取不到 SQLite 插件时的形态（与 `platform-adapters.ts` 的 unavailableSqlite 同款拒绝）。 */
function deadSqlite(message = '本机无端侧 SQLite：追剧历史需 Android 宿主'): SqliteLike {
  const refuse = async (): Promise<never> => { throw new Error(message); };
  return { isConnected: async () => false, open: refuse, close: async () => undefined, executeSet: refuse, queryResult: refuse };
}
async function seeded(items: readonly ContentItem[], revision = 7): Promise<SearchIndex> {
  const index = createSearchIndex({ sqlite: sqliteOf(new loaded.DatabaseSync(':memory:')) });
  await index.sync({ items, revision });
  return index;
}
const apiOf = (index: SearchIndex, items: readonly ContentItem[], remote?: SearchApi): SearchApi =>
  createLocalSearchApi({ index, localItems: () => items, ...(remote === undefined ? {} : { remote }) });

describe('§A-6.2 数据流：快照与增量批次落地即建索引', () => {
  it('commitSnapshot 成功后本批公开条目进索引；增量批次的新剧立刻可搜', async () => {
    const cache = newCache();
    const index = createSearchIndex({ sqlite: sqliteOf(new loaded.DatabaseSync(':memory:')) });
    const feeds: SnapshotFeed[] = [];
    const full = server({ '/api/channels': () => ok(topology()), '/api/catalog': () => ok(catalogPage('drama', CORPUS, 9)) });
    const service = createCatalogCacheService({
      client: full.client, cache, pageSize: 3,
      onSnapshotEntries: (feed) => { feeds.push(feed); void index.sync(feed); }
    });
    expect(await service.resyncFull()).toMatchObject({ revision: 9, full: true, offline: false });
    await vi.waitFor(() => expect(index.status()).toMatchObject({ available: true, docs: CORPUS.length, revision: 9 }));
    expect(feeds[0]).toMatchObject({ revision: 9 });
    expect(feeds[0]?.changes).toBeUndefined();
    expect(feeds[0]?.items.map((entry) => entry.id)).toEqual(CORPUS.map((entry) => entry.id));
    expect((await index.search('甜宠')).map((hit) => hit.contentId)).toEqual(['d_niangzi']);

    const incoming = changesAt(10, { revision: 10, contentId: 'd_new', operation: 'upsert', item: item('d_new', '逆袭之路') });
    const inc = server({ '/api/catalog/changes': () => ok(incoming) });
    const second = createCatalogCacheService({ client: inc.client, cache, pageSize: 3, onSnapshotEntries: (feed) => { feeds.push(feed); void index.sync(feed); } });
    expect(await second.syncIncremental()).toMatchObject({ revision: 10, full: false });
    await vi.waitFor(() => expect(index.status().revision).toBe(10));
    expect((await index.search('逆袭')).map((hit) => hit.contentId)).toEqual(['d_new']);
    expect(feeds[feeds.length - 1]).toMatchObject({ revision: 10 });
    expect(feeds[feeds.length - 1]?.changes).toHaveLength(1);
    expect([...full.seen, ...inc.seen].filter((path) => path.startsWith('/api/search'))).toEqual([]);
  });

  it('索引侧抛错不改写落盘结论：目录同步照常成功，条目照常可读', async () => {
    const cache = newCache();
    const service = createCatalogCacheService({
      client: server({ '/api/channels': () => ok(topology()), '/api/catalog': () => ok(catalogPage('drama', CORPUS, 9)) }).client,
      cache, pageSize: 3, onSnapshotEntries: () => { throw new Error('索引写盘失败'); }
    });
    expect(await service.resyncFull()).toMatchObject({ revision: 9, offline: false });
    expect(cache.list()).toHaveLength(CORPUS.length);
  });

  it('系统 SQLite 不带 fts5 模块时也只记账不拖垮：状态如实回报，检索回落云端', async () => {
    const index = createSearchIndex({ sqlite: deadSqlite('no such module: fts5') });
    expect(await index.sync({ items: CORPUS, revision: 9 })).toMatchObject({ indexed: 0, error: 'no such module: fts5' });
    expect(index.status().available).toBe(false);
    expect(await index.search('战神')).toEqual([]);
  });
});

describe('§A-6.4 门面：本机优先、默认零请求、能力缺席才回落', () => {
  const remoteStub = (items: SearchResult[], suggestions: SearchSuggestion[] = []): { client: PrismApiClient; seen: string[] } =>
    server({ '/api/search': () => ok({ items, page: 1 }), '/api/search/suggestions': () => ok({ query: '', suggestions }) });

  it('本机命中时一次请求都不发，结果自带命中类型', async () => {
    const remote = remoteStub([]);
    const api = apiOf(await seeded(CORPUS), CORPUS, remote.client);
    expect(api.localFirst).toBe(true);
    // `古装` 只存在于分类列：它落到 related 档，才证明优先级是真按列分档而不是全库模糊匹配。
    expect((await api.search({ q: '古装' })).items.map((entry) => [entry.item.id, entry.matchType])).toEqual([['d_changan', 'related']]);
    expect((await api.search({ q: '甜宠' })).items.map((entry) => entry.matchType)).toEqual(['exact']);
    // 首字母补全跟着真正的拼音命中走：`zszl` 是 战(z)神(s)之(z)龙(l) 的首字母前缀。
    const suggestions = await api.suggestions('zszl');
    expect(suggestions.suggestions.map((entry) => entry.type)).toEqual(['title', 'pinyin', 'category']);
    expect(suggestions.suggestions[0]).toMatchObject({ text: '战神之龙王归来', contentId: 'd_longwang' });
    expect(suggestions.suggestions[1]).toMatchObject({ text: 'zszlwgl', type: 'pinyin' });
    expect(remote.seen).toEqual([]);
  });

  it('本机没命中就是空：不拿云端猜第二次；联网补充只在用户点下去时才发请求', async () => {
    const remote = remoteStub([{ item: CORPUS[1] as ContentItem, matchType: 'exact' }]);
    const api = apiOf(await seeded(CORPUS), CORPUS, remote.client);
    expect((await api.search({ q: '不存在词' })).items).toEqual([]);
    expect(remote.seen).toEqual([]);
    expect((await api.searchOnline?.({ q: '不存在词' }))?.items.map((entry) => entry.item.id)).toEqual(['d_changan']);
    expect(remote.seen).toEqual(['/api/search?q=%E4%B8%8D%E5%AD%98%E5%9C%A8%E8%AF%8D']);
  });

  it('本机没有可用索引（Web 宿主无 SQLite）才如实回落云端检索', async () => {
    const remote = remoteStub([{ item: CORPUS[0] as ContentItem, matchType: 'exact' }], [{ text: '战神之龙王归来', type: 'title' }]);
    const api = apiOf(createSearchIndex({ sqlite: deadSqlite() }), CORPUS, remote.client);
    expect((await api.search({ q: '战神' })).items.map((entry) => entry.item.id)).toEqual(['d_longwang']);
    expect((await api.suggestions('战神')).suggestions.map((entry) => entry.text)).toEqual(['战神之龙王归来']);
    expect(remote.seen).toHaveLength(2);
  });

  it('快照已下架的条目即刻消失：索引只是候选源，条目本体一律以快照为准', async () => {
    const api = apiOf(await seeded(CORPUS), [CORPUS[0] as ContentItem]);
    expect((await api.search({ q: '甜宠' })).items).toEqual([]);
    expect((await api.search({ q: '战神' })).items.map((entry) => entry.item.id)).toEqual(['d_longwang']);
  });

  it('私密条目即便混进快照也不渲染：门面再挡一道（AC-02-3 端侧兜底）', async () => {
    const secret = item('p_secret', '深夜私语的秘密', { channelId: 'private', isPrivate: true });
    const api = apiOf(await seeded([secret]), [secret]);
    expect((await api.search({ q: '深夜' })).items).toEqual([]);
  });
});

describe('视图：本机检索的措辞与联网补充按钮（AC-A6-1/2）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  let host: HTMLElement = document.createElement('div');
  const input = (): HTMLInputElement => host.querySelector<HTMLInputElement>('[data-el="search-input"]') as HTMLInputElement;
  const click = (el: string): void => { (host.querySelector(`[data-el="${el}"]`) as HTMLElement).click(); };

  async function mount(api: SearchApi): Promise<{ view: ReturnType<typeof createSearchView>; opened: string[] }> {
    host = document.createElement('div');
    document.body.replaceChildren(host);
    const opened: string[] = [];
    const view = createSearchView({ api, root: host, onOpenTitle: (contentId) => void opened.push(contentId) });
    await view.mount();
    return { view, opened };
  }
  function typeAt(value: string): void {
    input().value = value;
    input().dispatchEvent(new Event('input', { bubbles: true }));
  }

  it('本机优先：补全与结果都写明是本机目录，点结果卡片直接起播', async () => {
    const api = apiOf(await seeded(CORPUS), CORPUS);
    const { view, opened } = await mount(api);
    typeAt('甜宠');
    expect(host.textContent).toContain('本机目录中补全');
    expect(host.textContent).not.toContain('正在获取词法补全');
    await vi.advanceTimersByTimeAsync(260);
    expect(host.querySelectorAll('[data-el="suggest-item"]').length).toBeGreaterThan(0);
    click('search-submit');
    expect(host.textContent).toContain('正在检索本机公开目录');
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelectorAll('[data-el="result-card"]').length).toBe(1);
    expect(host.textContent).not.toContain('词法检索需联网');
    expect(host.innerHTML).not.toContain('个人探索');
    (host.querySelector('[data-el="result-card"]') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(opened).toEqual(['d_niangzi']);
    view.destroy();
  });

  it('零结果显示「本机未命中」与可点的联网补充；不点就一次请求都不发', async () => {
    const remote = server({ '/api/search': () => ok({ items: [{ item: CORPUS[1] as ContentItem, matchType: 'exact' }], page: 1 }) });
    const api = apiOf(await seeded(CORPUS), CORPUS, remote.client);
    const { view, opened } = await mount(api);
    typeAt('不存在词');
    await vi.advanceTimersByTimeAsync(260);
    click('search-submit');
    await vi.advanceTimersByTimeAsync(0);
    expect(host.textContent).toContain('本机公开目录未命中');
    expect(remote.seen).toEqual([]);
    click('search-online');
    await vi.advanceTimersByTimeAsync(0);
    expect(remote.seen).toHaveLength(1);
    expect(host.querySelectorAll('[data-el="result-card"]').length).toBe(1);
    (host.querySelector('[data-el="result-card"]') as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(opened).toEqual(['d_changan']);
    view.destroy();
  });

  it('没接本机索引的宿主保持原样：没有补充按钮，也不冒充断网可用', async () => {
    const plain: SearchApi = { search: async () => ({ items: [], page: 1 }), suggestions: async () => ({ query: '', suggestions: [] }) };
    const { view } = await mount(plain);
    typeAt('战神');
    await vi.advanceTimersByTimeAsync(260);
    click('search-submit');
    await vi.advanceTimersByTimeAsync(0);
    expect(host.querySelector('[data-el="search-online"]')).toBeNull();
    expect(host.textContent).toContain('没有找到匹配的公开剧目');
    expect(host.textContent).not.toContain('本机');
    view.destroy();
  });
});
