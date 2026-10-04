import type { PreferenceStore } from './state/theme';
import type { GrantProbe } from './identity/offline-grant';
import type { PlaybackPreferences } from '../player/playback-rate';
import { PLAYBACK_PREF_KEYS, readPlaybackRates } from '../views/settings-playback';
import { createWatchTime, validMonetization, type WatchStop } from './watch-time';

/** Process-local caches only; failed reads never fabricate authorization or cloud policy. */
export async function createRuntimeServices(options: {
  prefs: PreferenceStore; grant: GrantProbe; monetization(): Promise<unknown>;
  report?(message: string): void; clock?: () => number;
}) {
  let rates = { normalRate: 1, holdRate: 2 }, authorized = false, config: unknown = null;
  let writes = Promise.resolve();
  const refreshGrant = async () => {
    try { authorized = (await options.grant.read()).ok; } catch { authorized = false; }
  };
  async function refresh() {
    await writes;
    await Promise.all([refreshGrant(), (async () => {
      try { rates = await readPlaybackRates(options.prefs); } catch { options.report?.('播放偏好读取失败，保留当前倍率'); }
    })()]);
  }
  await refresh();
  const watch = await createWatchTime({ prefs: options.prefs, clock: options.clock, isAuthorized: () => authorized })
    .catch(() => { options.report?.('观看时长读取失败，本次不计时、不展示支持提醒'); return null; });
  // Pre-read is deliberately best effort: no local fallback commercial thresholds.
  void options.monetization().then(value => { config = validMonetization(value) ? value : null; }).catch(() => { config = null; });
  const playbackPreferences: PlaybackPreferences = {
    normalRate: () => rates.normalRate, holdRate: () => rates.holdRate,
    onNormalRate(rate) {
      writes = writes.then(async () => {
        try { await options.prefs.set(PLAYBACK_PREF_KEYS.normalRate, String(rate)); rates = { ...rates, normalRate: rate }; }
        catch { options.report?.('播放倍率保存失败，保留上次偏好'); }
      });
    }
  };
  return {
    watch, playbackPreferences, refresh,
    async naturalBoundary() { await refreshGrant(); return watch?.naturalBoundary(config) ?? null; },
    destroy: async () => { await watch?.destroy(); await writes; }
  };
}
export type RuntimeServices = Awaited<ReturnType<typeof createRuntimeServices>>;

/** Observe the real video, not UI play commands or media timeline deltas. */
export function bindWatchVideo(root: HTMLElement, runtime: RuntimeServices) {
  let video: HTMLVideoElement | null = null, playing = false, frame = false, lastStop: WatchStop | null = null;
  let frameHandle: number | null = null, generation = 0;
  const listeners: Array<[string, EventListener]> = [];
  function reset(reason: WatchStop) {
    playing = false; frame = false; generation++; lastStop = reason;
    if (frameHandle !== null) video?.cancelVideoFrameCallback?.(frameHandle);
    frameHandle = null; void runtime.watch?.suspend(reason);
  }
  function decoded() {
    if (!video || !playing || document.hidden) return;
    if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
      frame = true; runtime.watch?.playing(frame);
    }
  }
  function firstFrame() {
    if (!video || !playing) return;
    if (video.requestVideoFrameCallback) {
      const mine = generation;
      frameHandle = video.requestVideoFrameCallback(() => { frameHandle = null; if (mine === generation) decoded(); });
    } else decoded();
  }
  function detach() {
    reset('switch');
    for (const [name, fn] of listeners.splice(0)) video?.removeEventListener(name, fn);
    video = null;
  }
  function attach() {
    const next = root.querySelector('video'); if (next === video) return;
    detach(); video = next; if (!video) return;
    const listen = (name: string, fn: () => void) => { const handler: EventListener = fn; video!.addEventListener(name, handler); listeners.push([name, handler]); };
    listen('playing', () => { playing = true; lastStop = null; firstFrame(); });
    listen('loadeddata', () => { if (!video?.requestVideoFrameCallback) decoded(); });
    for (const reason of ['waiting', 'stalled', 'seeking', 'seeked', 'pause', 'error', 'ended'] as const) listen(reason, () => reset(reason));
    listen('loadstart', () => reset('switch')); listen('emptied', () => reset('switch'));
  }
  const observer = new MutationObserver(attach); observer.observe(root, { childList: true, subtree: true }); attach();
  const blur = () => reset('blur');
  const visibility = () => reset(document.hidden ? 'blur' : 'resume');
  window.addEventListener('blur', blur); document.addEventListener('visibilitychange', visibility);
  return {
    reset,
    async naturalBoundary() {
      // Engine's ended callback can run before our DOM listener in the same dispatch.
      await Promise.resolve();
      if (lastStop !== 'ended') reset('ended');
      return runtime.naturalBoundary();
    },
    destroy() { observer.disconnect(); detach(); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility); }
  };
}
