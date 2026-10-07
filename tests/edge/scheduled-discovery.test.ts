import { beforeEach, describe, expect, it, vi } from 'vitest';
import { asD1, createInMemoryD1 } from '../support/sqlite-d1';
import { discoveryQueryKey, acquireDiscoveryLease } from '../../edge/src/search/discovery-query';
import { initializeDiscoveryJobs } from '../../edge/src/search/discovery-jobs';
import { resumePendingDiscoveryQueries, refreshOpenedPublicWork } from '../../edge/src/search/scheduled-discovery';
import { createDiscoveryService, type DiscoveryService } from '../../edge/src/search/discovery-service';
import type { DiscoveryContext } from '../../edge/src/search/discovery-store';
import type { DiscoveryProvider } from '../../edge/src/search/discovery-provider';
import type { Env } from '../../edge/src/types/env';

beforeEach(() => { vi.clearAllMocks(); });
describe('unattended public discovery continuation', () => {
  it('does not consult sources for private, fresh or unrelated detail responses', async () => {
    const get = vi.fn(async () => null);
    const env = { SEARCH_DISCOVERY_ENABLED: 'true', DISCOVERY_BUCKET: {}, KV: { get } } as unknown as Env;
    const clock = { nowSeconds: () => 2000, nowMillis: () => 2000000 };
    for (const item of [
      { isPrivate: true, channelId: 'private', releaseStatus: 'ongoing', lastSyncedAt: 0 },
      { isPrivate: false, channelId: 'drama', releaseStatus: 'ongoing', lastSyncedAt: 1999 },
      { isPrivate: false, channelId: 'drama', releaseStatus: 'finished', lastSyncedAt: 0 }
    ]) await refreshOpenedPublicWork(new Request('https://app.example.test/api/titles/drama_s_10'),
      new Response(JSON.stringify({ workId: 'drama_s_10', item })), env, clock);
    expect(get).not.toHaveBeenCalled();
  });
  it('resumes original search scope and page without initializing a new query', async () => {
    const sqlite = createInMemoryD1(), db = asD1(sqlite);
    const scope = JSON.stringify(['public:v2', 'fixture:4', ['provider_s1'], 3]);
    const key = await discoveryQueryKey('故事', scope), lease = await acquireDiscoveryLease(db, `query:${key.qhash}`, 100, 300);
    if (!lease) throw new Error('fixture lease');
    await initializeDiscoveryJobs(db, key, lease, [], false, false, 100);
    const query = vi.fn<DiscoveryService['query']>(async () => ({ items: [], pending: false, failed: false, hasMore: false }));
    const service: DiscoveryService = { query, queryScope: (page) => JSON.stringify(['public:v2', 'fixture:4', ['provider_s1'], page]) };
    expect(await resumePendingDiscoveryQueries(db, service, () => 1000)).toBe(1);
    expect(sqlite.selectOne('SELECT updated_at FROM discovery_job_queries WHERE qhash = ?', key.qhash)?.updated_at).toBe(1000);
    expect(query).toHaveBeenCalledWith('故事', 3, expect.any(Request));
  });
  it('finishes an existing durable job with the real service without another search', async () => {
    const sqlite = createInMemoryD1(), db = asD1(sqlite), objects = new Map<string, Uint8Array>();
    const context: DiscoveryContext = { bindings: { DB: db, DISCOVERY_BUCKET: {
      get: async (key: string) => { const bytes = objects.get(key); return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } : null; },
      put: async (key: string, bytes: Uint8Array) => { objects.set(key, bytes.slice()); return { key }; }
    } as unknown as R2Bucket }, authority: async () => ({ authoritative: false }), nowSeconds: () => 1000 };
    const candidate = { providerId: 'provider_s1' as const, sourceItemId: '10', id: 'drama_s_10', title: '故事', channelId: 'drama' as const };
    const provider: DiscoveryProvider = { id: 'provider_s1', search: vi.fn(async () => []), resolve: async () => ({ status: 'complete', fact: {
      ...candidate, workId: candidate.id, enabled: true, isPrivate: false, shareable: true, generatedAt: 1000,
      episodeCount: 1, episodes: [{ episodeNumber: 1, title: '第一集', mediaValidation: 'url-only-not-playback-verified',
        lines: [{ providerId: 'provider_s1', mediaUrl: 'https://media.example.test/1.mp4' }] }]
    } }) };
    const service = createDiscoveryService(context, [provider], { scope: 'fixture:4' });
    const key = await discoveryQueryKey('故事', service.queryScope(1));
    const lease = await acquireDiscoveryLease(db, `query:${key.qhash}`, 100, 300);
    if (!lease) throw new Error('fixture lease');
    await initializeDiscoveryJobs(db, key, lease, [{ candidate, workId: candidate.id }], false, false, 100);
    expect(await resumePendingDiscoveryQueries(db, service, () => 1000)).toBe(1);
    expect(provider.search).not.toHaveBeenCalled();
    expect(sqlite.selectOne('SELECT status FROM discovery_jobs')?.status).toBe('published');
    expect(sqlite.selectOne('SELECT enabled FROM discovery_works')?.enabled).toBe(1);
  });
  it('rotates bounded pending queries so a third query advances on the next wake-up', async () => {
    const sqlite = createInMemoryD1(), db = asD1(sqlite);
    const scope = JSON.stringify(['public:v2', 'fixture:4', ['provider_s1'], 1]);
    for (const text of ['故事甲', '故事乙', '故事丙']) {
      const key = await discoveryQueryKey(text, scope), lease = await acquireDiscoveryLease(db, `query:${key.qhash}`, 100, 300);
      if (!lease) throw new Error('fixture lease');
      await initializeDiscoveryJobs(db, key, lease, [], false, false, 100);
    }
    const query = vi.fn<DiscoveryService['query']>(async () => ({ items: [], pending: true, failed: false, hasMore: false }));
    const service: DiscoveryService = { query, queryScope: () => scope };
    expect(await resumePendingDiscoveryQueries(db, service, () => 1000)).toBe(2);
    const first = new Set(query.mock.calls.map(([text]) => text));
    expect(await resumePendingDiscoveryQueries(db, service, () => 1001)).toBe(2);
    expect(first.has(query.mock.calls[2][0])).toBe(false);
  });
  it('does not let many stale-scope queries hide current pending work', async () => {
    const sqlite = createInMemoryD1(), db = asD1(sqlite);
    const oldScope = JSON.stringify(['public:v2', 'stale:4', ['provider_s1'], 1]);
    const scope = JSON.stringify(['public:v2', 'fixture:4', ['provider_s1'], 1]);
    for (let i = 0; i < 33; i++) {
      const key = await discoveryQueryKey(`旧故事${i}`, oldScope), lease = await acquireDiscoveryLease(db, `query:${key.qhash}`, 100, 300);
      if (!lease) throw new Error('fixture lease');
      await initializeDiscoveryJobs(db, key, lease, [], false, false, 100);
    }
    const key = await discoveryQueryKey('新故事', scope), lease = await acquireDiscoveryLease(db, `query:${key.qhash}`, 101, 300);
    if (!lease) throw new Error('fixture lease');
    await initializeDiscoveryJobs(db, key, lease, [], false, false, 101);
    const query = vi.fn<DiscoveryService['query']>(async () => ({ items: [], pending: true, failed: false, hasMore: false }));
    expect(await resumePendingDiscoveryQueries(db, { query, queryScope: () => scope }, () => 1000)).toBe(1);
    expect(query.mock.calls[0][0]).toBe('新故事');
  });
  it('does not consume refresh checkpoints or a different provider configuration scope', async () => {
    const sqlite = createInMemoryD1(), db = asD1(sqlite);
    for (const scope of ['public-refresh:v1', JSON.stringify(['public:v2', 'stale:4', ['provider_s1'], 1])]) {
      const key = await discoveryQueryKey('故事', scope), lease = await acquireDiscoveryLease(db, `query:${key.qhash}`, 100, 300);
      if (!lease) throw new Error('fixture lease');
      await initializeDiscoveryJobs(db, key, lease, [], false, false, 100);
    }
    const query = vi.fn<DiscoveryService['query']>();
    expect(await resumePendingDiscoveryQueries(db, { query, queryScope: () => 'current' })).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});
