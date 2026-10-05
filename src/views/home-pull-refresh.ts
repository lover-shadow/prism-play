/**
 * HP-06a：页面顶部下拉刷新（HOME-PLAYER-REPAIR-SPEC-AND-PLAN §HP-06「下拉刷新使用同一入口」）。
 *
 * 只做**判定**，不做观感：位移阈值与阻尼都是未证工程参数，只在下面这一处定义；视觉承载（跟手位移、
 * 回弹动画、安全区）归 `src/views/views.css` / B6 批次，jsdom 没有布局引擎，本文件的几何结论
 * 一律标"待浏览器与真机验证"。
 *
 * 三条准入（任一不满足就完全不响应，避免与列表滚动、横向滑轨和浮层抢手势）：
 * 1. 当前容器已经在顶部（`topOffset() <= PULL_TOP_EPSILON_PX`）；
 * 2. 手势纵向占优——横向位移一旦超过纵向即整条手势作废（频道条与胶囊轨都是横向滚动）；
 * 3. `enabled()` 允许——刷新在途、视图被隐藏或有浮层承载时一律不触发。
 * 触发后调用的是与重复点击标题**同一条** `refresh()` 入口，本模块不自建第二套刷新语义。
 */

import { scrollTopOf, type ScrollHost } from './home-scroll';

/** 【待校准 · 未证工程参数】触发刷新所需的下拉位移：真机拇指行程需在浏览器/Android 复核后改这一处。 */
export const PULL_TRIGGER_PX = 72;
/** 【待校准 · 未证工程参数】"已经在顶部"的像素容差：回顶动画未完全落位时不该拒绝手势。 */
export const PULL_TOP_EPSILON_PX = 4;
/** 提示文案：只说"下拉刷新"，不承诺自动播放或必然有新内容。 */
export const PULL_LABEL = '下拉刷新';

export interface PullRefreshDeps {
  /** 真实滚动容器：与折叠搜索条、触底哨兵用的是同一个判定来源。 */
  scroller: ScrollHost;
  /** 提示节点的落位父节点（由刷新控制器给状态条容器）。 */
  host: HTMLElement;
  enabled(): boolean;
  /** 与重复点击标题共用的那一条刷新入口。 */
  refresh(): void;
  /** 注入读值口：jsdom 无布局，单测用它给定离顶距离。 */
  topOffset?: () => number;
  triggerPx?: number;
}

export interface PullRefresh {
  destroy(): void;
  node: HTMLElement;
}

const target = (host: ScrollHost): EventTarget => host as unknown as EventTarget;

/** 从触摸事件里读一个采样点；没有 touches 载荷的事件直接忽略（不做鼠标假手势）。 */
function pointOf(event: Event): { x: number; y: number } | null {
  const carrier = event as unknown as {
    touches?: { clientX: number; clientY: number }[];
    changedTouches?: { clientX: number; clientY: number }[];
  };
  const sample = carrier.touches?.[0] ?? carrier.changedTouches?.[0];
  if (sample === undefined || typeof sample.clientY !== 'number') return null;
  return { x: sample.clientX, y: sample.clientY };
}

export function createPullRefresh(deps: PullRefreshDeps): PullRefresh {
  const trigger = deps.triggerPx ?? PULL_TRIGGER_PX;
  const topOffset = deps.topOffset ?? (() => scrollTopOf(deps.scroller));
  const node = document.createElement('div');
  node.className = 'home-pull-refresh';
  node.dataset.el = 'pull-refresh';
  node.dataset.state = 'idle';
  node.setAttribute('role', 'status');
  node.setAttribute('aria-live', 'polite');
  node.textContent = PULL_LABEL;
  node.hidden = true;
  deps.host.appendChild(node);

  let startX = 0, startY = 0, active = false, armed = false, disposed = false;

  function paint(state: 'idle' | 'armed'): void {
    node.dataset.state = state;
    node.hidden = state === 'idle';
  }

  function abandon(): void {
    active = false;
    armed = false;
    paint('idle');
  }

  function onStart(event: Event): void {
    if (disposed || active || !deps.enabled()) return;
    if (topOffset() > PULL_TOP_EPSILON_PX) return;                       // 不在顶部：手势归列表滚动
    const point = pointOf(event);
    if (point === null) return;
    startX = point.x;
    startY = point.y;
    active = true;
    armed = false;
  }

  function onMove(event: Event): void {
    if (disposed || !active) return;
    const point = pointOf(event);
    if (point === null) return;
    const dx = Math.abs(point.x - startX);
    const dy = point.y - startY;
    if (dx > Math.abs(dy)) { abandon(); return; }                         // 横向手势冲突：整条作废
    if (topOffset() > PULL_TOP_EPSILON_PX || dy <= 0) { abandon(); return; }
    if (dy >= trigger) { armed = true; paint('armed'); }
  }

  function onEnd(): void {
    if (!active) return;
    const fire = armed && deps.enabled();
    abandon();
    if (fire) deps.refresh();
  }

  target(deps.scroller).addEventListener('touchstart', onStart, { passive: true });
  target(deps.scroller).addEventListener('touchmove', onMove, { passive: true });
  target(deps.scroller).addEventListener('touchend', onEnd, { passive: true });

  return {
    node,
    destroy(): void {
      disposed = true;
      active = false;
      armed = false;
      target(deps.scroller).removeEventListener('touchstart', onStart);
      target(deps.scroller).removeEventListener('touchmove', onMove);
      target(deps.scroller).removeEventListener('touchend', onEnd);
      node.remove();
    }
  };
}
