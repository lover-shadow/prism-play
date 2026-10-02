/**
 * 《光影Play》全手势播放器宿主（SPEC §4 / §7 / AC-06…AC-11 / AC-15）。
 * ArtPlayer + hls.js carry the media plumbing; this file owns what ADR-002 says they do not provide: the
 * gesture HUDs (system volume and window brightness reach the OS through `PrismNativeBridge`, so only a
 * device can prove them), double-tap seek, sleep timer, touch lock, episode drawer, call interruption and
 * the honest error states. `PlayerEngine` is injectable — the default factory lazy-imports ArtPlayer and
 * hls.js, tests hand in a fake. SPEC §10 caps a file at 300 lines: overlays live in `hud.ts`, yield
 * policies in `sleep-timer.ts`, episode/断点 bookkeeping in `episode-drawer.ts`.
 */
/// <reference types="vite/client" />
import './player.css';
import { createArtEngine } from './art-engine';
import type { EngineFactory, MediaEvent, PlayerEngine } from './engine-seam';
import { probeStageOrientation, type AspectOrientation } from './aspect';
import type { EpisodeItem, PlaybackInfo, TitleDetail } from '../../edge/src/types/api';
import { ApiError } from '../core/api/client';
import { icon } from '../components/icons';
import type { PrismNativeBridge } from '../core/native/bridge';
import { isPrivateSubject, type WatchHistoryRow } from '../core/storage/storage-domains';
import { createEpisodeDrawer, createProgressReporter } from './episode-drawer';
import type { ProgressContext } from './episode-drawer';
import { attachGestureLayer, clamp, createGestureController } from './gestures';
import type { GestureBounds, GestureController, ValueChannel } from './gestures';
import { createGestureHud, createPlayerChrome, createStateOverlay } from './hud';
import type { PlayerErrorKind } from './hud';
import { createCallInterruptPolicy, createSleepTimer, SLEEP_CHOICES, SLEEP_LABELS, systemClock } from './sleep-timer';
import type { Clock, SleepMode } from './sleep-timer';

export type PlayerPhase = 'idle' | 'loading' | 'ready' | 'ended' | 'error' | 'destroyed';
export interface PlayerApi { playback(episodeId: number): Promise<PlaybackInfo>; title(titleId: string): Promise<TitleDetail> }
export interface PlayerFailure { kind: PlayerErrorKind | 'media' | 'progress-blocked'; message: string }

export interface PrismPlayerOptions {
  root: HTMLElement; bridge: PrismNativeBridge; api: PlayerApi; titleId: string;
  clock?: Clock; engine?: EngineFactory; onProgress?: (row: WatchHistoryRow, context: ProgressContext) => void;
  onError?: (failure: PlayerFailure) => void;
  /** Pre-loaded detail avoids a second round trip; otherwise the player fetches `titleId` itself. */
  detail?: TitleDetail; allowShare?: boolean; onShare?: (episode: EpisodeItem) => void;
  /** AC-10 permission flag: background-audio persistence is never enabled without it. */
  allowBackgroundAudio?: boolean;
  /** Geometry override: jsdom has no layout, so integration tests inject the play-surface box. */
  measure?: () => GestureBounds; requestFrame?(callback: () => void): number; cancelFrame?(handle: number): void;
  /**
   * 画幅嗅探出口（SPEC §1.2.1）：元数据就绪后报告真实画幅朝向。
   * 播放器只**报告**，不据此锁屏或改全屏——方向锁与全屏态都是宿主的权威范围（§1.2.0）。
   */
  onAspect?: (orientation: AspectOrientation | null) => void;
}
export interface PlayerState {
  phase: PlayerPhase; errorKind: PlayerErrorKind | null; episodeId: number | null; contentId: string | null;
  playing: boolean; locked: boolean; sleepMode: SleepMode; isPrivate: boolean;
  positionSeconds: number; durationSeconds: number; volume: number;
  systemVolumeSupported: boolean; brightnessSupported: boolean;
}
export interface PrismPlayer {
  load(episodeId: number, resumeSeconds?: number): Promise<void>;
  play(): void; pause(): void; destroy(): void; state(): PlayerState;
  setLocked(locked: boolean): void; scheduleSleep(mode: SleepMode): void; openDrawer(): void; closeDrawer(): void;
  /** AC-11: audio focus is the host's fact, not the page's, so the caller reports it. */
  notifyAudioFocus(focus: 'restored' | 'lost'): void; notifyLeave(): void;
  /** 视口几何变了（进出全屏、转屏）：只让内核重算内部尺寸，不触碰任何全屏通道（SPEC §1.2.0）。 */
  relayout(): void;
}

const errorKindOf = (error: unknown): PlayerErrorKind =>
  error instanceof ApiError ? (error.treatedAsMissing ? 'missing' : error.code === 'NETWORK_ERROR' ? 'offline' : 'retryable') : 'retryable';

export function createPlayer(options: PrismPlayerOptions): PrismPlayer {
  const clock = options.clock ?? systemClock;
  const { bridge, api, root } = options;
  const disposers: (() => void)[] = [];
  const bound: Array<[EventTarget, string, EventListener]> = [];
  let mediaOff: (() => void)[] = [];
  let engine: PlayerEngine | null = null, detail: TitleDetail | null = options.detail ?? null, episodeId: number | null = null;
  let phase: PlayerPhase = 'idle', errorKind: PlayerErrorKind | null = null;
  let locked = false, destroyed = false, token = 0, backgroundAudioOn = false;
  let systemVolumeSupported = false, brightnessSupported = false;
  const listen = (target: EventTarget, type: string, handler: EventListener): void => { target.addEventListener(type, handler); bound.push([target, type, handler]); };
  const report = (failure: PlayerFailure): void => void options.onError?.(failure);
  const msg = (error: unknown): string => String(error instanceof Error ? error.message : error);
  const episodeNumber = (): number => detail?.episodes.find((item) => item.episodeId === episodeId)?.episodeNumber ?? 0;
  /** The surface box already excludes both control bands through CSS, so the classifier sees zero bands. */
  const readSurface = (): GestureBounds => { const r = chrome.surface.getBoundingClientRect(); return { width: r.width, height: r.height, top: r.top, left: r.left, topBandPx: 0, bottomBandPx: 0 }; };

  root.classList.add('prism-player');
  const backdrop = document.createElement('div'), speedPill = document.createElement('div'), pulse = document.createElement('div');
  backdrop.className = 'prism-player__backdrop';
  if (detail?.item.coverUrl) backdrop.innerHTML = `<img class="prism-player__backdrop-img" src="${detail.item.coverUrl}" alt="" /><div class="prism-player__backdrop-glow"></div>`;
  pulse.className = 'prism-player__pulse'; pulse.innerHTML = icon('play', { size: 24 }); pulse.addEventListener('click', () => { engine?.play(); });
  speedPill.className = 'prism-player__speed-pill'; speedPill.innerHTML = '<span>▶▶</span><span>2.0X 极速快进</span>';
  root.append(backdrop, pulse, speedPill);
  const overlay = createStateOverlay(root);
  const hud = createGestureHud(root, clock);
  const chrome = createPlayerChrome(root, (action) => {
    if (action === 'lock') setLocked(!locked);
    else if (action === 'list' && detail !== null && episodeId !== null) drawer.open(detail, episodeId);
    else {
      const cycle: SleepMode[] = ['off', ...SLEEP_CHOICES];
      scheduleSleep(cycle[(cycle.indexOf(sleep.mode()) + 1) % cycle.length] ?? 'off');
    }
  });
  const progress = createProgressReporter({
    clock, detail: () => detail, episodeId: () => episodeId, onProgress: options.onProgress,
    position: () => engine?.currentTime() ?? 0, duration: () => engine?.duration() ?? 0,
    onBlocked: (message) => report({ kind: 'progress-blocked', message })
  });
  const interruption = createCallInterruptPolicy({
    playing: () => engine?.playing() ?? false, position: () => engine?.currentTime() ?? 0, pause: () => engine?.pause(),
    resume: (position) => { engine?.setCurrentTime(position); engine?.play(); }
  });
  const drawer = createEpisodeDrawer({
    root, onSelect: (id) => void load(id, 0), onClose: () => undefined, allowShare: options.allowShare,
    onShare: options.onShare, allowBackgroundAudio: options.allowBackgroundAudio, backgroundAudioEnabled: () => backgroundAudioOn,
    onBackgroundAudioToggle: (enabled) => {
      if (options.allowBackgroundAudio !== true) return;
      backgroundAudioOn = false;
      if (enabled) ensureBackgroundAudio(); else void bridge.stopBackgroundAudio();
    }
  });
  const sleep = createSleepTimer(clock, { getVolume: () => engine?.volume() ?? 1, setVolume: (v) => engine?.setVolume(v), stop: () => releaseHandle('sleep') });
  const gesture: GestureController = createGestureController({
    clock, measure: options.measure ?? readSurface, isLocked: () => locked || destroyed,
    currentTime: () => engine?.currentTime() ?? 0, duration: () => engine?.duration() ?? 0,
    isSurface: (target) => !(target instanceof Element && target.closest('[data-prism-ui]') !== null),
    requestFrame: options.requestFrame, cancelFrame: options.cancelFrame,
    onVolume: (value) => void applyChannel('volume', value), onBrightness: (value) => void applyChannel('brightness', value),
    onSeek: (delta) => { if (engine !== null && delta !== 0) engine.setCurrentTime(engine.currentTime() + delta); },
    onTap: () => { engine?.toggleControls(); chrome.setVisible(!chrome.el.classList.contains('is-visible')); }
  });
  disposers.push(attachGestureLayer(chrome.surface, gesture).destroy);
  disposers.push(bridge.onCallState((state) => { if (!destroyed) interruption.onCallState(state); }));
  listen(overlay.retryButton, 'click', () => { if (episodeId !== null) void load(episodeId, engine?.currentTime() ?? 0); });
  render();

  function render(): void {
    const left = sleep.remainingMs();
    const label = SLEEP_LABELS[sleep.mode()];
    chrome.render({ title: detail?.item.title ?? '', locked, sleeping: sleep.mode() !== 'off', sleepLabel: left === null ? label : `${label} · ${Math.ceil(left / 60_000)}` });
  }

  function ensureBackgroundAudio(): void {
    if (options.allowBackgroundAudio !== true || backgroundAudioOn) return;
    backgroundAudioOn = true;
    void bridge.startBackgroundAudio(detail?.item.title ?? '', `第 ${episodeNumber()} 集`).catch(() => void (backgroundAudioOn = false));
  }

  /** AC-06/07: the number states what really moved; `supported` only says whether the OS moved. */
  async function applyChannel(channel: ValueChannel, value: number): Promise<void> {
    if (channel === 'brightness') {
      const applied = await bridge.setBrightness(value);
      brightnessSupported = applied.supported;
      return hud.show({ kind: 'brightness', value: applied.brightness, supported: applied.supported });
    }
    // AC-06 on the web: only the element's own gain moves, and the HUD states that instead of lying.
    if (!systemVolumeSupported) {
      engine?.setVolume(value);
      return hud.show({ kind: 'volume', value, supported: false });
    }
    const applied = await bridge.setSystemVolume(value);
    systemVolumeSupported = applied.supported;
    if (!applied.supported) engine?.setVolume(value);
    hud.show({ kind: 'volume', value: applied.volume, supported: applied.supported });
  }

  async function onEnded(): Promise<void> {
    const episodes = detail?.episodes ?? [];
    const index = Math.max(0, episodes.findIndex((item) => item.episodeId === episodeId));
    progress.emit(true);
    phase = 'ended';
    if (sleep.onEpisodeEnded({ episodeIndex: index, episodeTotal: episodes.length }) === 'stop') releaseHandle('sleep');
    else if (episodes[index + 1] !== undefined) await load(episodes[index + 1].episodeId, 0);
  }

  function handleMediaEvent(event: MediaEvent): void {
    if (destroyed || engine === null) return;
    if (event === 'play') { root.classList.add('is-playing'); interruption.noteUserAction(); void bridge.setKeepScreenOn(true); ensureBackgroundAudio(); }
    else if (event === 'pause') { root.classList.remove('is-playing'); if (!interruption.pausingForCall()) interruption.noteUserAction(); progress.emit(true); }
    else if (event === 'timeupdate') { if (progress.due()) progress.emit(); }
    else if (event === 'error') { root.classList.remove('is-playing'); phase = 'error'; errorKind = 'retryable'; overlay.show('retryable'); report({ kind: 'media', message: '播放失败' }); }
    // 必须显式一条分支：`loadedmetadata` 落到末尾的 `else` 会被当成 `ended`，于是每集刚出画面就自动跳下一集。
    else if (event === 'loadedmetadata') options.onAspect?.(probeStageOrientation(chrome.stage));
    else void onEnded();
  }

  async function ensureEngine(): Promise<PlayerEngine> {
    if (engine !== null) return engine;
    const theme = getComputedStyle(document.documentElement).getPropertyValue('--player-accent').trim();
    engine = await (options.engine ?? createArtEngine)({
      container: chrome.stage, theme, poster: detail?.item.coverUrl, onError: (message) => report({ kind: 'media', message })
    });
    const live = engine;
    mediaOff = (['ended', 'timeupdate', 'play', 'pause', 'error', 'loadedmetadata'] as const).map((event) => live.on(event, () => handleMediaEvent(event)));
    const [volume, brightness] = await Promise.all([bridge.getSystemVolume(), bridge.getBrightness()]);
    systemVolumeSupported = volume.supported; brightnessSupported = brightness.supported;
    gesture.seed('volume', volume.supported ? volume.volume : live.volume());
    gesture.seed('brightness', brightness.brightness);
    return live;
  }

  /** AC-09 归零瞬间：暂停并释放播放句柄（hls 实例与 MediaSource 一并解除）。 */
  function releaseHandle(reason: 'sleep' | 'destroy'): void {
    const live = engine;
    engine = null;
    for (const off of mediaOff.splice(0)) off();
    if (live !== null) { live.pause(); live.setSource(''); live.destroy(); }
    void bridge.setKeepScreenOn(false);
    if (backgroundAudioOn) { backgroundAudioOn = false; void bridge.stopBackgroundAudio(); }
    if (reason === 'sleep') phase = 'idle';
  }

  async function load(id: number, resumeSeconds = 0): Promise<void> {
    if (destroyed) return;
    token += 1;
    const mine = token;
    episodeId = id; phase = 'loading'; errorKind = null;
    overlay.show('loading');
    if (detail === null) {
      detail = await api.title(options.titleId).catch((error: unknown) => (report({ kind: 'retryable', message: `选集清单加载失败：${msg(error)}` }), null));
    }
    const live = await ensureEngine();
    try {
      const info: PlaybackInfo = await api.playback(id);
      if (mine !== token || destroyed) return;
      overlay.hide();
      live.setSource(info.url, info.mimeType);
      const duration = info.durationSeconds ?? 0;
      if (resumeSeconds > 0) live.setCurrentTime(duration > 0 ? clamp(resumeSeconds, 0, duration) : resumeSeconds);
      phase = 'ready';
      render();
      if (drawer.isOpen()) drawer.refresh(id);
      progress.emit(true);
    } catch (error) {
      // 私密与未知剧目共用同一份文案与同一套 UI，不泄露任何元信息（AC-02-6 / AC-15）。
      if (mine !== token || destroyed) return;
      phase = 'error'; errorKind = errorKindOf(error); overlay.show(errorKind);
      report({ kind: errorKind, message: msg(error) });
    }
  }

  const setLocked = (v: boolean): void => { locked = v; render(); }; const scheduleSleep = (m: SleepMode): void => { sleep.schedule(m); render(); };

  return {
    load, play: () => engine?.play(), pause: () => { progress.emit(true); engine?.pause(); },
    setLocked, scheduleSleep, closeDrawer: () => drawer.close(),
    openDrawer: () => { if (detail !== null && episodeId !== null) drawer.open(detail, episodeId); },
    notifyAudioFocus: (value) => interruption.audioFocus(value), notifyLeave: () => { interruption.noteUserAction(); progress.emit(true); },
    relayout: () => engine?.resize?.(),
    state: (): PlayerState => ({
      phase, errorKind, episodeId, contentId: detail?.item.id ?? null, playing: engine?.playing() ?? false,
      locked, sleepMode: sleep.mode(), isPrivate: isPrivateSubject(detail?.item ?? {}),
      positionSeconds: engine?.currentTime() ?? 0, durationSeconds: engine?.duration() ?? 0,
      volume: engine?.volume() ?? 1, systemVolumeSupported, brightnessSupported
    }),
    destroy: () => {
      if (destroyed) return;
      destroyed = true; phase = 'destroyed'; token += 1; progress.emit(true);
      sleep.destroy(); gesture.destroy(); hud.destroy(); drawer.destroy(); overlay.destroy(); chrome.destroy();
      for (const [target, type, handler] of bound) target.removeEventListener(type, handler);
      bound.length = 0;
      for (const dispose of disposers.splice(0)) dispose();
      releaseHandle('destroy');
    }
  };
}
