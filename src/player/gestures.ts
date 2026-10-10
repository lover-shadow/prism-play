/**
 * 全手势播放器手势层（SPEC F-02 / AC-06 / AC-07 / AC-08）：纯几何 + 纯事件状态机。
 *
 * No ArtPlayer import and no document access: `classifyTouch` is a pure function of the geometry handed
 * to it, `GestureController` consumes structural pointer records, so the 0-48 / 48-52 / 52-100 split,
 * the control bands and the double-tap window are provable without a browser.
 *
 * rAF coalescing: a fast swipe fires dozens of pointermoves per frame, and each frame pushes at most
 * one value per channel to the bridge — one JNI hop per frame instead of one per 8 pixels of travel.
 */

import type { Clock } from './sleep-timer';
import {
  BRIGHTNESS_ZONE_MAX, VOLUME_ZONE_MIN, DOUBLE_TAP_WINDOW_MS, SEEK_STEP_SECONDS,
  DEFAULT_TOP_BAND_PX, DEFAULT_BOTTOM_BAND_PX, MOVE_SLOP_PX, DOUBLE_TAP_SLOP_PX,
  clamp, clamp01, classifyTouch, type GestureZone, type ValueChannel,
  type TouchGeometryInput, type TouchClassification
} from './gestures-geometry';
export {
  BRIGHTNESS_ZONE_MAX, VOLUME_ZONE_MIN, DOUBLE_TAP_WINDOW_MS, SEEK_STEP_SECONDS,
  DEFAULT_TOP_BAND_PX, DEFAULT_BOTTOM_BAND_PX, MOVE_SLOP_PX, DOUBLE_TAP_SLOP_PX,
  clamp, clamp01, classifyTouch, type GestureZone, type ValueChannel,
  type TouchGeometryInput, type TouchClassification
};

export interface GestureBounds {
  width: number;
  height: number;
  top: number;
  left: number;
  topBandPx?: number;
  bottomBandPx?: number;
}

/** Structural so a test can hand in a literal; a real `PointerEvent` satisfies it. */
export interface PointerLike {
  pointerId: number;
  clientX: number;
  clientY: number;
  target?: unknown;
}

export interface GestureControllerOptions {
  measure(): GestureBounds;
  onVolume(value: number): void;
  onBrightness(value: number): void;
  /** Signed seconds, already clamped so the position never leaves [0, duration]. */
  onSeek(deltaSeconds: number): void;
  /** Deferred single tap: toggles the control chrome. */
  onTap(point: { x: number; y: number }): void;
  /** Central tap (play/pause toggle) per SPEC §4.3 */
  onCenterTap?(): void;
  /** Horizontal scrub preview during drag (delta in seconds, target time) */
  onScrubPreview?(preview: { deltaSeconds: number; targetSeconds: number; durationSeconds: number }): void;
  /** Horizontal scrub commit on pointer up */
  onScrubCommit?(targetSeconds: number): void;
  /** Cancel any active scrub preview */
  onScrubCancel?(): void;
  /** 全屏触摸锁：true 时所有手势回调被抑制。 */
  isLocked(): boolean;
  clock: Clock;
  currentTime(): number;
  duration(): number;
  /** Frame scheduler injection; defaults to requestAnimationFrame. */
  requestFrame?(callback: () => void): number;
  cancelFrame?(handle: number): void;
  /** False when the gesture began on player chrome (drawer, lock button, ArtPlayer controls). */
  isSurface?(target: unknown): boolean;
  doubleTapWindowMs?: number;
  seekStepSeconds?: number;
  moveSlopPx?: number;
  volumeSeed?: number;
  brightnessSeed?: number;
}

export interface GestureController {
  pointerDown(event: PointerLike): void;
  pointerMove(event: PointerLike): void;
  pointerUp(event: PointerLike): void;
  seed(channel: ValueChannel, value: number): void;
  values(): Record<ValueChannel, number>;
  destroy(): void;
  cancel(): void;
}

interface GestureSession {
  id: number;
  startX: number;
  startY: number;
  lastY: number;
  zone: 'undecided' | ValueChannel | 'scrub' | 'blocked';
  travelled: boolean;
  targetSeconds?: number;
}

const nextFrame = (callback: () => void): number => requestAnimationFrame(callback);
const stopFrame = (handle: number): void => void cancelAnimationFrame(handle);

export function createGestureController(options: GestureControllerOptions): GestureController {
  const clock = options.clock;
  const values: Record<ValueChannel, number> = { volume: clamp01(options.volumeSeed ?? 1), brightness: clamp01(options.brightnessSeed ?? 1) };
  const pending: Record<ValueChannel, number | null> = { volume: null, brightness: null };
  const pointers = new Set<number>();
  let session: GestureSession | null = null;
  let frame: number | null = null;
  let singleTap: number | null = null;
  let lastTap: { at: number; x: number; y: number } | null = null;

  const flush = (): void => {
    frame = null;
    const volume = pending.volume;
    const brightness = pending.brightness;
    pending.volume = null;
    pending.brightness = null;
    if (volume !== null) options.onVolume(volume);
    if (brightness !== null) options.onBrightness(brightness);
  };

  /** At most one bridge call per channel per animation frame, however many pointermoves arrive. */
  const push = (channel: ValueChannel, value: number): void => {
    values[channel] = value;
    pending[channel] = value;
    if (frame === null) frame = (options.requestFrame ?? nextFrame)(flush);
  };

  const localPoint = (event: PointerLike): { x: number; y: number } => {
    const b = options.measure();
    return { x: event.clientX - b.left, y: event.clientY - b.top };
  };

  const zoneAt = (point: { x: number; y: number }, deltaY: number, count = pointers.size): TouchClassification => {
    const b = options.measure();
    return classifyTouch({ x: point.x, y: point.y, width: b.width, height: b.height, deltaY, pointerCount: count, topBandPx: b.topBandPx, bottomBandPx: b.bottomBandPx });
  };

  const clearSingleTap = (): void => {
    if (singleTap !== null) clock.clearTimer(singleTap);
    singleTap = null;
  };

  const handleDrag = (event: PointerLike): void => {
    if (session === null) return;
    const point = localPoint(event);
    const bounds = options.measure();
    if (bounds.width <= 0 || bounds.height <= 0) return;
    const dx = point.x - session.startX;
    const dy = point.y - session.startY;
    if (session.zone === 'undecided') {
      if (Math.max(Math.abs(dx), Math.abs(dy)) < (options.moveSlopPx ?? MOVE_SLOP_PX)) return;
      session.travelled = true;
      if (Math.abs(dy) < Math.abs(dx)) {
        session.zone = options.duration() > 0 ? 'scrub' : 'blocked';
      } else {
        const start = zoneAt({ x: point.x, y: session.startY }, 0).zone;
        session.zone = start === 'volume' || start === 'brightness' ? start : 'blocked';
      }
      if (session.zone === 'blocked') return;
      // Fall through so the travel that decided the axis already counts: a short flick still moves the value.
    }
    if (session.zone === 'blocked') return;
    if (session.zone === 'scrub') {
      const duration = options.duration();
      if (duration <= 0) return;
      const b = options.measure();
      const scaleSeconds = Math.min(Math.max(duration, 30), 180);
      const deltaSeconds = Math.round((dx / (b.width || 400)) * scaleSeconds);
      const current = options.currentTime();
      const targetSeconds = clamp(current + deltaSeconds, 0, duration);
      session.targetSeconds = targetSeconds;
      options.onScrubPreview?.({ deltaSeconds, targetSeconds, durationSeconds: duration });
      return;
    }
    const step = zoneAt({ x: session.startX, y: point.y }, point.y - session.lastY);
    session.lastY = point.y;
    // Leaving the channel (dead band, control band, a second finger) mutes output; re-entering resumes.
    if (step.zone !== session.zone) return;
    push(session.zone, clamp01(values[session.zone] + step.deltaRatio));
  };

  const handleTap = (event: PointerLike): void => {
    const point = localPoint(event);
    // A tap is judged as a one-pointer gesture: the up handler has already released the pointer id.
    if (zoneAt(point, 0, 1).zone === 'control-band') return;
    const now = clock.now();
    const window = options.doubleTapWindowMs ?? DOUBLE_TAP_WINDOW_MS;
    const b = options.measure();
    const xFrac = b.width > 0 ? point.x / b.width : 0.5;
    const yFrac = b.height > 0 ? point.y / b.height : 0.5;
    const isCenter = xFrac >= 0.3 && xFrac <= 0.7 && yFrac >= 0.2 && yFrac <= 0.8;
    const near = lastTap !== null && now - lastTap.at < window &&
      Math.abs(point.x - lastTap.x) < DOUBLE_TAP_SLOP_PX && Math.abs(point.y - lastTap.y) < DOUBLE_TAP_SLOP_PX;
    if (!near) {
      lastTap = { at: now, x: point.x, y: point.y };
      clearSingleTap();
      singleTap = clock.setTimer(() => {
        singleTap = null;
        lastTap = null;
        if (isCenter && options.onCenterTap) {
          options.onCenterTap();
        } else {
          options.onTap(point);
        }
      }, window);
      return;
    }
    // The second tap killed the pending single tap, so the chrome never flickers on a double-tap.
    clearSingleTap();
    lastTap = null;
    if (isCenter && options.onCenterTap) {
      options.onCenterTap();
      return;
    }
    const duration = options.duration();
    if (duration <= 0) return;
    const position = options.currentTime();
    const direction = point.x < options.measure().width / 2 ? -1 : 1;
    const target = clamp(position + direction * (options.seekStepSeconds ?? SEEK_STEP_SECONDS), 0, duration);
    options.onSeek(target - position);
  };

  return {
    pointerDown: (event) => {
      pointers.add(event.pointerId);
      if (options.isLocked()) return;
      if (options.isSurface && !options.isSurface(event.target)) return;
      if (session !== null || pointers.size > 1) return;
      const point = localPoint(event);
      session = { id: event.pointerId, startX: point.x, startY: point.y, lastY: point.y, zone: 'undecided', travelled: false };
    },
    pointerMove: (event) => {
      if (!options.isLocked()) handleDrag(event);
    },
    pointerUp: (event) => {
      const mine = session !== null && session.id === event.pointerId;
      const travelled = session?.travelled ?? false;
      const currentSession = session;
      pointers.delete(event.pointerId);
      if (frame !== null) {
        (options.cancelFrame ?? stopFrame)(frame);
        frame = null;
        flush();
      }
      session = null;
      if (mine && travelled && currentSession?.zone === 'scrub') {
        if (currentSession.targetSeconds !== undefined) {
          options.onScrubCommit?.(currentSession.targetSeconds);
        } else {
          options.onScrubCancel?.();
        }
        return;
      }
      if (mine && !travelled && !options.isLocked()) handleTap(event);
    },
    cancel: () => {
      if (session?.zone === 'scrub') options.onScrubCancel?.();
      session = null; clearSingleTap(); lastTap = null;
    },
    seed: (channel, value) => void (values[channel] = clamp01(value)),
    values: () => ({ ...values }),
    destroy: () => {
      clearSingleTap();
      if (frame !== null) (options.cancelFrame ?? stopFrame)(frame);
      frame = null;
      session = null;
      lastTap = null;
      pointers.clear();
    }
  };
}

/**
 * Binds a controller to real events. move/up live on the window so a drag that leaves the player keeps
 * tracking, which is exactly what a full-height swipe needs.
 */
export function attachGestureLayer(target: HTMLElement, controller: GestureController): { destroy(): void } {
  const moveTarget: EventTarget = target.ownerDocument?.defaultView ?? target;
  const isPointer = (event: Event): boolean => typeof (event as PointerEvent).pointerId === 'number';
  const down = (event: Event) => void (isPointer(event) && controller.pointerDown(event as PointerEvent));
  const move = (event: Event) => void (isPointer(event) && controller.pointerMove(event as PointerEvent));
  const up = (event: Event) => void (isPointer(event) && controller.pointerUp(event as PointerEvent));
  const cancel = (event: Event) => { controller.cancel(); up(event); };

  target.addEventListener('pointerdown', down);
  moveTarget.addEventListener('pointermove', move);
  moveTarget.addEventListener('pointerup', up);
  moveTarget.addEventListener('pointercancel', cancel);

  return {
    destroy: () => {
      target.removeEventListener('pointerdown', down);
      moveTarget.removeEventListener('pointermove', move);
      moveTarget.removeEventListener('pointerup', up);
      moveTarget.removeEventListener('pointercancel', cancel);
      controller.destroy();
    }
  };
}
