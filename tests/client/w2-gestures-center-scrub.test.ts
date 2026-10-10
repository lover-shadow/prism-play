// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createGestureController } from '../../src/player/gestures';
import type { GestureBounds, PointerLike } from '../../src/player/gestures';
import { systemClock } from '../../src/player/sleep-timer';

const BOUNDS: GestureBounds = { width: 1000, height: 500, top: 0, left: 0, topBandPx: 0, bottomBandPx: 0 };
const point = (x: number, y: number, id = 1): PointerLike => ({ pointerId: id, clientX: x, clientY: y });

describe('W2 中央单点/双击与水平定位手势仲裁（SPEC §4.3）', () => {
  it('中央区域单点（30%-70%宽，20%-80%高）触发 onCenterTap，外围单点触发 onTap', async () => {
    vi.useFakeTimers();
    try {
      const centerTaps = vi.fn();
      const outerTaps = vi.fn();
      const controller = createGestureController({
        clock: { now: () => Date.now(), setTimer: (cb, ms) => window.setTimeout(cb, ms) as unknown as number, clearTimer: (id) => clearTimeout(id) },
        measure: () => BOUNDS, isLocked: () => false, currentTime: () => 30, duration: () => 100,
        onVolume: vi.fn(), onBrightness: vi.fn(), onSeek: vi.fn(),
        onTap: outerTaps,
        onCenterTap: centerTaps
      });

      // 1. 中央点按 (500, 250) -> 50% 宽，50% 高
      controller.pointerDown(point(500, 250));
      controller.pointerUp(point(500, 250));
      vi.advanceTimersByTime(350);
      expect(centerTaps).toHaveBeenCalledTimes(1);
      expect(outerTaps).not.toHaveBeenCalled();

      // 2. 外围点按 (100, 250) -> 10% 宽 (左侧外围)
      controller.pointerDown(point(100, 250));
      controller.pointerUp(point(100, 250));
      vi.advanceTimersByTime(350);
      expect(outerTaps).toHaveBeenCalledTimes(1);
      expect(centerTaps).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('中央区域双击合并为 onCenterTap，不触发外围的 ±10s onSeek', async () => {
    vi.useFakeTimers();
    try {
      const centerTaps = vi.fn();
      const seeks = vi.fn();
      const controller = createGestureController({
        clock: { now: () => Date.now(), setTimer: (cb, ms) => window.setTimeout(cb, ms) as unknown as number, clearTimer: (id) => clearTimeout(id) },
        measure: () => BOUNDS, isLocked: () => false, currentTime: () => 30, duration: () => 100,
        onVolume: vi.fn(), onBrightness: vi.fn(),
        onSeek: seeks,
        onTap: vi.fn(),
        onCenterTap: centerTaps
      });

      // 中央快速双击 (500, 250)
      controller.pointerDown(point(500, 250));
      controller.pointerUp(point(500, 250));
      vi.advanceTimersByTime(100);
      controller.pointerDown(point(500, 250));
      controller.pointerUp(point(500, 250));
      vi.advanceTimersByTime(350);

      expect(centerTaps).toHaveBeenCalledTimes(1);
      expect(seeks).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('外围双击正常触发 ±10s onSeek', async () => {
    vi.useFakeTimers();
    try {
      const seeks = vi.fn();
      const controller = createGestureController({
        clock: { now: () => Date.now(), setTimer: (cb, ms) => window.setTimeout(cb, ms) as unknown as number, clearTimer: (id) => clearTimeout(id) },
        measure: () => BOUNDS, isLocked: () => false, currentTime: () => 30, duration: () => 100,
        onVolume: vi.fn(), onBrightness: vi.fn(),
        onSeek: seeks,
        onTap: vi.fn()
      });

      // 右外围快速双击 (900, 250) -> seek +10s
      controller.pointerDown(point(900, 250));
      controller.pointerUp(point(900, 250));
      vi.advanceTimersByTime(100);
      controller.pointerDown(point(900, 250));
      controller.pointerUp(point(900, 250));
      vi.advanceTimersByTime(350);

      expect(seeks).toHaveBeenCalledWith(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it('水平滑动触发 onScrubPreview 实时预览，抬手提交 onScrubCommit', async () => {
    const previews: any[] = [];
    const commits: number[] = [];
    const controller = createGestureController({
      clock: systemClock,
      measure: () => BOUNDS, isLocked: () => false, currentTime: () => 50, duration: () => 100,
      onVolume: vi.fn(), onBrightness: vi.fn(), onSeek: vi.fn(), onTap: vi.fn(),
      onScrubPreview: (p) => previews.push(p),
      onScrubCommit: (s) => commits.push(s)
    });

    // 从 (500, 250) 向右拖动 200px (水平方向，明显大于垂直 dy)
    controller.pointerDown(point(500, 250));
    controller.pointerMove(point(510, 250)); // 尚未超 12px moveSlop
    expect(previews).toHaveLength(0);

    controller.pointerMove(point(600, 250)); // 超过 moveSlop，水平滑动判定成立
    expect(previews.length).toBeGreaterThan(0);
    expect(previews[previews.length - 1].targetSeconds).toBeGreaterThan(50);

    controller.pointerUp(point(600, 250));
    expect(commits).toHaveLength(1);
    expect(commits[0]).toBe(previews[previews.length - 1].targetSeconds);
  });
});
