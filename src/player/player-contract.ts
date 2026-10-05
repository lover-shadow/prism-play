/**
 * 播放器的对外契约（类型单一来源）。
 *
 * `prism-player.ts` 负责装配与生命周期，本文件只声明它对外承诺的形状：宿主、测试替身与投屏都读这里，
 * 于是"加一条能力就要先删一行别处的"不再是因为接口和实现挤在同一只 300 行文件里。
 */
import type { EpisodeItem, PlaybackInfo, TitleDetail, TitleManifest } from '../../edge/src/types/api';
import type { PrismNativeBridge } from '../core/native/bridge';
import type { WatchHistoryRow } from '../core/storage/storage-domains';
import type { AspectOrientation } from './aspect';
import type { EngineFactory } from './engine-seam';
import type { GestureBounds } from './gestures';
import type { PlayerErrorKind } from './hud';
import type { SheetMode } from './episode-sheet';
import type { PlaybackPreferences } from './playback-rate';
import type { ProgressContext } from './progress-reporter';
import type { Clock, SleepMode } from './sleep-timer';

export type PlayerPhase = 'idle' | 'loading' | 'ready' | 'ended' | 'error' | 'destroyed';
/** Missing title manifests fall back to the existing playback endpoint. */
export interface PlayerApi { playback(episodeId: number): Promise<PlaybackInfo>; title(titleId: string): Promise<TitleDetail>; titleManifest?(workId: string): Promise<TitleManifest> }
export interface PlayerFailure { kind: PlayerErrorKind | 'media' | 'progress-blocked'; message: string }

export interface PrismPlayerOptions {
  root: HTMLElement; bridge: PrismNativeBridge; api: PlayerApi; titleId: string;
  clock?: Clock; engine?: EngineFactory; onProgress?: (row: WatchHistoryRow, context: ProgressContext) => void;
  onError?: (failure: PlayerFailure) => void;
  /** Pre-loaded detail avoids a second round trip; otherwise the player fetches `titleId` itself. */
  detail?: TitleDetail; allowShare?: boolean; onShare?: (episode: EpisodeItem) => void;
  /** AC-10 permission flag: background-audio persistence is never enabled without it. */
  allowBackgroundAudio?: boolean;
  /** 选集面板宿主（R26-05）：inline 态挂进视频下方的正文槽位，浮动态由 CSS 摘成 fixed；模式现读不自持。 */
  drawerMount?: HTMLElement; sheetMode?: () => SheetMode;
  /** 全屏态与"别的菜单开着"由宿主报给播放器：控件收起判据与菜单互斥都只认宿主的真相。 */
  fullscreen?: () => boolean; overlayOpen?: () => boolean; onOverlayOpen?(): void;
  /** Geometry override: jsdom has no layout, so integration tests inject the play-surface box. */
  measure?: () => GestureBounds; requestFrame?(callback: () => void): number; cancelFrame?(handle: number): void;
  /** 画幅嗅探出口（SPEC §1.2.1）：播放器只**报告**真实朝向，不据此锁屏或改全屏（§1.2.0 的宿主权威）。 */
  onAspect?: (orientation: AspectOrientation | null) => void;
  playbackPreferences?: PlaybackPreferences;
  onEpisodeChange?(episode: EpisodeItem): void;
  /** Host accounting resets before replacing a source; auto-next is distinct from manual selection. */
  onSourceChange?(): void;
  onNaturalBoundary?(): Promise<void>;
}

export interface PlayerState {
  phase: PlayerPhase; errorKind: PlayerErrorKind | null; episodeId: number | null; contentId: string | null;
  playing: boolean; locked: boolean; sleepMode: SleepMode; isPrivate: boolean;
  positionSeconds: number; durationSeconds: number; volume: number;
  systemVolumeSupported: boolean; brightnessSupported: boolean;
  /** 直连时正在用的线路序号（0 起）；走代理回退链时为 null——界面与遥测都据此说真话。 */
  lineIndex: number | null;
}

export interface PrismPlayer {
  load(episodeId: number, resumeSeconds?: number): Promise<void>;
  play(): void; pause(): void; destroy(): void; state(): PlayerState;
  setLocked(locked: boolean): void; scheduleSleep(mode: SleepMode): void; openDrawer(): void; closeDrawer(): void;
  /** AC-11: audio focus is the host's fact, not the page's, so the caller reports it. */
  notifyAudioFocus(focus: 'restored' | 'lost'): void; notifyLeave(): void;
  /** 视口几何变了（进出全屏、转屏）：重算画面矩形与面板模式，不触碰任何全屏通道（SPEC §1.2.0）。 */
  relayout(): void;
  setPlaybackRate(rate: number): boolean; dismissOverlay(): boolean;
}
