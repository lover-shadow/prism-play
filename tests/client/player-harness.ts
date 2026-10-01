/**
 * 播放器集成测试的共享测试替身：假内核 + 假桥 + 假时钟 + 虚拟帧循环。
 * 存在理由：SPEC §10 单文件 ≤300 行，而"生命周期"与"交互手势"两组断言都会继续增长；
 * 测试替身必须只有一份真相，禁止为了减行数把它复制进两个文件。
 */
import { vi } from 'vitest';
import { createPlayer } from '../../src/player/prism-player';
import type { PlayerEngine, PlayerFailure, PrismPlayerOptions } from '../../src/player/prism-player';
import type { CallState, PrismNativeBridge } from '../../src/core/native/bridge';
import type { TitleDetail } from '../../edge/src/types/api';
import type { Clock } from '../../src/player/sleep-timer';
import type { GestureBounds } from '../../src/player/gestures';

export const BOUNDS: GestureBounds = { width: 400, height: 200, top: 0, left: 0, topBandPx: 0, bottomBandPx: 0 };
export const STREAM = 'https://play.prismos.org/proxy/m3u8/h1';
export const settle = async (): Promise<void> => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
export const detailOf = (over: Partial<TitleDetail['item']> = {}): TitleDetail => ({
  item: { id: 'c1', channelId: 'drama', title: '测试剧', category: '都市', isPrivate: false, shareable: true, ...over },
  episodes: [11, 12, 13].map((id, index) => ({ episodeId: id, episodeNumber: index + 1, durationSeconds: 100 }))
});

export function fakeClock(): Clock & { advance(ms: number): void; pending(): number[] } {
  let now = 0; let seq = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  return {
    now: () => now, pending: () => [...timers.keys()],
    setTimer: (cb, ms) => { seq += 1; timers.set(seq, { at: now + Math.max(0, ms), cb }); return seq; },
    clearTimer: (id) => void timers.delete(id),
    // Virtual time: fire due timers in timestamp order so chained re-arms behave like a real loop.
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].cb();
      }
      now = target;
    }
  };
}

export const fakeFrames = () => {
  const queued = new Map<number, () => void>(); let seq = 0;
  return {
    request: (cb: () => void) => { seq += 1; queued.set(seq, cb); return seq; },
    cancel: (handle: number) => void queued.delete(handle),
    run: () => { const batch = [...queued.values()]; queued.clear(); batch.forEach((cb) => cb()); },
    size: () => queued.size
  };
};

export function setup(options: Partial<PrismPlayerOptions> & { native?: boolean } = {}) {
  const { native = false, ...rest } = options;
  document.body.innerHTML = '<div id="root"></div>';
  const root = document.getElementById('root') as HTMLElement;
  const clock = fakeClock(); const frames = fakeFrames();
  const handlers = new Map<string, Array<() => void>>();
  const fire = (event: string) => { (handlers.get(event) ?? []).forEach((handler) => handler()); };
  const state = { t: 0, vol: 1, playing: false, destroyed: false, sources: [] as string[], toggles: 0 };
  // A real element emits play/pause when driven, so the fake does too: the host listens, it never guesses.
  const engine = {
    play: () => { state.playing = true; fire('play'); }, pause: () => { state.playing = false; fire('pause'); },
    playing: () => state.playing, currentTime: () => state.t, duration: () => 100, volume: () => state.vol,
    setCurrentTime: vi.fn((seconds: number) => { state.t = seconds; }),
    setVolume: vi.fn((value: number) => { state.vol = value; }),
    setSource: vi.fn((url: string) => { state.sources.push(url); }),
    toggleControls: vi.fn(() => { state.toggles += 1; }), destroy: vi.fn(() => { state.destroyed = true; }),
    on: (event: string, handler: () => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((item) => item !== handler));
    }
  } as unknown as PlayerEngine;
  const calls = {
    systemVolume: [] as number[], brightness: [] as number[], keepScreenOn: [] as boolean[], startBackground: [] as string[],
    stopBackground: 0, listener: null as ((state: CallState) => void) | null, unsubs: 0
  };
  const ok = { volume: native, brightness: native };
  const bridge = {
    getSystemVolume: async () => ({ volume: 1, supported: ok.volume }),
    setSystemVolume: async (value: number) => { calls.systemVolume.push(value); return { volume: value, supported: ok.volume }; },
    getBrightness: async () => ({ brightness: 1, supported: ok.brightness }),
    setBrightness: async (value: number) => { calls.brightness.push(value); return { brightness: value, supported: ok.brightness }; },
    setKeepScreenOn: async (on: boolean) => { calls.keepScreenOn.push(on); },
    startBackgroundAudio: async (title: string) => { calls.startBackground.push(title); },
    stopBackgroundAudio: async () => { calls.stopBackground += 1; },
    onCallState: (listener: (state: CallState) => void) => { calls.listener = listener; return () => { calls.listener = null; calls.unsubs += 1; }; }
  } as unknown as PrismNativeBridge;
  const progress = vi.fn(); const failures: PlayerFailure[] = [];
  const api = {
    playback: vi.fn(async (id: number) => ({ episodeId: id, url: STREAM, mimeType: 'application/vnd.m3u8+playlist', durationSeconds: 100 })),
    title: vi.fn(async () => detailOf())
  };
  const player = createPlayer({
    root, bridge, api, titleId: 'c1', clock, engine: async () => engine, measure: () => BOUNDS, progressFrame: undefined,
    onProgress: progress, onError: (failure) => failures.push(failure),
    requestFrame: frames.request, cancelFrame: frames.cancel, ...rest
  } as PrismPlayerOptions);
  const surface = root.querySelector<HTMLElement>('.prism-player__body') as HTMLElement;
  // jsdom ships no PointerEvent constructor, so the shape the listener duck-types is built by hand.
  const pointer = (type: string, x: number, y: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    surface.dispatchEvent(Object.assign(event, { pointerId: 1, clientX: x, clientY: y }));
  };
  const swipe = (x: number, from: number, to: number) => {
    pointer('pointerdown', x, from);
    for (let y = from; to > from ? y <= to : y >= to; y += to > from ? 12 : -12) pointer('pointermove', x, y);
    frames.run();
  };
  const hud = (kind: string) => root.querySelector<HTMLElement>(`.prism-hud--${kind}`) as HTMLElement;
  const q = <T extends Element>(selector: string) => root.querySelector(selector) as T | null;
  return { player, root, clock, frames, state, calls, progress, failures, api, hud, q, swipe, pointer, settle, fire,
    text: () => root.textContent ?? '' };
}
