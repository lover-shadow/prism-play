/**
 * 分集断点上报（SPEC §6.1 写入闸门的上游），从 `episode-drawer.ts` 拆出：
 * 面板管的是"用户怎么选集"，这里管的是"选完之后往哪儿写"，两件事共用一个 300 行文件迟早要有人被挤出去。
 *
 * 本模块**永不**直接写存储（SPEC §6.1）：它把当前位置翻译成 `WatchHistoryRow`，连同私密主语一起交给
 * 注入的 `onProgress` 汇口，由存储拦截器（而不是播放器）持有写入闸门。闸门拒绝时如实上报原因，
 * 不重试、不落盘——私密内容零落盘的边界正是靠"这里没有第二条写路径"成立的。
 */

import type { TitleDetail } from '../../edge/src/types/api';
import type { WatchHistoryRow, WriteGuardSubject } from '../core/storage/storage-domains';
import type { Clock } from './sleep-timer';

export interface ProgressContext extends WriteGuardSubject {
  episodeId: number;
  episodeNumber: number;
  episodeTotal: number;
}

export interface ProgressReporter {
  /** True when it emitted. `force` ignores the throttle, for pause / ended / leave. */
  emit(force?: boolean): boolean;
  due(): boolean;
}

export function createProgressReporter(input: {
  clock: Clock;
  intervalMs?: number;
  detail(): TitleDetail | null;
  episodeId(): number | null;
  position(): number;
  duration(): number;
  onProgress?(row: WatchHistoryRow, context: ProgressContext): void;
  onBlocked?(message: string): void;
}): ProgressReporter {
  const intervalMs = input.intervalMs ?? 5_000;
  let lastAt = 0;
  const due = (): boolean => input.clock.now() - lastAt >= intervalMs;
  const privacy = (): WriteGuardSubject => {
    const item = input.detail()?.item;
    return { isPrivate: item?.isPrivate ?? false, channelId: item?.channelId, contentId: item?.id };
  };
  return {
    due,
    emit: (force = false) => {
      const item = input.detail()?.item;
      const episodeId = input.episodeId();
      if (item === undefined || episodeId === null || (!force && !due())) return false;
      const position = input.position();
      const duration = input.duration() || position;
      const episodes = input.detail()?.episodes ?? [];
      const number = episodes.find((episode) => episode.episodeId === episodeId)?.episodeNumber ?? 0;
      lastAt = input.clock.now();
      const row: WatchHistoryRow = {
        content_id: item.id, title: item.title, cover_url: item.coverUrl ?? null, last_episode_id: episodeId,
        last_episode_number: number, position_seconds: Math.round(position), duration_seconds: Math.round(duration),
        total_episodes: episodes.length, updated_at: Math.round(lastAt / 1_000)
      };
      try {
        input.onProgress?.(row, { ...privacy(), episodeId, episodeNumber: number, episodeTotal: episodes.length });
      } catch (error) {
        // The sink's refusal is the AC-02 zero-disk boundary: surface it, never retry it, never write here.
        input.onBlocked?.(error instanceof Error ? error.message : String(error));
      }
      return true;
    }
  };
}
