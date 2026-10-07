/** Independent public discovery log: disk -> merged index -> cache-scoped cursor. */
import type { ContentItem } from '../../edge/src/types/api';
import { PUBLIC_CHANNEL_IDS } from '../../edge/src/types/api';
import type { PublicCache } from './storage/public-cache';
import { isPrivateSubject } from './storage/storage-domains';

// Local wire definition until the edge DTO is available; no runtime edge dependency.
export interface DiscoveryChangesResponse {
  changes: Array<{ seq: number; workId: string; operation: 'upsert' | 'withdraw'; updatedAt: number; card?: ContentItem }>;
  cursor: number;
  hasMore: boolean;
}
export interface DiscoverySyncResult { cursor: number; pages: number; hasMore: boolean; error: string | null }
export interface DiscoverySyncDeps {
  cache: PublicCache;
  client: { discoveryChanges(after: number, limit?: number): Promise<DiscoveryChangesResponse> };
  /** Must finish indexing (or throw) before the cursor can advance. */
  onEntries(items: readonly ContentItem[]): Promise<void>;
  pageBudget?: number;
  limit?: number;
}

function validate(response: DiscoveryChangesResponse, after: number): DiscoveryChangesResponse['changes'] {
  if (!response || !Array.isArray(response.changes) || typeof response.hasMore !== 'boolean'
    || !Number.isSafeInteger(response.cursor) || response.cursor < after) throw new Error('Invalid discovery response');
  const ordered = [...response.changes].sort((a, b) => a.seq - b.seq);
  let previous = after;
  for (const change of ordered) {
    if (!Number.isSafeInteger(change.seq) || change.seq <= previous || change.seq > response.cursor
      || typeof change.workId !== 'string' || !change.workId || !Number.isFinite(change.updatedAt)
      || !['upsert', 'withdraw'].includes(change.operation)) throw new Error('Invalid discovery change');
    // A card on a withdraw is not used, but must never smuggle private metadata into the public path.
    if (change.card && (isPrivateSubject(change.card) || !(PUBLIC_CHANNEL_IDS as readonly string[]).includes(change.card.channelId))) {
      throw new Error('Private discovery rejected');
    }
    if (change.operation === 'upsert' && (!change.card || change.card.id !== change.workId || !change.card.title)) {
      throw new Error('Invalid discovery card');
    }
    previous = change.seq;
  }
  if (response.hasMore && (ordered.length === 0 || response.cursor <= after)) throw new Error('Non-progressing discovery page');
  return ordered;
}

const runs = new WeakMap<PublicCache, Promise<DiscoverySyncResult>>();
export function createDiscoverySync(deps: DiscoverySyncDeps): { sync(): Promise<DiscoverySyncResult> } {
  const { cache } = deps;
  const bounded = (value: number | undefined, fallback: number, max: number): number =>
    Number.isFinite(value) ? Math.min(max, Math.max(1, Math.floor(value as number))) : fallback;
  const budget = bounded(deps.pageBudget, 4, 10), limit = bounded(deps.limit, 100, 200);
  async function run(): Promise<DiscoverySyncResult> {
    const start = cache.discoveryState();
    let cursor = start.cursor, pages = 0, hasMore = false;
    try {
      for (; pages < budget;) {
        const response = await deps.client.discoveryChanges(cursor, limit);
        const changes = validate(response, cursor);
        await cache.applyDiscoveryChanges(changes, start.epoch);
        // Full merged input is authoritative for withdrawals, including base ids that must survive.
        await deps.onEntries(cache.list());
        await cache.commitDiscoveryCursor(response.cursor, start.epoch);
        cursor = response.cursor; pages += 1; hasMore = response.hasMore;
        if (!hasMore) break;
      }
      return { cursor, pages, hasMore, error: null };
    } catch (error) {
      return { cursor: cache.discoveryState().cursor, pages, hasMore, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return {
    sync() {
      const active = runs.get(cache);
      if (active) return active;
      const task = run().finally(() => { runs.delete(cache); });
      runs.set(cache, task);
      return task;
    }
  };
}
