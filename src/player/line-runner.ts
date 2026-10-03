/**
 * 起播地址的编排层（SPEC-APP-REFACTOR A-7.2 / A-7.4）。
 *
 * 存在的理由是把"这一跳该播什么地址"收敛成**一种形状**（`Surface`），让 `prism-player.ts` 只管界面：
 * 直连上游与云端代理回退在界面侧从此无差别——同一个 `applySurface`、同一个断点续播、同一个诚实错误态。
 * §10 的 300 行红线也依赖这一刀：播放器再长一条能力就要先删一行别处的。
 *
 * 两条优先级（A-7.5 的回退链）：
 *   1. 剧集清单在场 → `lines[0].mediaUrl` 直连上游（魔都 CDN 全链路 `Access-Control-Allow-Origin: *` 已实测）；
 *   2. 清单缺席（旧云端仍返回 `TitleDetail`、私密 404、断网、`titleManifest` 未注入）→ 退回
 *      `/api/episodes/{id}/playback` 的代理句柄。**这条回退不是装饰**：云端清单尚未铺满时用户照常能看，
 *      而不是看到一张"暂无可用播放源"的假失败卡。
 *
 * 失败切换在此记账（≤2 次，见 `line-fallback.ts`），一次故障的多路事件（hls fatal 与 `video:error`）
 * 由 `LINE_SWITCH_GUARD_MS` 合并成一次切换；真实的两条线路各自失败间隔远大于这个窗口
 * （hls 的加载超时下限是十秒级），所以窗口不会误伤第二次真失败。
 */
import type { PlaybackInfo, TitleManifest } from '../../edge/src/types/api';
import type { Clock } from './sleep-timer';
import { clamp } from './gestures';
import type { LineFallback } from './line-fallback';
import type { PlayerEngine } from './engine-seam';
import type { TitleManifestStore } from './title-manifest';

/** 同一次故障的连发事件合并窗口。 */
export const LINE_SWITCH_GUARD_MS = 1_200;

/** 交给内核的一跳：地址、类型、第几条线路（null = 代理回退链）与已按真实时长夹过的续播秒数。 */
export interface Surface {
  url: string;
  mimeType?: string;
  lineIndex: number | null;
  durationSeconds: number;
}

export type LineOutcome =
  | { kind: 'surface'; surface: Surface; resumeSeconds: number }
  /** 地址根本拿不到：调用方按 `errorKindOf` 渲染诚实错误态（私密与未知同构，AC-02-6）。 */
  | { kind: 'unavailable'; error: unknown }
  /** 备用线路用尽：调用方落错误卡，失败信号已在 `line-fallback` 里就地记进遥测队列。 */
  | { kind: 'exhausted' }
  /** 该沉默的失败：非直连语义、或同一次故障的重复事件——界面不得为此重复渲染。 */
  | { kind: 'silent' };

export interface LineRunnerDeps {
  api: { playback(episodeId: number): Promise<PlaybackInfo>; titleManifest?(workId: string): Promise<TitleManifest> };
  manifests: TitleManifestStore;
  lines: LineFallback;
  engine: () => PlayerEngine | null;
  clock: Clock;
  workId: () => string;
  episodeNumber: () => number;
}

export interface LineRunner {
  start(episodeId: number, resumeSeconds: number): Promise<LineOutcome>;
  /** 直连语义下的一次线路失败；`position` 用来把断点带到下一条线，绝不因切线而回到片头。 */
  fail(position: number): LineOutcome;
  active(): boolean;
  reset(): void;
}

export function createLineRunner(deps: LineRunnerDeps): LineRunner {
  let lineIndex: number | null = null;
  let lastSwitchAt = -Infinity;
  const now = deps.clock.now;
  const live = (): PlayerEngine | null => deps.engine();

  const resumed = (seconds: number, duration: number): number =>
    (seconds > 0 ? (duration > 0 ? clamp(seconds, 0, duration) : seconds) : 0);

  const hopSurface = (hop: NonNullable<ReturnType<LineFallback['reset']>>): Surface =>
    ({ url: hop.url, mimeType: hop.mimeType, lineIndex: hop.index, durationSeconds: 0 });

  return {
    active: () => lineIndex !== null,
    reset() { lineIndex = null; lastSwitchAt = -Infinity; },

    async start(episodeId, resumeSeconds) {
      // 清单是地址的唯一入口：`typeof` 这道判定就是"新链路优先、旧链路兜底"的开关位。
      const candidates = typeof deps.api.titleManifest === 'function'
        ? await deps.manifests.linesFor(deps.workId(), deps.episodeNumber())
        : [];
      const hop = deps.lines.reset(candidates);
      if (hop !== null) {
        lineIndex = hop.index;
        lastSwitchAt = -Infinity;
        return { kind: 'surface', surface: hopSurface(hop), resumeSeconds: resumed(resumeSeconds, 0) };
      }
      try {
        const info = await deps.api.playback(episodeId);
        lineIndex = null;
        return {
          kind: 'surface',
          surface: { url: info.url, mimeType: info.mimeType, lineIndex: null, durationSeconds: info.durationSeconds ?? 0 },
          resumeSeconds: resumed(resumeSeconds, info.durationSeconds ?? 0)
        };
      } catch (error) {
        return { kind: 'unavailable', error };
      }
    },

    fail(position) {
      if (lineIndex === null || now() - lastSwitchAt < LINE_SWITCH_GUARD_MS) return { kind: 'silent' };
      const failureCode = live()?.failureCode?.() ?? 'http_error';
      const next = deps.lines.fail(failureCode);
      lastSwitchAt = now();
      if (next === null) { lineIndex = null; return { kind: 'exhausted' }; }
      lineIndex = next.index;
      // 断点跟着走：上一条线跑到哪儿，下一条就从哪儿继续，用户不该为源站的故障重看一遍。
      return { kind: 'surface', surface: hopSurface(next), resumeSeconds: resumed(position, 0) };
    }
  };
}
