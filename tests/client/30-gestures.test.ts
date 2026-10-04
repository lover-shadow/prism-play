// @vitest-environment jsdom
/**
 * 手势层单元测试（AC-06 / AC-07 / AC-08 + rAF 合并）：纯几何与纯状态机，无 ArtPlayer、无 document、无布局。
 */
import { describe, expect, it } from 'vitest';
import { classifyTouch, createGestureController, DOUBLE_TAP_WINDOW_MS } from '../../src/player/gestures';
import type { GestureBounds, GestureControllerOptions, PointerLike } from '../../src/player/gestures';
import type { Clock } from '../../src/player/sleep-timer';

const BOUNDS: GestureBounds = { width: 400, height: 200, top: 0, left: 0, topBandPx: 0, bottomBandPx: 0 };
const base = (over: Partial<Parameters<typeof classifyTouch>[0]> = {}) =>
  classifyTouch({ x: 200, y: 100, width: 400, height: 200, deltaY: 0, pointerCount: 1, ...over });

type Timer = { at: number; cb: () => void };
function fakeClock(): Clock & { advance(ms: number): void; pending(): number[] } {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, Timer>();
  return {
    now: () => now,
    setTimer: (cb, ms) => { seq += 1; timers.set(seq, { at: now + Math.max(0, ms), cb }); return seq; },
    clearTimer: (id) => void timers.delete(id),
    pending: () => [...timers.keys()],
    // Virtual time: fire due timers in timestamp order so chained re-arms behave like a real loop.
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        if (due.length === 0) break;
        const [id, timer] = due[0];
        timers.delete(id);
        now = Math.max(now, timer.at);
        timer.cb();
      }
      now = target;
    }
  };
}

function fakeFrames() {
  const queued = new Map<number, () => void>();
  let seq = 0;
  return {
    request: (cb: () => void) => { seq += 1; queued.set(seq, cb); return seq; },
    cancel: (handle: number) => void queued.delete(handle),
    run: () => { const batch = [...queued.values()]; queued.clear(); for (const cb of batch) cb(); },
    size: () => queued.size
  };
}

interface Harness {
  volumes: number[]; brightness: number[]; seeks: number[]; taps: Array<{ x: number; y: number }>;
  clock: ReturnType<typeof fakeClock>; frames: ReturnType<typeof fakeFrames>;
  down(x: number, y: number): void; move(x: number, y: number): void; up(x: number, y: number): void; tap(x: number, y: number): void;
}

function harness(overrides: Partial<GestureControllerOptions> = {}): Harness {
  const clock = fakeClock();
  const frames = fakeFrames();
  const volumes: number[] = [];
  const brightness: number[] = [];
  const seeks: number[] = [];
  const taps: Array<{ x: number; y: number }> = [];
  const point = (x: number, y: number): PointerLike => ({ pointerId: 1, clientX: x, clientY: y, target: null });
  const controller = createGestureController({
    clock, measure: () => BOUNDS, isLocked: () => false, currentTime: () => 50, duration: () => 100,
    volumeSeed: 0.5, brightnessSeed: 0.5, requestFrame: frames.request, cancelFrame: frames.cancel,
    onVolume: (value) => void volumes.push(value), onBrightness: (value) => void brightness.push(value),
    onSeek: (delta) => void seeks.push(delta), onTap: (where) => void taps.push(where), ...overrides
  });
  const send = (method: 'pointerDown' | 'pointerMove' | 'pointerUp', x: number, y: number) => controller[method](point(x, y));
  return {
    volumes, brightness, seeks, taps, clock, frames,
    down: (x, y) => send('pointerDown', x, y), move: (x, y) => send('pointerMove', x, y), up: (x, y) => send('pointerUp', x, y),
    tap: (x, y) => { send('pointerDown', x, y); send('pointerUp', x, y); }
  };
}

describe('classifyTouch — 区域划分（AC-06 / AC-07）', () => {
  it('splits 0-48 brightness / 48-52 dead / 52-100 volume at both band edges', () => {
    const edges: Array<[number, string]> = [
      [0, 'brightness'], [0.2, 'brightness'], [0.479, 'brightness'], [0.48, 'dead-band'], [0.481, 'dead-band'],
      [0.5, 'dead-band'], [0.519, 'dead-band'], [0.52, 'dead-band'], [0.521, 'volume'], [0.9, 'volume'], [1, 'volume']
    ];
    for (const [fraction, zone] of edges) expect(base({ x: fraction * 400, deltaY: -40 }).zone).toBe(zone);
  });

  it('treats a second finger and off-surface coordinates as scrub, never as a value drag', () => {
    expect(base({ pointerCount: 2, x: 40 }).zone).toBe('scrub');
    expect(base({ pointerCount: 0, x: 40 }).zone).toBe('scrub');
    expect(base({ x: -5 }).zone).toBe('scrub');
    expect(base({ x: 405 }).zone).toBe('scrub');
    expect(base({ y: 260 }).zone).toBe('scrub');
    expect(classifyTouch({ x: 10, y: 10, width: 0, height: 0, deltaY: -10, pointerCount: 1 }).zone).toBe('scrub');
  });

  it('keeps the control bands inert on both ends', () => {
    const bands = { topBandPx: 48, bottomBandPx: 64 };
    for (const y of [6, 47, 137, 150, 199]) expect(base({ x: 360, y, ...bands }).zone).toBe('control-band');
    for (const y of [48, 136]) expect(base({ x: 360, y, ...bands }).zone).toBe('volume');
    expect(base({ x: 40, y: 100, ...bands }).zone).toBe('brightness');
  });

  it('maps a full-height swipe onto the whole 0..1 range, linearly and clamped', () => {
    expect(base({ deltaY: -200 }).deltaRatio).toBeCloseTo(1, 10);
    expect(base({ deltaY: -100 }).deltaRatio).toBeCloseTo(0.5, 10);
    expect(base({ deltaY: 100 }).deltaRatio).toBeCloseTo(-0.5, 10);
    expect(base({ deltaY: -4000 }).deltaRatio).toBe(1);
    expect(base({ deltaY: 4000 }).deltaRatio).toBe(-1);
    expect(base({ x: 360, deltaY: -200 }).deltaRatio).toBeGreaterThan(base({ x: 360, deltaY: -20 }).deltaRatio);
  });
});

describe('GestureController — 竖向拖动与 rAF 合并', () => {
  it('drives volume only on the right band and brightness only on the left band', () => {
    const left = harness();
    left.down(360, 120);
    left.move(360, 90);
    left.frames.run();
    left.up(360, 90);
    expect(left.volumes).toHaveLength(1);
    expect(left.brightness).toHaveLength(0);
    expect(left.volumes[0]).toBeGreaterThan(0.5);
    const right = harness();
    right.down(40, 120);
    right.move(40, 90);
    right.frames.run();
    right.up(40, 90);
    expect(right.brightness).toHaveLength(1);
    expect(right.volumes).toHaveLength(0);
  });

  it('emits at most one bridge call per animation frame for a fast swipe', () => {
    const h = harness();
    h.down(360, 180);
    for (let y = 170; y >= 40; y -= 10) h.move(360, y);
    expect(h.volumes).toHaveLength(0);
    expect(h.frames.size()).toBe(1);
    h.frames.run();
    expect(h.volumes).toEqual([1]);
    h.up(360, 40);
    expect(h.volumes).toHaveLength(1);
  });

  it('never emits for the 48-52 dead band or for horizontal travel', () => {
    const dead = harness();
    dead.down(200, 150);
    dead.move(200, 60);
    dead.frames.run();
    dead.up(200, 60);
    expect([dead.volumes, dead.brightness, dead.seeks, dead.taps].map((list) => list.length)).toEqual([0, 0, 0, 0]);
    const side = harness();
    side.down(360, 100);
    for (let x = 60; x <= 360; x += 20) side.move(x, 100);
    side.frames.run();
    side.up(360, 100);
    expect([side.volumes, side.brightness, side.taps].map((list) => list.length)).toEqual([0, 0, 0]);
  });

  it('clamps at 0 and 1 instead of wrapping', () => {
    const h = harness({ volumeSeed: 0.05 });
    h.down(360, 60);
    h.move(360, 190);
    h.frames.run();
    h.move(360, 199);
    h.frames.run();
    expect(h.volumes.at(-1)).toBe(0);
    const top = harness({ volumeSeed: 0.95 });
    top.down(360, 150);
    top.move(360, 40);
    top.frames.run();
    expect(top.volumes.at(-1)).toBe(1);
  });
});

describe('GestureController — 双击快进退（AC-08）', () => {
  it('double tap seeks -10s on the left half and +10s on the right half', () => {
    const back = harness();
    back.tap(60, 100);
    back.clock.advance(120);
    back.tap(70, 100);
    expect(back.seeks).toEqual([-10]);
    const forward = harness();
    forward.tap(300, 100);
    forward.clock.advance(100);
    forward.tap(320, 100);
    expect(forward.seeks).toEqual([10]);
  });

  it('clamps the seek at 0 and at duration', () => {
    const start = harness({ currentTime: () => 4 });
    start.tap(60, 100);
    start.clock.advance(50);
    start.tap(60, 100);
    expect(start.seeks).toEqual([-4]);
    const tail = harness({ currentTime: () => 96 });
    tail.tap(340, 100);
    tail.clock.advance(50);
    tail.tap(340, 100);
    expect(tail.seeks).toEqual([4]);
  });

  it('a single tap toggles the chrome, never seeks, and two slow taps stay two singles', () => {
    const h = harness();
    h.tap(60, 100);
    expect(h.seeks).toHaveLength(0);
    expect(h.taps).toHaveLength(0);
    h.clock.advance(DOUBLE_TAP_WINDOW_MS + 10);
    expect(h.taps).toEqual([{ x: 60, y: 100 }]);
    h.tap(60, 100);
    h.clock.advance(DOUBLE_TAP_WINDOW_MS + 40);
    h.tap(60, 100);
    h.clock.advance(DOUBLE_TAP_WINDOW_MS + 40);
    expect(h.seeks).toHaveLength(0);
    expect(h.taps).toHaveLength(3);
  });

  it('ignores taps inside the top and bottom control bands', () => {
    const h = harness({ measure: () => ({ ...BOUNDS, topBandPx: 48, bottomBandPx: 64 }) });
    for (const y of [20, 30, 180, 190]) {
      h.tap(60, y);
      h.clock.advance(50);
      h.tap(60, y);
      h.clock.advance(50);
    }
    h.clock.advance(500);
    expect(h.seeks).toHaveLength(0);
    expect(h.taps).toHaveLength(0);
  });
});

describe('GestureController — 全屏触摸锁与生命周期', () => {
  it('suppresses every callback while locked, including taps', () => {
    const h = harness({ isLocked: () => true });
    h.down(360, 150);
    h.move(360, 60);
    h.frames.run();
    h.up(360, 60);
    h.tap(320, 100);
    h.clock.advance(1_000);
    expect([h.volumes, h.brightness, h.seeks, h.taps].map((list) => list.length)).toEqual([0, 0, 0, 0]);
  });

  it('destroy leaves no timer and no queued frame behind', () => {
    const clock = fakeClock();
    const frames = fakeFrames();
    const controller = createGestureController({
      clock, measure: () => BOUNDS, isLocked: () => false, currentTime: () => 10, duration: () => 20,
      requestFrame: frames.request, cancelFrame: frames.cancel,
      onVolume: () => undefined, onBrightness: () => undefined, onSeek: () => undefined, onTap: () => undefined
    });
    controller.pointerDown({ pointerId: 1, clientX: 60, clientY: 100 });
    controller.pointerUp({ pointerId: 1, clientX: 60, clientY: 100 });
    controller.pointerDown({ pointerId: 2, clientX: 360, clientY: 150 });
    controller.pointerMove({ pointerId: 2, clientX: 360, clientY: 70 });
    expect([clock.pending().length, frames.size()]).toEqual([1, 1]);
    controller.destroy();
    expect([clock.pending().length, frames.size()]).toEqual([0, 0]);
  });

  it('seeds and clamps the channel values the host mirrors from the platform', () => {
    const controller = createGestureController({
      clock: fakeClock(), measure: () => BOUNDS, isLocked: () => false, currentTime: () => 0, duration: () => 10,
      volumeSeed: 1.4, brightnessSeed: -2,
      onVolume: () => undefined, onBrightness: () => undefined, onSeek: () => undefined, onTap: () => undefined
    });
    expect(controller.values()).toEqual({ volume: 1, brightness: 0 });
    controller.seed('volume', 0.3);
    expect(controller.values().volume).toBe(0.3);
  });
});
