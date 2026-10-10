/**
 * W4 / W5: 分级媒体预取调度器与网络感知 (SPEC §4.4 / §4.5)。
 * 优先级: 0 当前播放 > 1 下一集预取 > 2 系列后续 > 3 预测候选 Top10
 */

import {
  canDownloadOverNetwork, MAX_PREFETCH_CONCURRENCY,
  type MediaNetworkPolicy
} from './media-cache-policy';

export type PrefetchPriority = 0 | 1 | 2 | 3;
export const PRIORITY_CURRENT_GAP: PrefetchPriority = 0;
export const PRIORITY_NEXT_EPISODE: PrefetchPriority = 1;
export const PRIORITY_SERIES_LOOKAHEAD: PrefetchPriority = 2;
export const PRIORITY_PREDICTIVE_TOP10: PrefetchPriority = 3;

export interface PrefetchTask {
  id: string;
  workId: string;
  episodeNumber: number;
  priority: PrefetchPriority;
  maxBytes?: number;
  run: (signal: AbortSignal) => Promise<void>;
}

interface QueuedItem {
  task: PrefetchTask;
  controller: AbortController;
  enqueuedAt: number;
}

export class MediaPrefetchScheduler {
  private networkPolicy: MediaNetworkPolicy = 'wifi_only';
  private isWifi = true;
  private isPlaybackBuffering = false;
  private readonly queue: QueuedItem[] = [];
  private readonly active = new Map<string, QueuedItem>();

  constructor(options?: { policy?: MediaNetworkPolicy; isWifi?: boolean }) {
    if (options?.policy) this.networkPolicy = options.policy;
    if (options?.isWifi !== undefined) this.isWifi = options.isWifi;
  }

  setNetworkState(isWifi: boolean): void {
    const changed = this.isWifi !== isWifi;
    this.isWifi = isWifi;
    if (changed && !canDownloadOverNetwork(this.networkPolicy, this.isWifi)) {
      this.cancelAllPrefetch('network_policy_violation');
    } else {
      this.pump();
    }
  }

  setNetworkPolicy(policy: MediaNetworkPolicy): void {
    this.networkPolicy = policy;
    if (!canDownloadOverNetwork(this.networkPolicy, this.isWifi)) {
      this.cancelAllPrefetch('policy_disabled');
    } else {
      this.pump();
    }
  }

  setPlaybackBuffering(buffering: boolean): void {
    this.isPlaybackBuffering = buffering;
    if (buffering) {
      // 正在缓冲，取消非关键的投机预取（优先级 > 0），让路带宽
      for (const [id, item] of this.active) {
        if (item.task.priority > PRIORITY_CURRENT_GAP) {
          item.controller.abort();
          this.active.delete(id);
          // 放回队列头部待网络恢复
          this.queue.unshift(item);
        }
      }
    } else {
      this.pump();
    }
  }

  enqueue(task: PrefetchTask): boolean {
    if (!canDownloadOverNetwork(this.networkPolicy, this.isWifi) && task.priority > PRIORITY_CURRENT_GAP) {
      return false;
    }
    // 已有相同 id 则去重
    if (this.active.has(task.id) || this.queue.some((q) => q.task.id === task.id)) {
      return false;
    }

    const item: QueuedItem = {
      task,
      controller: new AbortController(),
      enqueuedAt: Date.now()
    };

    // 按优先级排序插入（优先级数字越小越靠前）
    const idx = this.queue.findIndex((q) => q.task.priority > task.priority);
    if (idx === -1) this.queue.push(item);
    else this.queue.splice(idx, 0, item);

    this.pump();
    return true;
  }

  cancel(taskId: string): void {
    const activeItem = this.active.get(taskId);
    if (activeItem) {
      activeItem.controller.abort();
      this.active.delete(taskId);
    }
    const qIdx = this.queue.findIndex((q) => q.task.id === taskId);
    if (qIdx !== -1) this.queue.splice(qIdx, 1);
    this.pump();
  }

  cancelForWork(workId: string): void {
    for (const [id, item] of this.active) {
      if (item.task.workId === workId) {
        item.controller.abort();
        this.active.delete(id);
      }
    }
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].task.workId === workId) {
        this.queue.splice(i, 1);
      }
    }
    this.pump();
  }

  cancelAllPrefetch(_reason?: string): void {
    for (const [id, item] of this.active) {
      if (item.task.priority > PRIORITY_CURRENT_GAP) {
        item.controller.abort();
        this.active.delete(id);
      }
    }
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i].task.priority > PRIORITY_CURRENT_GAP) {
        this.queue.splice(i, 1);
      }
    }
  }

  getStats(): { queueLength: number; activeCount: number; isWifi: boolean; policy: MediaNetworkPolicy } {
    return {
      queueLength: this.queue.length,
      activeCount: this.active.size,
      isWifi: this.isWifi,
      policy: this.networkPolicy
    };
  }

  private pump(): void {
    if (this.isPlaybackBuffering) return;
    if (!canDownloadOverNetwork(this.networkPolicy, this.isWifi)) return;

    while (this.active.size < MAX_PREFETCH_CONCURRENCY && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;

      this.active.set(next.task.id, next);
      void (async () => {
        try {
          await next.task.run(next.controller.signal);
        } catch {
          // 预取失败静默降级，不阻断主链路
        } finally {
          this.active.delete(next.task.id);
          this.pump();
        }
      })();
    }
  }
}
