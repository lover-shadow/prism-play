import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeRequest } from '../../edge/src/index';
import { handleTitles } from '../../edge/src/routes/titles';
import { asD1, createInMemoryD1 } from '../support/sqlite-d1';
import { saveDiscoveryCard } from '../../edge/src/search/discovery-cards';
import type { Env, RequestContext } from '../../edge/src/types/env';
import { cardFixture, libraryEnv, seedLibraryAssets, seedPrivateManifest, seedTitleAsset } from './library-fixtures';

const clock = { nowSeconds: () => 1000, nowMillis: () => 1000000 };
afterEach(() => vi.unstubAllGlobals());
async function fixture(provider = 'provider_m1') {
  const db = createInMemoryD1(), objects = new Map<string, Uint8Array>();
  let resolvePut!: () => void;
  const gate = new Promise<void>(resolve => { resolvePut = resolve; });
  const bucket = { get: async (key: string) => {
    const bytes = objects.get(key); return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } : null;
  }, put: vi.fn(async (key: string, bytes: Uint8Array) => { await gate; objects.set(key, bytes.slice()); return { key }; }) };
  const env = { DB: asD1(db), APK_BUCKET: { get: async () => null }, DISCOVERY_BUCKET: bucket,
    SEARCH_DISCOVERY_ENABLED: 'true', SEARCH_DISCOVERY_CONFIG: JSON.stringify({ providers: { [provider]: {
      origin: 'https://api.example', originAllowlist: ['https://api.example'], mediaAllowlist: ['https://media.example'], coverAllowlist: ['https://cover.example']
    } } }), KV: { get: async (key: string) => key === 'catalog:manifest' ? JSON.stringify({ revision: 1, pageSize: 60,
      channels: { drama: { chunks: 0, total: 0 } }, workFacts: { schema: 1, maxBytes: 524288, packs: {} }, coverOrigins: [] }) : null } } as unknown as Env;
  const id = provider === 'provider_m1' ? 'drama_m_10' : 'drama_s_10';
  await saveDiscoveryCard({ bindings: env, nowSeconds: clock.nowSeconds, authority: async () => ({ authoritative: false }) },
    { id, providerId: provider as 'provider_m1' | 'provider_s1', sourceItemId: '10', title: '公开故事', channelId: 'drama', episodeCount: 3 });
  const fetcher = vi.fn(async () => new Response(JSON.stringify(provider === 'provider_m1'
    ? { code: 1, list: [{ vod_id: 10, type_id: 38, vod_name: '公开故事', vod_total: 3,
      vod_play_url: '第1集$https://media.example/1.mp4#第2集$https://media.example/2.mp4#第3集$https://media.example/3.mp4' }] }
    : { loaderData: { detail_page: { seriesDetail: { series_id_str: '10', series_title: '公开故事', episode_cnt: 3, vid_list: ['100', '101', '102'] } } } })));
  vi.stubGlobal('fetch', fetcher);
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil: (task: Promise<unknown>) => tasks.push(task), passThroughOnException: () => undefined } as RequestContext;
  const request = (query = '?ep=2') => new Request(`https://play.prismos.org/api/titles/${id}/bootstrap${query}`);
  return { env, db, id, bucket, fetcher, tasks, ctx, request, release: resolvePut };
}

describe('W3 bootstrap real dispatch and background persistence', () => {
  it('stored baseline keeps original line indices and no full episode array in bootstrap', async () => {
    const env = await libraryEnv();
    await seedLibraryAssets(env, { revision: 12, channels: { drama: [cardFixture('d_a')] } });
    await seedTitleAsset(env, { revision: 12, workId: 'd_a', episodes: [{ episodeNumber: 1 }, { episodeNumber: 2,
      lines: [{ providerId: 'provider_m1', mediaUrl: 'https://media.example/two.mp4' },
        { providerId: 'provider_m1', mediaUrl: 'https://media.example/backup.mp4' }] }] });
    const request = new Request('https://play.prismos.org/api/titles/d_a/bootstrap?ep=2');
    const response = await routeRequest(request, env, env.clock);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.persistenceStatus).toBe('stored');
    expect(body.targetEpisode.lines.map((line: any) => line.lineIndex)).toEqual([0, 1]);
    expect(body.revision).toBe(12); expect(body.episodes).toBeUndefined();
    const again = await routeRequest(request, env, env.clock);
    expect((await again.json() as any).factVersion).toBe(body.factVersion);
  });
  it('stored response cannot expose a target when catalog revision changes during R2 read', async () => {
    const env = await libraryEnv();
    await seedLibraryAssets(env, { revision: 12, channels: { drama: [cardFixture('d_a')] } });
    await seedTitleAsset(env, { revision: 12, workId: 'd_a' });
    const original = env.r2.get.bind(env.r2);
    env.r2.get = async key => {
      const result = await original(key);
      await seedLibraryAssets(env, { revision: 13, channels: { drama: [] } });
      return result;
    };
    const response = await routeRequest(new Request('https://play.prismos.org/api/titles/d_a/bootstrap'), env, env.clock);
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('targetEpisode');
  });
  it('private without admission and unknown share identical no-store 404 without metadata', async () => {
    const env = await libraryEnv();
    await seedLibraryAssets(env, { revision: 12, channels: { drama: [] } });
    await seedPrivateManifest(env, 4);
    await seedTitleAsset(env, { revision: 4, workId: 'secret', channelId: 'private', isPrivate: true,
      title: '不得显示的私密标题', episodes: [{ episodeNumber: 1 }] });
    const a = await routeRequest(new Request('https://play.prismos.org/api/titles/secret/bootstrap'), env, env.clock);
    const b = await routeRequest(new Request('https://play.prismos.org/api/titles/unknown/bootstrap'), env, env.clock);
    expect(a.status).toBe(404); expect(b.status).toBe(404);
    expect(await a.text()).toBe(await b.text()); expect(a.headers.get('Cache-Control')).toBe('no-store');
  });
  it('target with empty lines is unavailable, not an invented playable episode', async () => {
    const env = await libraryEnv();
    await seedLibraryAssets(env, { revision: 12, channels: { drama: [cardFixture('d_a')] } });
    await seedTitleAsset(env, { revision: 12, workId: 'd_a', episodes: [{ episodeNumber: 1, lines: [] }] });
    expect((await routeRequest(new Request('https://play.prismos.org/api/titles/d_a/bootstrap'), env, env.clock)).status).toBe(503);
  });
  it('background upload failure never publishes an incomplete pointer or claims stored success', async () => {
    const f = await fixture(); const beforeChanges = f.db.count('discovery_changes');
    f.bucket.put.mockRejectedValueOnce(new Error('fixture upload failed'));
    const response = await routeRequest(f.request(), f.env, clock, f.ctx);
    expect((await response.json() as any).persistenceStatus).toBe('scheduled');
    f.release(); await Promise.all(f.tasks);
    expect(f.db.count('discovery_works')).toBe(0); expect(f.db.count('discovery_changes')).toBe(beforeChanges);
  });

  it('returns target before slow R2 persistence, later old full title reads same complete fact without refetch', async () => {
    const f = await fixture();
    const response = await routeRequest(f.request(), f.env, clock, f.ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body).toMatchObject({ schema: 1, workId: f.id, revision: 1, catalogStatus: 'complete', persistenceStatus: 'scheduled',
      targetEpisode: { episodeNumber: 2, lines: [{ lineIndex: 0, providerId: 'provider_m1', mediaUrl: 'https://media.example/2.mp4' }] } });
    expect(body.episodes).toBeUndefined(); expect(body.factVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(f.tasks).toHaveLength(1); expect(f.db.count('discovery_works')).toBe(0);
    f.release(); await Promise.all(f.tasks);
    const full = await handleTitles(new Request(`https://play.prismos.org/api/titles/${f.id}`), f.env, clock);
    expect((await full.json() as any).episodes).toHaveLength(3); expect(f.fetcher).toHaveBeenCalledTimes(1);
    const warm = await routeRequest(f.request(), f.env, clock, f.ctx);
    expect((await warm.json() as any).persistenceStatus).toBe('stored'); expect(f.tasks).toHaveLength(1);
  });
  it('native recheck does not wait for already in-flight R2 publication', async () => {
    const f = await fixture('provider_s1');
    expect((await routeRequest(f.request('?ep=3'), f.env, clock, f.ctx)).status).toBe(200);
    const native = await routeRequest(new Request(`https://play.prismos.org/api/titles/${f.id}/episodes/3/native-playback?line=0`), f.env, clock, f.ctx);
    expect(native.status).toBe(200);
    expect(await native.json()).toMatchObject({ native: { kind: 's1-cenc', videoId: '102' } });
    // Different requests can still repeat the directory fetch before background persistence; no fake zero-fetch claim.
    expect(f.fetcher).toHaveBeenCalledTimes(2);
    f.release(); await Promise.all(f.tasks);
  });
  it('card deletion during background upload fences final pointer publication', async () => {
    const f = await fixture();
    expect((await routeRequest(f.request(), f.env, clock, f.ctx)).status).toBe(200);
    await vi.waitFor(() => expect(f.bucket.put).toHaveBeenCalled());
    f.db.execute('DELETE FROM discovery_cards WHERE work_id = ?', f.id);
    f.release(); await Promise.all(f.tasks);
    expect(f.db.count('discovery_works')).toBe(0);
  });
  it('native target is a key-free descriptor with original index, not an invented direct media URL', async () => {
    const f = await fixture('provider_s1');
    const response = await routeRequest(f.request('?ep=3'), f.env, clock, f.ctx);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.targetEpisode.lines).toEqual([{ lineIndex: 0, providerId: 'provider_s1', native: { kind: 's1-cenc', videoId: '102' } }]);
    expect(JSON.stringify(body)).not.toMatch(/keyHex|licenseUrl/);
    f.release(); await Promise.all(f.tasks);
  });
  it('no background context on cold request is 503, not a synchronous blocking publication or fake scheduled success', async () => {
    const f = await fixture();
    expect((await routeRequest(f.request(), f.env, clock)).status).toBe(503);
    expect(f.bucket.put).not.toHaveBeenCalled(); f.release();
  });
  it.each(['?ep=0', '?ep=5001', '?ep=1&ep=2', '?ep=2&videoId=100', '?ep=1.5'])('rejects ambiguous query %s before upstream', async query => {
    const f = await fixture(); expect((await routeRequest(f.request(query), f.env, clock, f.ctx)).status).toBe(400);
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.tasks).toHaveLength(0); f.release();
  });
  it('missing target does not schedule a full fact publication or invent the target', async () => {
    const f = await fixture(); expect((await routeRequest(f.request('?ep=4'), f.env, clock, f.ctx)).status).toBe(404);
    expect(f.tasks).toHaveLength(0); f.release();
  });
  it('withdrawal while provider resolves is rechecked before exposing a new target', async () => {
    const f = await fixture(); f.fetcher.mockImplementationOnce(async () => {
      f.db.execute('DELETE FROM discovery_cards WHERE work_id = ?', f.id);
      return new Response(JSON.stringify({ code: 1, list: [{ vod_id: 10, type_id: 38, vod_name: '公开故事', vod_total: 3,
        vod_play_url: '第1集$https://media.example/1.mp4#第2集$https://media.example/2.mp4#第3集$https://media.example/3.mp4' }] }));
    });
    expect((await routeRequest(f.request('?ep=1'), f.env, clock, f.ctx)).status).toBe(404);
    expect(f.tasks).toHaveLength(0); f.release();
  });
});
