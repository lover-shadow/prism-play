import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { EngineFactory, MediaEvent } from './engine-seam';
import type { LineFailureCode } from '../core/native/telemetry';
import { containedRect } from './media-frame';
import { createNativeControls } from './native-controls';

interface Bounds { left: number; top: number; width: number; height: number }
interface NativeEvent {
  sessionId: string; event: MediaEvent; positionSeconds: number; durationSeconds: number;
  playing: boolean; volume: number; rate: number; width: number; height: number; failureCode?: LineFailureCode;
}
interface NativePlayer {
  create(args: { sessionId: string; bounds: Bounds }): Promise<void>;
  setSource(args: { sessionId: string; videoId: string; positionSeconds?: number }): Promise<void>;
  play(args: { sessionId: string }): Promise<void>;
  pause(args: { sessionId: string }): Promise<void>;
  seek(args: { sessionId: string; seconds: number }): Promise<void>;
  setVolume(args: { sessionId: string; volume: number }): Promise<void>;
  setRate(args: { sessionId: string; rate: number }): Promise<void>;
  setBackgroundAllowed(args: { sessionId: string; allowed: boolean }): Promise<void>;
  setBounds(args: { sessionId: string; bounds: Bounds }): Promise<void>;
  release(args: { sessionId: string }): Promise<void>;
  addListener(event: 'event', callback: (event: NativeEvent) => void): Promise<PluginListenerHandle>;
}
const plugin = registerPlugin<NativePlayer>('PrismPlayer');
let pendingRelease: Promise<void> = Promise.resolve();
export const nativePlayerAvailable = (): boolean => Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('PrismPlayer');

export const createExoEngine: EngineFactory = async ({ container, onError, resolveNative }) => {
  if (!nativePlayerAvailable()) throw new Error('当前环境不支持原生加密播放');
  const sessionId = crypto.randomUUID();
  const listeners = new Map<MediaEvent, Set<() => void>>();
  let disposed = false, position = 0, duration = 0, playing = false, volume = 1, rate = 1;
  let failure: LineFailureCode | null = null;
  let preparing = false, wantsPlayback = true, pendingSeek: number | null = null;
  let requestedRate = 1;
  let queue = Promise.resolve();
  let controls: ReturnType<typeof createNativeControls> | null = null;
  const ancestors: HTMLElement[] = [];
  for (let el: HTMLElement | null = container; el; el = el.parentElement) ancestors.push(el);
  ancestors.forEach((el) => el.classList.add('prism-native-transparent'));
  document.documentElement.classList.add('prism-native-active');
  const box = (): Bounds => {
    const rect = container.getBoundingClientRect();
    const width = Number(container.dataset.nativeVideoWidth), height = Number(container.dataset.nativeVideoHeight);
    const content = containedRect(rect, width > 0 && height > 0 ? { width, height } : null);
    return { left: rect.left + content.left, top: rect.top + content.top, width: Math.max(1, content.width), height: Math.max(1, content.height) };
  };
  const dispatch = (event: MediaEvent): void => { for (const handler of listeners.get(event) ?? []) handler(); };
  const failed = (): void => {
    if (disposed) return;
    preparing = false; pendingSeek = null;
    failure = 'http_error';
    onError('原生播放暂不可用', failure);
    dispatch('error');
  };
  const command = (action: () => Promise<void>): void => {
    queue = queue.then(async () => { if (!disposed) await action(); }).catch(failed);
  };
  const resize = (): void => { if (!disposed) void plugin.setBounds({ sessionId, bounds: box() }).catch(failed); };
  let subscription: PluginListenerHandle | undefined;
  try {
    subscription = await plugin.addListener('event', (event) => {
      if (disposed || event.sessionId !== sessionId) return;
      position = pendingSeek ?? event.positionSeconds; duration = event.durationSeconds; playing = event.playing;
      volume = event.volume; rate = preparing ? requestedRate : event.rate; failure = event.failureCode ?? failure;
      container.dataset.nativeVideoWidth = String(event.width);
      container.dataset.nativeVideoHeight = String(event.height);
      if (event.event === 'loadedmetadata') resize();
      dispatch(event.event);
      controls?.update();
    });
    await pendingRelease; await plugin.create({ sessionId, bounds: box() });
  } catch (error) {
    ancestors.forEach((el) => el.classList.remove('prism-native-transparent'));
    document.documentElement.classList.remove('prism-native-active');
    await subscription?.remove();
    throw error;
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  window.addEventListener('scroll', resize, true);
  window.addEventListener('resize', resize);
  const seek = (seconds: number): void => {
    position = seconds;
    if (preparing) pendingSeek = seconds; else command(() => plugin.seek({ sessionId, seconds }));
  };
  const play = (): void => { wantsPlayback = true; if (!preparing) command(() => plugin.play({ sessionId })); };
  const pause = (): void => { wantsPlayback = false; if (!preparing) command(() => plugin.pause({ sessionId })); };
  controls = createNativeControls(container.parentElement ?? container, {
    playing: () => playing,
    play, pause,
    currentTime: () => position,
    duration: () => duration,
    setCurrentTime: seek
  });
  return {
    play, pause,
    playing: () => playing,
    currentTime: () => position,
    setCurrentTime: seek,
    duration: () => duration,
    volume: () => volume,
    setVolume: (value) => { volume = value; command(() => plugin.setVolume({ sessionId, volume: value })); },
    playbackRate: () => rate,
    setPlaybackRate: (value) => { requestedRate = rate = value; if (!preparing) command(() => plugin.setRate({ sessionId, rate: value })); },
    setSource: (_url, _mime, native) => {
      failure = null; position = 0; duration = 0; pendingSeek = null;
      if (!native) { failed(); return; }
      preparing = true; wantsPlayback = true;
      command(async () => {
        if (!resolveNative) throw new Error('原生播放复核不可用');
        const checked = await resolveNative(native);
        if (disposed) return;
        await plugin.setSource({ sessionId, videoId: checked.videoId });
        if (disposed) return;
        while (!disposed && pendingSeek !== null) {
          const seconds = pendingSeek;
          await plugin.seek({ sessionId, seconds });
          if (pendingSeek === seconds) pendingSeek = null;
        }
        let appliedRate: number;
        do {
          appliedRate = requestedRate;
          await plugin.setRate({ sessionId, rate: appliedRate });
          if (disposed) return;
        } while (appliedRate !== requestedRate);
        rate = requestedRate; preparing = false;
        if (wantsPlayback) await plugin.play({ sessionId });
      });
    },
    toggleControls: () => controls?.toggle(),
    setControlsVisible: (visible) => controls?.setVisible(visible),
    setControlsLocked: (locked) => controls?.setLocked(locked),
    setBackgroundAllowed: (allowed) => { if (!disposed) void plugin.setBackgroundAllowed({ sessionId, allowed }).catch(failed); },
    resize,
    failureCode: () => failure,
    on: (event, handler) => {
      const group = listeners.get(event) ?? new Set<() => void>();
      group.add(handler); listeners.set(event, group);
      return () => { group.delete(handler); };
    },
    destroy: () => {
      if (disposed) return;
      disposed = true; playing = false;
      controls?.destroy(); controls = null;
      observer.disconnect(); window.removeEventListener('scroll', resize, true); window.removeEventListener('resize', resize);
      void subscription?.remove();
      pendingRelease = plugin.release({ sessionId }).catch(() => {});
      ancestors.forEach((el) => el.classList.remove('prism-native-transparent'));
      document.documentElement.classList.remove('prism-native-active');
      delete container.dataset.nativeVideoWidth; delete container.dataset.nativeVideoHeight;
      listeners.clear();
    }
  };
};
