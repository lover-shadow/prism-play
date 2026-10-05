// B5（HP-06 发现式刷新 / HP-07 分类榜）三份测试共用的夹具：注入时钟、可控曝光观察器、可编排的候选池。
import type { ChannelId, ChannelItem, ContentItem } from '../../edge/src/types/api';
import type { WatchHistoryRow } from '../../src/core/storage/storage-domains';
import { createHomeView, type HomeApi, type HomeView } from '../../src/views/home-view';
import type { ExposureDeps, ExposureEntryLike, ExposureObserverLike } from '../../src/views/home-exposure';
import type { RefreshFeedback } from '../../src/views/home-repeat';

/** 注入时钟：时间窗与停留阈值都必须由测试推进，绝不吃真实毫秒。 */
export const clock = (start = 0) => {
  let at = start;
  return { now: (): number => at, advance: (ms: number): void => { at += ms; }, set: (ms: number): void => { at = ms; } };
};

export interface FakeObserver extends ExposureObserverLike {
  observed: Element[];
  disconnected: number;
  emit(node: Element, ratio: number, intersecting?: boolean): void;
}

/** 曝光观察器替身：jsdom 没有布局引擎，相交比例与停留都由测试逐次喂给实现。 */
export function fakeExposure() {
  const foreground = { visible: true };
  const observers: FakeObserver[] = [];
  const timers = new Map<number, { task: () => void; ms: number }>();
  let seq = 0;
  const factory = (onEntries: (entries: ExposureEntryLike[]) => void) => {
    const node = new Map<Element, boolean>();
    const observer: FakeObserver = {
      observed: [],
      disconnected: 0,
      observe(target: Element) { observer.observed.push(target); node.set(target, false); },
      unobserve(target: Element) { node.delete(target); },
      disconnect() { observer.disconnected += 1; node.clear(); observer.observed.length = 0; },
      emit(target: Element, ratio: number, intersecting = true) {
        if (!node.has(target)) return;
        node.set(target, intersecting);
        onEntries([{ target, intersectionRatio: ratio, isIntersecting: intersecting }]);
      }
    };
    observers.push(observer);
    return observer;
  };
  return {
    deps: {
      observerFactory: factory,
      schedule: (task: () => void, ms: number): (() => void) => {
        const id = ++seq;
        timers.set(id, { task, ms });
        return () => { timers.delete(id); };
      },
      isForeground: () => foreground.visible
    },
    foreground,
    timers,
    observers,
    lastMs: () => Math.max(0, ...[...timers.values()].map((entry) => entry.ms)),
    runDue(limit: number) { for (const [id, entry] of [...timers]) { if (entry.ms <= limit) { timers.delete(id); entry.task(); } } },
    runAll() { for (const [id, entry] of [...timers]) { timers.delete(id); entry.task(); } },
    /** 让一张卡片"真实可见且停留达标"：先相交，再推进到达阈值的停留。 */
    show(node: Element | null, ratio = 1, dwell = 5_000): void {
      if (node === null) return;
      const observer = observers.at(-1);
      observer?.emit(node, ratio);
      if (dwell > 0) { for (const [id, entry] of [...timers]) { if (entry.ms <= dwell) { timers.delete(id); entry.task(); } } }
    },
    hide(node: Element | null): void { if (node !== null) observers.at(-1)?.emit(node, 0, false); }
  };
}

export const item = (id: string, channelId: ChannelId, overrides: Partial<ContentItem> = {}): ContentItem =>
  ({ id, channelId, title: `剧目${id}`, category: '都市', isPrivate: false, coverUrl: `https://cdn.example/${id}.jpg`, ...overrides });

export const chan = (id: string, name: string, order: number, categories: string[] = []): ChannelItem =>
  ({ id: id as ChannelItem['id'], name, order, requiresTier: [], categories } as ChannelItem);

export interface HomeHarnessOptions {
  items?: ContentItem[];
  channels?: ChannelItem[];
  revision?: number;
  rows?: WatchHistoryRow[];
  sync?: () => Promise<void>;
  nowMillis?: () => number;
  networkFails?: boolean;
  /** 曝光判定阈值覆盖：比例/停留/观察器替身都由测试显式设定，实现里不留第二套数字。 */
  exposure?: ExposureDeps;
  onFeedback?: (state: RefreshFeedback) => void;
}

export function mountHome(over: HomeHarnessOptions = {}) {
  const exposure = over.exposure ?? fakeExposure().deps;
  const clk = over.nowMillis === undefined ? clock(0) : { now: over.nowMillis, advance: () => undefined, set: () => undefined };
  const items = over.items ?? [];
  const channels = over.channels ?? [chan('drama', '精彩短剧', 1, ['都市', '战神', '逆袭']), chan('movie', '电影仓库', 2, ['科幻'])];
  const requested: string[] = [];
  const network = (): ContentItem[] => (over.networkFails === true ? [] : items);
  const api: HomeApi = {
    channels: async () => ({ version: 3, channels }),
    catalog: async (input) => {
      requested.push(`catalog:${input.channel}:${input.category ?? '全部'}:${input.page ?? 1}`);
      if (over.networkFails === true) throw new TypeError('fetch failed');
      const page = input.page ?? 1, size = input.pageSize ?? 60;
      const source = items.filter((entry) => entry.channelId === input.channel
        && (input.category === undefined || entry.category === input.category));
      return { items: network().length === 0 ? [] : source.slice((page - 1) * size, page * size), page, pageSize: size, total: source.length, revision: over.revision ?? 42 };
    },
    cachedSnapshot: () => ({
      channels: { version: 3, channels },
      items: (channelId: string) => channelId === 'private' ? [] : items.filter((entry) => entry.channelId === channelId),
      state: () => ({ revision: over.revision ?? 42, items: items.length, channels: channels.length, partial: false })
    })
  };
  const scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  const root = document.createElement('div');
  scroller.append(root);
  document.body.append(scroller);
  const view: HomeView = createHomeView({
    api, root, posterMode: () => 'compact-3', onPosterModeChange: () => undefined,
    onOpenTitle: () => undefined, onResume: () => undefined,
    historyPreview: async () => over.rows ?? [],
    nowSeconds: () => 1_700_000_000,
    nowMillis: () => clk.now(),
    exposure,
    ...(over.sync === undefined ? {} : { syncCatalog: over.sync }),
    ...(over.onFeedback === undefined ? {} : { onFeedback: over.onFeedback })
  });
  const click = (selector: string): void => { root.querySelector<HTMLButtonElement>(selector)?.click(); };
  const ids = (): string[] => Array.from(root.querySelectorAll<HTMLElement>('.poster-card'))
    .map((node) => node.dataset.contentId ?? '');
  const card = (id: string): Element | null => root.querySelector(`.poster-card[data-content-id="${id}"]`);
  const phase = (): string | undefined => root.querySelector<HTMLElement>('[data-el="home-refresh-status"]')?.dataset.phase;
  return { root, scroller, view, ids, card, click, requested, phase, clk, api };
}

/** 在滚动容器上派发一次触摸序列；jsdom 无布局，几何结论仍待浏览器验证。 */
export function gesture(host: HTMLElement, steps: [number, number][]): void {
  steps.forEach(([x, y], index) => {
    const kind = index === 0 ? 'touchstart' : index === steps.length - 1 ? 'touchend' : 'touchmove';
    const event = new Event(kind, { bubbles: true, cancelable: true }) as Event & {
      touches: { clientX: number; clientY: number }[]; changedTouches: { clientX: number; clientY: number }[];
    };
    event.touches = [{ clientX: x, clientY: y }];
    event.changedTouches = [{ clientX: x, clientY: y }];
    host.dispatchEvent(event);
  });
}

export const flush = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)); };
