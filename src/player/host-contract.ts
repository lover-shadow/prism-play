/**
 * 播放宿主的公共接缝（SPEC §10 的 300 行红线切分，字段含义与行为逐条未改）：
 * 组合根 `main.ts` 与端侧测试只通过这三个接口认识播放器宿主，宿主内部状态机不外泄。
 */
import type { ContentItem, EpisodeItem, RelatedResponse } from '../../edge/src/types/api';
import type { PrismNativeBridge } from '../core/native/bridge';
import type { WatchHistoryRow } from '../core/storage/storage-domains';
import type { OrientationPort } from '../core/native/orientation';
import type { ExitReport } from '../core/user-sync';
import type { NotificationAction } from '../core/native/capacitor-bridge';
import type { RuntimeServices } from '../core/runtime-services';
import type { TitleFactsStore } from '../core/api/title-facts';
import type { PlayerApi, PrismPlayer } from './prism-player';
import type { EngineFactory } from './engine-seam';
import type { ProgressContext } from './progress-reporter';

export interface PlayerHostApi extends PlayerApi {
  related?(titleId: string): Promise<RelatedResponse>;
}

/** W1 渐进详情：卡片预填仅允许携带卡片已展示的合法公开字段，不伪造分集/线路。 */
export interface OpenCandidate {
  title?: string;
  coverUrl?: string;
}

export interface OpenOptions {
  /** 卡片预填（可选）；缺席时首个 await 前仍是零元信息壳。 */
  candidate?: OpenCandidate;
  /** 换季切换：复用当前壳层与舞台（内部使用，不作为公开入口语义）。 */
  retainStage?: boolean;
}

export interface PlayerHostDeps {
  /** 浮层挂到这里（通常是 `.app-shell`，让 safe-area 与 `--native-dim` 继续生效）。 */
  mount: HTMLElement;
  bridge: PrismNativeBridge;
  api: PlayerHostApi;
  /** 进度落库路由由组合根提供：私密内容必须进内存域，这条分支不许出现在宿主里重复实现。 */
  onProgress(row: WatchHistoryRow, context: ProgressContext): void;
  /** AC-10 权限位：未开启"后台/息屏播放"时播放器不得拉起前台服务。 */
  allowBackgroundAudio(): boolean;
  onShare?(item: ContentItem, episode: EpisodeItem): void;
  /** 私密断点路由失败之类的闸门拒绝原因（播放器已自行渲染其余错误态）。 */
  onBlocked?(message: string): void;
  /** 每次私密性落定后回调，由组合根合并频道状态再决定 FLAG_SECURE。 */
  onPrivacyChange(isPrivate: boolean): void;
  /** §1.9.3 退出载荷就地定格，交同步中枢判私密与落队列。 */
  onExit?(report: ExitReport): void;
  onClose?(): void;
  /** HP-03：这是"来自卡片的候选标题"，属受保护元信息，只在详情身份核验通过后才允许进 DOM。 */
  titleOf?(): string;
  /** W1 统一事实缓存（测试注入或跨层共享；缺省由宿主按 api 能力自建）。 */
  facts?: TitleFactsStore;
  /** 播放内核工厂是公开接缝（默认为 ArtPlayer+hls.js）：真机之外的装配与集成测试由此注入替身。 */
  engine?: EngineFactory;
  /** AC-20 方向端口：Web 自动降级，注入端口验证锁/解时序，真机验证旋转。 */
  orientation?: OrientationPort;
  playbackPreferences?: import('./playback-rate').PlaybackPreferences;
  following?: import('../core/storage/following-store').FollowingStore;
  seriesItems?(): readonly ContentItem[];
  supplementSeries?(item: ContentItem, onUpdated: () => void): void;
  runtime?: RuntimeServices;
  onRedeem?(): void;
}

export interface PlayerHost {
  open(contentId: string, resume?: WatchHistoryRow, options?: OpenOptions): Promise<boolean>;
  close(): void;
  /** HP-03：loading 期即为真——"有没有一层挡住首页"与"内核是否已装配"是两件事，不该混为一谈。 */
  isOpen(): boolean;
  playingPrivateContent(): boolean;
  onNotification(action: NotificationAction): void;
  suspend(): void;
  state(): ReturnType<PrismPlayer['state']> | null;
}
