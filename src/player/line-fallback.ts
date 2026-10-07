/**
 * 直连线路的切换状态机（SPEC-APP-REFACTOR A-7.4）。
 *
 * 单独成文件的理由不是"整洁"：`prism-player.ts` 贴着 §10 的 300 行红线，而这条链路要记账的东西
 * （当前第几条线、已经切过几次、哪条线的失败已经上报过）一旦散进 `load()` 与 `handleMediaEvent()`，
 * "≤2 次"与"同一线路只记一次账"就会在两处各自漂移——本项目已经为两个权威各算各的付过一次学费（全屏）。
 *
 * 两条不变量：
 *   1. 切换上限是**次数**而不是线路条数：清单给了五条线也只试 `lines[0..2]`，超出即落到诚实错误态，
 *      绝不让用户在黑屏前看五次转圈（与分享页 `MAX_LINE_SWITCHES` 同一口径）。
 *   2. 每次失败就地记一条遥测（A-8），由 `telemetry.ts` 决定私密剧目拒收；本文件不判断私密性，
 *      只把播放器交出的出处原样透传，避免第二套私密口径。
 */
import type { PlaybackLine } from '../../edge/src/types/api';
import { pushLineSignal, type LineFailureCode } from '../core/native/telemetry';
import { mimeTypeOfMediaUrl } from './title-manifest';

/** A-7.4 的硬上限：`lines[0]` 起播失败后最多再切两条。 */
export const MAX_LINE_SWITCHES = 2;

/** 交给内核的一跳：地址、MIME 与它是第几条线（遥测要按线路序号记账）。 */
export interface ActiveLine {
  line: PlaybackLine;
  index: number;
  url?: string;
  mimeType?: string;
}

export interface LineFallbackDeps {
  /** 遥测载荷的剧目 id 与私密出处：判定留在 `telemetry.ts`，这里只透传。 */
  workId: () => string;
  privacy: () => { isPrivate?: boolean; channelId?: string };
}

export interface LineFallback {
  /** 空清单返回 null——调用方据此退回代理播放链，而不是当成"没有线路可播"。 */
  reset(lines: PlaybackLine[]): ActiveLine | null;
  current(): ActiveLine | null;
  /** 记下这一条的失败并推进；线路耗尽或切换次数用尽时返回 null。 */
  fail(failureCode: LineFailureCode): ActiveLine | null;
  switches(): number;
  attempts(): number;
}

export function createLineFallback(deps: LineFallbackDeps): LineFallback {
  let lines: PlaybackLine[] = [];
  let index = -1;
  let switches = 0;
  // 同一条线路的连续失败只记一次：hls 的 fatal 事件会连着发好几条，全记进队列会挤掉十九条好信号。
  const signalled = new Set<number>();

  const at = (position: number): ActiveLine | null => {
    const line = lines[position];
    if (line === undefined) return null;
    return { line, index: position, url: line.mediaUrl,
      mimeType: line.mediaUrl === undefined ? undefined : mimeTypeOfMediaUrl(line.mediaUrl) };
  };

  return {
    reset(next) {
      lines = next;
      index = lines.length > 0 ? 0 : -1;
      switches = 0;
      signalled.clear();
      return at(index);
    },
    current: () => at(index),
    fail(failureCode) {
      const failed = at(index);
      if (failed !== null && !signalled.has(failed.index)) {
        signalled.add(failed.index);
        pushLineSignal({
          providerId: failed.line.providerId,
          workId: deps.workId(),
          lineIndex: failed.index,
          failureCode,
          ...deps.privacy()
        });
      }
      if (switches >= MAX_LINE_SWITCHES || index + 1 >= lines.length) return null;
      index += 1;
      switches += 1;
      return at(index);
    },
    switches: () => switches,
    attempts: () => index + 1
  };
}
