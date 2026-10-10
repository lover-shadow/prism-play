/** R26-03: left brightness, right volume; central reserve and double-tap seek unchanged. */
export const BRIGHTNESS_ZONE_MAX = 0.48;
export const VOLUME_ZONE_MIN = 0.52;
export const DOUBLE_TAP_WINDOW_MS = 300;
export const SEEK_STEP_SECONDS = 10;
/** 控件条像素带：其中的点按属于按钮本身，绝不驱动手势（SPEC §10 的 ≥44px 触点即落在此带内）。 */
export const DEFAULT_TOP_BAND_PX = 48;
export const DEFAULT_BOTTOM_BAND_PX = 64;
export const MOVE_SLOP_PX = 12;
export const DOUBLE_TAP_SLOP_PX = 44;

export type GestureZone = 'volume' | 'brightness' | 'dead-band' | 'control-band' | 'scrub';
export type ValueChannel = 'volume' | 'brightness';

export interface TouchGeometryInput {
  x: number;
  y: number;
  width: number;
  height: number;
  deltaY: number;
  pointerCount: number;
  topBandPx?: number;
  bottomBandPx?: number;
}

export interface TouchClassification {
  zone: GestureZone;
  /** Horizontal position inside the play surface, 0..1. */
  xFraction: number;
  /** Vertical travel as a fraction of the full height: a full-height swipe spans the whole 0..1 range. */
  deltaRatio: number;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

/**
 * The one geometry authority. Outside the surface, multi-touch and non-vertical travel come back as
 * `scrub`, which owns neither HUD; inside the control bands nothing is emitted either.
 */
export function classifyTouch(input: TouchGeometryInput): TouchClassification {
  const { x, y, width, height, deltaY, pointerCount } = input;
  const inside = pointerCount === 1 && width > 0 && height > 0 && x >= 0 && x <= width && y >= 0 && y <= height;
  if (!inside) return { zone: 'scrub', xFraction: 0, deltaRatio: 0 };
  const xFraction = clamp01(x / width);
  const top = input.topBandPx ?? DEFAULT_TOP_BAND_PX;
  const bottom = input.bottomBandPx ?? DEFAULT_BOTTOM_BAND_PX;
  if (y < top || y > height - bottom) return { zone: 'control-band', xFraction, deltaRatio: 0 };
  // Dragging up lowers clientY, so the sign flip is what makes "swipe up" mean "more".
  const deltaRatio = clamp(-deltaY / height, -1, 1);
  if (xFraction < BRIGHTNESS_ZONE_MAX) return { zone: 'brightness', xFraction, deltaRatio };
  if (xFraction > VOLUME_ZONE_MIN) return { zone: 'volume', xFraction, deltaRatio };
  return { zone: 'dead-band', xFraction, deltaRatio };
}
