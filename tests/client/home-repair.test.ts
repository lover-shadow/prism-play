// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHomeView, type HomeApi, type HomeViewDeps } from '../../src/views/home-view';
import { createRankingsRail, rankItems } from '../../src/views/rankings-rail';
import { weave, BLOCK_PATTERN } from '../../src/core/recommendation';
import { dispatchBackButtonForTest, getBackHandlerCountOf, registerBackHandler } from '../../src/core/native/back-button';
import { catalog, content, flush, TOPOLOGY, resetHomeFixtures } from './home-view-harness';

afterEach(() => { resetHomeFixtures(); vi.restoreAllMocks(); });
function setup(syncCatalog?: () => Promise<void>, onSearch?: () => void) {
  const scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  const root = document.createElement('div');
  scroller.append(root); document.body.append(scroller);
  const scrollTo = vi.fn(); scroller.scrollTo = scrollTo;
  const api = { channels: vi.fn(async () => ({ version: 1, channels: TOPOLOGY })),
    catalog: vi.fn(async (_input: Parameters<HomeApi['catalog']>[0]) => catalog([content('old', { hitsTotal: 10 })])),
    // HP-04：综合首页只读本机公开候选池；注入快照门面后，本文件的 catalog 调用计数仍只反映频道目录。
    cachedSnapshot: () => ({ channels: { version: 1, channels: TOPOLOGY }, items: (id: string) => id === 'private' ? [] : [content('old', { hitsTotal: 10 })] }) };
  const view = createHomeView({ api, root, syncCatalog, onSearch, posterMode: () => 'compact-3',
    onPosterModeChange: () => {}, onOpenTitle: () => {}, onResume: () => {}, historyPreview: async () => [] } as HomeViewDeps);
  const click = (selector: string) => root.querySelector<HTMLButtonElement>(selector)!.click();
  /** 本文件的用例都证频道目录与榜单语义：先点进 drama，再按既有的"重复点击"序列验（scrollTo 计数复位）。 */
  const enterDrama = async () => { click(drama); await flush(); scrollTo.mockClear(); };
  return { view, root, api, scrollTo, click, enterDrama };
}
const drama = '[data-channel-id="drama"]', movie = '[data-channel-id="movie"]';
const all = '[data-category="全部"]', urban = '[data-category="都市"]', war = '[data-category="战神"]';

describe('R26-07 repeat navigation', () => {
  it('first returns to actual scroller, second syncs then displays new page; repeated requests merge', async () => {
    let finish!: () => void;
    const sync = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const h = setup(sync); await h.view.mount(); await h.enterDrama();
    h.click(drama); expect(h.scrollTo).toHaveBeenCalledTimes(1); expect(sync).not.toHaveBeenCalled();
    h.click(drama); h.click(drama); h.click(drama);
    expect(sync).toHaveBeenCalledTimes(1);
    h.api.catalog.mockResolvedValue(catalog([content('new', { hitsTotal: 99 })]));
    finish(); await flush();
    expect(h.root.querySelector('.poster-card')?.getAttribute('data-content-id')).toBe('new');
    expect(h.api.catalog).toHaveBeenCalledTimes(2);
    h.click(drama); expect(sync).toHaveBeenCalledTimes(1);
    h.view.destroy();
  });
  it('category first/second works; interleaving target and search break sequence', async () => {
    const sync = vi.fn(async () => {}), search = vi.fn();
    const h = setup(sync, search); await h.view.mount(); await h.enterDrama();
    h.click(drama); h.click(all); h.click(drama); expect(sync).not.toHaveBeenCalled();
    h.root.querySelector<HTMLElement>('.home-search-bar')!.click();
    h.click(drama); expect(sync).not.toHaveBeenCalled();
    h.click(urban); await flush(); expect(h.api.catalog.mock.calls.at(-1)?.[0]).toMatchObject({ page: 1, category: '都市' });
    h.click(urban); expect(sync).not.toHaveBeenCalled(); h.click(urban); await flush();
    expect(sync).toHaveBeenCalledTimes(1);
    h.view.interruptNavigation(); h.click(urban); expect(sync).toHaveBeenCalledTimes(1);
    h.view.destroy();
  });
  it('failure is visible and resets repeat sequence, no automatic retry loop', async () => {
    const sync = vi.fn(() => { throw new Error('sync failed'); });
    const h = setup(sync); await h.view.mount(); await h.enterDrama(); h.click(drama); h.click(drama); await flush();
    expect(h.root.textContent).toContain('内容加载失败'); expect(sync).toHaveBeenCalledTimes(1);
    h.click(drama); expect(sync).toHaveBeenCalledTimes(1); h.click(drama); await flush();
    expect(sync).toHaveBeenCalledTimes(2); h.view.destroy();
  });
  it('channel switch invalidates pending refresh and late result after destroy', async () => {
    let finish!: () => void;
    const h = setup(() => new Promise<void>(resolve => { finish = resolve; })); await h.view.mount(); await h.enterDrama();
    h.click(drama); h.click(drama); h.click(movie); await flush();
    const count = h.api.catalog.mock.calls.length; finish(); await flush();
    expect(h.api.catalog).toHaveBeenCalledTimes(count);
    expect(h.root.querySelector('.channel-tab[aria-current]')?.getAttribute('data-channel-id')).toBe('movie');
    h.view.destroy(); expect(h.root.childElementCount).toBe(0);
  });
  it('duplicate-only advancing pages stop automatic pagination', async () => {
    const h = setup();
    h.api.catalog.mockImplementation(async input => catalog([content('same')], input.page, 100));
    await h.view.mount(); await h.enterDrama(); await flush();
    expect(h.api.catalog).toHaveBeenCalledTimes(2);
    h.view.loadMore(); await flush(); expect(h.api.catalog).toHaveBeenCalledTimes(2); h.view.destroy();
  });
  it('root itself can be the scroll container', async () => {
    const h = setup(); h.root.style.overflowY = 'auto'; h.root.scrollTo = vi.fn();
    await h.view.mount(); h.click(drama);
    expect(h.root.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    expect(h.scrollTo).not.toHaveBeenCalled(); h.view.destroy();
  });
  it('out-of-order category result and destroyed refresh never repaint', async () => {
    const h = setup(); await h.view.mount(); await h.enterDrama();
    let late!: (value: ReturnType<typeof catalog>) => void;
    h.api.catalog.mockImplementationOnce(() => new Promise(resolve => { late = resolve; }));
    h.click(urban); h.click('[data-category="战神"]'); await flush();
    late(catalog([content('stale')])); await flush();
    expect(h.root.querySelector('[data-content-id="stale"]')).toBeNull();
    let finish!: () => void;
    const other = setup(() => new Promise(resolve => { finish = resolve; })); await other.view.mount(); await other.enterDrama();
    other.click(drama); other.click(drama); other.view.destroy(); finish(); await flush();
    expect(other.root.childElementCount).toBe(0); expect(other.api.catalog).toHaveBeenCalledTimes(1);
    h.view.destroy();
  });
  it('without sync injection catalog API is still called, no repaint-only refresh', async () => {
    const h = setup(); await h.view.mount(); await h.enterDrama(); h.click(all); h.click(all); await flush();
    expect(h.api.catalog).toHaveBeenCalledTimes(2); h.view.destroy();
  });
});

describe('R26-08 truthful rankings', () => {
  it('uses finite nonnegative heat only and channel filter, excludes private, ID only ties', () => {
    const pool = [content('a', { hitsTotal: 2, isHot: true }), content('z', { hitsTotal: 20 }),
      content('missing'), content('neg', { hitsTotal: -1 }), content('nan', { hitsTotal: NaN }),
      content('other', { channelId: 'movie', hitsTotal: 100 }), content('private', { isPrivate: true, hitsTotal: 100 }),
      content('b', { hitsTotal: 2 })];
    expect(rankItems(pool, 'hot', 20, 'drama').map(x => x.id)).toEqual(['z', 'a', 'b']);
  });
  it('public channel top entry opens local hot list; private has no entry; search keeps three tabs', async () => {
    const h = setup(); await h.view.mount(); await h.enterDrama();
    const entry = h.root.querySelector<HTMLButtonElement>('[data-el="channel-hot-entry"]');
    expect(entry).not.toBeNull(); entry!.click();
    expect(h.root.textContent).toContain('累计热度'); expect(h.root.textContent).toContain('本机快照');
    expect(h.root.querySelectorAll('.rank-tab')).toHaveLength(0);
    h.api.channels.mockResolvedValue({ version: 2, channels: [...TOPOLOGY, { id: 'private', name: '个人探索', order: 5, categories: [], requiresTier: [] }] });
    await h.view.refresh(); h.click('[data-channel-id="private"]'); await flush();
    expect(h.root.querySelector('[data-el="channel-hot-entry"]')).toBeNull(); h.view.destroy();
    const root = document.createElement('div');
    const rail = createRankingsRail({ root, items: () => [], onOpenTitle: () => {} });
    expect(root.querySelectorAll('.rank-tab')).toHaveLength(3);
    expect(root.textContent).toContain('热度数据不足'); rail.destroy();
  });
  it('missing heat produces honest empty state with coverage, no made-up rank', () => {
    const root = document.createElement('div');
    const rail = createRankingsRail({ root, items: () => [content('x', { isHot: true })], onOpenTitle: () => {} });
    expect(root.querySelectorAll('.rank-row')).toHaveLength(0);
    expect(root.textContent).toContain('热度数据不足'); expect(root.textContent).toContain('本机快照'); rail.destroy();
  });
  it('channel ranking reads the whole cached channel, not category page or other channel', async () => {
    const h = setup();
    Object.assign(h.api, { cachedSnapshot: () => ({ channels: { version: 1, channels: TOPOLOGY },
      items: () => [content('cached', { category: '战神', hitsTotal: 500 }), content('foreign', { channelId: 'movie', hitsTotal: 999 })] }) });
    await h.view.mount(); await h.enterDrama();
    // HP-07a：榜面随当前二级分类收口，因此这里选中该缓存条目所在的分类；
    // 仍要证明的是**读面**＝完整缓存频道，而不是刚拉到的那一页目录，也不是别的频道。
    h.click(war); await flush();
    h.click('[data-el="channel-hot-entry"]');
    expect(h.root.querySelector('.rank-row')?.getAttribute('data-content-id')).toBe('cached');
    expect(h.root.querySelector('.rank-row[data-content-id="foreign"]')).toBeNull(); h.view.destroy();
  });
  it('home hot track follows heat while preserving quota and completed blocks on arbitrary append IDs', () => {
    const pool = Array.from({ length: 20 }, (_, i) => content(`x-${String(i).padStart(2, '0')}`, {
      isAi: i < 7, isHot: i >= 7 && i < 14, hitsTotal: i >= 7 && i < 14 ? i * 10 : undefined
    }));
    const first = weave(pool, {}, { preserveAppend: true });
    const hot = first.items.filter((_, i) => BLOCK_PATTERN[i] === 'H');
    expect(hot.map(x => x.hitsTotal)).toEqual([130, 120, 110, 100, 90, 80, 70]);
    expect(first.items.filter(x => x.isAi)).toHaveLength(7);
    expect(weave([...pool, content('aaa', { hitsTotal: 10000 })], {}, { preserveAppend: true }).items.slice(0, 20)).toEqual(first.items);
  });
});

const hotEntry = '[data-el="channel-hot-entry"]';
const panelOf = (root: HTMLElement): HTMLElement => root.querySelector<HTMLElement>('[data-el="rankings-host"]')!;
const hotOf = (root: HTMLElement): HTMLElement => root.querySelector<HTMLElement>(hotEntry)!;

describe('HP-02 热门榜返回层', () => {
  it('HP-02a 开榜注册唯一 layer：返回只关榜单、焦点还原、不增不减历史记录', async () => {
    const h = setup(); await h.view.mount(); await h.enterDrama();
    const base = getBackHandlerCountOf('layer');
    const entries = window.history.length;
    h.click(hotEntry);
    expect(panelOf(h.root).hidden).toBe(false);
    expect(hotOf(h.root).getAttribute('aria-expanded')).toBe('true');
    expect(getBackHandlerCountOf('layer')).toBe(base + 1);
    // 关了再开、连点都不叠加：同一张榜单在栈上只允许一条 handler
    h.click(hotEntry); h.click(hotEntry);
    expect(getBackHandlerCountOf('layer')).toBe(base + 1);
    expect(window.history.length).toBe(entries); // 榜单位于既有展开区，不占历史条目
    expect(await dispatchBackButtonForTest()).toBe(true);
    expect(panelOf(h.root).hidden).toBe(true);
    expect(hotOf(h.root).getAttribute('aria-expanded')).toBe('false');
    expect(getBackHandlerCountOf('layer')).toBe(base);
    expect(document.activeElement).toBe(hotOf(h.root)); // 焦点还给打开它的那颗按钮
    expect(window.history.length).toBe(entries);        // 未占条目也就无需弹历史
    h.view.destroy();
  });
  it('HP-02a 后开的搜索/播放器层优先消费，榜单不误抢也不被抢先关掉', async () => {
    const h = setup(); await h.view.mount(); await h.enterDrama();
    const base = getBackHandlerCountOf('layer');
    h.click(hotEntry);
    // 真实顺序：榜单先开、Overlay/播放器后开 —— 同层 LIFO 让高层先拿到返回
    const above: string[] = [];
    const release = registerBackHandler(() => { above.push('higher'); return true; }, 'layer');
    expect(await dispatchBackButtonForTest()).toBe(true);
    expect(above).toEqual(['higher']);
    expect(panelOf(h.root).hidden).toBe(false);
    expect(getBackHandlerCountOf('layer')).toBe(base + 2);
    release();
    expect(await dispatchBackButtonForTest()).toBe(true);
    expect(panelOf(h.root).hidden).toBe(true);
    expect(getBackHandlerCountOf('layer')).toBe(base);
    h.view.destroy();
  });
  it('HP-02b 切频道、离页、destroy 都把 layer 计数打回基线，旧榜单不再消费返回', async () => {
    const h = setup(); await h.view.mount(); await h.enterDrama();
    const base = getBackHandlerCountOf('layer');
    h.click(hotEntry); expect(getBackHandlerCountOf('layer')).toBe(base + 1);
    h.click(movie); await flush();
    expect(panelOf(h.root).hidden).toBe(true);
    expect(getBackHandlerCountOf('layer')).toBe(base);
    expect(await dispatchBackButtonForTest()).toBe(false); // 换频道后的返回不该被上一张榜吃掉

    h.click(hotEntry); expect(getBackHandlerCountOf('layer')).toBe(base + 1);
    h.root.hidden = true; // 外壳切 Tab 的真实机制：整个 `.app-view` 容器 hidden
    expect(await dispatchBackButtonForTest()).toBe(false);
    expect(panelOf(h.root).hidden).toBe(true);
    expect(getBackHandlerCountOf('layer')).toBe(base);
    h.root.hidden = false;

    h.click(hotEntry); expect(getBackHandlerCountOf('layer')).toBe(base + 1);
    h.view.destroy();
    expect(getBackHandlerCountOf('layer')).toBe(base);
    expect(await dispatchBackButtonForTest()).toBe(false);
  });
});
