/**
 * 首页两条 feed 的共同契约（HP-04：综合首页与真实频道目录共用同一个视图回口）。
 *
 * 拆这一层只为 §10 的 300 行红线与"一条渲染路径"两个目的：综合首页与频道目录**必须**共用同一套
 * 五态、哨兵放行与代次核对语义，否则会出现"首页能返回、频道不能"这类分叉缺陷。契约里没有任何
 * 第二套翻页口径：`page / revision / 游标` 的语义仍归各自实现，但视图回口只有一个。
 */

import type { ContentItem } from '../../edge/src/types/api';
import type { BadgeKind } from '../core/recommendation';
import type { ViewStateKind } from '../components/state-views';

export interface FeedStateOptions {
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
}

/** 视图交给 feed 的六个回口：feed 不碰 DOM、不自己判定私密、也不另开一条网络路径。 */
export interface FeedContext {
  paint(items: readonly ContentItem[], badges: ReadonlyMap<string, BadgeKind>): void;
  state(kind: ViewStateKind, options?: FeedStateOptions): void;
  /** 错误态的唯一入口：五态种类与详情文案都由视图统一判定，两条 feed 不得各写一套口径。 */
  fail(error: unknown, retry: () => void): void;
  skeleton(): void;
  /** 尾部哨兵是否处于"正在等下一页"：挂起期间不许重复放行。 */
  pending(pending: boolean): void;
  recheck(): void;
  /** 代次核对：导航/销毁之后的迟到结果一律不回写（AC-21 与 HP-03 的同一口径）。 */
  isCurrent(token: number): boolean;
  /** HP-06c：本机内已"真实可见"过的公开作品。feed 只读它，绝不把它当画像分，也不落任何存储。 */
  exposed(): ReadonlySet<string>;
}

/**
 * HP-06b：一次显式刷新的如实回执。
 * `changed` 只说"可见序列是否真的变了"，`exhausted` 说"未看过的候选是否已不足以铺满一页"——
 * 两者都不成立时必须回答"没有新内容"，绝不谎称已更新，也不靠随机洗牌制造假的新意。
 */
export interface DiscoveryReport {
  changed: boolean;
  candidates: number;
  delivered: number;
  exhausted: boolean;
  /**
   * 本范围候选读取时的网络故障。本地重排成功也必须把这条单独带出来：
   * §HP-06「联网同步失败与本地推荐成功分别反馈」，不许合成一句"已更新"。
   */
  error?: unknown;
}

export interface HomeFeed {
  /** `append === false` 是范围加载（重新累积第 1 页）；`true` 是尾块追加，不回算前页。 */
  load(token: number, append: boolean): Promise<void>;
  /**
   * HP-06：显式刷新的唯一发现入口——本范围候选的**发现 feed 重选**（结合画像与真实曝光），
   * 既不是公共热门榜的随机洗牌，也不只是把修订号同步一遍。抛错即"本地也排不出来"，由上层如实反馈。
   */
  restart(token: number): Promise<DiscoveryReport>;
  canLoadMore(): boolean;
  /** 榜单与诊断的唯一读面：feed 自己决定"这一范围内该看哪些条目"。 */
  rankingsItems(): ContentItem[];
  /** 当前范围是否已经有可显示内容：决定要不要铺骨架屏，也决定刷新时是否保留现有片单。 */
  hasContent(): boolean;
  /** 落五态时的挂起：哨兵从此不再放行，但已累积条目不清（重试沿用同一条读面）。 */
  suspend(): void;
  /** 切范围/销毁前的清空：不留上一范围的累积条目。 */
  reset(): void;
}
