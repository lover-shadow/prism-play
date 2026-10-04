/**
 * 首页滚动行为（SPEC-APP-REFACTOR A-2 折叠搜索栏 / A-4 无感加载）。
 *
 * 从 `home-view.ts` 拆出这一件的唯一原因是 §10 的单文件 300 行红线；更重要的是这两段逻辑
 * 各自都有独立的可测边界（滚动差量状态机 / 触底观察器），混在装配根里只能用间接方式断言。
 *
 * 三条纪律：
 * 1. **零假 UI**：收起与续载都消费真实滚动位置；观察器不可用时退化为滚动距离判定，而不是留着手动按钮骗人；
 * 2. **rAF 节流**：滚动事件按帧合并，一帧内多次事件只读一次布局（滚动读值是 reflow 源）；
 * 3. **宿主可注入**：`Window` 与元素两种滚动容器都支持（Capacitor 里是 `#app-main`，纯 Web 构建可能是文档）。
 */

export type ScrollHost = HTMLElement | (Window & typeof globalThis);

/** 观察器接缝：单测注入假实现，无 IntersectionObserver 的旧 WebView 走滚动兜底。 */
export interface SentinelObserverLike {
  observe(target: Element): void;
  disconnect(): void;
}
export type SentinelObserverFactory = (
  onIntersect: () => void,
  root: Element | null,
  rootMargin: string
) => SentinelObserverLike | null;

export interface ToolbarController {
  destroy(): void;
  isHidden(): boolean;
}

/** 顶部这一段一律可见：刚起步的像素抖动不该把搜索入口藏掉。 */
export const TOOLBAR_TOP_ZONE = 24;
/** 触底预加载带（与 A-4 的 rootMargin 同判据）。 */
export const SENTINEL_MARGIN = 300;

const isWindowHost = (host: ScrollHost): host is Window & typeof globalThis =>
  typeof Window !== 'undefined' && host instanceof Window;

const asTarget = (host: ScrollHost): EventTarget => host as unknown as EventTarget;

const bindScroll = (host: ScrollHost, handler: () => void): void =>
  asTarget(host).addEventListener('scroll', handler, { passive: true });

const unbindScroll = (host: ScrollHost, handler: () => void): void =>
  asTarget(host).removeEventListener('scroll', handler);

const frame = (task: () => void): void => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(task);
  else setTimeout(task, 16);
};

/** 找到真正的滚动容器：沿祖先链找第一个纵向可滚元素，找不到就交给文档。 */
export function resolveScroller(node: HTMLElement | null): ScrollHost {
  let cursor = node;
  while (cursor !== null && cursor !== document.documentElement) {
    const overflow = getComputedStyle(cursor).overflowY;
    if (overflow === 'auto' || overflow === 'scroll') return cursor;
    cursor = cursor.parentElement;
  }
  if (typeof window !== 'undefined') return window;
  return document.documentElement;
}

export function scrollTopOf(host: ScrollHost): number {
  return isWindowHost(host) ? host.scrollY : host.scrollTop;
}

/** 平滑回顶；宿主没有平滑滚动能力时如实即时回顶（"回到顶部"必须真发生，不承诺动画）。 */
export function smoothScrollToTop(host: ScrollHost): void {
  try {
    if (isWindowHost(host)) host.scrollTo({ top: 0, behavior: 'smooth' });
    else host.scrollTo({ top: 0, behavior: 'smooth' });
  } catch {
    if (isWindowHost(host)) host.scroll(0, 0);
    else host.scrollTop = 0;
  }
}

export interface CollapsingToolbarDeps {
  scroller: ScrollHost;
  target: HTMLElement;
  /** 向下累计多少像素才收起（A-2 定案 15）。 */
  hideAfter?: number;
  /** 向上累计多少像素才复现（A-2 定案 10：比收起灵敏，回一点点就亮回来）。 */
  showAfter?: number;
  hiddenClass?: string;
}

/** A-2 下隐上现：按滚动**差量**累计过阈值才切状态，而不是"一有下滑就藏"。 */
export function createCollapsingToolbar(deps: CollapsingToolbarDeps): ToolbarController {
  const hideAfter = deps.hideAfter ?? 15;
  const showAfter = deps.showAfter ?? 10;
  const hiddenClass = deps.hiddenClass ?? 'home-search-bar--hidden';
  let last = scrollTopOf(deps.scroller);
  let accumulated = 0;
  let hidden = false;
  let ticking = false;

  function paint(next: boolean): void {
    hidden = next;
    deps.target.classList.toggle(hiddenClass, next);
    deps.target.setAttribute('aria-hidden', next ? 'true' : 'false');
  }

  function settle(): void {
    ticking = false;
    const position = scrollTopOf(deps.scroller);
    const delta = position - last;
    last = position;
    if (delta === 0) return;
    if (position <= TOOLBAR_TOP_ZONE) {
      accumulated = 0;
      if (hidden) paint(false);
      return;
    }
    accumulated += delta;
    if (delta > 0 && accumulated >= hideAfter) {
      if (!hidden) paint(true);
      accumulated = 0;
    } else if (delta < 0 && accumulated <= -showAfter) {
      if (hidden) paint(false);
      accumulated = 0;
    }
  }

  const onScroll = (): void => {
    if (ticking) return;
    ticking = true;
    frame(settle);
  };
  bindScroll(deps.scroller, onScroll);

  return {
    isHidden: () => hidden,
    destroy() {
      unbindScroll(deps.scroller, onScroll);
      if (hidden) paint(false);
    }
  };
}

export interface HomeScrollDeps {
  /** 视图根：用于反推真正的滚动容器。 */
  root: HTMLElement;
  /** 折叠搜索条；未注入搜索能力时为 null（那就没什么可折叠的，也不假装监听）。 */
  searchBar: HTMLElement | null;
  /** 尾部容器（moreHost）：哨兵与状态行住这里，网格重绘不会清掉它。 */
  tail: HTMLElement;
  /** 当前是否还能续载：翻页在途、已到 total、非就绪态都必须回 false。 */
  canLoad: () => boolean;
  onLoad: () => void;
  observerFactory?: SentinelObserverFactory;
  pendingLabel?: string;
  rootMargin?: string;
}

export interface HomeScroll {
  destroy(): void;
  /** 数据落定后主动复查一次：哨兵若仍贴在触底带里，续载必须继续，不能等下一次 crossing。 */
  recheck(): void;
  /** 翻页在途标记：状态行亮起，复查同时被抑制。 */
  setPending(pending: boolean): void;
}

const defaultObserverFactory: SentinelObserverFactory = (onIntersect, root, rootMargin) => {
  if (typeof IntersectionObserver === 'undefined') return null;
  return new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting)) onIntersect();
  }, { root, rootMargin }) as unknown as SentinelObserverLike;
};

/** 距容器底部是否已进入触底带（无 IntersectionObserver 宿主用的同一判据）。 */
function nearBottom(host: ScrollHost, margin: number): boolean {
  const viewport = isWindowHost(host) ? host.innerHeight : host.clientHeight;
  const content = isWindowHost(host) ? host.document.documentElement.scrollHeight : host.scrollHeight;
  return scrollTopOf(host) + viewport >= content - margin;
}

/**
 * A-2 + A-4 装配点：一条调用装好「下隐上现折叠条」与「1px 哨兵静默续载」。
 * IntersectionObserver 缺席的宿主自动退化为滚动距离判定，行为口径不变（触底前 300px 静默追加）。
 */
export function attachHomeScroll(deps: HomeScrollDeps): HomeScroll {
  const scroller = resolveScroller(deps.root);
  const status = document.createElement('p');
  status.className = 'home-more-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = deps.pendingLabel ?? '正在加载更多剧目…';
  status.dataset.active = '0';
  const sentinel = document.createElement('div');
  sentinel.className = 'home-sentinel';
  sentinel.setAttribute('aria-hidden', 'true');
  deps.tail.append(status, sentinel);

  let pending = false;
  const toolbar = deps.searchBar === null
    ? null
    : createCollapsingToolbar({ scroller, target: deps.searchBar });

  const request = (): void => {
    if (pending || !deps.canLoad()) return;
    deps.onLoad();
  };

  const observer = (deps.observerFactory ?? defaultObserverFactory)(
    request,
    isWindowHost(scroller) ? null : scroller,
    deps.rootMargin ?? `0px 0px ${SENTINEL_MARGIN}px 0px`
  );
  let fallback: (() => void) | null = null;
  if (observer === null) {
    fallback = () => {
      if (nearBottom(scroller, SENTINEL_MARGIN)) request();
    };
    bindScroll(scroller, fallback);
  } else {
    observer.observe(sentinel);
  }

  return {
    recheck: request,
    setPending(next: boolean) {
      pending = next;
      status.dataset.active = next ? '1' : '0';
    },
    destroy() {
      toolbar?.destroy();
      observer?.disconnect();
      if (fallback !== null) unbindScroll(scroller, fallback);
      status.remove();
      sentinel.remove();
    }
  };
}
