import { describe, expect, it, vi } from 'vitest';
import { createCardDiscoveryService } from '../../edge/src/search/discovery-card-service';
import { asD1, createInMemoryD1 } from '../support/sqlite-d1';
import { saveDiscoveryCard, readDiscoveryCard } from '../../edge/src/search/discovery-cards';
import { readDiscoveryChanges, type DiscoveryContext } from '../../edge/src/search/discovery-store';

function fixture(authoritative = false) {
  const sqlite = createInMemoryD1();
  const context: DiscoveryContext = {
    bindings: { DB: asD1(sqlite) }, nowSeconds: () => 100,
    authority: async () => authoritative ? { authoritative: true, read: { status: 'rejected' } } : { authoritative: false }
  };
  return { sqlite, context };
}
const candidate = { providerId: 'provider_s1' as const, sourceItemId: '10', id: 'drama_s_10',
  title: '故事', channelId: 'drama' as const, episodeCount: 100,
  coverTargetUrl: 'https://cover.example/cover.jpg', synopsis: '故事简介' };

describe('standalone discovery cards', () => {
  it('returns and caches search cards without calling episode resolve', async () => {
    const f = fixture();
    const provider = { id: 'provider_s1' as const, search: vi.fn(async () => [candidate]), resolve: vi.fn() };
    const service = createCardDiscoveryService(f.context, [provider]);
    const request = new Request('https://app.example/api/search');
    const first = await service.query('故事', 1, request);
    expect(first.items[0].item.title).toBe('故事');
    expect(first.pending).toBe(false);
    expect(first.failed).toBe(false);
    expect((await service.query('故事', 1, request)).items).toEqual(first.items);
    expect(provider.search).toHaveBeenCalledTimes(1);
    expect(provider.resolve).not.toHaveBeenCalled();
  });
  it('retains a successful provider result when another provider fails', async () => {
    const f = fixture();
    const service = createCardDiscoveryService(f.context, [
      { id: 'provider_s1', search: async () => [candidate], resolve: vi.fn() },
      { id: 'provider_m1', search: async () => { throw new Error('unavailable'); }, resolve: vi.fn() }
    ]);
    const result = await service.query('故事', 1, new Request('https://app.example/api/search'));
    expect(result.failed).toBe(true);
    expect(result.items[0].item.id).toBe(candidate.id);
  });
  it('stores and reads a search card without an R2 bucket or episode resolution', async () => {
    const f = fixture();
    expect(await saveDiscoveryCard(f.context, candidate)).toBe(true);
    const stored = await readDiscoveryCard(f.context, candidate.id);
    expect(stored?.item).toMatchObject({ id: candidate.id, title: '故事', episodeCount: 100 });
    expect(JSON.stringify(stored?.item)).not.toContain('cover.example');
    expect(stored?.candidate.coverTargetUrl).toBe(candidate.coverTargetUrl);
    expect(await f.context.bindings.DB.prepare('SELECT COUNT(*) AS n FROM discovery_works').first('n')).toBe(0);
  });
  it('publishes cards through the shared changes feed without complete facts', async () => {
    const f = fixture();
    await saveDiscoveryCard(f.context, candidate);
    const changes = await readDiscoveryChanges(f.context, 0, 100);
    expect(changes.changes).toHaveLength(1);
    expect(changes.changes[0]).toMatchObject({ workId: candidate.id, operation: 'upsert', card: { title: '故事' } });
  });
  it('does not expire a stored card just because the query cache is stale', async () => {
    const f = fixture();
    await saveDiscoveryCard(f.context, candidate);
    f.context.nowSeconds = () => 999999;
    expect((await readDiscoveryCard(f.context, candidate.id))?.item.title).toBe('故事');
  });
  it('does not turn a baseline denial into a new discovery card', async () => {
    const f = fixture(true);
    expect(await saveDiscoveryCard(f.context, candidate)).toBe(false);
    expect(await readDiscoveryCard(f.context, candidate.id)).toBeNull();
  });
});
