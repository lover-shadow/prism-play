/**
 * HP-06 首页刷新控制器：把"重复点击／顶部下拉 → 同一条刷新入口"、"刷新状态条"与"真实曝光登记"
 * 收成一件（HOME-PLAYER-REPAIR-SPEC-AND-PLAN §HP-06 / §4.1 B5 行）。
 *
 * 拆出来只为 §10 的 300 行红线与一条硬要求：**页面顶部下拉刷新与点击标题必须走同一个入口**。
 * 两条来路都只调 `repeat.refresh()`，时间窗、单飞与代次失效全在 `home-repeat.ts` 一处判定；
 * 本控制器不解释候选、不碰配额、也不新增第二条刷新语义。
 *
 * 曝光部分只负责"把当前渲染出来的公开卡片交给观察器"：判定与阈值归 `home-exposure.ts`，
 * 候选重选归 `home-discovery.ts` 与两条 feed，三者互不顶算。
 */

import type { ContentItem } from '../../edge/src/types/api';
import { element } from '../components/state-views';
import type { DiscoveryReport } from './home-feeds';
import { createExposureTracker, type ExposureDeps, type ExposureTarget } from './home-exposure';
import { createHomeRepeat, type RefreshFeedback } from './home-repeat';
import { createPullRefresh } from './home-pull-refresh';
import { createRefreshStatus } from './home-refresh-status';
import type { ScrollHost } from './home-scroll';

export interface HomeControllerDeps {
  /** 视图根：卡片节点在其中查（与折叠条、哨兵同一个容器）。 */
  root: HTMLElement;
  /** 状态条与下拉提示的落位父节点。 */
  slot: HTMLElement;
  /** 落在网格宿主之前，保证"刷新中"出现在片单上方而不是列表尾巴。 */
  insertBefore: HTMLElement | null;
  /** 回到当前一级/二级容器顶部：与重复点击标题用的是同一件事。 */
  top(): void;
  scroller: () => ScrollHost;
  /** 显式刷新的发现入口：视图按当前范围交给对应 feed。 */
  discover(): Promise<DiscoveryReport>;
  invalidate(): void;
  feedback(state: RefreshFeedback): void;  sync?: () => Promise<void>;
  nowMillis: () => number;
  /** 浮层冲突：榜单展开区开着时下拉不抢手势。 */
  blocked: () => boolean;
  exposure?: ExposureDeps;
}

export interface HomeController {
  /** 一级/二级目标的重复点击判定：首重复回顶，窗内再重复才刷新。 */
  click(target: string): void;
  refresh(): Promise<void>;
  interrupt(): void;
  busy(): boolean;
  /** 状态条的唯一写入口：刷新管线与"首读失败但已画本机快照"这类降级都汇到这一处文案判定。 */
  feedback(state: RefreshFeedback): void;
  /** 每次网格重绘后把当前渲染的公开卡片交给曝光观察器；落五态时传空集以摘除观察。 */
  observePaint(items: readonly ContentItem[]): void;
  exposed(): ReadonlySet<string>;
  exposedCount(): number;
  destroy(): void;
}

/** 视图是否真的挂在可见页面上：外壳切 Tab 走的是容器 `hidden`（A-1 只隐藏不销毁）。 */
function shownOnPage(node: HTMLElement): boolean {
  for (let cursor: HTMLElement | null = node; cursor !== null; cursor = cursor.parentElement) {
    if (cursor.hidden) return false;
  }
  return true;
}

export function createHomeController(deps: HomeControllerDeps): HomeController {
  const exposure = createExposureTracker(deps.exposure ?? {});
  const band = element('div', 'home-refresh-slots');
  band.dataset.el = 'refresh-slots';
  deps.slot.insertBefore(band, deps.insertBefore);

  const status = createRefreshStatus({ host: band, retry: () => { void controller.refresh(); } });

  const repeat = createHomeRepeat({
    top: deps.top,
    ...(deps.sync === undefined ? {} : { sync: deps.sync }),
    discover: deps.discover,
    invalidate: deps.invalidate,
    // 呈现归呈现：状态条与宿主的五态判断都由视图的 `feedback` 决定，本控制器不再第二条渲染路径。
    feedback: deps.feedback,
    now: deps.nowMillis
  });

  const pull = createPullRefresh({
    scroller: deps.scroller(),
    host: band,
    enabled: () => !repeat.busy() && !deps.blocked() && shownOnPage(deps.root),
    refresh: () => { void controller.refresh(); }
  });

  const controller: HomeController = {
    click: (target: string) => repeat.click(target),
    refresh: () => repeat.refresh(),
    interrupt: () => repeat.interrupt(),
    busy: () => repeat.busy(),
    feedback: (state: RefreshFeedback): void => status.show(state),
    observePaint(items: readonly ContentItem[]): void {
      const known = new Map(items.map((entry) => [entry.id, entry] as const));
      const targets: ExposureTarget[] = [];
      for (const node of Array.from(deps.root.querySelectorAll<HTMLElement>('.poster-card[data-content-id]'))) {
        const id = node.dataset.contentId ?? '';
        const item = known.get(id);
        if (item === undefined) continue;                                       // 骨架与身份不明：不登记
        targets.push({ node, id, item });
      }
      exposure.sync(targets);
    },
    exposed: () => exposure.exposed(),
    exposedCount: () => exposure.size(),
    destroy(): void {
      pull.destroy();
      status.destroy();
      repeat.destroy();
      exposure.destroy();
      band.remove();
    }
  };
  return controller;
}
