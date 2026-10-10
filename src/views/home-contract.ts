/**
 * 首页视图的对外契约（HOME-PLAYER-REPAIR-SPEC-AND-PLAN §2.2 模块责任表 / §4.1 B4·B5 行）。
 *
 * 拆出这一件的唯一理由是 §10 的 300 行红线：组合根本体只管装配，契约形状与装配混在一起时，
 * 每次给首页加一条注入缝都要挤占装配行数。类型仍然由 `home-view.ts` 原样再导出，
 * 导入面（`import type { HomeApi } from './home-view'`）一字不变，本文件不是第二套契约。
 */

import type { CatalogResponse, ChannelItem, ChannelsResponse, ContentItem } from '../../edge/src/types/api';
import type { SnapshotState } from '../core/catalog-cache';
import type { WatchHistoryRow } from '../core/storage/storage-domains';
import type { HomeRoundRecord, ReputationOf } from '../core/home-recommendation';
import type { PosterMode } from '../core/state/theme';
import type { ExposureDeps } from './home-exposure';
import type { RefreshFeedback } from './home-repeat';

/** 主视图实际消费的两个端点：组合根注入的是"快照优先"门面（AC-01 / AC-18），视图不该看见它拿不到的端点。 */
export interface HomeApi {
  channels(): Promise<ChannelsResponse>;
  catalog(input: { channel: string; category?: string; page?: number; pageSize?: number; revision?: number }): Promise<CatalogResponse>;
  /** 可选的本地快照读取门面：0ms 同步读取已持久化的频道与剧目，供启动立刻展示。 */
  cachedSnapshot?(): HomeSnapshot;
}

export interface HomeSnapshot {
  channels: ChannelsResponse | null;
  items(channel: string): ContentItem[];
  /** HP-05 输入记录的事实来源：快照覆盖度与修订；未注入即按"部分覆盖"如实降级，不夸口成全库。 */
  state?(): SnapshotState | null;
}

export interface HomeViewDeps {
  api: HomeApi;
  root: HTMLElement;
  /** 外壳顶栏工具槽，缺省时排版器退回视图内。 */
  headerAccessory?: HTMLElement | null;
  posterMode: () => PosterMode;
  onPosterModeChange: (mode: PosterMode) => void;
  onOpenTitle: (contentId: string, item?: ContentItem) => void;
  onResume: (row: WatchHistoryRow) => void;
  historyPreview: () => Promise<WatchHistoryRow[]>;
  /** 回传当前频道供宿主挂/摘 FLAG_SECURE（AC-02-4）；综合首页不是频道，回 null 即公开态。 */
  onChannelChange?: (channel: ChannelItem | null) => void;
  pageSize?: number;
  /** 打开全屏搜索 Overlay（A-3：搜索不再是 Tab）。未注入则整条搜索栏不渲染，不做只长样子的控件。 */
  onSearch?: () => void;
  /** main 注入真实目录同步；resolve 必须在新快照提交后。未注入则直接重读 api（本地门面可能仅缓存）。 */
  syncCatalog?: () => Promise<void>;
  /** HP-05 画像衰减的时钟注入点：引擎不自取时钟，同输入必同输出。 */
  nowSeconds?: () => number;
  /** HP-05 口碑证据接缝：生产缺省即"仓库无口碑字段"的诚实状态；B3 交付证据字段后由此注入。 */
  reputationOf?: ReputationOf;
  /** HP-06a 重复点击时间窗的时钟注入点：实现不自行取时钟，单测用它推进窗外判定。 */
  nowMillis?: () => number;
  /** HP-06c 曝光判定注入点（观察器替身/停留计时/前台判定）；未注入即走宿主真实 IntersectionObserver。 */
  exposure?: ExposureDeps;
  /** HP-06b 刷新反馈的旁路口：状态条已如实呈现，宿主可另做轻提示或诊断，但不改写文案。 */
  onFeedback?: (state: RefreshFeedback) => void;
}

export interface HomeView {
  mount: () => Promise<void>;
  /** HP-06：显式发现刷新的唯一入口（重复点击、顶部下拉与宿主 reload 都汇到这里）。 */
  refresh: () => Promise<void>;
  setPosterMode: (mode: PosterMode) => void;
  /** 触底续载的唯一入口：哨兵与调用方共用同一条路径，不留第二套翻页语义。 */
  loadMore: () => void;
  /** 宿主离页、打开 Overlay/播放器或其他导航时调用，打断重复序列并废弃在途视图结果。 */
  interruptNavigation: () => void;
  /** HP-05 输入记录：轮次号、内容 revision、候选覆盖、证据与逐轨 requested/actual/deviation。 */
  recommendationRecord: () => HomeRoundRecord | null;
  /** 背景同步的唯一入口：同修订不重排已展示条目；显式发现刷新只走 `refresh()`（HP-06b）。 */
  syncRecommendation: () => Promise<void>;
  destroy: () => void;
}
