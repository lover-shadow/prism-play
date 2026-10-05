/**
 * HP-05 选择器的排序与供给机制（`home-recommendation.ts` 的配套模块，为 §10 的 300 行红线也让路）。
 *
 * 这里只有"怎么排、怎么取"，没有配额政策：席位散布与配额由调用方把 `tracks / targets` 传进来，
 * 因此本模块不反向依赖首页配额常量（只 `import type`，运行时零循环）。
 *
 * 【待证工程参数】来源内分位（`percentilesBySource`）与队列轮换（`takeFrom`）都是**工程选择**：
 * 跨源 `hitsTotal` 的单位、统计窗口与更新时间未经核验前，这里不比跨源绝对值，缺证据也绝不冒充 0 分。
 */

import type { ContentItem } from '../../edge/src/types/api';
import type { GenreScores } from './recommendation';
import type { HomeTrack } from './home-recommendation';

export const byId = (a: ContentItem, b: ContentItem): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 缺字段与真实 0 分是两件事：只有 `null` 才表示"没有热度证据"。 */
export function heatOf(item: ContentItem): number | null {
  return typeof item.hitsTotal === 'number' && Number.isFinite(item.hitsTotal) && item.hitsTotal >= 0 ? item.hitsTotal : null;
}

/**
 * 来源内分位：只在同一 `channelId` 内部排名后归一到 0..1，跨频道绝不比绝对 hitsTotal。
 *
 * 【HP-07b 同分收口】真实相等的热度读数取**同一个分位**（不按数组下标把同分拆开），相等即并列，
 * 次序统一交给 workId 收口；否则"同分只按 ID 收口"这条契约会在归一环节被悄悄破坏。
 */
export function percentilesBySource(pool: readonly ContentItem[]): Map<string, number> {
  const groups = new Map<string, ContentItem[]>();
  for (const item of pool) {
    if (heatOf(item) === null) continue;
    const list = groups.get(item.channelId);
    if (list === undefined) groups.set(item.channelId, [item]); else list.push(item);
  }
  const out = new Map<string, number>();
  for (const [, group] of groups) {
    const read = (entry: ContentItem): number => heatOf(entry) ?? 0;
    group.sort((left, right) => read(right) - read(left) || byId(left, right));
    const levels = [...new Set(group.map(read))];
    const span = levels.length - 1;
    group.forEach((entry) => out.set(entry.id, span <= 0 ? 1 : 1 - levels.indexOf(read(entry)) / span));
  }
  return out;
}

/** 排序键：本地画像分（降序）→ 来源内热度分位（降序，缺证据一律最后）→ workId 稳定序。 */
export function makeCompare(scores: GenreScores, percentiles: Map<string, number>) {
  const score = (item: ContentItem): number => {
    const value = scores[item.category];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };
  const rank = (item: ContentItem): number => percentiles.get(item.id) ?? -1;
  return (a: ContentItem, b: ContentItem): number => score(b) - score(a) || rank(b) - rank(a) || byId(a, b);
}

/**
 * 席位散布：把每轨配额均匀铺满一页，避免"前 20 张全是 AI"这类观感；顺序确定即同轮冻结。
 * 剩余空位一律归偏好轨，因此 `targets` 合计小于 `pageSize` 时也不会漏席位。
 */
export function pageSlotPattern(tracks: readonly HomeTrack[], targets: Readonly<Record<HomeTrack, number>>, pageSize: number): HomeTrack[] {
  const slots: (HomeTrack | null)[] = new Array<HomeTrack | null>(pageSize).fill(null);
  const taken = tracks.filter((track) => track !== 'preference').reduce((sum, track) => sum + Math.min(targets[track], pageSize), 0);
  for (const track of tracks) {
    const quota = track === 'preference' ? Math.max(0, pageSize - taken) : Math.min(targets[track], pageSize);
    for (let i = 0; i < quota; i += 1) {
      let at = Math.floor(((i + 0.5) * pageSize) / quota);
      while (at < pageSize && slots[at] !== null) at += 1;
      if (at >= pageSize) at = slots.findIndex((slot) => slot === null);
      if (at < 0) break;
      slots[at] = track;
    }
  }
  return slots.map((slot): HomeTrack => slot ?? 'preference');
}

/** 一条供给池：`queues` 多于一条即按轮换取用（纪录片／动漫两频道兼顾、偏好跨频道轮流都靠它）。 */
export interface Supply {
  queues: ContentItem[][];
  heads: number[];
  rotation: number;
  basis: string;
}

export function makeSupply(queues: ContentItem[][], basis: string): Supply {
  return { queues, heads: queues.map(() => 0), rotation: 0, basis };
}

/** 取一条未被占用的供给：同分已在前一步排好，这里只推进游标，因此同轮追加不会回算前页。 */
export function takeFrom(supply: Supply, taken: Set<string>): ContentItem | undefined {
  const count = supply.queues.length;
  for (let offset = 0; offset < count; offset += 1) {
    const at = (supply.rotation + offset) % count;
    const queue = supply.queues[at];
    while (supply.heads[at] < queue.length) {
      const candidate = queue[supply.heads[at]];
      supply.heads[at] += 1;
      if (taken.has(candidate.id)) continue;
      if (count > 1) supply.rotation = (at + 1) % count;
      return candidate;
    }
  }
  return undefined;
}
