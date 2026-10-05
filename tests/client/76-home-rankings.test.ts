// @vitest-environment jsdom
/**
 * HP-07 频道＋二级分类热门榜（HOME-PLAYER-REPAIR-SPEC-AND-PLAN §HP-07 / §3.2 公平热度条 / §5.1 HP-07a·HP-07b）。
 * 榜单仍在既有就地展开区（HP-02 的返回层不受影响）；热度口径与跨源可比性是待证参数，只在单处定义。
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelId, ContentItem } from '../../edge/src/types/api';
import { createRankingsRail, RANKING_LIMIT, rankItems } from '../../src/views/rankings-rail';
import { coverageOf, fairRank, rankWindow, scopeCandidates } from '../../src/views/home-rank-scope';
import { getBackHandlerCountOf } from '../../src/core/native/back-button';
import { item as raw, pool } from './home-composite-harness';
import { flush as micro, mountHome } from './home-refresh-harness';

const drama = '[data-nav-id="drama"]', movie = '[data-nav-id="movie"]';
const reverse = '[data-category="逆袭"]', war = '[data-category="战神"]', hotEntry = '[data-el="channel-hot-entry"]';
const panelOf = (root: HTMLElement): HTMLElement | null => root.querySelector<HTMLElement>('[data-el="rankings-host"]');
const rows = (root: HTMLElement): string[] => Array.from(root.querySelectorAll<HTMLElement>('.rank-row'))
  .map((row) => row.dataset.contentId ?? '');
const textOf = (root: HTMLElement, el: string): string => root.querySelector<HTMLElement>(`[data-el="${el}"]`)?.textContent ?? '';
const item = (id: string, channelId: string, overrides: Partial<ContentItem> = {}): ContentItem =>
  raw(id, channelId as ChannelId, { category: '都市', ...overrides });

/** 构造"分类候选落在频道总榜 20 名以外"的夹具：先截总榜再过滤必然整个丢掉该分类。 */
function beyondTopTwenty(): ContentItem[] {
  const city = Array.from({ length: 20 }, (_, index) => item(`city-${index}`, 'drama', { category: '都市', hitsTotal: 1_000 - index }));
  const reversed = [item('rev-a', 'drama', { category: '逆袭', hitsTotal: 500 }),
    item('rev-b', 'drama', { category: '逆袭', hitsTotal: 400 }), item('rev-c', 'drama', { category: '逆袭', hitsTotal: 300 })];
  return [...city, ...reversed];
}

function railOf(items: readonly ContentItem[], over: { channel?: string; category?: string } = {}) {
  const root = document.createElement('div');
  document.body.append(root);
  const rail = createRankingsRail({
    root, items: () => items, onOpenTitle: () => undefined,
    ...(over.channel === undefined ? {} : { channel: () => over.channel ?? null }),
    ...(over.category === undefined ? {} : { category: () => over.category ?? '全部' }),
    channelName: () => (over.channel === 'drama' ? '精彩短剧' : over.channel === 'movie' ? '电影仓库' : null)
  });
  return { root, rail };
}

afterEach(() => { document.body.replaceChildren(); });

describe('HP-07a 先筛完整候选，再排序，最后截断', () => {
  it('HP-07a 分类候选在频道总榜 20 名以外时仍完整上榜，不是过滤总榜前 20', () => {
    const items = beyondTopTwenty();
    expect(rankItems(items, 'hot', RANKING_LIMIT, 'drama').some((entry) => entry.id.startsWith('rev-'))).toBe(false);
    expect(scopeCandidates(items, { channel: 'drama', category: '逆袭' })).toHaveLength(3);
    expect(rankWindow(items, 'hot', RANKING_LIMIT, { channel: 'drama', category: '逆袭' }).map((entry) => entry.id))
      .toEqual(['rev-a', 'rev-b', 'rev-c']);
    const { root } = railOf(items, { channel: 'drama', category: '逆袭' });
    expect(rows(root)).toEqual(['rev-a', 'rev-b', 'rev-c']);
    expect(textOf(root, 'rankings-title')).toContain('逆袭');
    root.remove();
  });

  it('HP-07a 全部＋热门榜＝频道总榜；切分类保留开榜状态并即时更新标题、范围与排名', async () => {
    // 逆袭榜的两部作品热度都排在频道总榜 20 名以外：先截总榜再过滤就会整个丢掉这个分类。
    const items = [...pool().filter((entry) => entry.channelId === 'drama'),
      item('rev-a', 'drama', { category: '逆袭', hitsTotal: 400 }), item('rev-b', 'drama', { category: '逆袭', hitsTotal: 300 })];
    const h = mountHome({ items });
    await h.view.mount(); await micro();
    h.click(drama); await micro();
    const base = getBackHandlerCountOf('layer');
    h.click(hotEntry);
    expect(panelOf(h.root)?.hidden).toBe(false);
    expect(rows(h.root)).toHaveLength(RANKING_LIMIT);                      // 频道总榜照常只给 20 名
    expect(rows(h.root)[0]).toBe('live-01');                                // 「全部」＝本频道总榜热度首位
    expect(rows(h.root).filter((id) => id.startsWith('rev-'))).toEqual([]);  // 这两个分类作品在 20 名以外
    expect(textOf(h.root, 'rankings-title')).toContain('全部');
    h.click(reverse); await micro();
    expect(panelOf(h.root)?.hidden).toBe(false);                           // 切分类不关榜
    expect(h.root.querySelector<HTMLElement>(hotEntry)?.getAttribute('aria-expanded')).toBe('true');
    expect(getBackHandlerCountOf('layer')).toBe(base + 1);                 // 返回层仍只有一条
    expect(textOf(h.root, 'rankings-title')).toContain('逆袭');
    expect(rows(h.root)).toEqual(['rev-a', 'rev-b']);                       // 排名即时按新范围重算
    expect(panelOf(h.root)?.querySelector<HTMLElement>('.rank-row')?.dataset.rank).toBe('1');
    h.click(war); await micro();
    expect(rows(h.root).length).toBeGreaterThan(0);                         // 战神分类另有自己的完整候选
    expect(rows(h.root).every((id) => !id.startsWith('rev-'))).toBe(true);
    expect(textOf(h.root, 'rankings-title')).toContain('战神');
    h.view.destroy();
  });

  it('HP-07a 切频道按既有导航规则清理旧开榜状态，重开后标题与范围随新频道', async () => {
    const items = [...pool().filter((entry) => entry.channelId === 'drama'),
      item('mv-only', 'movie', { category: '科幻', hitsTotal: 7_000 })];
    const h = mountHome({ items });
    await h.view.mount(); await micro();
    const base = getBackHandlerCountOf('layer');
    h.click(drama); await micro();
    h.click(hotEntry);
    expect(panelOf(h.root)?.hidden).toBe(false);
    h.click(movie); await micro();
    expect(panelOf(h.root)?.hidden).toBe(true);                             // 旧频道的榜不漂到新频道
    expect(getBackHandlerCountOf('layer')).toBe(base);
    h.click(hotEntry); await micro();
    expect(panelOf(h.root)?.hidden).toBe(false);
    expect(textOf(h.root, 'rankings-title')).toContain('电影仓库');
    expect(rows(h.root)).toEqual(['mv-only']);
    h.view.destroy();
  });

  it('HP-07a 私密、撤片与未知频道候选不进榜', () => {
    const items = [item('pub', 'drama', { hitsTotal: 10 }), item('priv', 'drama', { isPrivate: true, hitsTotal: 999 }),
      item('gone', 'drama', { enabled: false, hitsTotal: 999 }), item('odd', 'weird', { hitsTotal: 999 })];
    expect(scopeCandidates(items, { channel: 'drama', category: '全部' }).map((entry) => entry.id)).toEqual(['pub']);
    expect(rankWindow(items, 'hot', RANKING_LIMIT, { channel: 'drama', category: '全部' }).map((entry) => entry.id)).toEqual(['pub']);
    expect(rankWindow(items, 'hot', RANKING_LIMIT, { channel: 'weird', category: '全部' })).toEqual([]);
  });
});

describe('HP-07b 公平热度口径与诚实覆盖', () => {
  it('HP-07b 跨源单位不明时按来源内分位公平合并，绝不比绝对 hitsTotal', () => {
    const items = [item('d-a', 'drama', { hitsTotal: 10 }), item('d-b', 'drama', { hitsTotal: 9 }),
      item('m-a', 'movie', { hitsTotal: 1_000 })];
    expect(fairRank(items, 'hot').map((entry) => entry.id)).toEqual(['d-a', 'm-a', 'd-b']);
    expect(rankItems(items, 'hot', RANKING_LIMIT).map((entry) => entry.id)).toEqual(['d-a', 'm-a', 'd-b']);
    expect(coverageOf(items, { channel: null, category: '全部' }).sources).toBe(2);
  });

  it('HP-07b 真实 0 与字段缺失分开：0 分仍上榜并标注真实值，缺失者不进榜并计入覆盖', () => {
    const items = [item('zero', 'drama', { hitsTotal: 0 }), item('missing', 'drama'), item('low', 'drama', { hitsTotal: 3 })];
    expect(rankWindow(items, 'hot', RANKING_LIMIT, { channel: 'drama', category: '全部' }).map((entry) => entry.id))
      .toEqual(['low', 'zero']);
    const coverage = coverageOf(items, { channel: 'drama', category: '全部' });
    expect(coverage.missingHeat).toBe(1);
    expect(coverage.realZero).toBe(1);
    const { root } = railOf(items, { channel: 'drama', category: '全部' });
    expect(root.querySelector('.rank-row[data-content-id="zero"]')?.textContent).toContain('热度 0');
    expect(root.textContent).toContain('缺失');
    root.remove();
  });

  it('HP-07b isHot 只作标签不作唯一排序，ID 仅在同分处收口', () => {
    const items = [item('loud', 'drama', { isHot: true, hitsTotal: 5 }), item('quiet', 'drama', { hitsTotal: 50 }),
      item('tie-b', 'drama', { hitsTotal: 50 }), item('tie-a', 'drama', { hitsTotal: 50 })];
    expect(fairRank(items, 'hot').map((entry) => entry.id)).toEqual(['quiet', 'tie-a', 'tie-b', 'loud']);
    expect(fairRank([...items].reverse(), 'hot').map((entry) => entry.id)).toEqual(['quiet', 'tie-a', 'tie-b', 'loud']);
  });

  it('HP-07b 指标未变时排名不变：反复刷新同序，不随机洗牌也不称全网实时', () => {
    const items = beyondTopTwenty();
    const { root, rail } = railOf(items, { channel: 'drama', category: '全部' });
    const first = rows(root);
    rail.refresh(); rail.refresh();
    expect(rows(root)).toEqual(first);
    expect(root.textContent).toContain('本机快照');
    expect(root.textContent).toContain('非24小时或全网实时榜');
    root.remove();
  });

  it('HP-07b 空分类与部分缓存给诚实空态与覆盖说明，不编造名次', () => {
    const items = [item('city', 'drama', { category: '都市', hitsTotal: 100 })];
    const { root } = railOf(items, { channel: 'drama', category: '战神' });
    expect(root.querySelectorAll('.rank-row')).toHaveLength(0);
    expect(root.textContent).toContain('战神');
    expect(root.textContent).toContain('本机快照');
    expect(root.textContent).not.toContain('第 1 名');
    root.remove();
  });

  it('HP-07b 个人偏好不冒充公共热度，且频道榜不给三榜切换', () => {
    const items = [item('liked', 'drama', { hitsTotal: 1, isAi: true }), item('hot', 'drama', { hitsTotal: 900 })];
    expect(rankWindow(items, 'hot', RANKING_LIMIT, { channel: 'drama', category: '都市' }).map((entry) => entry.id))
      .toEqual(['hot', 'liked']);
    const { root } = railOf(items, { channel: 'drama', category: '都市' });
    expect(root.querySelectorAll('.rank-tab')).toHaveLength(0);              // 首页/频道榜只有热门榜
    root.remove();
  });
});

describe('HP-02a 展开区的键盘出口与返回层归还', () => {
  it('HP-02a 开榜后焦点进入展开区，Escape 只关榜单并把焦点还给入口', async () => {
    const h = mountHome({ items: pool() });
    await h.view.mount(); await micro();
    h.click(drama); await micro();
    const base = getBackHandlerCountOf('layer');
    h.click(hotEntry);
    const panel = panelOf(h.root);
    expect(panel?.hidden).toBe(false);
    expect(getBackHandlerCountOf('layer')).toBe(base + 1);
    // 焦点必须落在展开区内部：开着搜索/播放器时 Escape 归那一层消费，首页不许替上层做主。
    expect(panel?.contains(document.activeElement)).toBe(true);
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel?.hidden).toBe(true);
    expect(getBackHandlerCountOf('layer')).toBe(base);                     // 关掉即注销，返回层回到基线
    expect(document.activeElement).toBe(h.root.querySelector(hotEntry));   // 谁开的榜就收回谁
    h.view.destroy();
  });

  it('HP-02a 切完分类焦点已离开展开区，Escape 仍只关榜单（浏览器实测的漏口）', async () => {
    const h = mountHome({ items: pool() });
    await h.view.mount(); await micro();
    h.click(drama); await micro();
    const base = getBackHandlerCountOf('layer');
    h.click(hotEntry);
    expect(panelOf(h.root)?.hidden).toBe(false);
    h.click(reverse); await micro();                                      // 分类胶囊在展开区之外，点完焦点就离开了榜单
    expect(panelOf(h.root)?.hidden).toBe(false);                          // HP-07a：切分类仍保留开榜
    const inside = panelOf(h.root)?.contains(document.activeElement) ?? false;
    (inside ? document.activeElement : h.root.querySelector(hotEntry))
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panelOf(h.root)?.hidden).toBe(true);
    expect(getBackHandlerCountOf('layer')).toBe(base);
    h.view.destroy();
  });

  it('HP-02a 榜单没开着时 Escape 不注册返回层，也不消费别人的 Escape', async () => {
    const h = mountHome({ items: pool() });
    await h.view.mount(); await micro();
    h.click(drama); await micro();                                        // 进频道才会画出展开区宿主机
    const base = getBackHandlerCountOf('layer');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(getBackHandlerCountOf('layer')).toBe(base);
    expect(panelOf(h.root)?.hidden).toBe(true);
    h.view.destroy();
  });
});
