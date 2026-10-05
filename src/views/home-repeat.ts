/**
 * HP-06a/b：重复点击的时间窗判定 + 刷新的单飞、代次失效与分路反馈。
 * （HOME-PLAYER-REPAIR-SPEC-AND-PLAN §HP-06 / §3.2 第 4、5 条 / §5.1 HP-06a·HP-06b）
 *
 * 与 R26-07 旧实现的区别只有一条但很关键：旧版把"连续同一个目标"当成刷新，隔多久都刷新；
 * HP-06 要求**第一次重复点击只回本容器顶部，短时间窗内再次点击才真正刷新**，且刷新必须是
 * 一次新的发现轮次（`discover()`），而不是把修订号同步一遍再画一遍旧列表。
 *
 * 三条施工纪律：
 * 1. **时间窗数值只写在这里一次**（`REPEAT_REFRESH_WINDOW_MS`），界面、测试与 main 都只引用常量；
 * 2. **同步与本地重排分开反馈**：`sync()` 失败不阻断 `discover()`，两者的结论各自留在 `RefreshFeedback` 里，
 *    绝不合成"已更新"这类含糊话术（§HP-06「联网同步失败与本地推荐成功分别反馈」）；
 * 3. **单飞 + 代次失效**：窗内连点、下拉与标题点击都落到同一条 pipeline；导航/销毁之后的迟到结果不回写。
 */

import type { DiscoveryReport } from './home-feeds';

/**
 * 【待校准 · 未证工程参数】重复点击判定"短时间窗"的唯一数值。
 * 800ms 取自"回顶动画 + 一次犹豫"的经验量级，既不是 Master 批准的数字，也没有真机数据支撑：
 * 需要在 Android 真机与浏览器两种滚动惯性下复核后一次性改动此处（不散落魔法数）。
 */
export const REPEAT_REFRESH_WINDOW_MS = 800;

/** 刷新状态机的五个对用户可见相位 + 归位 idle（§HP-06「状态必须齐」）。 */
export const REFRESH_PHASES = ['idle', 'refreshing', 'updated', 'no-new', 'offline', 'failed'] as const;
export type RefreshPhase = (typeof REFRESH_PHASES)[number];

export interface RefreshFeedback {
  phase: RefreshPhase;
  /** 云端同步失败的原因；与"本地是否重排成功"分两条陈述，不许合并成"已更新"。 */
  syncError?: unknown;
  /** 发现流程本身失败（含空缓存）的原因：视图据此落五态，状态条只说事实。 */
  error?: unknown;
  /** 本地发现轮次的如实回执：候选读了多少、可见序列是否真变、未看过的候选是否已尽。 */
  report?: DiscoveryReport;
}

export interface HomeRepeatDeps {
  /** 回到当前一级/二级容器的顶部（唯一动作，不夹带刷新）。 */
  top(): void;
  /** 可选的目录同步：失败只影响"联网同步"这一条反馈。 */
  sync?: () => Promise<void>;
  /** 显式刷新的唯一发现入口：新一轮次、本范围候选重选；抛错即本地也排不出来。 */
  discover(): Promise<DiscoveryReport>;
  /** 作废在途结果（视图 ++token 并挂起 feed）。 */
  invalidate(): void;
  feedback(state: RefreshFeedback): void;
  /** 注入时钟：时间窗判定必须能在单测里推进，不吃真实毫秒。 */
  now?: () => number;
}

export interface HomeRepeat {
  refresh(): Promise<void>;
  interrupt(): void;
  busy(): boolean;
  click(target: string): void;
  destroy(): void;
}

export function createHomeRepeat(deps: HomeRepeatDeps): HomeRepeat {
  const now = deps.now ?? ((): number => Date.now());
  let previous: string | null = null, markedAt = 0, generation = 0, disposed = false;
  let pending: Promise<void> | null = null;

  const interrupt = (): void => { previous = null; generation += 1; deps.invalidate(); };

  function refresh(): Promise<void> {
    if (pending !== null) return pending;                 // 单飞：连点、下拉与外部调用都合并成一次
    interrupt();                                          // 先让上一批在途结果作废
    const at = generation;
    deps.feedback({ phase: 'refreshing' });               // 同步等待期间也必须看得见"刷新中"
    pending = (async () => {
      let syncError: unknown = null;
      try {
        await deps.sync?.();
      } catch (error) {
        syncError = error;                                // 同步失败不吞掉本地重排：两条反馈各说各的
      }
      if (disposed || at !== generation) return;
      let report: DiscoveryReport | undefined;
      let localError: unknown = null;
      try {
        report = await deps.discover();
      } catch (error) {
        localError = error;
      }
      if (disposed || at !== generation) return;
      if (localError !== null) {
        deps.feedback({ phase: 'failed', error: localError, ...(syncError === null ? {} : { syncError }) });
        return;
      }
      const outcome: DiscoveryReport = report ?? { changed: false, candidates: 0, delivered: 0, exhausted: true };
      // 网络这一侧的失败有两个来源：目录同步与本范围候选读取。任一失败都只影响"联网同步"这条反馈，
      // 本地是否真的重排出来，另由 report.changed 单独陈述。
      const cause = syncError !== null ? syncError : outcome.error;
      if (cause !== undefined && cause !== null) deps.feedback({ phase: 'offline', syncError: cause, report: outcome });
      else deps.feedback({ phase: outcome.changed ? 'updated' : 'no-new', report: outcome });
    })().finally(() => { previous = null; pending = null; });
    return pending;
  }

  return {
    refresh,
    interrupt,
    busy: () => pending !== null,
    click(target: string): void {
      if (disposed || pending !== null) return;
      const at = now();
      if (previous === target && at - markedAt <= REPEAT_REFRESH_WINDOW_MS) { void refresh(); return; }
      // 首重复、以及"隔了很久才再点同一个目标"，都只回顶，并把序列起点推到这一次点击。
      previous = target;
      markedAt = at;
      deps.top();
    },
    destroy(): void { disposed = true; interrupt(); }
  };
}
