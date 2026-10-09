import { describe, expect, it, vi } from 'vitest';
import { PublicCache, MemoryCacheDisk } from '../../src/core/storage/public-cache';
import { createDiscoverySync, createDiscoveryIndexPatcher, type DiscoveryChangesResponse } from '../../src/core/discovery-sync';
import type { ContentItem } from '../../edge/src/types/api';
import type { SnapshotFeed } from '../../src/core/storage/search-index';

const card = (id: string, title = id): ContentItem => ({ id, title, channelId: 'drama', category: '都市', isPrivate: false });
const page: DiscoveryChangesResponse = { changes: [{ seq: 1, workId: 'drama_new', operation: 'upsert', updatedAt: 1, card: card('drama_new') }], cursor: 1, hasMore: false };
describe('AC-OPT-04/05/06/07 durable discovery index receipts', () => {
  it('deduplicates repeated IDs and restores the base row after withdrawal', async () => {
    const cache = new PublicCache(new MemoryCacheDisk()); await cache.hydrate();
    await cache.importBundle({ revision: 4, channels: { version: 1, channels: [] }, items: [card('base')] });
    const write = vi.fn(async (_feed: SnapshotFeed) => ({ error: null }));
    const patch = createDiscoveryIndexPatcher(cache, { sync: write, clear: vi.fn() });
    await patch([], [
      { seq: 1, workId: 'base', operation: 'upsert', updatedAt: 1 },
      { seq: 2, workId: 'base', operation: 'withdraw', updatedAt: 2 }
    ]);
    expect(write.mock.calls[0][0].changes).toEqual([{ operation: 'upsert', revision: 4, contentId: 'base', item: card('base') }]);
  });
  it.each(['index', 'cursor'])('recovers a %s failure before making any network request', async (fault) => {
    const disk = new MemoryCacheDisk(), cache = new PublicCache(disk); await cache.hydrate();
    const index = vi.fn(async () => {});
    if (fault === 'index') index.mockRejectedValueOnce(new Error('index failure'));
    else vi.spyOn(cache, 'commitDiscoveryCursor').mockRejectedValueOnce(new Error('cursor failure'));
    const first = createDiscoverySync({ cache, client: { discoveryChanges: async () => page }, onEntries: index });
    expect((await first.sync()).error).toContain('failure');
    const restart = new PublicCache(disk); await restart.hydrate();
    const repaired: string[] = [];
    const recovered = createDiscoverySync({ cache: restart, onEntries: async (_items, changes) => {
      repaired.push(...(changes ?? []).map((c) => c.workId));
    }, client: { discoveryChanges: async () => {
      expect(repaired).toEqual(['drama_new']);
      expect(restart.discoveryState().cursor).toBe(1);
      throw new Error('offline');
    } } });
    expect(await recovered.sync()).toMatchObject({ cursor: 1, error: 'offline' });
  });
  it('failed cache batch leaves no durable receipt or new card', async () => {
    const disk = new MemoryCacheDisk(), cache = new PublicCache(disk); await cache.hydrate();
    vi.spyOn(disk, 'writeBatch').mockRejectedValueOnce(new Error('disk full'));
    const index = vi.fn(async () => {});
    await createDiscoverySync({ cache, onEntries: index, client: { discoveryChanges: async () => page } }).sync();
    const restarted = new PublicCache(disk); await restarted.hydrate();
    expect(restarted.getItem('drama_new')).toBeNull();
    expect(index).not.toHaveBeenCalled();
  });
});
