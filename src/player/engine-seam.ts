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

export type MediaEvent = 'ended' | 'timeupdate' | 'play' | 'pause' | 'error' | 'loadedmetadata';

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
}

export interface EngineContext { container: HTMLDivElement; theme: string; poster?: string; onError(message: string): void }
export type EngineFactory = (context: EngineContext) => PlayerEngine | Promise<PlayerEngine>;
