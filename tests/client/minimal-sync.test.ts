import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCatalogBundle } from '../../src/core/catalog-bundle-loader';
import { createDiscoverySync } from '../../src/core/discovery-sync';
import { MemoryCacheDisk, PublicCache } from '../../src/core/storage/public-cache';

afterEach(() => vi.useRealTimers());
describe('MIN-02 bounded bundle and playback-friendly discovery', () => {
  it.each(['fetch', 'body'])('aborts a hanging %s after 60 seconds', async (stage) => {
    vi.useFakeTimers(); let signal: AbortSignal | null | undefined;
    const pending = fetchCatalogBundle('https://example.test/assets/catalog-bundle.json', async (_u, init) => {
      signal = init?.signal;
      if (stage === 'fetch') return new Promise<Response>(() => {});
      return new Response(new ReadableStream({ start() {} }));
    });
    const rejected = expect(pending).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await vi.advanceTimersByTimeAsync(60000); await rejected;
    expect(signal?.aborted).toBe(true);
  });
  it('stops before the next page when playback starts', async () => {
    const cache = new PublicCache(new MemoryCacheDisk()); await cache.hydrate(); let busy = false;
    const fetch = vi.fn(async (after: number) => ({ changes: [{ seq: after + 1, workId: 'drama_one', operation: 'upsert' as const, updatedAt: 1,
      card: { id: 'drama_one', title: '剧目', category: '都市', channelId: 'drama' as const, isPrivate: false } }], cursor: after + 1, hasMore: true }));
    const sync = createDiscoverySync({ cache, client: { discoveryChanges: fetch }, busy: () => busy, onEntries: async () => { busy = true; } });
    expect(await sync.sync()).toMatchObject({ cursor: 1, hasMore: true, error: null });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not start a request on a disposed signal', async () => {
    const cache = new PublicCache(new MemoryCacheDisk()); await cache.hydrate(); const controller = new AbortController(); controller.abort();
    const fetch = vi.fn(async () => ({ changes: [], cursor: 0, hasMore: false }));
    await createDiscoverySync({ cache, signal: controller.signal, client: { discoveryChanges: fetch }, onEntries: async () => {} }).sync();
    expect(fetch).not.toHaveBeenCalled();
  });
});
