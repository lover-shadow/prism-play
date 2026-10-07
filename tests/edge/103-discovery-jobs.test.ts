import { describe, expect, it, vi } from 'vitest';
import { asD1, createInMemoryD1 } from '../support/sqlite-d1';
import { createDiscoveryService } from '../../edge/src/search/discovery-service';
import { createS1Provider } from '../../edge/src/search/providers/s1';
import { createM1Provider } from '../../edge/src/search/providers/m1';
import { acquireDiscoveryLease, discoveryQueryKey, releaseDiscoveryLease } from '../../edge/src/search/discovery-query';
import { claimDiscoveryJob, initializeDiscoveryJobs, readDiscoveryCursor, readDiscoveryJobs,
  safeDiscoveryCandidate, saveDiscoveryJob } from '../../edge/src/search/discovery-jobs';
import { discoveryWorkId } from '../../edge/src/search/discovery-facts';
import { readDiscoveryFact } from '../../edge/src/search/discovery-store';
import type { DiscoveryContext } from '../../edge/src/search/discovery-store';
import type { DiscoveryConfig, DiscoveryCandidate } from '../../edge/src/search/discovery-provider';

function fixture() {
  const sqlite = createInMemoryD1(), DB = asD1(sqlite), objects = new Map<string, Uint8Array>();
  let now = 100;
  const bucket = {
    get: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } : null;
    }),
    put: vi.fn(async (key: string, bytes: Uint8Array) => { objects.set(key, bytes.slice()); return { key }; })
  };
  const context: DiscoveryContext = { bindings: { DB, DISCOVERY_BUCKET: bucket as unknown as R2Bucket },
    authority: async () => ({ authoritative: false }), nowSeconds: () => now };
  const request = new Request('https://app.invalid/search', { headers: { 'CF-Connecting-IP': '192.0.2.5' } });
  return { sqlite, DB, objects, bucket, context, request, setClock: (clock: number) => { now = clock; } };
}
const candidate: DiscoveryCandidate = { providerId: 'provider_s1', sourceItemId: '10', id: 'drama_s_10', title: '故事', channelId: 'drama' };
const router = (key: string, value: unknown) => `<script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { [key]: value } })};</script>`;
function config(handler: (url: URL) => string): DiscoveryConfig {
  return { origin: 'https://api.example', originAllowlist: new Set(['https://api.example']),
    mediaAllowlist: new Set(['https://media.example']), coverAllowlist: new Set(['https://cover.example']),
    fetcher: async (url) => new Response(handler(new URL(url))) };
}

describe('durable discovery checkpoints and real adapter integration', () => {
  it('retains search card metadata while rejecting malformed metadata', () => {
    const card = { ...candidate, episodeCount: 100, synopsis: '故事简介', coverTargetUrl: 'https://cover.example/cover.jpg' };
    expect(safeDiscoveryCandidate(card)).toEqual(card);
    expect(() => safeDiscoveryCandidate({ ...card, episodeCount: -1 })).toThrow();
    expect(() => safeDiscoveryCandidate({ ...card, coverTargetUrl: 'http://cover.example/cover.jpg' })).toThrow();
  });
  it('publishes all 95 episodes across fresh service/provider instances without repeating search or first-page detail', async () => {
    const f = fixture(); let searchGets = 0, detailGets = 0, playerGets = 0, batchGets = 0;
    const cfg = config((url) => {
      batchGets++;
      const row = { series_id_str: '10', series_title: '故事' };
      if (url.pathname.startsWith('/search/')) {
        searchGets++; return router('search_page', { query: '故事', isSuccess: true, searchList: [{ video_data: row }] });
      }
      if (url.pathname === '/detail') {
        detailGets++; return router('detail_page', { seriesDetail: { ...row, episode_cnt: 95,
          vid_list: Array.from({ length: 95 }, (_, i) => String(i + 100)) } });
      }
      playerGets++;
      const vid = url.pathname.split('/').pop();
      return router('player_page', { series_id: '10', vid, video_player_info: { main_url: `https://media.example/${vid}.mp4` } });
    });
    const workId = candidate.id;
    let polls = 0;
    while (polls < 20) {
      // Even beyond the queue's creation TTL, unfinished checkpoints must not restart search.
      if (polls === 1) f.setClock(4001);
      batchGets = 0;
      const response = await createDiscoveryService(f.context, [createS1Provider(cfg)], { rateLimit: 1 }).query('故事', 1, f.request);
      // Initial search is separate; resolve gets never exceed eight in any continuation.
      expect(batchGets).toBeLessThanOrEqual(polls === 0 ? 9 : 8);
      expect(response.failed).toBe(false);
      expect(JSON.stringify(response)).not.toMatch(/media\.example|cursor|sourceItemId|vid_list/);
      polls++;
      if (!response.pending) {
        expect(response.items.map((row) => row.item.id)).toEqual([workId]); break;
      }
      expect(response).toMatchObject({ retryAfterSeconds: 1, items: [], hasMore: false });
      expect(f.sqlite.count('discovery_works')).toBe(0);
      expect(f.sqlite.count('discovery_queries')).toBe(0);
      const metadata = JSON.stringify(f.sqlite.selectAll('SELECT * FROM discovery_jobs'));
      expect(metadata).not.toMatch(/media\.example|episodes|vid_list/);
      expect(f.sqlite.selectOne('SELECT cursor_key FROM discovery_jobs')?.cursor_key).toMatch(/^discovery\/jobs\//);
    }
    expect(polls).toBeGreaterThan(10); expect(polls).toBeLessThan(20);
    expect(searchGets).toBe(1); expect(detailGets).toBe(1); expect(playerGets).toBe(95);
    expect(f.sqlite.count('discovery_queries')).toBe(1);
    const fact = await readDiscoveryFact(f.context, workId, 100);
    expect(fact.status).toBe('ok');
    if (fact.status === 'ok') expect(fact.fact.asset.episodeCount).toBe(95);
    await createDiscoveryService(f.context, [createS1Provider(cfg)]).query('故事', 1, f.request);
    expect(searchGets).toBe(1); expect(playerGets).toBe(95);
    expect(f.sqlite.count('discovery_leases')).toBe(0);
  });

  it('finishes m1 candidates in order, returns every published item and independently caches source pages', async () => {
    const f = fixture(), searches: number[] = [], resolves: string[] = [];
    const cms = (id: number) => ({ vod_id: id, type_id: 38, vod_name: `故事${id}`, vod_total: 1,
      vod_play_url: `第1集$https://media.example/${id}.mp4` });
    const cfg = config((url) => {
      const id = url.searchParams.get('ids');
      if (id) { resolves.push(id); return JSON.stringify({ code: 1, list: [cms(Number(id))] }); }
      const page = Number(url.searchParams.get('pg')); searches.push(page);
      return JSON.stringify({ code: 1, list: page === 1 ? [cms(10), cms(11), cms(12)] : [cms(20)] });
    });
    const poll = (page: number) => createDiscoveryService(f.context, [createM1Provider(cfg)]).query('故事', page, f.request);
    expect(await poll(1)).toMatchObject({ pending: true, retryAfterSeconds: 1, providerHasMore: true, items: [{ item: { title: '故事10' } }] });
    expect((await poll(1)).items).toHaveLength(2);
    const done = await poll(1); expect(done.pending).toBe(false); expect(done.items).toHaveLength(3);
    expect(resolves).toEqual(['10', '11', '12']); expect(searches).toEqual([1]);
    expect((await poll(2)).items[0].item.title).toBe('故事20');
    expect((await poll(1)).items).toHaveLength(3);
    expect(searches).toEqual([1, 2]); expect(f.sqlite.count('discovery_queries')).toBe(2);
    // Query stale discovers a new source item while fresh complete facts are not resolved again.
    f.setClock(401);
    const original = cfg.fetcher!;
    cfg.fetcher = async (url, init) => new URL(url).searchParams.has('ids') ? original(url, init) :
      new Response(JSON.stringify({ code: 1, list: [cms(10), cms(11), cms(12), cms(13)] }));
    for (let i = 0; i < 4; i++) await poll(1);
    expect(resolves).toEqual(['10', '11', '12', '20', '13']);
    expect((await poll(1)).items).toHaveLength(4);
  });

  it('keeps upload failures pointer-free and checks lease ownership after bucket IO', async () => {
    const f = fixture(), key = await discoveryQueryKey('故事'), lease = await acquireDiscoveryLease(f.DB, `query:${key.qhash}`, 100, 300);
    expect(lease).not.toBeNull(); if (!lease) return;
    const workId = await discoveryWorkId('provider_s1', '10');
    await initializeDiscoveryJobs(f.DB, key, lease, [{ candidate, workId }], false, false, 100);
    const [job] = await readDiscoveryJobs(f.DB, key.qhash);
    expect(await claimDiscoveryJob(f.DB, job, lease, 100)).toBe(true);
    f.bucket.put.mockRejectedValueOnce(new Error('upload offline'));
    await expect(saveDiscoveryJob(f.context, job, lease, 'pending', '{"mediaUrl":"https://media.example/1.mp4"}')).rejects.toThrow();
    expect(f.sqlite.selectOne('SELECT cursor_key FROM discovery_jobs')?.cursor_key).toBeNull();
    f.bucket.put.mockImplementationOnce(async (objectKey, bytes) => {
      f.objects.set(objectKey, bytes.slice()); f.setClock(401); return { key: objectKey };
    });
    expect(await saveDiscoveryJob(f.context, job, lease, 'pending', '{"next":8}')).toBe(false);
    expect(f.sqlite.selectOne('SELECT cursor_key FROM discovery_jobs')?.cursor_key).toBeNull();
    await releaseDiscoveryLease(f.DB, lease);
    const nextLease = await acquireDiscoveryLease(f.DB, `query:${key.qhash}`, 401, 300);
    if (!nextLease) throw new Error('Missing next lease');
    expect(await claimDiscoveryJob(f.DB, job, nextLease, 401)).toBe(true);
    expect(await saveDiscoveryJob(f.context, job, nextLease, 'pending', '{"next":8}')).toBe(true);
    const [saved] = await readDiscoveryJobs(f.DB, key.qhash);
    expect(await readDiscoveryCursor(f.context, saved.cursor_key)).toBe('{"next":8}');
    f.objects.set(saved.cursor_key!, new TextEncoder().encode('{"next":9}'));
    await expect(readDiscoveryCursor(f.context, saved.cursor_key)).rejects.toThrow('Corrupt');
  });

  it('whitelists metadata, limits polls independently and never treats a blocked job as empty success', async () => {
    expect(safeDiscoveryCandidate({ ...candidate, mediaUrl: 'https://media.example/secret' } as DiscoveryCandidate)).toEqual(candidate);
    const f = fixture(), provider = { id: 'provider_s1' as const, search: vi.fn(async () => [candidate]),
      resolve: vi.fn(async () => ({ status: 'blocked' as const, providerId: 'provider_s1' as const, reason: 'unavailable' as const })) };
    const service = createDiscoveryService(f.context, [provider], { rateLimit: 1, pollRateLimit: 1 });
    expect(await service.query('故事', 1, f.request)).toMatchObject({ pending: false, failed: true, items: [] });
    expect(f.sqlite.selectOne('SELECT status FROM discovery_jobs')?.status).toBe('failed');
    expect(f.sqlite.count('discovery_queries')).toBe(0);
    expect(await service.query('故事', 1, f.request)).toMatchObject({ failed: true });
    expect(provider.search).toHaveBeenCalledTimes(1); expect(provider.resolve).toHaveBeenCalledTimes(1);
  });
});
