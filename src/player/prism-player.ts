/** Player orchestration: injectable media engine, native gestures, overlays and episode state. */
/// <reference types="vite/client" />
import './player.css';
import { createPlaybackRate } from './playback-rate';
import { createArtEngine } from './art-engine';
import type { MediaEvent, PlayerEngine } from './engine-seam';
import { probeStageOrientation } from './aspect';
import type { TitleDetail } from '../../edge/src/types/api';
import { ApiError } from '../core/api/client';
import { icon } from '../components/icons';
import { isPrivateSubject } from '../core/storage/storage-domains';
import { createEpisodeDrawer } from './episode-drawer';
import { createEndedGuard } from './ended-guard';
import { createProgressReporter } from './progress-reporter';
import { createControlsIdle } from './controls-idle';
import { updateMediaFrame } from './media-frame';
import { createLineFallback } from './line-fallback';
import { createLineRunner, type Surface } from './line-runner';
import { usesLocalEpisodeIds } from '../core/api/title-detail';
import { createTitleManifestStore, installTitleManifestStore } from './title-manifest';
import { attachGestureLayer, createGestureController } from './gestures';
import type { GestureBounds, GestureController } from './gestures';
import { createGestureHud, createPlayerChrome, createStateOverlay } from './hud';
import type { PlayerErrorKind } from './hud';
import { createCallInterruptPolicy, createSleepTimer, SLEEP_CHOICES, SLEEP_LABELS, systemClock } from './sleep-timer';
import type { SleepMode } from './sleep-timer';
import { createValueChannels } from './value-channel';
import type { PlayerFailure, PlayerPhase, PrismPlayer, PrismPlayerOptions, PlayerState } from './player-contract';
export type { PlayerApi, PlayerFailure, PlayerPhase, PrismPlayer, PrismPlayerOptions, PlayerState } from './player-contract';
const errorKindOf = (error: unknown): PlayerErrorKind => error instanceof ApiError ? (error.treatedAsMissing ? 'missing' : error.code === 'NETWORK_ERROR' ? 'offline' : 'retryable') : 'retryable';
export function createPlayer(options: PrismPlayerOptions): PrismPlayer {
  const clock = options.clock ?? systemClock;
  const { bridge, api, root } = options;
  const disposers: (() => void)[] = [];
  const bound: Array<[EventTarget, string, EventListener]> = [];
  let mediaOff: (() => void)[] = [];
  let engine: PlayerEngine | null = null, detail: TitleDetail | null = options.detail ?? null, episodeId: number | null = null;
  let phase: PlayerPhase = 'idle', errorKind: PlayerErrorKind | null = null;
  let locked = false, destroyed = false, token = 0, backgroundAudioOn = false;
  /** 正在播的直连线路序号；null 即本轮走的是代理回退链（旧云端未切完时就是它）。 */
  let direct: number | null = null;
  let mediaGeneration = 0, savedVolume = 1;
  const guard = createEndedGuard(() => mediaGeneration);
  const listen = (target: EventTarget, type: string, handler: EventListener): void => { target.addEventListener(type, handler); bound.push([target, type, handler]); };
  const report = (failure: PlayerFailure): void => void options.onError?.(failure);
  const msg = (error: unknown): string => String(error instanceof Error ? error.message : error);
  const episodeNumber = (): number => detail?.episodes.find((item) => item.episodeId === episodeId)?.episodeNumber ?? 0;
  /** The surface box already excludes both control bands through CSS, so the classifier sees zero bands. */
  const readSurface = (): GestureBounds => { const r = chrome.surface.getBoundingClientRect(); return { width: r.width, height: r.height, top: r.top, left: r.left, topBandPx: 0, bottomBandPx: 0 }; };
  root.classList.add('prism-player');
  const backdrop = document.createElement('div'), speedPill = document.createElement('div'), pulse = document.createElement('div');
  backdrop.className = 'prism-player__backdrop'; speedPill.className = 'prism-player__speed-pill';
  if (detail?.item.coverUrl) backdrop.innerHTML = `<img class="prism-player__backdrop-img" src="${detail.item.coverUrl}" alt="" /><div class="prism-player__backdrop-glow"></div>`;
  pulse.className = 'prism-player__pulse'; pulse.innerHTML = icon('play', { size: 24 }); pulse.addEventListener('click', () => { engine?.play(); });
  root.append(backdrop, pulse, speedPill);
  const overlay = createStateOverlay(root);
  const hud = createGestureHud(root, clock);
  const chrome = createPlayerChrome(root, (action) => {
    if (action === 'lock') setLocked(!locked);
    else if (action === 'list') openDrawer();
    else {
      const cycle: SleepMode[] = ['off', ...SLEEP_CHOICES];
      scheduleSleep(cycle[(cycle.indexOf(sleep.mode()) + 1) % cycle.length] ?? 'off');
    }
  });
  const currentEpisodeId = (): number | null => episodeId;
  const progress = createProgressReporter({
    clock, detail: () => detail, episodeId: currentEpisodeId, sourceEpisodeId: () => guard.loadedEpisodeId(),
    hasBoundSource: () => guard.ownsReading(episodeId), onProgress: options.onProgress,
    position: () => engine?.currentTime() ?? 0, duration: () => engine?.duration() ?? 0,
    onBlocked: (message) => report({ kind: 'progress-blocked', message })
  });
  const interruption = createCallInterruptPolicy({
    playing: () => engine?.playing() ?? false, position: () => engine?.currentTime() ?? 0, pause: () => engine?.pause(),
    resume: (position) => { engine?.setCurrentTime(position); engine?.play(); }
  });
  const drawer = createEpisodeDrawer({
    root, mount: options.drawerMount, mode: options.sheetMode, onSelect: (id) => void load(id, 0), onClose: () => relayout(),
    onOpen: () => { options.onOverlayOpen?.(); relayout(); }, allowShare: options.allowShare,
    onShare: options.onShare, allowBackgroundAudio: options.allowBackgroundAudio, backgroundAudioEnabled: () => backgroundAudioOn,
    onBackgroundAudioToggle: (enabled) => {
      if (options.allowBackgroundAudio !== true) return;
      backgroundAudioOn = false;
      if (enabled) ensureBackgroundAudio(); else void bridge.stopBackgroundAudio();
    }
  });
  const rate = createPlaybackRate({ root, surface: chrome.surface, pill: speedPill, clock, engine: () => engine, locked: () => locked || destroyed,
    preferences: options.playbackPreferences, onHold: () => gesture.cancel(), onError: (message) => report({ kind: 'media', message }),
    beforeOpen: () => { drawer.close(); options.onOverlayOpen?.(); } });
  chrome.el.append(rate.button);
  // 全屏才收起控件：详情台的工具栏是那一屏唯一的控制面，收掉等于没有控制面（AC-19）。
  const idle = createControlsIdle({
    clock, playing: () => engine?.playing() ?? false, fullscreen: options.fullscreen ?? (() => false),
    visible: () => chrome.el.classList.contains('is-visible'), setVisible: (on) => chrome.setVisible(on),
    blocked: () => drawer.isOpen() || rate.isOpen() || (options.overlayOpen?.() ?? false)
  });
  const sleep = createSleepTimer(clock, { getVolume: () => engine?.volume() ?? savedVolume, setVolume: (v) => { savedVolume = v; engine?.setVolume(v); }, stop: () => releaseHandle('sleep') });
  /** 剧集清单（§2.2）的进程内唯一缓存：装成"当前生效的那只"，投屏侧因此不必再造一份 api 客户端重拉清单。 */
  const manifests = installTitleManifestStore(createTitleManifestStore({ api }));
  const lines = createLineFallback({ workId: () => options.titleId, privacy: () => ({ isPrivate: detail?.item.isPrivate, channelId: detail?.item.channelId }) });
  const runner = createLineRunner({ api, manifests, lines, engine: () => engine, clock, workId: () => options.titleId, episodeNumber, localEpisodeIds: () => usesLocalEpisodeIds(detail) });
  const channels = createValueChannels({ bridge, hud, engine: () => engine, seed: (channel, value) => gesture.seed(channel, value) });
  const gesture: GestureController = createGestureController({
    clock, measure: options.measure ?? readSurface, isLocked: () => locked || destroyed,
    currentTime: () => engine?.currentTime() ?? 0, duration: () => engine?.duration() ?? 0,
    isSurface: (target) => !(target instanceof Element && target.closest('[data-prism-ui]') !== null),
    requestFrame: options.requestFrame, cancelFrame: options.cancelFrame,
    onVolume: (value) => void channels.apply('volume', value), onBrightness: (value) => void channels.apply('brightness', value),
    onSeek: (delta) => { if (engine !== null && delta !== 0) engine.setCurrentTime(engine.currentTime() + delta); },
    onTap: () => { engine?.toggleControls(); idle.tap(); }
  });
  disposers.push(attachGestureLayer(chrome.surface, gesture).destroy);
  disposers.push(bridge.onCallState((state) => { if (!destroyed) interruption.onCallState(state); }));
  listen(overlay.retryButton, 'click', () => { if (episodeId !== null) void load(episodeId, engine?.currentTime() ?? 0); });
  chrome.setVisible(true); render();
  function remeasure(): void { updateMediaFrame(root, chrome.stage); }
  function relayout(): void { engine?.resize?.(); drawer.setMode(); remeasure(); }
  /** 唤起选集面板：倍速先收（菜单互斥），当前集所在的分段由面板自己定位。 */
  function openDrawer(): void { rate.close(); rate.cancel(); if (detail !== null && episodeId !== null) drawer.open(detail, episodeId); }
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
  async function onEnded(): Promise<void> {
    if (destroyed || engine === null) return;
    const endedEpisodeId = episodeId;
    if (!guard.consumeEnded(endedEpisodeId)) return;
    const episodes = detail?.episodes ?? [];
    const index = Math.max(0, episodes.findIndex((item) => item.episodeId === episodeId));
    progress.emit(true); phase = 'ended';
    if (sleep.onEpisodeEnded({ episodeIndex: index, episodeTotal: episodes.length }) === 'stop') return releaseHandle('sleep');
    const next = episodes[index + 1];
    if (next === undefined) return;
    const mine = token;
    await options.onNaturalBoundary?.();
    if (!destroyed && mine === token && guard.endedFor(endedEpisodeId)) await load(next.episodeId, 0);
  }
  function handleMediaEvent(event: MediaEvent, generation: number): void {
    if (destroyed || engine === null || generation !== mediaGeneration) return;
    idle.onMediaEvent(event);
    if (event === 'play') {
      root.classList.add('is-playing'); interruption.noteUserAction(); void bridge.setKeepScreenOn(true); ensureBackgroundAudio();
      // A source is proven playable once the engine has reported playback, even if this device's HLS
      // implementation does not emit a separate `playing` event before a natural `ended`.
      guard.confirmPlayback(episodeId);
    }
    else if (event === 'playing') { guard.confirmPlayback(episodeId); }
    else if (event === 'seeked') return;
    else if (event === 'pause') { root.classList.remove('is-playing'); if (!interruption.pausingForCall()) interruption.noteUserAction(); progress.emit(true); }
    else if (event === 'timeupdate') { if (progress.due()) progress.emit(); }
    else if (event === 'error') { if (direct !== null) { noteLineFailure(); return; } root.classList.remove('is-playing'); phase = 'error'; errorKind = 'retryable'; overlay.show('retryable'); report({ kind: 'media', message: '播放失败' }); }
    // 必须显式一条分支：`loadedmetadata` 落到末尾的 `else` 会被当成 `ended`，于是每集刚出画面就自动跳下一集。
    else if (event === 'loadedmetadata') { options.onAspect?.(probeStageOrientation(chrome.stage)); remeasure(); }
    // 缓冲/拖动同样必须显式一条分支：它们只剩收起判据的输入（`idle` 已接），绝不能落到 `else` 变成 `ended`。
    else if (event === 'waiting' || event === 'seeking') return;
    else if (event === 'ended') void onEnded();
  }
  async function ensureEngine(mine: number, generation = mediaGeneration): Promise<PlayerEngine | null> {
    const current = (): boolean => !destroyed && mine === token && generation === mediaGeneration;
    if (!current()) return null;
    if (engine !== null) return engine;
    const theme = getComputedStyle(document.documentElement).getPropertyValue('--player-accent').trim();
    let live: PlayerEngine | null = null;
    const created = await (options.engine ?? createArtEngine)({
      container: chrome.stage, theme, poster: detail?.item.coverUrl,
      onError: (message) => { if (!current() || live === null || engine !== live) return; if (direct !== null) noteLineFailure(); else report({ kind: 'media', message }); }
    });
    if (!current()) { created.destroy(); return null; }
    live = created; engine = live; live.setVolume(savedVolume);
    mediaOff = (['ended', 'timeupdate', 'play', 'playing', 'pause', 'waiting', 'seeking', 'seeked', 'error', 'loadedmetadata'] as const).map((event) => created.on(event, () => { if (engine === created) handleMediaEvent(event, generation); }));
    await channels.sync();
    return current() && engine === created ? created : null;
  }
  function retireEngine(): void {
    const live = engine; if (live !== null) savedVolume = live.volume();
    engine = null; mediaGeneration += 1; guard.beginLoad(); direct = null;
    for (const off of mediaOff.splice(0)) off();
    root.classList.remove('is-playing');
    if (live !== null) { live.pause(); live.destroy(); }
  }
  /** AC-09 归零瞬间：暂停并释放播放句柄（hls 实例与 MediaSource 一并解除）。 */
  function releaseHandle(reason: 'sleep' | 'destroy'): void {
    options.onSourceChange?.();
    retireEngine();
    void bridge.setKeepScreenOn(false);
    if (backgroundAudioOn) { backgroundAudioOn = false; void bridge.stopBackgroundAudio(); }
    if (reason === 'sleep') phase = 'idle';
  }
  /** Flush the outgoing source before its state is replaced, so a valid breakpoint is never silently lost. */
  function commitPreviousSource(): void {
    if (guard.ownsReading(episodeId)) progress.emit(true);
  }
  async function load(id: number, resumeSeconds = 0): Promise<void> {
    if (destroyed) return;
    commitPreviousSource();
    rate.cancel(); token += 1; retireEngine(); options.onSourceChange?.();
    const mine = token, generation = mediaGeneration;
    episodeId = id; phase = 'loading'; errorKind = null; runner.reset();
    overlay.show('loading');
    // 预加载过的详情不打第二次网络；缺席时这一句也是私密 404 的落点（AC-02-6 同构渲染）。
    if (detail === null) detail = await api.title(options.titleId).catch((error: unknown) => (report({ kind: 'retryable', message: `选集清单加载失败：${msg(error)}` }), null));
    if (mine !== token || destroyed || generation !== mediaGeneration) return;
    const live = await ensureEngine(mine, generation);
    if (live === null) return;
    const outcome = await runner.start(id, resumeSeconds);
    if (mine !== token || destroyed || generation !== mediaGeneration || engine !== live) return;
    if (outcome.kind === 'surface') applySurface(live, outcome.surface, outcome.resumeSeconds);
    else if (outcome.kind === 'unavailable') refuseWith(outcome.error);
  }
  /** 界面只认一种起播形状：直连与代理回退的差别已在 `line-runner` 收敛，这里不再复制第二套口径。 */
  function applySurface(live: PlayerEngine, surface: Surface, resumeSeconds: number): void {
    options.onSourceChange?.();
    direct = surface.lineIndex; errorKind = null; phase = 'ready';
    if (episodeId !== null) guard.bind(episodeId);
    live.setSource(surface.url, surface.mimeType); rate.reapply();
    const current = detail?.episodes.find((ep) => ep.episodeId === episodeId);
    if (current) { options.onEpisodeChange?.(current); if (backgroundAudioOn) void bridge.startBackgroundAudio(detail?.item.title ?? '', `第 ${current.episodeNumber} 集`).catch(() => undefined); }
    if (resumeSeconds > 0) live.setCurrentTime(resumeSeconds);
    overlay.hide(); render(); progress.emit(true); remeasure();
    if (drawer.isOpen() && episodeId !== null) drawer.refresh(episodeId);
  }
  // 私密与未知剧目共用同一份文案与同一套 UI，不泄露任何元信息（AC-02-6 / AC-15）。
  function refuseWith(error: unknown): void {
    guard.beginLoad();
    phase = 'error'; errorKind = errorKindOf(error); overlay.show(errorKind);
    report({ kind: errorKind, message: msg(error) });
  }
  /** A-7.4：直连失败即顺序切下一条（最多两条），全灭才落错误卡；每条失败都就地记进线路遥测（A-8）。 */
  function noteLineFailure(): void {
    if (engine === null) return;
    const live = engine, outcome = runner.fail(live.currentTime());
    if (outcome.kind === 'silent') return;
    if (outcome.kind === 'surface') {
      commitPreviousSource(); rate.cancel(); retireEngine(); options.onSourceChange?.();
      const mine = token;
      phase = 'loading'; overlay.show('loading');
      void ensureEngine(mine).then((next) => {
        if (next === null || destroyed || mine !== token || engine !== next) return;
        applySurface(next, outcome.surface, outcome.resumeSeconds);
        report({ kind: 'media', message: `本条线路不可用，已切到第 ${(outcome.surface.lineIndex ?? 0) + 1} 条备用线路` });
      });
      return;
    }
    if (outcome.kind === 'exhausted') {
      guard.beginLoad(); direct = null; phase = 'error'; errorKind = 'retryable';
      root.classList.remove('is-playing'); overlay.show('retryable');
      report({ kind: 'media', message: '所有备用线路均不可用' });
    }
  }
  const setLocked = (v: boolean): void => { rate.cancel(); locked = v; render(); }; const scheduleSleep = (m: SleepMode): void => { sleep.schedule(m); render(); };
  return {
    load, play: () => engine?.play(), pause: () => { progress.emit(true); engine?.pause(); },
    setLocked, scheduleSleep, closeDrawer: () => drawer.close(), openDrawer,
    setPlaybackRate: rate.set, dismissOverlay: () => rate.close() || (drawer.isOpen() ? (drawer.close(), true) : false),
    notifyAudioFocus: (value) => { if (value === 'lost') rate.cancel(); interruption.audioFocus(value); }, notifyLeave: () => { rate.cancel(); interruption.noteUserAction(); progress.emit(true); },
    // 视口几何变了（进出全屏、转屏）：重算画面矩形并让面板重判模式，仍然不触碰任何全屏通道（SPEC §1.2.0）。
    relayout,
    state: (): PlayerState => ({
      phase, errorKind, episodeId, contentId: detail?.item.id ?? null, playing: engine?.playing() ?? false,
      locked, sleepMode: sleep.mode(), isPrivate: isPrivateSubject(detail?.item ?? {}),
      positionSeconds: engine?.currentTime() ?? 0, durationSeconds: engine?.duration() ?? 0, volume: engine?.volume() ?? savedVolume,
      ...channels.read(), lineIndex: direct
    }),
    destroy: () => {
      if (destroyed) return;
      destroyed = true; phase = 'destroyed'; token += 1; progress.emit(true);
      idle.destroy(); rate.destroy(); sleep.destroy(); gesture.destroy(); hud.destroy(); drawer.destroy(); overlay.destroy(); chrome.destroy();
      for (const [target, type, handler] of bound) target.removeEventListener(type, handler);
      bound.length = 0;
      for (const dispose of disposers.splice(0)) dispose();
      releaseHandle('destroy');
    }
  };
}
