// @vitest-environment jsdom
/**
 * HP-06c 真实曝光（HOME-PLAYER-REPAIR-SPEC-AND-PLAN §HP-06c / §3.3 曝光契约）。
 * jsdom 无布局：相交比例与停留都由替身观察器逐次喂入，真机可见性判定仍待浏览器验证。
 * 曝光阈值与容量都是未证工程参数：用例只引用 `home-exposure.ts` 里那一处常量，不在测试里重复写字面量。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExposureTracker, EXPOSURE_CAPACITY, EXPOSURE_MIN_MS, EXPOSURE_MIN_RATIO } from '../../src/views/home-exposure';
import { flush as micro, item as freshItem, item as raw, pool } from './home-composite-harness';
import { fakeExposure, gesture, mountHome } from './home-refresh-harness';

const drama = '[data-nav-id="drama"]';
const bandOf = (root: HTMLElement): HTMLElement => root.querySelector<HTMLElement>('[data-el="home-refresh-status"]')!;
const wide = () => [...pool(), ...Array.from({ length: 60 }, (_, index) => freshItem(`extra-${index}`, 'drama', { category: '都市', hitsTotal: 10 + index }))];

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('HP-06c 曝光判定：真实可见才记', () => {
  it('HP-06c 相交比例与停留同时达标才记曝光，任一项不足都不记', () => {
    const fx = fakeExposure();
    const tracker = createExposureTracker(fx.deps);
    const low = document.createElement('i'); const high = document.createElement('i');
    tracker.sync([{ node: low, id: 'low', item: freshItem('low', 'drama') }, { node: high, id: 'high', item: freshItem('high', 'drama') }]);
    fx.show(low, EXPOSURE_MIN_RATIO - 0.2);
    expect(tracker.has('low')).toBe(false);                              // 比例不达标：停留再久也不算
    fx.show(high, EXPOSURE_MIN_RATIO + 0.2, 0);                           // 达标但未推进停留计时
    expect(tracker.has('high')).toBe(false);                              // 停留未达标：不记
    fx.runDue(EXPOSURE_MIN_MS);
    expect(tracker.has('high')).toBe(true);
    expect(tracker.size()).toBe(1);
    tracker.destroy();
  });

  it('HP-06c 后台页、离开视口与从未登记的节点一律不记', () => {
    const fx = fakeExposure();
    const tracker = createExposureTracker(fx.deps);
    const onScreen = document.createElement('i'); const off = document.createElement('i');
    tracker.sync([{ node: onScreen, id: 'a', item: freshItem('a', 'drama') }]);
    fx.foreground.visible = false;
    fx.show(onScreen, 1);
    expect(tracker.has('a')).toBe(false);                                  // 后台页不记
    fx.foreground.visible = true;
    fx.show(off, 1);                                                       // 预取/屏外：没有 observe 过就不记
    expect(tracker.has('off')).toBe(false);
    fx.show(onScreen, 1, 0);
    fx.hide(onScreen);                                                     // 停留未达标就离开视口
    fx.runAll();
    expect(tracker.has('a')).toBe(false);
    tracker.destroy();
  });

  it('HP-06c 重复 visible 幂等，destroy 注销观察器且迟到回调不再回写', () => {
    const fx = fakeExposure();
    const tracker = createExposureTracker(fx.deps);
    const node = document.createElement('i');
    tracker.sync([{ node, id: 'a', item: freshItem('a', 'drama') }]);
    fx.show(node, 1); fx.show(node, 1); fx.show(node, 1);
    fx.runAll(); fx.runAll();
    expect(tracker.size()).toBe(1);
    const observer = fx.observers.at(-1)!;
    expect(observer.observed).toContain(node);
    tracker.destroy();
    expect(observer.disconnected).toBeGreaterThan(0);
    const late = fakeExposure();
    const second = createExposureTracker(late.deps);
    const other = document.createElement('i');
    second.sync([{ node: other, id: 'b', item: freshItem('b', 'drama') }]);
    second.destroy();
    late.observers.at(-1)!.emit(other, 1);
    late.runAll();
    expect(second.size()).toBe(0);                                         // 销毁之后的迟到回调不回写
  });

  it('HP-06c 私密与未知身份在入口拒绝，且不输出任何身份日志', () => {
    const fx = fakeExposure();
    const tracker = createExposureTracker(fx.deps);
    const spy = vi.spyOn(console, 'log'); const warn = vi.spyOn(console, 'warn'); const err = vi.spyOn(console, 'error');
    const publicNode = document.createElement('i');
    const privateNode = document.createElement('i');
    const unknownNode = document.createElement('i');
    tracker.sync([
      { node: publicNode, id: 'pub', item: freshItem('pub', 'drama') },
      { node: privateNode, id: 'private-secret', item: freshItem('private-secret', 'private', { isPrivate: true }) },
      { node: unknownNode, id: 'unknown-secret' }
    ]);
    fx.show(privateNode, 1); fx.show(unknownNode, 1); fx.show(publicNode, 1);
    fx.runAll();
    expect(tracker.size()).toBe(1);
    expect(tracker.has('pub')).toBe(true);
    expect([...tracker.exposed()].some((id) => id.includes('secret'))).toBe(false);
    expect(fx.observers.at(-1)!.observed).not.toContain(privateNode);       // 连观察都不挂
    expect(fx.observers.at(-1)!.observed).not.toContain(unknownNode);
    expect(spy).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(err).not.toHaveBeenCalled();
    tracker.destroy();
  });

  it('HP-06c 进程内有界集合：超容量按先到者退出，且零持久化零云上报', () => {
    const fx = fakeExposure();
    const tracker = createExposureTracker({ ...fx.deps, capacity: 3 });
    const nodes = Array.from({ length: 5 }, () => document.createElement('i'));
    tracker.sync(nodes.map((node, index) => ({ node, id: `x-${index}`, item: freshItem(`x-${index}`, 'drama') })));
    nodes.forEach((node) => fx.show(node, 1));
    fx.runAll();
    expect(tracker.size()).toBe(3);
    expect(tracker.has('x-0')).toBe(false); expect(tracker.has('x-4')).toBe(true);
    expect(window.localStorage.length).toBe(0);                               // 本批不新增持久化存储
    tracker.destroy();
  });

  it('HP-06c 阈值与容量集中在单一定义处（待校准参数不散落）', () => {
    expect(EXPOSURE_MIN_RATIO).toBeGreaterThan(0);
    expect(EXPOSURE_MIN_RATIO).toBeLessThanOrEqual(1);
    expect(EXPOSURE_MIN_MS).toBeGreaterThan(0);
    expect(EXPOSURE_CAPACITY).toBeGreaterThan(0);
  });
});

describe('HP-06c 曝光进入下一次发现轮次', () => {
  it('HP-06c 已曝光候选整体降权，未看过的公开候选重新占位', async () => {
    const fx = fakeExposure();
    const h = mountHome({ items: wide(), exposure: fx.deps });
    await h.view.mount(); await micro();
    h.click(drama); await micro();                                            // 频道目录同样吃真实曝光
    const first = h.ids();
    expect(first.length).toBeGreaterThan(0);
    first.forEach((id) => fx.show(h.card(id)));                               // 达标停留后就地提交
    expect(fx.observers.at(-1)!.observed).toContain(h.card(first[0]));         // 只有真挂上去的公开卡片被观察
    h.view.loadMore(); await micro();
    expect(h.ids().slice(0, first.length)).toEqual(first);                     // 同轮追加不回排已展示条目
    expect(new Set(h.ids()).size).toBe(h.ids().length);                         // 也不跨页重复
    gesture(h.scroller, [[20, 120], [22, 200], [22, 210]]); await micro();      // 与标题点击同一条刷新入口
    const next = h.ids();
    expect(next.length).toBeGreaterThan(0);
    expect(next.filter((id) => first.includes(id))).toEqual([]);                // 本范围重选：看过的不再占前排
    h.view.destroy();
  });

  it('HP-06c 候选已全部展示过时如实说没有新内容，不重洗旧列表冒充新意', async () => {
    const fx = fakeExposure();
    const h = mountHome({ items: Array.from({ length: 8 }, (_, index) => raw(`x-${index}`, 'drama', { hitsTotal: 100 - index })), exposure: fx.deps });
    await h.view.mount(); await micro();
    h.click(drama); await micro();
    const first = h.ids();
    expect(first).toHaveLength(8);
    first.forEach((id) => fx.show(h.card(id)));
    await h.view.refresh();
    expect(h.ids()).toEqual(first);                                          // 没看过的一个都没有：不洗牌、不硬凑
    expect(bandOf(h.root).dataset.phase).toBe('no-new');
    expect(bandOf(h.root).textContent).toContain('已展示');
    h.view.destroy();
  });

  it('HP-06c 没有 IntersectionObserver 的宿主不假记曝光', async () => {
    const h = mountHome({ items: pool(), exposure: {} });
    await h.view.mount(); await micro();
    h.click(drama); await micro();
    const first = h.ids();
    await h.view.refresh();
    expect(h.ids()).toEqual(first);                                          // 无真实可见信号＝不宣称重新发现
    h.view.destroy();
  });

  it('HP-06c 骨架屏与隐藏榜单永不进曝光登记，首页不挂榜单位', async () => {
    const fx = fakeExposure();
    const h = mountHome({ items: pool(), exposure: fx.deps });
    const pending = h.view.mount();
    expect(h.root.querySelectorAll('.poster-card--skeleton').length).toBeGreaterThan(0);
    await pending; await micro();
    const observed = fx.observers.flatMap((observer) => observer.observed);
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((node) => !node.classList.contains('poster-card--skeleton'))).toBe(true);
    expect(h.root.querySelectorAll('[data-el="rankings-host"]')).toHaveLength(0);  // 综合首页无榜单展开区
    h.view.destroy();
  });
});
