/**
 * 全屏控件的收起判据（AC-19 / R26-05：controls 正在播才计时收起，暂停、缓冲、拖动、开浮层一律保持）。
 *
 * 为什么要有这个模块：收起与否是**一台状态机**，不是某条 CSS 动画。旧实现里工具栏一挂上去就常驻，
 * 真机全屏时标题条和定时/锁定/选集三枚键一直压在画面上，观感等于把播放器糊住；而"直接 3 秒后收起"
 * 这种朴素写法又会把用户正在用的倍速面板一起收掉——那是更严重的回归。
 *
 * 三条判据按优先级固定：
 *   1. 非全屏不收起——详情台的工具栏是那一屏唯一的控制面，收掉等于没有控制面；
 *   2. 有浮层（选集/倍速/投屏）不收起——浮层是用户主动唤起的，替用户收掉它属于越权；
 *   3. 只有"内核确实在播"才计时；`pause`/`waiting`/`seeking`/`ended`/`error` 立即显形并停表。
 *
 * 计时走注入时钟：单测用假时钟推进，真机用 `systemClock`，两条路径共用同一份判据。
 */

import type { MediaEvent } from './engine-seam';
import type { Clock } from './sleep-timer';

/** 起播后多久收控件：3.5s 够读完一行标题，又短到不会让人以为控件坏在画面上。 */
export const CONTROLS_IDLE_MS = 3_500;

/** 停表即显形的媒体事件：这些时刻用户都在看画面之外的事。 */
const KEEP_EVENTS: readonly MediaEvent[] = ['pause', 'waiting', 'seeking', 'ended', 'error'];

export interface ControlsIdle {
  /** 媒体事件入口，由播放器原样转发内核事件，本模块不另订一份订阅。 */
  onMediaEvent(event: MediaEvent): void;
  /** 单击画面：手动翻转可见性，显示出来时重新计时。 */
  tap(): void;
  /** 立即显形并停表（换集、错误卡、锁定等外部动作）。 */
  show(): void;
  /** 重新计时（起播、源码变化后调用）。 */
  arm(): void;
  destroy(): void;
}

export function createControlsIdle(input: {
  clock: Clock;
  visible(): boolean;
  setVisible(on: boolean): void;
  playing(): boolean;
  fullscreen(): boolean;
  /** 有菜单开着（选集/倍速/投屏）——替用户收起他刚唤起的面板属于越权。 */
  blocked(): boolean;
  idleMs?: number;
}): ControlsIdle {
  const idleMs = input.idleMs ?? CONTROLS_IDLE_MS;
  let timer: number | null = null;
  const stop = (): void => { if (timer !== null) input.clock.clearTimer(timer); timer = null; };

  const arm = (): void => {
    stop();
    if (!input.fullscreen() || !input.playing()) return;
    timer = input.clock.setTimer(() => {
      timer = null;
      // 宿主与内核状态可能先于事件转发变化，到点必须重新核验收起资格。
      if (!input.fullscreen() || !input.playing()) { show(); return; }
      // 到点时若正被浮层占住：不收起，也不放弃计时——浮层一关，下一次到点自然收起。
      if (input.blocked()) { arm(); return; }
      input.setVisible(false);
    }, idleMs);
  };
  const show = (): void => { stop(); input.setVisible(true); };

  return {
    onMediaEvent: (event) => {
      if (event === 'play' || event === 'playing' || event === 'seeked') arm();
      else if (KEEP_EVENTS.includes(event)) show();
    },
    tap: () => {
      if (!input.fullscreen()) { show(); return; }
      if (input.visible()) { stop(); input.setVisible(false); return; }
      show();
      arm();
    },
    show,
    arm,
    destroy: stop
  };
}
