import type { ContentItem, SearchResponse } from '../../edge/src/types/api';
import { season } from '../../edge/src/search/providers/seasons';
import { isPrivateSubject } from './storage/storage-domains';

export interface SeriesDiscoveryDeps {
  search(input: { q: string; channel?: string; page?: number; pageSize?: number }): Promise<SearchResponse>;
  onDiscovered(items: ContentItem[]): Promise<void>;
  maxPages?: number;
}

function normalizeBaseTitle(title: string): string {
  return title.normalize('NFKC').replace(/[\p{P}\s]+$/u, '').trim();
}

export function createSeriesDiscovery(deps: SeriesDiscoveryDeps) {
  const maxPages = deps.maxPages ?? 2;
  const inFlight = new Map<string, Promise<ContentItem[]>>();
  const searchedCache = new Map<string, ContentItem[]>();

  async function discover(target: ContentItem): Promise<ContentItem[]> {
    if (isPrivateSubject(target)) return [];
    const parsed = season(target.title);
    const query = parsed ? parsed.base : target.title;
    const baseKey = normalizeBaseTitle(query);
    if (!baseKey) return [];
    const key = `${target.channelId}:${baseKey}`;

    if (searchedCache.has(key)) return searchedCache.get(key)!;
    const active = inFlight.get(key);
    if (active) return active;

    const task = (async (): Promise<ContentItem[]> => {
      try {
        const found = new Map<string, ContentItem>();
        let complete = false;
        for (let page = 1; page <= maxPages; page += 1) {
          let response: SearchResponse;
          try { response = await deps.search({ q: query, channel: target.channelId, page, pageSize: 20 }); }
          catch { break; }
          for (const hit of response.items) {
            const item = hit.item;
            if (isPrivateSubject(item) || item.channelId !== target.channelId || item.enabled === false) continue;
            const p = season(item.title);
            const hitBase = p ? normalizeBaseTitle(p.base) : normalizeBaseTitle(item.title);
            if (hitBase === baseKey && item.id !== target.id) {
              found.set(item.id, item);
            }
          }
          if (response.discoveryPending || response.discoveryFailed) break;
          if (!response.hasMore) { complete = !response.discoveryHasMore; break; }
        }
        const list = [...found.values()];
        if (list.length > 0) await deps.onDiscovered(list);
        if (complete) searchedCache.set(key, list);
        return list;
      } catch {
        return [];
      } finally {
        inFlight.delete(key);
      }
    })();

    inFlight.set(key, task);
    return task;
  }

  return { discover };
}
