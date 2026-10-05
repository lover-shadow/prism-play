/**
 * 播放内核的可注入接缝（SPEC §4 / ADR-002）。
 *
 * 单独成文件的原因：`prism-player.ts` 拥有界面与手势，`art-engine.ts` 拥有第三方播放器适配，
 * 两者之间的**合同**既不属于前者也不属于后者——放进任何一方都会让另一方反过来 import 自己。
 * 合同放这里，谁都能只读它。
 *
 * §10 的 300 行红线也依赖这个拆分：`prism-player.ts` 此前把 ArtPlayer+hls.js 适配器写在同一文件里，
 * 于是每加一条能力都要先删一行别处的。
 */

/**
 * 内核向上转发的媒体事件闭集，与 `<video>` 原生事件同名（ArtPlayer 以 `video:` 前缀透传）。
 * `waiting`/`seeking` 是控件收起判据的输入（AC-19：缓冲与拖动期间控件必须留在屏幕上）。
 */
export type MediaEvent = 'ended' | 'timeupdate' | 'play' | 'playing' | 'pause' | 'waiting' | 'seeking' | 'seeked' | 'error' | 'loadedmetadata';

/**
 * 失败码闭集（A-8 / 云端 §C-4）从遥测层取用，不在这里另立一套：线路记账与内核分类必须共用同一份口径，
 * 否则"超时"会在两个文件里各自漂移成不同的字符串。
 */
import type { LineFailureCode } from '../core/native/telemetry';

/**
 * What this module drives inside ArtPlayer; a fake satisfies it under test.
 *
 * 这里**没有** `setFullscreen`：全屏不是内核的能力，它只有一个权威（`player-host.ts` 的宿主类）。
 * 旧实现有一条 `setFullscreen: (f) => { art.fullscreenWeb = f; ... }`，而 `fullscreenWeb` 的 setter 会
 * 申请浏览器 Fullscreen API，在 Android WebView 里被 Capacitor 的 `WebChromeClient` 接成原生全屏容器，
 * 与 CSS 层互不感知——那是"三重权威"里最难查的一方。内核只保留 `resize()`（重算内部尺寸）。
 */
export interface PlayerEngine {
  play(): void; pause(): void; playing(): boolean; destroy(): void;
  currentTime(): number; setCurrentTime(seconds: number): void; duration(): number;
  volume(): number; setVolume(value: number): void; setSource(url: string, mimeType?: string): void;
  toggleControls(): void; on(event: MediaEvent, handler: () => void): () => void;
  resize?(): void;
  playbackRate?(): number; setPlaybackRate?(rate: number): void;
  /**
   * 直连上游之后（A-7），切线与遥测都需要知道这一跳是怎么死的：超时、HTTP 失败还是解码失败。
   * 可选是因为不是每个内核都分得出来——假内核与降级路径没有这个信息，缺席即按 `http_error` 记账。
   */
  failureCode?(): LineFailureCode | null;
}

export interface EngineContext {
  container: HTMLDivElement; theme: string; poster?: string;
  /** 第二条实参是内核分得出的失败类型（hls fatal 明细 / `MediaError.code`）；分不出来时为 undefined。 */
  onError(message: string, failureCode?: LineFailureCode): void;
}
export type EngineFactory = (context: EngineContext) => PlayerEngine | Promise<PlayerEngine>;
