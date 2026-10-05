// @vitest-environment jsdom
/**
 * HP-06 发现式刷新（HOME-PLAYER-REPAIR-SPEC-AND-PLAN §HP-06 / §3.2 / §5.1 HP-06a·HP-06b）。
 * 时间窗数值是未证工程参数：用例只引用 `home-repeat.ts` 里那一处常量，不在测试里另写魔法数。
 * jsdom 无布局：真实下拉手势的几何/观感结论一律标"待浏览器验证"，本文件只证判定逻辑与反馈文案。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPEAT_REFRESH_WINDOW_MS, type RefreshFeedback } from '../../src/views/home-repeat';
import { FOUR, flush as micro, item as freshItem, must, pool } from './home-composite-harness';
import { clock, gesture, mountHome, type HomeHarnessOptions } from './home-refresh-harness';

const drama = '[data-nav-id="drama"]', home = '[data-nav-id="local-home"]';
const urban = '[data-category="都市"]', reverse = '[data-category="战神"]';
const bandOf = (root: HTMLElement): HTMLElement => root.querySelector<HTMLElement>('[data-el="home-refresh-status"]')!;
const enterDrama = async (h: ReturnType<typeof mountHome>): Promise<void> => {
  h.click(drama); await micro(); h.scroller.scrollTo = vi.fn();
};

function tracked(over: HomeHarnessOptions = {}) {
  const seen: RefreshFeedback[] = [];
  const h = mountHome({ ...over, onFeedback: (state) => seen.push(state) });
  return { ...h, seen, phases: () => seen.map((entry) => entry.phase) };
}

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('HP-06a 重复点击时间窗与共用刷新入口', () => {
  it('HP-06a 第一次重复点击只回顶，时间窗内再次点击才真正刷新', async () => {
    const h = tracked({ items: pool(), channels: FOUR });
    await h.view.mount(); await enterDrama(h);
    const before = h.requested.length;
    h.click(drama);
    expect(h.scroller.scrollTo).toHaveBeenCalledTimes(1);
    expect(h.requested).toHaveLength(before);                        // 首重复：只回顶，不发任何发现请求
    h.click(drama); await micro();
    expect(h.phases()).toContain('refreshing');                       // 窗内再重复：真正刷新
    h.view.destroy();
  });

  it('HP-06a 超出时间窗的重复点击只回顶，序列起点随最后一次回顶重置', async () => {
    const clk = clock(0);
    const h = tracked({ items: pool(), channels: FOUR, nowMillis: () => clk.now() });
    await h.view.mount(); await enterDrama(h);
    h.click(drama);                                                  // 首重复 → 回顶
    clk.advance(REPEAT_REFRESH_WINDOW_MS + 1);
    h.click(drama); await micro();                                   // 窗外 → 仍只回顶
    expect(h.phases()).not.toContain('refreshing');
    expect(h.scroller.scrollTo).toHaveBeenCalledTimes(2);
    h.click(drama); await micro();                                   // 上一次回顶重新成为序列起点
    expect(h.phases()).toContain('refreshing');
    h.view.destroy();
  });

  it('HP-06a 页面顶部下拉与重复点击标题共用同一条刷新入口', async () => {
    const h = tracked({ items: pool(), channels: FOUR });
    await h.view.mount(); await enterDrama(h);
    const refreshing = () => h.phases().filter((phase) => phase === 'refreshing').length;
    gesture(h.scroller, [[20, 120], [22, 200], [22, 210]]); await micro();
    expect(refreshing()).toBe(1);
    h.click(drama); h.click(drama); await micro();
    expect(refreshing()).toBe(2);                                    // 两条来路落到同一条 pipeline
    h.view.destroy();
  });

  it('HP-06a 非顶部、横向手势与刷新在途时下拉不触发', async () => {
    const h = tracked({ items: pool(), channels: FOUR });
    await h.view.mount(); await enterDrama(h);
    Object.defineProperty(h.scroller, 'scrollTop', { configurable: true, get: () => 480 });
    gesture(h.scroller, [[20, 120], [22, 210], [22, 240]]); await micro();
    expect(h.phases()).not.toContain('refreshing');
    Object.defineProperty(h.scroller, 'scrollTop', { configurable: true, get: () => 0 });
    gesture(h.scroller, [[20, 120], [120, 140], [160, 150]]); await micro();  // 横向位移占优：手势冲突
    expect(h.phases()).not.toContain('refreshing');

    let finish!: () => void;
    const busy = tracked({ items: pool(), channels: FOUR, sync: () => new Promise<void>((resolve) => { finish = resolve; }) });
    await busy.view.mount(); await enterDrama(busy);
    gesture(busy.scroller, [[20, 120], [22, 210], [22, 240]]); await micro();
    expect(busy.phases()).toContain('refreshing');
    gesture(busy.scroller, [[20, 120], [22, 210], [22, 240]]); await micro();  // 在途：不叠加第二条
    expect(busy.phases().filter((phase) => phase === 'refreshing')).toHaveLength(1);
    finish(); await micro(); busy.view.destroy(); h.view.destroy();
  });

  it('HP-06a 切新分类是新范围加载，重复点击判定序列随之重置', async () => {
    const h = tracked({ items: pool(), channels: FOUR });
    await h.view.mount(); await enterDrama(h);
    h.click(urban); await micro();
    expect(h.requested).toContain('catalog:drama:都市:1');             // 新范围：正常加载
    const loads = h.requested.length;
    h.click(urban);                                                   // 首重复 → 只回顶
    expect(h.requested).toHaveLength(loads);
    h.click(urban); await micro();                                    // 窗内再重复 → 本范围发现刷新
    expect(h.requested.length).toBeGreaterThan(loads);
    h.click(reverse); await micro();
    expect(h.requested).toContain('catalog:drama:战神:1');              // 换分类：又是新范围加载
    expect(h.phases().filter((phase) => phase === 'refreshing')).toHaveLength(1);  // 序列已被新范围重置
    h.click(reverse); await micro();
    expect(h.phases().filter((phase) => phase === 'refreshing')).toHaveLength(1);
    h.view.destroy();
  });
});

describe('HP-06b 新的推荐轮次与诚实反馈', () => {
  it('HP-06b 显式刷新开新轮次：同修订也重新发现，背景同修订不重排', async () => {
    const h = mountHome({ items: pool(), channels: FOUR });
    await h.view.mount(); await micro();
    const first = must(h.view.recommendationRecord());
    expect(first.round).toBe(1);
    await h.view.syncRecommendation();
    expect(must(h.view.recommendationRecord()).round).toBe(1);        // 背景同步同修订：不动本轮
    await h.view.refresh();
    const next = must(h.view.recommendationRecord());
    expect(next.round).toBe(2);                                       // 显式刷新＝新的推荐轮次
    expect(next.revision).toBe(first.revision);                       // 轮次与云 revision 各归各
    expect(next.candidates).toBe(first.candidates);
    h.view.destroy();
  });

  it('HP-06b 同轮 loadMore 只追加：不回排已展示条目、不跨页重复', async () => {
    const h = mountHome({ items: pool(), channels: FOUR });
    await h.view.mount(); await micro();
    const first = h.ids();
    expect(first).toHaveLength(60);
    h.view.loadMore(); await micro();
    const after = h.ids();
    expect(after.slice(0, 60)).toEqual(first);
    expect(new Set(after).size).toBe(after.length);
    h.view.destroy();
  });

  it('HP-06b 同步失败与本地重排成功分别反馈，绝不混成已更新', async () => {
    const items = pool();
    const h = tracked({ items, channels: FOUR, sync: async () => { throw new Error('sync failed'); } });
    await h.view.mount(); await micro();
    items.push(freshItem('new-movie', 'movie', { category: '科幻', hitsTotal: 9_000 }));
    await h.view.refresh();
    const band = bandOf(h.root);
    expect(band.dataset.phase).toBe('offline');                        // 同步失败：如实标离线
    expect(band.dataset.local).toBe('reordered');                       // 本地重排成功：单独一条事实
    expect(band.textContent).toContain('离线');
    expect(band.textContent).toContain('重新推荐');
    expect(band.querySelector('[data-el="home-refresh-sync"]')?.textContent).toContain('内容加载失败');
    expect(band.textContent).not.toContain('已更新');
    expect(h.root.querySelectorAll('.poster-card').length).toBeGreaterThan(0);  // 片单不被失败态吞掉
    h.view.destroy();
  });

  it('HP-06b 断网时候选读的是本机快照，离线重排照样成立且不谎报新内容', async () => {
    const h = tracked({ items: pool(), channels: FOUR, sync: async () => { throw new TypeError('fetch failed'); } });
    await h.view.mount(); await micro();
    expect(h.requested).toHaveLength(0);                                // 综合首页优先读本机快照，不硬发请求
    await h.view.refresh();
    const band = bandOf(h.root);
    expect(band.dataset.phase).toBe('offline');
    expect(band.dataset.local).toBe('unchanged');
    expect(band.textContent).toContain('离线');
    expect(band.textContent).not.toContain('已更新');
    expect(h.ids().length).toBeGreaterThan(0);
    h.view.destroy();
  });

  it('HP-06b 空缓存诚实失败：不谎称已更新，并提供重试出口', async () => {
    const h = tracked({ items: [], channels: FOUR, networkFails: true });
    await h.view.mount(); await micro();
    await h.view.refresh();
    expect(h.phases()).toContain('failed');
    const band = bandOf(h.root);
    expect(band.dataset.phase).toBe('failed');
    expect(band.textContent).not.toContain('已更新');
    expect(band.textContent).not.toContain('重新推荐');
    expect(band.querySelector('[data-el="home-refresh-retry"]')).not.toBeNull();
    h.view.destroy();
  });

  it('HP-06b 五态齐备：刷新中／已完成／没有新内容／离线重排／失败重试', async () => {
    const items = pool();
    let finish!: () => void, hanging = true;
    const h = tracked({ items, channels: FOUR, sync: () => (hanging
      ? new Promise<void>((resolve) => { hanging = false; finish = resolve; })
      : Promise.resolve()) });
    await h.view.mount(); await micro();
    const task = h.view.refresh();                                      // 不 await：刷新中态必须可见
    expect(bandOf(h.root).dataset.phase).toBe('refreshing');
    finish(); await task;
    expect(h.phases()).toContain('no-new');                            // 同候选同修订同曝光：如实说没有新内容
    items.push(freshItem('fresh-1', 'movie', { category: '科幻', hitsTotal: 5_000 }));
    await h.view.refresh();
    expect(h.phases()).toContain('updated');                           // 候选变化后如实说已完成
    expect(must(h.view.recommendationRecord()).round).toBeGreaterThanOrEqual(3);
    h.click(home); h.click(home); await micro();                        // 首页目标的窗内重复走同一条入口
    expect(h.phases().filter((phase) => phase === 'refreshing').length).toBeGreaterThanOrEqual(2);
    h.view.destroy();
  });

  it('HP-06b 首次加载：云端目录整条读不到时仍画本机快照，不把降级写成整页错误', async () => {
    const h = tracked({ items: pool(), channels: FOUR });
    h.api.channels = async () => { throw new TypeError('fetch failed'); };   // §3.2「更新失败保留上一可用快照」
    await h.view.mount(); await micro();
    expect(h.ids().length).toBeGreaterThan(0);                                // 快照先显（AC-01）优先于"报错"
    expect(h.root.querySelector('.state-view')).toBeNull();                   // 五态不许盖住本机已有的片单
    const band = bandOf(h.root);
    expect(band.dataset.phase).toBe('offline');
    expect(band.textContent).not.toContain('已更新');
    expect(band.textContent).toContain('本机已缓存的公开快照');
    h.view.destroy();
  });

  it('HP-06b 首次加载：拓扑失败且本机也没有候选时如实落空态，不谎称已更新', async () => {
    const h = tracked({ items: [], channels: FOUR });
    h.api.channels = async () => { throw new TypeError('fetch failed'); };
    await h.view.mount(); await micro();
    expect(h.ids()).toHaveLength(0);                                          // 空缓存不许被说成"已更新"
    expect(h.root.querySelector('[data-state="empty"]')).not.toBeNull();      // 空态由 feed 现读，视图不另判
    expect(bandOf(h.root).dataset.phase).not.toBe('offline');                 // 没有本地片单就不许说"来自本机快照"
    h.view.destroy();
  });
});
