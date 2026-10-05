/**
 * HP-06c：真实曝光登记（HOME-PLAYER-REPAIR-SPEC-AND-PLAN §HP-06c / §3.3 曝光契约行）。
 *
 * 曝光 = "这张公开卡片此刻真的在屏幕上被看见"。以下四种都**不是**曝光，一律不记：
 * 预取/整库快照（节点根本不在 DOM 里）、骨架屏（无作品身份）、隐藏榜单的行、后台页或被遮挡的画面。
 * 判定只走 IntersectionObserver：视口相交比例达标 **且** 前台未遮挡 **且** 停留达到时长。
 *
 * 三条硬边界：
 * 1. **私密与未知身份在入口直接拒绝**：连观察都不挂，也**不输出任何身份日志**（本模块没有 console/report 调用）；
 * 2. **进程内有界集合起步**：不新增持久化存储、不新增云上报端点。要落盘或上云必须先立存储/契约（本批不做）；
 * 3. **宿主没有 IntersectionObserver 就什么都不记**：宁可"没有可见性信号"，也不用滚动事件或条数冒充曝光。
 *
 * 画像分（`recommendation.ts` 的题材分）只证明"看过哪些题材"，与"这一张卡真的被看见过"是两件事，
 * 本模块不读画像，也不被画像顶替（§4.3 HP-06 行「profile 不可混同曝光」）。
 */

import type { ContentItem } from '../../edge/src/types/api';
import { isPrivateSubject } from '../core/storage/storage-domains';
import { keepPublicCandidate } from './home-nav';

/**
 * 【待校准 · 未证工程参数】下面三个数值是本轮施工唯一一处定义，界面与测试都只引用常量：
 * `EXPOSURE_MIN_RATIO` 要求半张卡真的进画面；`EXPOSURE_MIN_MS` 要求停留满半秒（划走不算看见）；
 * `EXPOSURE_CAPACITY` 把进程内集合钉在两千条量级。真机滑动速度与列表密度需在浏览器/Android 复核后
 * 只改这一处，不在调用方散落第二套数字。
 */
export const EXPOSURE_MIN_RATIO = 0.5;
export const EXPOSURE_MIN_MS = 500;
export const EXPOSURE_CAPACITY = 2_000;

export interface ExposureEntryLike {
  target: Element;
  intersectionRatio: number;
  isIntersecting: boolean;
}
export interface ExposureObserverLike {
  observe(target: Element): void;
  unobserve(target: Element): void;
  disconnect(): void;
}
export type ExposureObserverFactory = (
  onEntries: (entries: readonly ExposureEntryLike[]) => void,
  options: { threshold: number }
) => ExposureObserverLike | null;
/** 停留计时注入点：单测用它推进"达标/未达标"，实现里不吃真实毫秒。 */
export type ExposureSchedule = (task: () => void, ms: number) => (() => void);

export interface ExposureTarget {
  node: Element;
  id: string;
  /** 缺省即"身份未知"：入口直接拒绝，不观察、不记录、不解释。 */
  item?: ContentItem;
}

export interface ExposureDeps {
  observerFactory?: ExposureObserverFactory;
  schedule?: ExposureSchedule;
  isForeground?: () => boolean;
  ratio?: number;
  minMs?: number;
  capacity?: number;
}

export interface ExposureTracker {
  /** 每次网格重绘后调用：挂上新的可见候选，摘掉已离场的节点，并取消它们的在途停留计时。 */
  sync(targets: readonly ExposureTarget[]): void;
  exposed(): ReadonlySet<string>;
  has(id: string): boolean;
  size(): number;
  destroy(): void;
}

const isPublicSubject = (target: ExposureTarget): boolean =>
  target.item !== undefined && target.id !== '' && !isPrivateSubject(target.item) && keepPublicCandidate(target.item);

const inForeground = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';

const defaultFactory: ExposureObserverFactory = (onEntries, options) => {
  if (typeof IntersectionObserver === 'undefined') return null;
  const observer = new IntersectionObserver((entries) => {
    onEntries(entries.map((entry) => ({
      target: entry.target, intersectionRatio: entry.intersectionRatio, isIntersecting: entry.isIntersecting
    })));
  }, { threshold: options.threshold });
  return observer as unknown as ExposureObserverLike;
};

const defaultSchedule: ExposureSchedule = (task, ms) => {
  const timer = setTimeout(task, ms);
  return () => clearTimeout(timer);
};

export function createExposureTracker(deps: ExposureDeps = {}): ExposureTracker {
  const ratio = deps.ratio ?? EXPOSURE_MIN_RATIO;
  const minMs = deps.minMs ?? EXPOSURE_MIN_MS;
  const capacity = deps.capacity ?? EXPOSURE_CAPACITY;
  const schedule = deps.schedule ?? defaultSchedule;
  const foreground = deps.isForeground ?? inForeground;
  const observer = (deps.observerFactory ?? defaultFactory)((entries) => handle(entries), { threshold: ratio });

  const ids = new Map<Element, string>();
  const timers = new Map<Element, () => void>();
  const recorded = new Set<string>();
  let disposed = false;

  function handle(entries: readonly ExposureEntryLike[]): void {
    if (disposed) return;
    for (const entry of entries) {
      const id = ids.get(entry.target);
      if (id === undefined) continue;
      const cancel = timers.get(entry.target);
      if (cancel !== undefined) { cancel(); timers.delete(entry.target); }
      if (recorded.has(id)) continue;                                            // 重复 visible 幂等
      const visible = entry.isIntersecting && entry.intersectionRatio >= ratio && foreground();
      if (!visible) continue;                                                    // 比例不足/离开视口/后台页：不记
      timers.set(entry.target, schedule(() => {
        timers.delete(entry.target);
        if (disposed || ids.get(entry.target) !== id || recorded.has(id)) return; // 迟到回调不回写
        if (recorded.size >= capacity) {
          const oldest = recorded.values().next().value;
          if (oldest !== undefined) recorded.delete(oldest);                      // 有界集合：先到者退出
        }
        recorded.add(id);
      }, minMs));
    }
  }

  return {
    sync(targets: readonly ExposureTarget[]): void {
      if (disposed || observer === null) return;
      const keep = new Set<Element>();
      for (const target of targets) {
        if (!isPublicSubject(target)) continue;                                   // 私密/未知：入口拒绝，零日志
        keep.add(target.node);
        if (ids.has(target.node)) continue;
        ids.set(target.node, target.id);
        observer.observe(target.node);
      }
      for (const node of [...ids.keys()]) {
        if (keep.has(node)) continue;
        ids.delete(node);
        const cancel = timers.get(node);
        if (cancel !== undefined) { cancel(); timers.delete(node); }
        observer.unobserve(node);
      }
    },
    exposed: () => recorded,
    has: (id: string) => recorded.has(id),
    size: () => recorded.size,
    destroy(): void {
      disposed = true;
      for (const cancel of timers.values()) cancel();
      timers.clear();
      ids.clear();
      observer?.disconnect();                                                     // 观察器随视图一起注销
    }
  };
}
