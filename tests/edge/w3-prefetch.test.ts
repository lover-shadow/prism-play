import { afterEach, describe, expect, it, vi } from 'vitest';
import { routeRequest } from '../../edge/src/index';
import { libraryEnv, seedLibraryAssets, seedTitleAsset, seedPrivateManifest, cardFixture } from './library-fixtures';
import { buildClaims, getEdgeKeyMaterial, signJwt } from '../../edge/src/auth/jwt';
import { issuePrivateSession } from '../../edge/src/auth/private-session';
import { seedDevice, seedStandardChannels } from '../support/seed';
import { asD1, createInMemoryD1 } from '../support/sqlite-d1';
import { saveDiscoveryCard } from '../../edge/src/search/discovery-cards';
import type { Env, RequestContext } from '../../edge/src/types/env';

const clock = { nowSeconds: () => 1000, nowMillis: () => 1000000 };
const payload = { requestId: 'request_001', episodeNumbers: [1, 2], reason: 'lookahead' };
const request = (id: string, body: unknown = payload) => new Request(`https://play.prismos.org/api/titles/${id}/prefetch`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' }, body: JSON.stringify(body)
});
afterEach(() => vi.unstubAllGlobals());
async function cold() {
  const sqlite = createInMemoryD1(), DB = asD1(sqlite), blobs = new Map<string, Uint8Array>();
  let released!: () => void;
  const gate = new Promise<void>(resolve => { released = resolve; });
  const env = { DB, APK_BUCKET: { get: async () => null }, DISCOVERY_BUCKET: {
    get: async (key: string) => { const bytes = blobs.get(key); return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } : null; },
    put: async (key: string, bytes: Uint8Array) => { blobs.set(key, bytes.slice()); return { key }; }
  }, KV: { get: async (key: string) => key === 'catalog:manifest' ? JSON.stringify({ revision: 1, pageSize: 60,
    channels: { drama: { chunks: 0, total: 0 } }, workFacts: { schema: 1, maxBytes: 524288, packs: {} }, coverOrigins: [] }) : null },
    SEARCH_DISCOVERY_ENABLED: 'true', SEARCH_DISCOVERY_CONFIG: JSON.stringify({ providers: { provider_m1: {
      origin: 'https://api.example', originAllowlist: ['https://api.example'], mediaAllowlist: ['https://media.example'], coverAllowlist: ['https://cover.example']
    } } }) } as unknown as Env;
  await saveDiscoveryCard({ bindings: env, authority: async () => ({ authoritative: false }), nowSeconds: clock.nowSeconds },
    { providerId: 'provider_m1', sourceItemId: '10', id: 'drama_m_10', title: '公开故事', channelId: 'drama', episodeCount: 2 });
  const fetcher = vi.fn(async (url: string) => {
    expect(new URL(url).origin).toBe('https://api.example'); // Never fetch the media host.
    await gate;
    return new Response(JSON.stringify({ code: 1, list: [{ vod_id: 10, type_id: 38, vod_name: '公开故事', vod_total: 2,
      vod_play_url: '第1集$https://media.example/one.mp4#第2集$https://media.example/two.mp4' }] }));
  });
  vi.stubGlobal('fetch', fetcher);
  const tasks: Promise<unknown>[] = [];
  const ctx = { waitUntil: (task: Promise<unknown>) => tasks.push(task), passThroughOnException: () => undefined } as RequestContext;
  return { env, sqlite, fetcher, tasks, ctx, release: released };
}

describe('W3 metadata-only prefetch dispatch', () => {
  it('cold 202 returns before provider resolves, same work merges requests and only metadata is stored', async () => {
    const f = await cold();
    const first = await routeRequest(request('drama_m_10'), f.env, clock, f.ctx);
    expect(first.status).toBe(202);
    expect(await first.json()).toMatchObject({ schema: 1, accepted: 2, deduped: false });
    const second = await routeRequest(request('drama_m_10'), f.env, clock, f.ctx);
    expect(second.status).toBe(202);
    expect(await second.json()).toMatchObject({ accepted: 0, deduped: true });
    expect(f.tasks).toHaveLength(1); f.release(); await Promise.all(f.tasks);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.sqlite.count('discovery_works')).toBe(1);
    expect(f.sqlite.count('discovery_leases')).toBe(0);
  });
  it('ready target metadata is no-op without provider or background task', async () => {
    const env = await libraryEnv();
    await seedLibraryAssets(env, { revision: 12, channels: { drama: [cardFixture('d_a')] } });
    await seedTitleAsset(env, { revision: 12, workId: 'd_a' });
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const tasks: Promise<unknown>[] = [], ctx = { waitUntil: (task: Promise<unknown>) => tasks.push(task), passThroughOnException: () => undefined };
    const response = await routeRequest(request('d_a'), env, env.clock, ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: 0, reason: 'already_ready' });
    for (let i = 0; i < 11; i++) expect((await routeRequest(request('d_a'), env, env.clock, ctx)).status).toBe(200);
    expect((await routeRequest(request('d_a'), env, env.clock, ctx)).status).toBe(429);
    expect(fetcher).not.toHaveBeenCalled(); expect(tasks).toHaveLength(0);
  });
  it.each([{ ...payload, episodeNumbers: [1, 1] }, { ...payload, episodeNumbers: [1, 5] },
    { ...payload, episodeNumbers: [] }, { ...payload, reason: 'anything' }, { ...payload, url: 'https://media.example/one.mp4' },
    { ...payload, requestId: 'x' }, { ...payload, episodeNumbers: [1.5] }])('rejects malformed input without upstream or tasks: %j', async body => {
    const f = await cold();
    expect((await routeRequest(request('drama_m_10', body), f.env, clock, f.ctx)).status).toBe(400);
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.tasks).toHaveLength(0); f.release();
  });
  it('unknown work cannot create background tasks', async () => {
    const f = await cold();
    expect((await routeRequest(request('unknown'), f.env, clock, f.ctx)).status).toBe(404);
    expect(f.tasks).toHaveLength(0); expect(f.fetcher).not.toHaveBeenCalled(); f.release();
  });
  it('context registration failure does not start provider work or leak an owner lease', async () => {
    const f = await cold();
    const bad = { waitUntil: () => { throw new Error('fixture ctx reject'); }, passThroughOnException: () => undefined };
    expect((await routeRequest(request('drama_m_10'), f.env, clock, bad)).status).toBe(503);
    f.release(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.sqlite.count('discovery_leases')).toBe(0);
  });
  it('cold request without context fails closed rather than false 202', async () => {
    const f = await cold();
    expect((await routeRequest(request('drama_m_10'), f.env, clock)).status).toBe(503);
    expect(f.tasks).toHaveLength(0); f.release();
  });
  it('completed failed probe is deduped within episode window, then caller request rate is bounded', async () => {
    const f = await cold(); f.fetcher.mockRejectedValue(new Error('fixture unavailable'));
    expect((await routeRequest(request('drama_m_10'), f.env, clock, f.ctx)).status).toBe(202);
    f.release(); await Promise.all(f.tasks);
    const again = await routeRequest(request('drama_m_10'), f.env, clock, f.ctx);
    expect(await again.json()).toMatchObject({ accepted: 0, deduped: true });
    expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.tasks).toHaveLength(1);
    for (let i = 0; i < 10; i++) expect((await routeRequest(request('drama_m_10'), f.env, clock, f.ctx)).status).toBe(202);
    const limited = await routeRequest(request('drama_m_10'), f.env, clock, f.ctx);
    expect(limited.status).toBe(429); expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0);
  });
  it('chunked body is cancelled at byte limit before database lookup', async () => {
    const f = await cold(), cancel = vi.fn(), prepare = vi.spyOn(f.env.DB, 'prepare');
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(2048)); controller.enqueue(new Uint8Array(2049));
    }, cancel });
    const req = new Request('https://play.prismos.org/api/titles/drama_m_10/prefetch',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, duplex: 'half' } as RequestInit);
    const response = await routeRequest(req, f.env, clock, f.ctx);
    expect(response.status).toBe(400); expect(cancel).toHaveBeenCalledOnce(); expect(prepare).not.toHaveBeenCalled(); f.release();
  });
  it('temporary database failure maps to stable no-store 503', async () => {
    const f = await cold(); vi.spyOn(f.env.DB, 'prepare').mockImplementation(() => { throw new Error('db offline'); });
    const response = await routeRequest(request('drama_m_10'), f.env, clock, f.ctx);
    expect(response.status).toBe(503); expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(f.tasks).toHaveLength(0); f.release();
  });
  it('oversize body is rejected without background work, no fake 202', async () => {
    const f = await cold();
    const response = await routeRequest(request('drama_m_10', { ...payload, junk: 'x'.repeat(4096) }), f.env, clock, f.ctx);
    expect(response.status).toBe(400); expect(f.tasks).toHaveLength(0); f.release();
  });
  it('real private fact with valid dual admission still stays outside public prefetch', async () => {
    const env = await libraryEnv(), now = env.clock.nowSeconds();
    seedStandardChannels(env.db);
    seedDevice(env.db, { deviceId: 'GY-BBBB0001', tier: 'B', tierName: '高级全源卡', expiresAt: now + 86400 });
    await seedLibraryAssets(env, { revision: 12, channels: { drama: [] } });
    await seedPrivateManifest(env, 4);
    await seedTitleAsset(env, { revision: 4, workId: 'private_secret', isPrivate: true, channelId: 'private', title: '绝不能反射' });
    const { signing } = await getEdgeKeyMaterial(env.JWT_PRIVATE_KEY_JWK);
    const jwt = await signJwt(buildClaims({ deviceId: 'GY-BBBB0001', tier: 'B', issuedAt: now, expiresAt: now + 86400, jti: 'test-prefetch-private' }), signing, 'p2026');
    const session = await issuePrivateSession(env.PRIVATE_SESSION_SECRET, 'GY-BBBB0001', now, 1800);
    const req = request('private_secret'); req.headers.set('Authorization', `Bearer ${jwt}`); req.headers.set('X-Private-Session', session.token);
    const tasks: Promise<unknown>[] = [], fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const response = await routeRequest(req, env, env.clock, { waitUntil: task => tasks.push(task), passThroughOnException: () => undefined });
    expect(response.status).toBe(404); expect(await response.text()).not.toContain('绝不能反射');
    expect(tasks).toHaveLength(0); expect(fetcher).not.toHaveBeenCalled();
  });
  it('background failure releases work lease and cannot publish fake fact', async () => {
    const f = await cold(); f.fetcher.mockRejectedValueOnce(new Error('fixture unavailable'));
    expect((await routeRequest(request('drama_m_10'), f.env, clock, f.ctx)).status).toBe(202);
    f.release(); await Promise.all(f.tasks);
    expect(f.sqlite.count('discovery_works')).toBe(0); expect(f.sqlite.count('discovery_leases')).toBe(0);
  });
});
