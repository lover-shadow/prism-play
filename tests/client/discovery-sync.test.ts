import { describe, expect, it, vi } from 'vitest';
import type { ContentItem } from '../../edge/src/types/api';
import { PrismApiClient } from '../../src/core/api/client';
import { createDiscoverySync, type DiscoveryChangesResponse } from '../../src/core/discovery-sync';
import { MemoryCacheDisk, PublicCache } from '../../src/core/storage/public-cache';

const card = (id: string, title = id): ContentItem => ({ id, title, channelId: 'drama', category: '都市', isPrivate: false } as ContentItem);
const up = (seq: number, id: string, title = id) => ({ seq, workId: id, operation: 'upsert' as const, updatedAt: seq, card: card(id, title) });
const page = (changes: DiscoveryChangesResponse['changes'], hasMore = false): DiscoveryChangesResponse => ({ changes, cursor: Math.max(0, ...changes.map((row) => row.seq)), hasMore });
async function setup(disk = new MemoryCacheDisk()) {
  const cache = new PublicCache(disk); await cache.hydrate();
  const fetch = vi.fn(async (_after: number) => page([]));
  const index = vi.fn(async (_items: readonly ContentItem[]) => undefined);
  const sync = createDiscoverySync({ cache, client: { discoveryChanges: fetch }, onEntries: index, pageBudget: 2 });
  return { disk, cache, fetch, index, sync };
}

describe('independent public discovery sync', () => {
  it('hydrates persisted cursor across restart; budgets pages and resumes next run', async () => {
    const s = await setup();
    s.fetch.mockImplementation(async (after) => page([up(after + 1, `d_${after + 1}`)], true));
    expect(await s.sync.sync()).toMatchObject({ cursor: 2, pages: 2, hasMore: true });
    const restarted = await setup(s.disk);
    restarted.fetch.mockImplementation(async (after) => ({ changes: [], cursor: after, hasMore: false }));
    await restarted.sync.sync();
    expect(restarted.fetch).toHaveBeenCalledWith(2, 100, undefined);
    expect(restarted.cache.list()).toHaveLength(2);
  });
  it('indexes only durable merged entries and advances cursor only after indexing', async () => {
    const s = await setup(); s.fetch.mockResolvedValue(page([up(1, 'd_new')]));
    s.index.mockImplementation(async (items) => {
      const restart = new PublicCache(s.disk); await restart.hydrate();
      expect(restart.list()).toEqual(items);
      expect(restart.discoveryState().cursor).toBe(0);
      expect(s.cache.discoveryState().cursor).toBe(0);
    });
    await s.sync.sync(); expect(s.cache.discoveryState().cursor).toBe(1);
  });
  it('sorts changes by seq and updates an existing discovery even at unchanged base revision', async () => {
    const s = await setup(); await s.cache.mergeDiscoveries([card('d_one', '旧集')]);
    s.fetch.mockResolvedValue(page([up(2, 'd_one', '新集'), up(1, 'd_one', '中集')]));
    await s.sync.sync();
    expect(s.cache.getItem('d_one')?.title).toBe('新集');
    expect(s.index.mock.calls.at(-1)?.[0][0]?.title).toBe('新集');
  });
  it('disk failure does not index or advance; retry retains offline items', async () => {
    const s = await setup(); await s.cache.mergeDiscoveries([card('d_old')]);
    s.fetch.mockResolvedValue(page([up(1, 'd_new')]));
    vi.spyOn(s.disk, 'writeBatch').mockRejectedValueOnce(new Error('disk full'));
    expect(await s.sync.sync()).toMatchObject({ cursor: 0, error: 'disk full' });
    expect(s.cache.list().map((row) => row.id)).toEqual(['d_old']);
    expect(s.index).not.toHaveBeenCalled();
    await s.sync.sync(); expect(s.cache.discoveryState().cursor).toBe(1);
  });
  it('index and cursor commit failures keep cursor replayable after disk succeeds', async () => {
    const s = await setup(); s.fetch.mockResolvedValue(page([up(1, 'd_new')]));
    s.index.mockRejectedValueOnce(new Error('index unavailable'));
    expect(await s.sync.sync()).toMatchObject({ cursor: 0, error: 'index unavailable' });
    expect(s.cache.getItem('d_new')).not.toBeNull();
    const commit = vi.spyOn(s.cache, 'commitDiscoveryCursor').mockRejectedValueOnce(new Error('cursor failed'));
    expect(await s.sync.sync()).toMatchObject({ cursor: 0, error: 'cursor failed' });
    commit.mockRestore(); await s.sync.sync(); expect(s.cache.discoveryState().cursor).toBe(1);
  });
  it('rejects an entire private batch before any disk, index or cursor writes', async () => {
    for (const over of [{ isPrivate: true }, { channelId: 'private' }]) {
      const s = await setup(), secret = up(2, 'p_secret'); Object.assign(secret.card, over);
      s.fetch.mockResolvedValue(page([up(1, 'd_ok'), secret]));
      expect((await s.sync.sync()).error).not.toBeNull();
      expect(s.cache.list()).toEqual([]); expect(s.index).not.toHaveBeenCalled();
      expect(s.cache.discoveryState().cursor).toBe(0);
    }
  });
  it('withdraw removes supplements only and never mutates static base', async () => {
    const s = await setup();
    await s.cache.importBundle({ revision: 7, channels: { version: 1, channels: [] }, items: [card('d_base')] });
    await s.cache.mergeDiscoveries([card('d_extra')]);
    s.fetch.mockResolvedValue(page([{ seq: 1, workId: 'd_extra', operation: 'withdraw', updatedAt: 1 }, { seq: 2, workId: 'd_base', operation: 'withdraw', updatedAt: 2 }]));
    await s.sync.sync(); expect(s.cache.list().map((row) => row.id)).toEqual(['d_base']);
    expect(s.cache.snapshotRevision()).toBe(7);
    const restarted = await setup(s.disk); expect(restarted.cache.list().map((row) => row.id)).toEqual(['d_base']);
  });
  it('clear resets cursor and rejects a pre-clear in-flight page', async () => {
    const s = await setup(); s.fetch.mockResolvedValue(page([up(1, 'd_first')])); await s.sync.sync();
    let resolve!: (value: DiscoveryChangesResponse) => void;
    s.fetch.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const running = s.sync.sync(); await Promise.resolve(); await s.cache.clearCache();
    resolve(page([up(2, 'd_stale')])); await running;
    expect(s.cache.list()).toEqual([]); expect(s.cache.discoveryState().cursor).toBe(0);
    s.fetch.mockResolvedValue(page([up(1, 'd_first')])); await s.sync.sync();
    expect(s.fetch.mock.calls.at(-1)?.[0]).toBe(0);
  });
  it('coalesces same-process concurrent calls and preserves cursor on network or malformed responses', async () => {
    const s = await setup(); s.fetch.mockRejectedValueOnce(new Error('offline'));
    const first = s.sync.sync(); expect(s.sync.sync()).toBe(first); await first;
    expect(s.fetch).toHaveBeenCalledTimes(1);
    for (const response of [page([up(0, 'd_bad')]), { changes: [], cursor: 0, hasMore: true }, page([up(1, 'd_a'), up(1, 'd_b')])]) {
      s.fetch.mockResolvedValue(response); expect((await s.sync.sync()).error).not.toBeNull();
      expect(s.cache.discoveryState().cursor).toBe(0);
    }
  });
  it('uses the independent GET endpoint without private session headers; preserves discoveryPage search input', async () => {
    const fetch = vi.fn(async (_input: string, _init?: RequestInit) => new Response(JSON.stringify(page([]))));
    const api = new PrismApiClient({ baseUrl: 'https://example.test', fetchImpl: fetch });
    api.bindSessionHolder({ read: () => 'secret', write: () => undefined });
    await api.discoveryChanges(12, 100);
    expect(fetch.mock.calls[0]?.[0]).toBe('https://example.test/api/search/discoveries?after=12&limit=100');
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers).not.toHaveProperty('X-Private-Session');
    await api.search({ q: '新剧', discoveryPage: 3 }); expect(fetch.mock.calls[1]?.[0]).toContain('discoveryPage=3');
  });
});
