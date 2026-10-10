// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentItem } from '../../edge/src/types/api';
import { createPosterGrid } from '../../src/components/poster-grid';
import { createHomeView } from '../../src/views/home-view';
import { createSearchOverlay } from '../../src/views/search-overlay';
import { createSeriesCard } from '../../src/views/series-card';
import { createHistoryView } from '../../src/views/history-view';
import { createRankingsRail } from '../../src/views/rankings-rail';
import { TOPOLOGY, historyRow } from './home-view-harness';

const item = (id = 'shown'): ContentItem => ({ id, title: '已显示标题', coverUrl: '/shown.jpg', synopsis: '已显示剧情', channelId: 'drama', category: '都市', isPrivate: false, hitsTotal: 100 });
const host = (): HTMLElement => { const root = document.createElement('div'); document.body.append(root); return root; };
const flush = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('W1 卡片已有数据交接', () => {
  it('网格真实点击交出渲染对象原引用，旧单参数回调仍可用', () => {
    const root = host(), shown = item(), open = vi.fn();
    const grid = createPosterGrid({ root, mode: () => 'compact-3', onOpenTitle: open });
    grid.render([shown]); root.querySelector<HTMLButtonElement>('.poster-open')!.click();
    expect(open).toHaveBeenCalledWith(shown.id, shown);
    expect(open.mock.calls[0][1]).toBe(shown);
    const legacy = vi.fn((id: string) => id);
    createPosterGrid({ root, mode: () => 'compact-3', onOpenTitle: legacy }).render([shown]);
    root.querySelector<HTMLButtonElement>('.poster-open')!.click();
    expect(legacy.mock.results[0].value).toBe(shown.id);
  });

  it('首页网格和频道榜单中间转发不丢真实对象', async () => {
    const root = host(), shown = item(), open = vi.fn();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const view = createHomeView({ root, api: {
      channels: async () => ({ version: 1, channels: TOPOLOGY }),
      catalog: async ({ channel }) => ({ items: channel === 'drama' ? [shown] : [], page: 1, pageSize: 60, total: channel === 'drama' ? 1 : 0, revision: 1 })
    }, posterMode: () => 'compact-3', onPosterModeChange: () => undefined, onOpenTitle: open, onResume: () => undefined, historyPreview: async () => [] });
    await view.mount();
    root.querySelector<HTMLButtonElement>('[data-channel-id="drama"]')!.click(); await flush();
    root.querySelector<HTMLButtonElement>('.poster-open')!.click();
    expect(open.mock.calls[0]).toEqual([shown.id, shown]); expect(open.mock.calls[0][1]).toBe(shown);
    root.querySelector<HTMLButtonElement>('[data-el="channel-hot-entry"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-el="rank-row"]')!.click();
    expect(open.mock.calls[1][1]).toBe(shown); view.destroy();
  });

  it('搜索结果关闭覆盖层后仍转发结果原引用而不是本地同ID缓存', async () => {
    const root = host(), shown = item(), cached = { ...shown, title: '另一缓存标题' };
    vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const open = vi.fn((_id: string, _item?: ContentItem) => { expect(overlay.isOpen()).toBe(false); expect(root.querySelector('[data-el="search-overlay"]')).toBeNull(); });
    const overlay = createSearchOverlay({ appRoot: root, localItems: () => [cached], hotWords: () => [], onOpenTitle: open, api: {
      search: async () => ({ items: [{ item: shown, matchType: 'exact' }], page: 1 }), suggestions: async () => ({ query: '', suggestions: [] })
    } });
    overlay.open(); root.querySelector('input')!.value = '标题';
    root.querySelector<HTMLButtonElement>('[data-el="search-submit"]')!.click(); await flush();
    root.querySelector<HTMLButtonElement>('[data-el="result-card"]')!.click();
    expect(open).toHaveBeenCalledWith(shown.id, shown); expect(open.mock.calls[0][1]).toBe(shown); overlay.destroy();
  });

  it('搜索空态榜单经视图和覆盖层转发真实对象并先关闭', () => {
    const root = host(), shown = item();
    vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const open = vi.fn((_id: string, _item?: ContentItem) => { expect(overlay.isOpen()).toBe(false); });
    const overlay = createSearchOverlay({ appRoot: root, localItems: () => [shown], hotWords: () => [], onOpenTitle: open,
      api: { search: async () => ({ items: [], page: 1 }), suggestions: async () => ({ query: '', suggestions: [] }) } });
    overlay.open(); root.querySelector<HTMLButtonElement>('[data-el="rank-row"]')!.click();
    expect(open).toHaveBeenCalledWith(shown.id, shown); expect(open.mock.calls[0][1]).toBe(shown); overlay.destroy();
  });

  it('系列默认选中和改选均交出选项对应真实对象', () => {
    const first = item('first'), second = item('second'), open = vi.fn();
    const root = createSeriesCard({ title: '系列', items: [first, second] }, () => document.createElement('button'), open);
    root.querySelector<HTMLButtonElement>('[data-el="series-open"]')!.click();
    expect(open).toHaveBeenCalledWith(first.id, first); expect(open.mock.calls[0][1]).toBe(first);
    root.querySelector('select')!.value = second.id; root.querySelector<HTMLButtonElement>('[data-el="series-open"]')!.click();
    expect(open.mock.calls[1][1]).toBe(second);
  });

  it('搜索榜单交接的是渲染时对象，不重读更新的数据源', () => {
    const root = host(), shown = item(), open = vi.fn(); let source = [shown];
    const rail = createRankingsRail({ root, items: () => source, onOpenTitle: open });
    source = [{ ...shown, title: '后来的缓存' }]; root.querySelector<HTMLButtonElement>('[data-el="rank-row"]')!.click();
    expect(open.mock.calls[0][1]).toBe(shown); rail.destroy();
  });

  it('历史推荐交出ContentItem，历史记录详情仅交ID不捏造对象', async () => {
    const root = host(), shown = item(), open = vi.fn();
    const row = historyRow('history', { last_episode_number: 1, total_episodes: 1, position_seconds: 135, duration_seconds: 135 });
    const view = createHistoryView({ root, api: { related: async () => ({ items: [shown] }) }, history: { list: async () => [row], clear: async () => undefined },
      credentials: { readGrant: async () => null, clearGrant: async () => undefined }, onOpenTitle: open, onResume: () => undefined });
    await view.mount(); root.querySelector<HTMLButtonElement>('[data-el="related-card"]')!.click();
    expect(open.mock.calls[0][1]).toBe(shown);
    root.querySelector<HTMLElement>('[data-el="finished-row"]')!.querySelectorAll<HTMLButtonElement>('button')[1].click();
    expect(open.mock.calls[1]).toEqual([row.content_id]); view.destroy();
  });
});
