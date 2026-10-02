import { describe, expect, it } from 'vitest';
import worker, { routeRequest, runScheduledWork } from '../../edge/src/index';
import type { RequestContext, ScheduledController } from '../../edge/src/types/env';
import { revokeSession } from '../../edge/src/auth/private-session';
import type { PrismTestEnv } from '../support/test-env';
import { createTestEnv, TEST_BASE_TIME_SECONDS } from '../support/test-env';
import { seedCoupon, seedStandardChannels } from '../support/seed';

const ctx: RequestContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined
};

/** Every path template of openapi.yaml with the verbs the contract declares. */
const MOUNTED: readonly { path: string; allow: string; wrongMethod: string }[] = [
  { path: '/api/channels', allow: 'GET', wrongMethod: 'POST' },
  { path: '/api/sources', allow: 'GET', wrongMethod: 'POST' },
  { path: '/api/catalog', allow: 'GET', wrongMethod: 'DELETE' },
  { path: '/api/catalog/changes', allow: 'GET', wrongMethod: 'POST' },
  { path: '/api/search/suggestions', allow: 'GET', wrongMethod: 'PUT' },
  { path: '/api/search', allow: 'GET', wrongMethod: 'POST' },
  { path: '/api/titles/d_1/related', allow: 'GET', wrongMethod: 'POST' },
  { path: '/api/titles/d_1', allow: 'GET', wrongMethod: 'PATCH' },
  { path: '/api/episodes/10231/playback', allow: 'GET', wrongMethod: 'POST' },
  { path: '/api/private-sessions', allow: 'POST, DELETE', wrongMethod: 'GET' },
  { path: '/api/config/monetization', allow: 'GET', wrongMethod: 'POST' },
  { path: '/api/redeem', allow: 'POST', wrongMethod: 'GET' },
  { path: '/api/device/ping', allow: 'GET', wrongMethod: 'POST' },
  { path: '/api/user/sync', allow: 'GET, POST', wrongMethod: 'DELETE' },
  { path: '/api/version', allow: 'GET', wrongMethod: 'POST' },
  { path: '/s/d_8f31c2', allow: 'GET', wrongMethod: 'POST' },
  { path: '/dl', allow: 'GET', wrongMethod: 'POST' },
  { path: '/dl/latest/android', allow: 'GET', wrongMethod: 'POST' },
  { path: '/proxy/img/d_8f31c2', allow: 'GET', wrongMethod: 'POST' }
];

async function call(env: PrismTestEnv, method: string, path: string): Promise<Response> {
  return worker.fetch(new Request(`http://localhost:8787${path}`, { method }), env, ctx);
}

describe('edge router mounts all 19 contract endpoints', () => {
  it('answers 405 with the declared verbs instead of 404, proving each route is registered', async () => {
    const env = await createTestEnv();
    for (const route of MOUNTED) {
      const response = await call(env, route.wrongMethod, route.path);
      expect(response.status, `${route.wrongMethod} ${route.path}`).toBe(405);
      expect(response.headers.get('Allow'), route.path).toBe(route.allow);
      expect(await response.text(), route.path).toBe('');
    }
  });

  it('never routes the same path template twice', () => {
    expect(new Set(MOUNTED.map((route) => route.path)).size).toBe(MOUNTED.length);
  });

  it('serves the Stage 1 endpoints end to end through worker.fetch', async () => {
    const env = await createTestEnv();
    seedStandardChannels(env.db);
    seedCoupon(env.db, { code: 'GY-Q90D-A7F2-8899', tier: 'Q', tierName: '季度畅享卡', durationDays: 90 });

    const channels = await call(env, 'GET', '/api/channels');
    expect(channels.status).toBe(200);
    expect(await channels.json()).toMatchObject({
      channels: [{ id: 'drama' }, { id: 'movie' }, { id: 'anime' }, { id: 'documentary' }]
    });

    const redeemed = await worker.fetch(
      new Request('http://localhost:8787/api/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '10.0.0.9' },
        body: JSON.stringify({ code: 'GY-Q90D-A7F2-8899', deviceId: 'GY-800DF614', platform: 'android' })
      }),
      env,
      ctx
    );
    expect(redeemed.status).toBe(200);
    const body = (await redeemed.json()) as Record<string, unknown>;
    expect(body.tier).toBe('Q');
    // worker.fetch runs on the system clock, so the proof is that D1 and the wire agree.
    expect(env.db.selectOne('SELECT expires_at FROM devices')?.expires_at).toBe(body.expiresAt);
  });

  it('keeps the public catalogue reachable and its private sibling denied through the same mount', async () => {
    const env = await createTestEnv();
    seedStandardChannels(env.db);
    const publicPage = await call(env, 'GET', '/api/catalog?channel=drama');
    expect(publicPage.status).toBe(200);
    expect((await publicPage.json() as { items: unknown[] }).items).toEqual([]);

    const privatePage = await call(env, 'GET', '/api/catalog?channel=private');
    expect(privatePage.status).toBe(404);
    expect(JSON.stringify(await privatePage.json())).not.toContain('个人探索');
  });

  it('answers undeclared paths with one indistinguishable 404', async () => {
    const env = await createTestEnv();
    const bodies = new Set<string>();
    for (const path of ['/api/unknown', '/s', '/proxy/img', '/proxy/img/a/b', '/dl/latest/pc/x', '/']) {
      const response = await call(env, 'GET', path);
      expect(response.status, path).toBe(404);
      bodies.add(await response.text());
    }
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).toContain('NOT_FOUND');
  });

  it('tolerates one trailing slash but rejects an empty segment', async () => {
    const env = await createTestEnv();
    seedStandardChannels(env.db);
    // A hand-pasted share link must not 404 because of a trailing slash.
    expect((await call(env, 'GET', '/api/channels/')).status).toBe(200);
    expect((await call(env, 'GET', '/api//channels')).status).toBe(404);
    expect((await call(env, 'GET', '/api/channels?x=1')).status).toBe(200);
  });

  it('collapses an internal defect into a 503 without leaking the cause', async () => {
    const env = await createTestEnv();
    env.db.prepare = () => {
      throw new Error('D1 unreachable at the edge of the world');
    };
    const response = await call(env, 'GET', '/api/channels');
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain('D1 unreachable');
    expect(JSON.parse(text)).toMatchObject({ success: false, code: 'SERVICE_UNAVAILABLE' });
  });

  it('exposes routeRequest for a caller that supplies its own clock', async () => {
    const env = await createTestEnv();
    seedStandardChannels(env.db);
    const response = await routeRequest(new Request('http://localhost:8787/api/channels'), env, env.clock);
    expect(response.status).toBe(200);
  });
});

describe('scheduled wake-up (wrangler crons)', () => {
  it('prunes expired revocation tombstones and reports an inert ingest pass', async () => {
    const env = await createTestEnv();
    await revokeSession(env.DB, 'hash-expired', TEST_BASE_TIME_SECONDS - 1, TEST_BASE_TIME_SECONDS - 10);
    await revokeSession(env.DB, 'hash-live', TEST_BASE_TIME_SECONDS + 3600, TEST_BASE_TIME_SECONDS);

    const report = await runScheduledWork(env, env.clock);
    expect(report.pruned).toBe(1);
    expect(env.db.selectOne('SELECT token_hash FROM private_session_revocations')?.token_hash).toBe('hash-live');
    expect(report.sources).toBe(0);
    expect(report.recordsInserted).toBe(0);
  });

  it('hands the work to ctx.waitUntil instead of blocking the invocation', async () => {
    const env = await createTestEnv();
    const pending: Promise<unknown>[] = [];
    const controller: ScheduledController = {
      cron: '0 4,16 * * *',
      scheduledTime: env.clock.nowMillis(),
      waitUntil: (promise) => pending.push(promise)
    };
    await worker.scheduled(controller, env, {
      waitUntil: (promise) => pending.push(promise),
      passThroughOnException: () => undefined
    });
    expect(pending).toHaveLength(1);
    await expect(pending[0] as Promise<{ pruned: number }>).resolves.toMatchObject({ pruned: 0 });
  });
});
