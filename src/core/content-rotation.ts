/**
 * W5: 内容轮换、曝光降权、7:3 探索交错与最多 10 候选预测缓存 (SPEC §4.2 / §4.5)。
 * 严格落地 Master 铁律：7:3 E&E 策略（偏好利用 + 破茧探索），单候选 <= 32MiB，总预测预算 <= 20%。
 */

import type { ContentItem } from '../../edge/src/types/api';

export const MAX_PREDICTIVE_CANDIDATES = 10;
export const MAX_PREDICTIVE_ITEM_BYTES = 32 * 1024 * 1024; // 32 MiB
export const MAX_PREDICTIVE_BUDGET_RATIO = 0.2; // 占总配额 20%
export const DEFAULT_EXPOSURE_TTL_MS = 24 * 60 * 60 * 1000; // 24小时

export interface PredictiveCandidate {
  workId: string;
  title: string;
  episodeNumber: number;
  durationSeconds?: number;
  budgetBytes: number;
}

export class ExposureTracker {
  private readonly exposures = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_EXPOSURE_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  record(workIds: string[], now: number = Date.now()): void {
    for (const id of workIds) {
      this.exposures.set(id, now);
    }
  }

  isExposed(workId: string, now: number = Date.now()): boolean {
    const time = this.exposures.get(workId);
    if (!time) return false;
    if (now - time > this.ttlMs) {
      this.exposures.delete(workId);
      return false;
    }
    return true;
  }

  clear(): void {
    this.exposures.clear();
  }

  size(): number {
    return this.exposures.size;
  }
}

/**
 * 7:3 探索/利用交错器 (70% 偏好利用 + 30% 未曝光破茧探索)
 */
export function applyEeInterleave(
  exploitPool: ContentItem[],
  explorePool: ContentItem[]
): ContentItem[] {
  const result: ContentItem[] = [];
  const seen = new Set<string>();

  let exploitIdx = 0;
  let exploreIdx = 0;

  while (exploitIdx < exploitPool.length || exploreIdx < explorePool.length) {
    // 放入最多 7 个偏好利用候选
    for (let i = 0; i < 7 && exploitIdx < exploitPool.length; i++) {
      const item = exploitPool[exploitIdx++];
      if (!seen.has(item.id)) {
        seen.add(item.id);
        result.push(item);
      }
    }
    // 穿插最多 3 个探索候选
    for (let i = 0; i < 3 && exploreIdx < explorePool.length; i++) {
      const item = explorePool[exploreIdx++];
      if (!seen.has(item.id)) {
        seen.add(item.id);
        result.push(item);
      }
    }
  }

  return result;
}

/**
 * 同轮稳定分页会话：同轮内多次读取不乱跳、不重复
 */
export class RotationSession {
  private readonly items: ContentItem[];
  private readonly pageSize: number;
  private cursor = 0;

  constructor(items: ContentItem[], pageSize = 20) {
    this.items = [...items];
    this.pageSize = pageSize;
  }

  nextPage(): ContentItem[] {
    if (this.cursor >= this.items.length) return [];
    const page = this.items.slice(this.cursor, this.cursor + this.pageSize);
    this.cursor += this.pageSize;
    return page;
  }

  hasMore(): boolean {
    return this.cursor < this.items.length;
  }

  reset(): void {
    this.cursor = 0;
  }
}

/**
 * 构建最多 10 部预测候选剧目与预取字节上限
 */
export function buildTop10PredictiveCandidates(params: {
  candidates: ContentItem[];
  currentWorkId?: string;
  totalQuotaBytes: number;
  exposureTracker?: ExposureTracker;
}): PredictiveCandidate[] {
  const { candidates, currentWorkId, totalQuotaBytes, exposureTracker } = params;
  const maxTotalBudget = Math.floor(totalQuotaBytes * MAX_PREDICTIVE_BUDGET_RATIO);
  const now = Date.now();

  const filtered = candidates.filter((c) => {
    if (currentWorkId && c.id === currentWorkId) return false;
    return true;
  });

  // 优先排序：未曝光探索作品排前，随后按热门排序
  const sorted = [...filtered].sort((a, b) => {
    const aExposed = exposureTracker?.isExposed(a.id, now) ? 1 : 0;
    const bExposed = exposureTracker?.isExposed(b.id, now) ? 1 : 0;
    if (aExposed !== bExposed) return aExposed - bExposed;
    return (b.hitsTotal ?? 0) - (a.hitsTotal ?? 0);
  });

  const selected = sorted.slice(0, MAX_PREDICTIVE_CANDIDATES);
  const result: PredictiveCandidate[] = [];
  let allocatedBytes = 0;

  for (const item of selected) {
    if (allocatedBytes >= maxTotalBudget) break;
    // 每部候选最多预分配 32 MiB，且不超过剩余可用预测预算
    const remaining = maxTotalBudget - allocatedBytes;
    const itemBudget = Math.min(MAX_PREDICTIVE_ITEM_BYTES, remaining);
    if (itemBudget <= 0) break;

    result.push({
      workId: item.id,
      title: item.title,
      episodeNumber: 1,
      durationSeconds: 120, // 默认估算短剧单集时长
      budgetBytes: itemBudget
    });
    allocatedBytes += itemBudget;
  }

  return result;
}
