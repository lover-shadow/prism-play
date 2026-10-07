import type { SearchResponse } from '../../edge/src/types/api';
import { isPrivateSubject } from '../core/storage/storage-domains';

export type SearchInput = { q: string; channel?: string; tag?: string; page?: number; pageSize?: number; discoveryPage?: number };
export type SearchSource = { online: boolean; page: number; discoveryPage?: number; more: boolean; busy: boolean;
  done: boolean; error: string; items: SearchResponse['items']; pending?: boolean; polls?: number };
/** One timer per source, bounded automatic polling; exhaustion remains explicitly pending. */
export function createSearchPoll() {
  const timers = new Map<SearchSource, ReturnType<typeof setTimeout>>();
  return {
    cancel(): void { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); },
    schedule(source: SearchSource, response: SearchResponse, run: () => void): void {
      const old = timers.get(source); if (old !== undefined) clearTimeout(old);
      timers.delete(source);
      if (!response.discoveryPending || (source.polls ?? 0) >= 120) return;
      source.polls = (source.polls ?? 0) + 1;
      const delay = Math.max(1, Math.min(30, response.retryAfterSeconds ?? 1)) * 1000;
      timers.set(source, setTimeout(() => { timers.delete(source); run(); }, delay));
    }
  };
}
/** Overwrite existing IDs with the latest successful response without shifting their position. */
export function applySearchPage(source: SearchSource, response: SearchResponse): void {
  const merged = new Map(source.items.map((entry) => [entry.item.id, entry]));
  for (const entry of response.items) if (!isPrivateSubject(entry.item)) merged.set(entry.item.id, entry);
  source.items = [...merged.values()]; source.done = true;
  source.pending = response.discoveryPending === true;
  source.more = source.pending || response.discoveryFailed === true || response.discoveryHasMore === true ||
    (response.hasMore ?? response.items.length >= 20);
  if (response.discoveryFailed) source.error = '联网发现暂未完成；可重试，已成功结果保留';
  if (response.discoveryPage !== undefined) source.discoveryPage = response.discoveryPage;
  // A partial window must be revisited when a new provider page appends IDs below its end.
  if (!source.pending && !response.discoveryFailed) {
    if (response.hasMore ?? response.items.length >= 20) source.page += 1;
    else if (response.discoveryHasMore) {
      source.discoveryPage = (source.discoveryPage ?? 1) + 1;
      if (response.items.length >= 20) source.page += 1;
    }
  }
}
