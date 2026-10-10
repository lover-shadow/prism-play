/** Player orchestration: injectable media engine, native gestures, overlays and episode state. */
/// <reference types="vite/client" />
import './player.css';
import { createPlaybackRate } from './playback-rate';
import type { MediaEvent, PlayerEngine } from './engine-seam';
import { buildPlayerEngine } from './player-engine';
import { probeStageOrientation } from './aspect';
import type { TitleDetail } from '../../edge/src/types/api';
import { ApiError } from '../core/api/client';
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
import { attachGestureLayer, createGestureController, type GestureBounds, type GestureController } from './gestures';
import type { PlayerErrorKind } from './hud';
import { createCallInterruptPolicy, createSleepTimer, SLEEP_CHOICES, SLEEP_LABELS, systemClock, type SleepMode } from './sleep-timer';
import { createValueChannels } from './value-channel';
import type { PlayerFailure, PlayerPhase, PrismPlayer, PrismPlayerOptions, PlayerState } from './player-contract';
import { createPlayerDom } from './player-dom';

export type { PlayerApi, PlayerFailure, PlayerPhase, PrismPlayer, PrismPlayerOptions, PlayerState } from './player-contract';
const errorKindOf = (error: unknown): PlayerErrorKind => error instanceof ApiError ? (error.treatedAsMissing ? 'missing' : error.code === 'NETWORK_ERROR' ? (typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'connection') : 'retryable') : 'retryable';

export function createPlayer(options: PrismPlayerOptions): PrismPlayer {
  const clock = options.clock ?? systemClock, { bridge, api, root } = options;
  const disposers: (() => void)[] = [], bound: Array<[EventTarget, string, EventListener]> = [];
  let mediaOff: (() => void)[] = [];
  let engine: PlayerEngine | null = null, detail: TitleDetail | null = options.detail ?? null, episodeId: number | null = null;
  let phase: PlayerPhase = 'idle', errorKind: PlayerErrorKind | null = null, direct: number | null = null;
  let locked = false, destroyed = false, token = 0, backgroundAudioOn = false, backgroundAudioDisabled = false;
  let mediaGeneration = 0, savedVolume = 1, firstFrameNotified = false, prefetchFired = false;
  const guard = createEndedGuard(() => mediaGeneration);

  function setLocked(v: boolean): void { rate.cancel(); locked = v; engine?.setControlsLocked?.(v); render(); }
  function scheduleSleep(m: SleepMode): void { sleep.schedule(m); render(); }

  const triggerPrefetchProbe = (): void => {
    if (prefetchFired || !engine || destroyed || !api.titlePrefetch) return;
    const duration = engine.duration(), current = engine.currentTime();
    if (duration > 10 && current / duration >= 0.7) {
      prefetchFired = true;
      const currentEp = episodeNumber(), count = detail?.item.episodeCount ?? 999;
      const nextEpisodes = [currentEp + 1, currentEp + 2, currentEp + 3].filter((n) => n <= count);
      if (nextEpisodes.length > 0 && detail?.item.isPrivate === false) {
        void api.titlePrefetch(options.titleId, {
          requestId: `probe-${options.titleId}-${currentEp}-${clock.now()}`,
          episodeNumbers: nextEpisodes, reason: 'lookahead'
        }).catch(() => {});
      }
    }
  };

  const notifyFirstFrame = (): void => { if (!firstFrameNotified && !destroyed) { firstFrameNotified = true; options.onFirstFrame?.(); } };
  const hookVideoFirstFrame = (): void => {
    const video = chrome.stage.querySelector('video');
    if (video && typeof (video as any).requestVideoFrameCallback === 'function') {
      const g = mediaGeneration;
      (video as any).requestVideoFrameCallback(() => { if (!destroyed && g === mediaGeneration) notifyFirstFrame(); });
    } else notifyFirstFrame();
  };
  const listen = (target: EventTarget, type: string, handler: EventListener): void => { target.addEventListener(type, handler); bound.push([target, type, handler]); };
  const report = (failure: PlayerFailure): void => void options.onError?.(failure);
  const msg = (error: unknown): string => String(error instanceof Error ? error.message : error);
  const episodeNumber = (): number => detail?.episodes.find((item) => item.episodeId === episodeId)?.episodeNumber ?? 0;
  const readSurface = (): GestureBounds => { const r = chrome.surface.getBoundingClientRect(); return { width: r.width, height: r.height, top: r.top, left: r.left, topBandPx: 0, bottomBandPx: 0 }; };

  const { speedPill, overlay, hud, chrome } = createPlayerDom(
    root, detail, clock,
    (action) => {
      if (action === 'lock') setLocked(!locked);
      else if (action === 'list') openDrawer();
      else {
        const cycle: SleepMode[] = ['off', ...SLEEP_CHOICES];
        scheduleSleep(cycle[(cycle.indexOf(sleep.mode()) + 1) % cycle.length] ?? 'off');
      }
    },
    () => { engine?.play(); }
  );
  const currentEpisodeId = (): number | null => episodeId;
  const progress = createProgressReporter({
    clock, detail: () => detail, episodeId: currentEpisodeId, sourceEpisodeId: () => guard.loadedEpisodeId(),
    hasBoundSource: () => guard.ownsReading(episodeId), onProgress: options.onProgress,
    position: () => engine?.currentTime() ?? 0, duration: () => engine?.duration() ?? 0,
    onBlocked: (message) => report({ kind: 'progress-blocked', message })
  });
  const interruption = createCallInterruptPolicy({
    playing: () => engine?.playing() ?? false, position: () => engine?.currentTime() ?? 0, pause: () => engine?.pause(),
    resume: (pos) => { engine?.setCurrentTime(pos); engine?.play(); }
  });
  const drawer = createEpisodeDrawer({
    root, mount: options.drawerMount, mode: options.sheetMode, onSelect: (id) => void load(id, 0), onClose: relayout,
    onOpen: () => { options.onOverlayOpen?.(); relayout(); }, allowShare: options.allowShare, onShare: options.onShare,
    allowBackgroundAudio: options.allowBackgroundAudio, backgroundAudioEnabled: () => backgroundAudioOn,
    onBackgroundAudioToggle: (on) => {
      if (options.allowBackgroundAudio !== true) return;
      backgroundAudioDisabled = !on; backgroundAudioOn = false;
      if (on) ensureBackgroundAudio(); else { engine?.setBackgroundAllowed?.(false); void bridge.stopBackgroundAudio(); }
    }
  });
  const rate = createPlaybackRate({ root, surface: chrome.surface, pill: speedPill, clock, engine: () => engine, locked: () => locked || destroyed,
    preferences: options.playbackPreferences, onHold: () => gesture.cancel(), onError: (message) => report({ kind: 'media', message }),
    beforeOpen: () => { drawer.close(); options.onOverlayOpen?.(); } });
  chrome.el.append(rate.button);
  const idle = createControlsIdle({
    clock, playing: () => engine?.playing() ?? false, fullscreen: options.fullscreen ?? (() => false),
    visible: () => chrome.el.classList.contains('is-visible'), setVisible: (on) => { chrome.setVisible(on); engine?.setControlsVisible?.(on); },
    blocked: () => drawer.isOpen() || rate.isOpen() || (options.overlayOpen?.() ?? false)
  });
  const sleep = createSleepTimer(clock, { getVolume: () => engine?.volume() ?? savedVolume, setVolume: (v) => { savedVolume = v; engine?.setVolume(v); }, stop: () => releaseHandle('sleep') });
  const manifests = installTitleManifestStore(createTitleManifestStore(options.facts !== undefined ? { api, facts: options.facts } : { api }));
  const lines = createLineFallback({ workId: () => options.titleId, privacy: () => ({ isPrivate: detail?.item.isPrivate, channelId: detail?.item.channelId }) });
  const runner = createLineRunner({ api, manifests, lines, engine: () => engine, clock, workId: () => options.titleId, episodeNumber, localEpisodeIds: () => usesLocalEpisodeIds(detail) });
  const channels = createValueChannels({ bridge, hud, engine: () => engine, seed: (ch, val) => gesture.seed(ch, val) });
  const gesture: GestureController = createGestureController({
    clock, measure: options.measure ?? readSurface, isLocked: () => locked || destroyed,
    currentTime: () => engine?.currentTime() ?? 0, duration: () => engine?.duration() ?? 0,
    isSurface: (t) => !(t instanceof Element && t.closest('[data-prism-ui]') !== null),
    requestFrame: options.requestFrame, cancelFrame: options.cancelFrame,
    onVolume: (val) => void channels.apply('volume', val), onBrightness: (val) => void channels.apply('brightness', val),
    onSeek: (delta) => { if (engine !== null && delta !== 0) engine.setCurrentTime(engine.currentTime() + delta); },
    onTap: () => { engine?.toggleControls(); idle.tap(); },
    onCenterTap: () => { if (engine !== null) { if (engine.playing()) engine.pause(); else engine.play(); idle.tap(); } },
    onScrubPreview: (p) => hud.showSeek?.(p.targetSeconds, p.durationSeconds, p.deltaSeconds),
    onScrubCommit: (s) => { hud.hideSeek?.(); if (engine !== null) engine.setCurrentTime(s); },
    onScrubCancel: () => hud.hideSeek?.()
  });
  disposers.push(attachGestureLayer(chrome.surface, gesture).destroy);
  disposers.push(bridge.onCallState((state) => { if (!destroyed) interruption.onCallState(state); }));
  listen(overlay.retryButton, 'click', () => { if (episodeId !== null) void load(episodeId, engine?.currentTime() ?? 0); });
  chrome.setVisible(true); render();
  function remeasure(): void { updateMediaFrame(root, chrome.stage); }
  function relayout(): void { engine?.resize?.(); drawer.setMode(); remeasure(); }
  function openDrawer(): void { rate.close(); rate.cancel(); if (detail !== null && episodeId !== null) drawer.open(detail, episodeId); }
  function render(): void {
    const left = sleep.remainingMs(), label = SLEEP_LABELS[sleep.mode()];
    chrome.render({ title: detail?.item.title ?? '', locked, sleeping: sleep.mode() !== 'off', sleepLabel: left === null ? label : `${label} · ${Math.ceil(left / 60_000)}` });
  }
  function ensureBackgroundAudio(): void {
    if (options.allowBackgroundAudio !== true || backgroundAudioDisabled || backgroundAudioOn) return;
    backgroundAudioOn = true; engine?.setBackgroundAllowed?.(true); const mine = token;
    void bridge.startBackgroundAudio(detail?.item.title ?? '', `第 ${episodeNumber()} 集`).then(() => {
      if (destroyed || (!backgroundAudioOn && mine === token)) return bridge.stopBackgroundAudio();
    }).catch(() => { if (mine === token) { backgroundAudioOn = false; engine?.setBackgroundAllowed?.(false); } });
  }
  async function onEnded(): Promise<void> {
    if (destroyed || engine === null) return;
    const endedEpisodeId = episodeId; if (!guard.consumeEnded(endedEpisodeId)) return;
    const episodes = detail?.episodes ?? [], index = Math.max(0, episodes.findIndex((item) => item.episodeId === episodeId));
    progress.emit(true); phase = 'ended';
    if (sleep.onEpisodeEnded({ episodeIndex: index, episodeTotal: episodes.length }) === 'stop') return releaseHandle('sleep');
    const next = episodes[index + 1]; if (next === undefined) return;
    const mine = token; await options.onNaturalBoundary?.();
    if (!destroyed && mine === token && guard.endedFor(endedEpisodeId)) await load(next.episodeId, 0);
  }
  function handleMediaEvent(event: MediaEvent, generation: number): void {
    if (destroyed || engine === null || generation !== mediaGeneration) return;
    idle.onMediaEvent(event);
    if (event === 'play') {
      root.classList.add('is-playing'); interruption.noteUserAction(); void bridge.setKeepScreenOn(true); ensureBackgroundAudio();
      guard.confirmPlayback(episodeId);
    } else if (event === 'playing') {
      guard.confirmPlayback(episodeId); hookVideoFirstFrame(); notifyFirstFrame();
    } else if (event === 'pause') {
      root.classList.remove('is-playing'); if (!interruption.pausingForCall()) interruption.noteUserAction(); progress.emit(true);
    } else if (event === 'timeupdate') {
      if (engine !== null && engine.currentTime() > 0) notifyFirstFrame();
      if (progress.due()) progress.emit();
      triggerPrefetchProbe();
    } else if (event === 'loadedmetadata') {
      rate.reapply(); options.onAspect?.(probeStageOrientation(chrome.stage)); remeasure();
    } else if (event === 'error') {
      if (direct !== null) { noteLineFailure(); return; }
      root.classList.remove('is-playing'); phase = 'error'; errorKind = 'retryable'; overlay.show('retryable'); report({ kind: 'media', message: '播放失败' });
    } else if (event === 'ended') void onEnded();
  }
  async function ensureEngine(mine: number, generation = mediaGeneration, native = false): Promise<PlayerEngine | null> {
    const isCurrent = (): boolean => !destroyed && mine === token && generation === mediaGeneration;
    if (!isCurrent()) return null;
    if (engine !== null) return engine;
    const res = await buildPlayerEngine(
      {
        options, container: chrome.stage, detail, getDirect: () => direct, getEngine: () => engine, savedVolume, locked,
        backgroundAudioOn, episodeNumber, handleMediaEvent, noteLineFailure, report, channels
      },
      native, generation, isCurrent
    );
    if (res === null) return null;
    engine = res.engine;
    mediaOff = res.mediaOff;
    return isCurrent() ? res.engine : null;
  }
  function retireEngine(): void {
    const live = engine; if (live !== null) savedVolume = live.volume();
    engine = null; mediaGeneration += 1; guard.beginLoad(); direct = null; firstFrameNotified = false; prefetchFired = false;
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
    commitPreviousSource(); rate.cancel(); token += 1; retireEngine(); options.onSourceChange?.();
    const mine = token, generation = mediaGeneration;
    episodeId = id; phase = 'loading'; errorKind = null; runner.reset(); overlay.show('loading');
    if (detail === null) detail = await api.title(options.titleId).catch((err: unknown) => (report({ kind: 'retryable', message: `选集清单加载失败：${msg(err)}` }), null));
    if (mine !== token || destroyed || generation !== mediaGeneration) return;
    const outcome = await runner.start(id, resumeSeconds);
    if (mine !== token || destroyed || generation !== mediaGeneration || outcome.kind !== 'surface') {
      if (outcome.kind === 'unavailable') refuseWith(outcome.error);
      return;
    }
    try {
      const live = await ensureEngine(mine, generation, outcome.surface.native !== undefined);
      if (live !== null && mine === token && !destroyed && engine === live) applySurface(live, outcome.surface, outcome.resumeSeconds);
    } catch (error) { if (mine === token && !destroyed) refuseWith(error); }
  }
  function applySurface(live: PlayerEngine, surface: Surface, resumeSeconds: number): void {
    options.onSourceChange?.(); firstFrameNotified = false; prefetchFired = false;
    direct = surface.lineIndex; errorKind = null; phase = 'ready';
    if (episodeId !== null) guard.bind(episodeId);
    if (surface.native) live.setSource(surface.url, surface.mimeType, surface.native);
    else live.setSource(surface.url, surface.mimeType);
    rate.reapply();
    const current = detail?.episodes.find((ep) => ep.episodeId === episodeId);
    if (current) { options.onEpisodeChange?.(current); if (backgroundAudioOn) void bridge.startBackgroundAudio(detail?.item.title ?? '', `第 ${current.episodeNumber} 集`).catch(() => undefined); }
    if (resumeSeconds > 0) live.setCurrentTime(resumeSeconds);
    overlay.hide(); render(); progress.emit(true); remeasure();
    if (drawer.isOpen() && episodeId !== null) drawer.refresh(episodeId);
  }
  function refuseWith(error: unknown): void {
    guard.beginLoad(); phase = 'error'; errorKind = errorKindOf(error);
    overlay.show(errorKind); report({ kind: errorKind, message: msg(error) });
  }
  function noteLineFailure(): void {
    if (engine === null) return;
    const outcome = runner.fail(engine.currentTime());
    if (outcome.kind === 'silent') return;
    if (outcome.kind === 'surface') {
      commitPreviousSource(); rate.cancel(); retireEngine(); options.onSourceChange?.();
      const mine = token; phase = 'loading'; overlay.show('loading');
      void ensureEngine(mine, mediaGeneration, outcome.surface.native !== undefined).then((next) => {
        if (next === null || destroyed || mine !== token || engine !== next) return;
        applySurface(next, outcome.surface, outcome.resumeSeconds);
        report({ kind: 'media', message: `本条线路不可用，已切到第 ${(outcome.surface.lineIndex ?? 0) + 1} 条备用线路` });
      }).catch((err) => { if (mine === token && !destroyed) refuseWith(err); });
      return;
    }
    if (outcome.kind === 'exhausted') {
      guard.beginLoad(); direct = null; phase = 'error'; errorKind = 'retryable';
      root.classList.remove('is-playing'); overlay.show('retryable'); report({ kind: 'media', message: '所有备用线路均不可用' });
    }
  }
  return {
    load, play: () => engine?.play(), pause: () => { progress.emit(true); engine?.pause(); },
    setLocked, scheduleSleep, closeDrawer: () => drawer.close(), openDrawer,
    setPlaybackRate: rate.set, dismissOverlay: () => rate.close() || (drawer.isOpen() ? (drawer.close(), true) : false),
    notifyAudioFocus: (v) => { if (v === 'lost') rate.cancel(); interruption.audioFocus(v); },
    notifyLeave: () => { rate.cancel(); interruption.noteUserAction(); progress.emit(true); },
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
