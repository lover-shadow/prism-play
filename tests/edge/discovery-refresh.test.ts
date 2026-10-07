import { describe, expect, it, vi } from 'vitest';
import { asD1, createInMemoryD1 } from '../support/sqlite-d1';
import { publishDiscoveryFact, readDiscoveryChanges, withdrawDiscoveryFact } from '../../edge/src/search/discovery-store';
import type { DiscoveryContext } from '../../edge/src/search/discovery-store';
import type { DiscoveryProvider, DiscoveryPublicFact } from '../../edge/src/search/discovery-provider';
import { refreshDiscoveryWorks } from '../../edge/src/search/discovery-refresh';

const fact = (count: number): DiscoveryPublicFact => ({ providerId: 'provider_s1', sourceItemId: '10', id: 'drama_s_10',
  workId: 'drama_s_10', title: '故事', channelId: 'drama', category: '故事', enabled: true, isPrivate: false,
  shareable: true, generatedAt: 100, episodeCount: count,
  episodes: Array.from({ length: count }, (_, i) => ({ episodeNumber: i + 1, title: `第${i + 1}集`,
    mediaValidation: 'url-only-not-playback-verified', lines: [{ providerId: 'provider_s1', mediaUrl: `https://media.example.test/${i + 1}.mp4` }] })) });

function setup() {
  const sqlite = createInMemoryD1(), DB = asD1(sqlite), objects = new Map<string, Uint8Array>();
  let now = 100;
  const bucket = { get: async (key: string) => {
    const bytes = objects.get(key); return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } : null;
  }, put: async (key: string, bytes: Uint8Array) => { objects.set(key, bytes.slice()); return { key }; } };
  const context: DiscoveryContext = { bindings: { DB, DISCOVERY_BUCKET: bucket as unknown as R2Bucket },
    authority: async () => ({ authoritative: false }), nowSeconds: () => now };
  return { sqlite, context, setTime: (value: number) => { now = value; } };
}

describe('bounded public discovery refresh', () => {
  it('refreshes an ongoing work after thirty minutes but leaves other identities untouched', async () => {
    const f = setup();
    const ongoing = { ...fact(1), releaseStatus: 'ongoing' as const, lastSyncedEpisode: 1, lastSyncedAt: 100 };
    await publishDiscoveryFact(f.context, 'provider_s1', '10', ongoing, 100, 86400, 'drama_s_10');
    f.setTime(2000);
    const provider: DiscoveryProvider = { id: 'provider_s1', search: vi.fn(async () => []),
      resolve: vi.fn(async () => ({ status: 'complete' as const, fact: { ...fact(2), releaseStatus: 'ongoing' as const } })) };
    expect((await refreshDiscoveryWorks(f.context, [provider], 1, 'drama_s_99')).examined).toBe(0);
    expect((await refreshDiscoveryWorks(f.context, [provider], 1, 'drama_s_10')).published).toBe(1);
    expect(provider.resolve).toHaveBeenCalledOnce();
  });
  it('refreshes existing shared work without searching and publishes new episodes to shared changes', async () => {
    const f = setup();
    await publishDiscoveryFact(f.context, 'provider_s1', '10', fact(1), 100, 86400, 'drama_s_10');
    f.setTime(22000);
    const provider: DiscoveryProvider = { id: 'provider_s1', search: vi.fn(async () => []),
      resolve: vi.fn(async () => ({ status: 'complete' as const, fact: fact(2) })) };
    expect(await refreshDiscoveryWorks(f.context, [provider])).toMatchObject({ examined: 1, published: 1, failed: 0 });
    expect(provider.search).not.toHaveBeenCalled();
    const row = f.sqlite.selectOne('SELECT card_json FROM discovery_works WHERE work_id = ?', 'drama_s_10');
    expect(JSON.parse(String(row?.card_json)).episodeCount).toBe(2);
    expect((await refreshDiscoveryWorks(f.context, [provider])).examined).toBe(0);
  });
  it('can refresh an expired but not explicitly withdrawn work', async () => {
    const f = setup();
    await publishDiscoveryFact(f.context, 'provider_s1', '10', fact(1), 100, 86400, 'drama_s_10');
    f.setTime(90000);
    const provider: DiscoveryProvider = { id: 'provider_s1', search: vi.fn(async () => []),
      resolve: vi.fn(async () => ({ status: 'complete' as const, fact: fact(2) })) };
    expect((await refreshDiscoveryWorks(f.context, [provider])).published).toBe(1);
  });
  it('does not resurrect an expired tombstone without a new public discovery', async () => {
    const f = setup();
    await publishDiscoveryFact(f.context, 'provider_s1', '10', fact(1), 100, 86400, 'drama_s_10');
    f.setTime(90000);
    await readDiscoveryChanges(f.context, 0, 90000);
    const provider: DiscoveryProvider = { id: 'provider_s1', search: vi.fn(async () => []),
      resolve: vi.fn(async () => ({ status: 'complete' as const, fact: fact(2) })) };
    expect((await refreshDiscoveryWorks(f.context, [provider])).published).toBe(0);
    expect(provider.resolve).not.toHaveBeenCalled();
  });
  it('does not republish a work withdrawn while refresh was resolving', async () => {
    const f = setup();
    await publishDiscoveryFact(f.context, 'provider_s1', '10', fact(1), 100, 86400, 'drama_s_10');
    f.setTime(22000);
    const provider: DiscoveryProvider = { id: 'provider_s1', search: vi.fn(async () => []), resolve: async () => {
      await withdrawDiscoveryFact(f.context.bindings.DB, 'drama_s_10', 22000);
      return { status: 'complete', fact: fact(2) };
    } };
    expect((await refreshDiscoveryWorks(f.context, [provider])).published).toBe(0);
    expect(f.sqlite.selectOne('SELECT enabled FROM discovery_works WHERE work_id = ?', 'drama_s_10')?.enabled).toBe(0);
  });
  it('does not overwrite a newer shared fact published during refresh', async () => {
    const f = setup();
    await publishDiscoveryFact(f.context, 'provider_s1', '10', fact(1), 100, 86400, 'drama_s_10');
    f.setTime(22000);
    const provider: DiscoveryProvider = { id: 'provider_s1', search: vi.fn(async () => []), resolve: async () => {
      await publishDiscoveryFact(f.context, 'provider_s1', '10', fact(3), 22000, 86400, 'drama_s_10');
      return { status: 'complete', fact: fact(2) };
    } };
    expect((await refreshDiscoveryWorks(f.context, [provider])).published).toBe(0);
    const row = f.sqlite.selectOne('SELECT card_json FROM discovery_works WHERE work_id = ?', 'drama_s_10');
    expect(JSON.parse(String(row?.card_json)).episodeCount).toBe(3);
  });
  it('rejects a different fact published within the same timestamp as the refresh snapshot', async () => {
    const f = setup();
    await publishDiscoveryFact(f.context, 'provider_s1', '10', fact(1), 100, 86400, 'drama_s_10');
    f.setTime(22000);
    const provider: DiscoveryProvider = { id: 'provider_s1', search: vi.fn(async () => []), resolve: async () => {
      f.setTime(100);
      const replacement = await publishDiscoveryFact(f.context, 'provider_s1', '10', fact(3), 100, 86400, 'drama_s_10');
      expect(replacement.status).toBe('published');
      f.setTime(22000);
      return { status: 'complete', fact: fact(2) };
    } };
    expect((await refreshDiscoveryWorks(f.context, [provider])).published).toBe(0);
    const row = f.sqlite.selectOne('SELECT card_json FROM discovery_works WHERE work_id = ?', 'drama_s_10');
    expect(JSON.parse(String(row?.card_json)).episodeCount).toBe(3);
  });
  it('does not let an unfinished long work monopolize the next refresh batch', async () => {
    const f = setup();
    await publishDiscoveryFact(f.context, 'provider_s1', '10', fact(1), 100, 86400, 'drama_s_10');
    const second = { ...fact(1), id: 'drama_s_11', workId: 'drama_s_11', sourceItemId: '11', title: '另一故事' };
    await publishDiscoveryFact(f.context, 'provider_s1', '11', second, 100, 86400, 'drama_s_11');
    f.setTime(22000);
    const seen: string[] = [];
    const provider: DiscoveryProvider = { id: 'provider_s1', search: vi.fn(async () => []),
      resolve: async (candidate) => {
        seen.push(candidate.id);
        return { status: 'progress', cursor: `checkpoint-${candidate.id}`, state: {} as never,
          resolvedEpisodes: 1, expectedEpisodes: 95 };
      } };
    await refreshDiscoveryWorks(f.context, [provider], 1);
    f.setTime(22301);
    await refreshDiscoveryWorks(f.context, [provider], 1);
    expect(seen).toEqual(['drama_s_10', 'drama_s_11']);
  });
  it('resumes a bounded checkpoint across worker instances without searching again', async () => {
    const f = setup();
    await publishDiscoveryFact(f.context, 'provider_s1', '10', fact(1), 100, 86400, 'drama_s_10');
    f.setTime(22000);
    const resolve = vi.fn<DiscoveryProvider['resolve']>(async (_candidate, cursor, budget) => {
      expect(budget).toEqual({ maxRequests: 8, timeoutMs: 15000 });
      if (!cursor) return { status: 'progress', cursor: 'fixture-checkpoint',
        state: {} as never, resolvedEpisodes: 1, expectedEpisodes: 2 };
      expect(cursor).toBe('fixture-checkpoint');
      return { status: 'complete', fact: fact(2) };
    });
    const provider: DiscoveryProvider = { id: 'provider_s1', search: vi.fn(async () => []), resolve };
    expect((await refreshDiscoveryWorks(f.context, [provider])).pending).toBe(1);
    f.setTime(22301);
    expect((await refreshDiscoveryWorks(f.context, [{ ...provider }])).published).toBe(1);
    expect(resolve).toHaveBeenCalledTimes(2); expect(provider.search).not.toHaveBeenCalled();
  });
  it('rejects an upstream episode-count shrink and retains the shared series', async () => {
    const f = setup();
    await publishDiscoveryFact(f.context, 'provider_s1', '10', fact(2), 100, 86400, 'drama_s_10');
    f.setTime(22000);
    const provider: DiscoveryProvider = { id: 'provider_s1', search: vi.fn(async () => []),
      resolve: vi.fn(async () => ({ status: 'complete' as const, fact: fact(1) })) };
    expect((await refreshDiscoveryWorks(f.context, [provider])).failed).toBe(1);
    const row = f.sqlite.selectOne('SELECT card_json FROM discovery_works WHERE work_id = ?', 'drama_s_10');
    expect(JSON.parse(String(row?.card_json)).episodeCount).toBe(2);
    expect((await refreshDiscoveryWorks(f.context, [provider])).examined).toBe(0);
  });
  it('retains the previous fact when upstream resolution is blocked', async () => {
    const f = setup();
    await publishDiscoveryFact(f.context, 'provider_s1', '10', fact(1), 100, 86400, 'drama_s_10');
    f.setTime(22000);
    const provider: DiscoveryProvider = { id: 'provider_s1', search: vi.fn(async () => []),
      resolve: vi.fn(async () => ({ status: 'blocked' as const, providerId: 'provider_s1' as const, reason: 'unavailable' as const })) };
    expect((await refreshDiscoveryWorks(f.context, [provider])).failed).toBe(1);
    expect(f.sqlite.selectOne('SELECT enabled FROM discovery_works WHERE work_id = ?', 'drama_s_10')?.enabled).toBe(1);
    expect((await refreshDiscoveryWorks(f.context, [provider])).examined).toBe(0);
    f.setTime(26000);
    expect((await refreshDiscoveryWorks(f.context, [provider])).examined).toBe(1);
  });
});
