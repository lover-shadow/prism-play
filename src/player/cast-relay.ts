/**
 * 「本集播完自动推下一集」的定时器权威（SPEC §1.5.1 连播段，AC-24）。
 *
 * 为什么单独一个文件：连播是投屏里**唯一**由时间推进的状态，而 `ended` 事件归 `prism-player.ts` 所有，
 * 本包无权改动它。所以连播先按 `PlaybackInfo.durationSeconds` 自行计时推进，并刻意多等
 * `AUTO_CONTINUE_GRACE_MS`；`CastPanel.handleEpisodeEnded()` 是留给播放器的那一行接缝，接上后播完
 * 即刻推进、不必等这段保护间隔。缺那一行的后果只有"连播按定时走"，不是"投屏不可用"。
 *
 * 时长未知的分集**不武装**定时器：没有依据的自动连播，就是在大屏播到一半时把下一集压上去。
 */
import type { EpisodeItem } from '../../edge/src/types/api';
import { autoContinueDelayMs, nextEpisodeId, type TimerPort } from './cast-ports';

export interface CastRelayDeps {
  timers: TimerPort;
  episodes: () => EpisodeItem[];
  currentEpisodeId: () => number;
  /** 没有目标渲染器就没有连播可言：设备为 null 时武装定时器只会攒出一个无人接管的回调。 */
  hasTarget: () => boolean;
  onDue: () => void;
}

export interface CastRelay {
  /** 每次成功推送、以及从暂停恢复后都要重新计时——暂停掉的那段不该算进"本集已播完"。 */
  arm(durationSeconds: number | undefined): void;
  cancel(): void;
  /** 视图层用它决定状态条上要不要出现"支持自动无缝连播"。 */
  armed(): boolean;
}

export function createCastRelay(deps: CastRelayDeps): CastRelay {
  let handle: number | null = null;

  function cancel(): void {
    if (handle !== null) deps.timers.clear(handle);
    handle = null;
  }

  /** 只有"有活动设备 + 时长已知 + 确实还有下一集"三者同时成立才武装，否则宁可不连播。 */
  function arm(durationSeconds: number | undefined): void {
    cancel();
    const delay = autoContinueDelayMs(durationSeconds);
    if (delay === 0 || !deps.hasTarget()) return;
    if (nextEpisodeId(deps.episodes(), deps.currentEpisodeId()) === null) return;
    handle = deps.timers.set(() => {
      handle = null;
      deps.onDue();
    }, delay);
  }

  return { arm, cancel, armed: () => handle !== null };
}
