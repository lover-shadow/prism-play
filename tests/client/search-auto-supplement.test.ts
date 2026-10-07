// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentItem, SearchResponse } from '../../edge/src/types/api';
import { createSearchView, type SearchApi } from '../../src/views/search-view';

type Page = SearchResponse & { hasMore?: boolean };
const entry = (id: string, title = id, extra: Partial<ContentItem> = {}) => ({
  item: { id, title, channelId: 'drama', category: '都市', isPrivate: false, ...extra } as ContentItem,
  matchType: 'fuzzy' as const
});
const page = (ids: string[], hasMore?: boolean): Page => ({ items: ids.map((id) => entry(id)), page: 1, ...(hasMore === undefined ? {} : { hasMore }) });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const views: ReturnType<typeof createSearchView>[] = [];
afterEach(() => { views.splice(0).forEach((view) => view.destroy()); document.body.replaceChildren(); });
async function setup(search: SearchApi['search'], searchOnline?: SearchApi['searchOnline']) {
  const root = document.createElement('div');
  document.body.append(root);
  const opened = vi.fn();
  const view = createSearchView({ root, api: { localFirst: true, search, searchOnline, suggestions: async (q) => ({ query: q, suggestions: [] }) }, onOpenTitle: opened });
  views.push(view);
  await view.mount();
  const submit = (q: string) => {
    const input = root.querySelector<HTMLInputElement>('input')!;
    input.value = q;
    input.dispatchEvent(new Event('input'));
    root.querySelector<HTMLButtonElement>('[data-el="search-submit"]')!.click();
  };
  const cards = () => [...root.querySelectorAll<HTMLButtonElement>('[data-el="result-card"]')];
  const more = () => root.querySelector<HTMLButtonElement>('[data-el="search-more"]');
  return { root, submit, cards, more, opened, view };
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe('搜索自动补充与逐页纵向结果', () => {
  it('本机已有命中立即显示，同时自动补充，按 contentId 去重且云端补充更新元数据', async () => {
    const cloud = deferred<Page>();
    const online = vi.fn(() => cloud.promise);
    const local = vi.fn(async () => ({ items: [entry('same', '本地标题')], page: 1, hasMore: false }));
    const s = await setup(local, online);
    s.submit('标题');
    await flush();
    expect(local).toHaveBeenCalledWith({ q: '标题', page: 1, pageSize: 20 });
    expect(online).toHaveBeenCalledWith({ q: '标题', page: 1, pageSize: 20 });
    expect(s.cards().map((card) => card.dataset.contentId)).toEqual(['same']);
    expect(s.root.textContent).toContain('补充中');
    expect(s.root.querySelector('[data-el="search-online"]')).toBeNull();
    cloud.resolve({ items: [entry('same', '云端标题'), entry('new')], page: 1, hasMore: false });
    await flush();
    expect(s.cards()).toHaveLength(2);
    expect(s.cards()[0].textContent).toContain('云端标题');
    expect(s.root.textContent).not.toContain('本地标题');
  });

  it('云端先返回、本机后返回不会覆盖云端更新', async () => {
    const local = deferred<Page>();
    const s = await setup(() => local.promise, async () => ({ items: [entry('same', '云端')], page: 1 }));
    s.submit('词');
    await flush();
    expect(s.cards()).toHaveLength(1);
    local.resolve({ items: [entry('same', '本机')], page: 1 });
    await flush();
    expect(s.cards()).toHaveLength(1);
    expect(s.cards()[0].textContent).toContain('云端');
  });

  it('联网失败保留成功结果，加载更多重试不跳过失败页', async () => {
    const online = vi.fn().mockRejectedValueOnce(new Error('断线')).mockResolvedValueOnce(page(['cloud'], false));
    const s = await setup(async () => page(['local'], false), online);
    s.submit('词');
    await flush();
    expect(s.cards()).toHaveLength(1);
    expect(s.root.textContent).toContain('断线');
    expect(s.more()?.textContent).toContain('重试');
    s.more()!.click();
    await flush();
    expect(online.mock.calls[1][0]).toEqual({ q: '词', page: 1, pageSize: 20 });
    expect(s.cards()).toHaveLength(2);
  });

  it('切词后旧本机、联网、分页响应都不能混入新结果', async () => {
    const oldLocal = deferred<Page>();
    const oldCloud = deferred<Page>();
    const nextPage = deferred<Page>();
    const s = await setup(({ q, page: p }) => q === '旧' ? oldLocal.promise : p === 2 ? nextPage.promise : Promise.resolve(page(['new'], true)),
      ({ q }) => q === '旧' ? oldCloud.promise : Promise.resolve(page([], false)));
    s.submit('旧');
    s.submit('新');
    await flush();
    s.more()!.click();
    s.submit('最新');
    await flush();
    oldLocal.resolve(page(['old-local'])); oldCloud.resolve(page(['old-cloud'])); nextPage.resolve(page(['old-page']));
    await flush();
    expect(s.cards().map((card) => card.dataset.contentId)).toEqual(['new']);
  });

  it('hasMore 优先于满页判断，不自动取全部；加载更多是可聚焦按钮并保持焦点', async () => {
    const local = vi.fn(async ({ page: p }) => ({ ...page(p === 1 ? ['one'] : ['two'], p === 1), page: p! }));
    const online = vi.fn(async () => page(Array.from({ length: 20 }, (_, i) => `cloud-${i}`), false));
    const s = await setup(local, online);
    s.submit('词'); await flush();
    expect(local).toHaveBeenCalledTimes(1); expect(online).toHaveBeenCalledTimes(1);
    const more = s.more()!;
    expect(more.type).toBe('button'); more.focus(); more.click(); more.click(); await flush();
    expect(local).toHaveBeenCalledTimes(2); expect(online).toHaveBeenCalledTimes(1);
    expect(local.mock.calls[1][0]).toEqual({ q: '词', page: 2, pageSize: 20 });
    expect(s.cards()).toHaveLength(22); expect(s.more()).toBeNull();
    expect(s.root.contains(document.activeElement)).toBe(true);
    expect(s.root.querySelector('[data-el="search-results"] .pv-rail')).toBeNull();
    expect(s.root.querySelectorAll('.srch-results-grid').length).toBeGreaterThan(0);
    s.cards()[0].click(); expect(s.opened).toHaveBeenCalledOnce();
    expect(readFileSync(resolve(process.cwd(), 'src/views/views.css'), 'utf8')).toMatch(/\.srch-results-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  });

  it('hasMore 缺席按原始20满页判断，过滤私密与去重不改变分页判断', async () => {
    const items = [entry('public'), ...Array.from({ length: 19 }, (_, i) => entry(`private-${i}`, '隐藏', { isPrivate: true }))];
    const local = vi.fn(async ({ page: p }) => p === 1 ? { items, page: 1 } : page([]));
    const s = await setup(local);
    s.submit('词'); await flush();
    expect(s.cards()).toHaveLength(1); expect(s.root.textContent).not.toContain('隐藏');
    s.more()!.click(); await flush();
    expect(local.mock.calls[1][0].page).toBe(2); expect(s.more()).toBeNull();
  });

  it('本地空、补充中、联网空分别提示；本地简介与云端纠错不混淆', async () => {
    const cloud = deferred<Page>();
    const s = await setup(async () => page([], false), () => cloud.promise);
    s.submit('词'); await flush();
    expect(s.root.textContent).toContain('本机公开目录未命中'); expect(s.root.textContent).toContain('补充中');
    cloud.resolve(page([], false)); await flush();
    expect(s.root.textContent).toContain('联网目录未命中');
    const labels = await setup(async () => ({ items: [entry('synopsis', '其他', { synopsis: '包含关键词' }), entry('title', '关键词之旅')], page: 1 }),
      async () => ({ items: [entry('correction', '纠正后的剧名')], page: 1 }));
    labels.submit('关键词'); await flush();
    expect(labels.cards().find((card) => card.dataset.contentId === 'synopsis')?.textContent).toContain('简介关键词命中');
    expect(labels.cards().find((card) => card.dataset.contentId === 'title')?.textContent).toContain('剧名关键词命中');
    expect(labels.cards().find((card) => card.dataset.contentId === 'correction')?.textContent).toContain('模糊或纠错命中');
  });

  it('本地失败不能清掉先成功的联网结果，销毁后响应不重建DOM', async () => {
    const local = deferred<Page>();
    const s = await setup(() => local.promise, async () => page(['cloud'], false));
    s.submit('词'); await flush();
    local.reject(new Error('本机失败')); await flush();
    expect(s.cards()).toHaveLength(1); expect(s.root.textContent).toContain('本机失败');
    const pending = deferred<Page>();
    const destroyed = await setup(() => pending.promise);
    destroyed.submit('词'); destroyed.view.destroy(); pending.resolve(page(['late'])); await flush();
    expect(destroyed.root.childElementCount).toBe(0);
  });
});
