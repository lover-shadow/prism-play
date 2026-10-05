/**
 * HP-06 发现式刷新的候选重选（HOME-PLAYER-REPAIR-SPEC-AND-PLAN §HP-06 / §3.2 第 4、5 条）。
 *
 * 这一层只管"把本轮可见候选按真实曝光重新收成一份候选池"，配额与席位归 `home-recommendation.ts`，
 * 频道/分类筛选归 `home-rank-scope.ts`：三件事各有唯一实现处，不互相顶算。
 *
 * 两条诚实边界：
 * 1. **降权不是洗牌**：只把"已经真实看过"的整体移出本轮池，池内相对次序仍由画像分与来源内热度分位决定，
 *    同输入必同输出，绝不随机打乱来冒充"每次都不一样"（SPEC §HP-06「不能承诺每次每张都不同」）；
 * 2. **不硬凑**：未看过的候选不足以铺满一页时，宁可如实回 `exhausted` 让上层说"没有新内容"，
 *    也不把看过的重新塞回前排（那正是"重画旧列表"的假刷新）。
 */

import type { ContentItem } from '../../edge/src/types/api';

export interface DiscoveryPool {
  items: ContentItem[];
  /** 本轮被移出前排的已曝光作品数；0 且 `exhausted` 为假即"本机还没有真实可见信号"。 */
  demoted: number;
  /** 未曝光候选不足以铺满一页：只能老实说没有新内容。 */
  exhausted: boolean;
}

/**
 * 发现池：`exposed` 来自 `home-exposure.ts` 的进程内可见集合（真实相交比例＋停留达标才在里面）。
 * 跨源重复 workId 在这里先收一次（§3.2「先统一去 private/撤片/重复 workId」的端侧前半段）。
 */
export function discoveryPool(
  candidates: readonly ContentItem[],
  exposed: ReadonlySet<string>,
  pageSize: number
): DiscoveryPool {
  const fresh: ContentItem[] = [];
  const stale: ContentItem[] = [];
  const seen = new Set<string>();
  for (const item of candidates) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    (exposed.has(item.id) ? stale : fresh).push(item);
  }
  // 未看过的够铺一页：已曝光的整轮出局；不够时也让未看过的先占位，这本身就是新的发现。
  if (fresh.length >= pageSize) return { items: fresh, demoted: stale.length, exhausted: false };
  if (fresh.length > 0) return { items: [...fresh, ...stale], demoted: 0, exhausted: false };
  // 一个没看过的都没有：不许把看过的重新洗一遍冒充新意，如实交给上层说"没有新内容"。
  return { items: stale, demoted: 0, exhausted: stale.length > 0 };
}

/** 序列是否真的变了：`changed` 是"有没有新东西"的唯一判据，不用条数或修订号冒充。 */
export function changedSequence(before: readonly string[], after: readonly string[]): boolean {
  return before.length !== after.length || after.some((id, index) => before[index] !== id);
}
