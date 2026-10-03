import { describe, expect, it } from 'vitest';
import { buildClaims, getEdgeKeyMaterial, signJwt } from '../../edge/src/auth/jwt';
import { hashPrivateSessionToken, issuePrivateSession, revokeSession } from '../../edge/src/auth/private-session';
import { PRIVATE_SESSION_HEADER } from '../../edge/src/core/admission';
import { PRIVATE_SESSION_TTL_SECONDS } from '../../edge/src/core/constants';
import { handleSources } from '../../edge/src/routes/sources';
import { seedDevice, seedProvider, seedStandardChannels } from '../support/seed';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';
import type { DeviceTier, SourcesResponse } from '../../edge/src/types/api';

/**
 * The detail route moved to R2 episode manifests with the cloud refactor, and its coverage now lives in
 * `76-titles-assets.test.ts`; this file keeps the `/api/sources` contract, which still reads the provider
 * probe table (its own switch is a later stage, see SPEC-CLOUD-REFACTOR C-5 open items).
 */

const NOW = TEST_BASE_TIME_SECONDS;
const LIVE_UNTIL = NOW + 86_400;
const DEVICE_B = 'GY-BBBB0001';
const DEVICE_Q = 'GY-QQQQ0001';
const UPSTREAM_MARK = 'upstream.invalid';
const NOT_FOUND_BYTES = JSON.stringify({ success: false, code: 'NOT_FOUND', message: '内容不存在或已下架' });

async function bearer(env: PrismTestEnv, deviceId: string, tier: DeviceTier): Promise<string> {
  const { signing } = await getEdgeKeyMaterial(env.JWT_PRIVATE_KEY_JWK);
  const claims = buildClaims({ deviceId, tier, expiresAt: LIVE_UNTIL, issuedAt: NOW, jti: `j-${deviceId}` });
  return `Bearer ${await signJwt(claims, signing, 'p2026')}`;
}

async function sessionFor(env: PrismTestEnv, deviceId: string): Promise<{ token: string; exp: number }> {
  const issued = await issuePrivateSession(env.PRIVATE_SESSION_SECRET, deviceId, env.clock.nowSeconds(), PRIVATE_SESSION_TTL_SECONDS);
  return { token: issued.token, exp: issued.payload.exp };
}

/** Headers for a caller that holds the tier but has no live session: denied on every private path. */
async function revokedSessionFor(env: PrismTestEnv, deviceId: string): Promise<string> {
  const token = (await sessionFor(env, deviceId)).token;
  await revokeSession(env.DB, await hashPrivateSessionToken(token), LIVE_UNTIL, env.clock.nowSeconds());
  return token;
}

async function deniedHeaders(env: PrismTestEnv): Promise<Record<string, string>[]> {
  return [
    {},
    { Authorization: await bearer(env, DEVICE_Q, 'Q') },
    { Authorization: await bearer(env, DEVICE_B, 'B') },
    { Authorization: await bearer(env, DEVICE_B, 'B'), [PRIVATE_SESSION_HEADER]: await revokedSessionFor(env, DEVICE_B) }
  ];
}

async function grantedHeaders(env: PrismTestEnv): Promise<Record<string, string>> {
  return { Authorization: await bearer(env, DEVICE_B, 'B'), [PRIVATE_SESSION_HEADER]: (await sessionFor(env, DEVICE_B)).token };
}

function sourcesRequest(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:8787/api/sources${query}`, { headers });
}

/** Four probe states plus one private provider; every stored upstream address must stay off the wire. */
async function fixture(): Promise<PrismTestEnv> {
  const env = await createTestEnv();
  seedStandardChannels(env.db);
  seedDevice(env.db, { deviceId: DEVICE_B, tier: 'B', tierName: '高级全源卡', expiresAt: LIVE_UNTIL });
  seedDevice(env.db, { deviceId: DEVICE_Q, tier: 'Q', tierName: '季度畅享卡', expiresAt: LIVE_UNTIL });
  seedProvider(env.db, { id: 'provider_s1', channelId: 'drama', name: '光影极速专线A', latencyMs: 120 }, NOW + 300);
  seedProvider(env.db, { id: 'provider_s2', channelId: 'drama', name: '光影流畅专线B', latencyMs: 40 }, NOW + 100);
  seedProvider(env.db, { id: 'provider_s3', channelId: 'drama', name: '光影备用专线C', latencyMs: 30, healthy: 0 }, NOW + 200);
  seedProvider(env.db, { id: 'provider_m1', channelId: 'movie', name: '院线专线D', latencyMs: 68 }, NOW + 400);
  seedProvider(env.db, { id: 'provider_p1', channelId: 'private', name: '私域专线E', latencyMs: 15 }, NOW + 500);
  return env;
}

async function jsonOf<T>(response: Response): Promise<T> {
  return JSON.parse(await response.clone().text()) as T;
}

describe('GET /api/sources — probe ordering and de-platforming', () => {
  it('orders healthy before latency and reports the newest probe of what it actually served', async () => {
    const env = await fixture();
    const response = await handleSources(sourcesRequest(''), env, env.clock);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(response.headers.get('Vary')).toBe(`Authorization, ${PRIVATE_SESSION_HEADER}`);
    const body = await jsonOf<SourcesResponse>(response);
    expect(body.providers.map((provider) => provider.id)).toEqual(['provider_s2', 'provider_m1', 'provider_s1', 'provider_s3']);
    expect(body.providers.map((provider) => provider.healthy)).toEqual([true, true, true, false]);
    expect(body.providers.map((provider) => provider.latencyMs)).toEqual([40, 68, 120, 30]);
    expect(body.updatedAt).toBe(NOW + 400);
    expect(env.db.selectOne('SELECT MAX(last_checked_at) AS m FROM source_providers WHERE channel_id <> ?', 'private')?.m).toBe(NOW + 400);
  });

  it('derives apiBase from the provider id on the request origin and never ships an upstream address', async () => {
    const env = await fixture();
    const text = await (await handleSources(sourcesRequest(''), env, env.clock)).text();
    expect(text).toContain('http://localhost:8787/proxy/media/provider_s2');
    expect(text).not.toContain(UPSTREAM_MARK);
    expect(text.toLowerCase()).not.toContain('upstream');
  });

  it('filters by channel and takes a disabled channel’s providers with it', async () => {
    const env = await fixture();
    const drama = await jsonOf<SourcesResponse>(await handleSources(sourcesRequest('?channel=drama'), env, env.clock));
    expect([drama.providers.map((p) => p.id), drama.updatedAt]).toEqual([['provider_s2', 'provider_s1', 'provider_s3'], NOW + 300]);

    env.db.execute("UPDATE channels SET enabled = 0 WHERE id = 'movie'");
    const merged = await jsonOf<SourcesResponse>(await handleSources(sourcesRequest(''), env, env.clock));
    expect(merged.providers.map((p) => p.id)).toEqual(['provider_s2', 'provider_s1', 'provider_s3']);
    expect(merged.updatedAt).toBe(NOW + 300);
    expect((await handleSources(sourcesRequest('?channel=movie'), env, env.clock)).status).toBe(200);
  });

  it('404s a channel that is not in the contract without enumerating the ones that are', async () => {
    const env = await fixture();
    for (const query of ['?channel=nope', '?channel=PRIVATE', '?channel=drama;']) {
      const response = await handleSources(sourcesRequest(query), env, env.clock);
      expect(response.status, query).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.text(), query).toBe(NOT_FOUND_BYTES);
    }
  });

  it('hides private providers from every denied caller, filtered and merged', async () => {
    const env = await fixture();
    for (const headers of await deniedHeaders(env)) {
      const gated = await handleSources(sourcesRequest('?channel=private', headers), env, env.clock);
      expect(gated.status).toBe(404);
      expect(gated.headers.get('Cache-Control')).toBe('no-store');
      expect(await gated.text()).toBe(NOT_FOUND_BYTES);
      const merged = await handleSources(sourcesRequest('', headers), env, env.clock);
      const text = await merged.text();
      expect(text).not.toContain('provider_p1');
      expect(text.toLowerCase()).not.toContain('private');
      expect((JSON.parse(text) as SourcesResponse).updatedAt).toBe(NOW + 400);
    }
  });

  it('serves the private provider no-store to a doubly admitted caller', async () => {
    const env = await fixture();
    const headers = await grantedHeaders(env);
    const filtered = await handleSources(sourcesRequest('?channel=private', headers), env, env.clock);
    expect(filtered.headers.get('Cache-Control')).toBe('no-store');
    expect(await jsonOf<SourcesResponse>(filtered)).toEqual({
      updatedAt: NOW + 500,
      providers: [
        {
          id: 'provider_p1',
          name: '私域专线E',
          channelId: 'private',
          apiBase: 'http://localhost:8787/proxy/media/provider_p1',
          priority: 1,
          latencyMs: 15,
          healthy: true
        }
      ]
    });
    const merged = await jsonOf<SourcesResponse>(await handleSources(sourcesRequest('', headers), env, env.clock));
    expect(merged.providers.map((p) => p.id)).toEqual(['provider_p1', 'provider_s2', 'provider_m1', 'provider_s1', 'provider_s3']);
    expect(merged.updatedAt).toBe(NOW + 500);
  });

  it('a disabled private channel stays 404 even with a granted session', async () => {
    const env = await fixture();
    env.db.execute("UPDATE channels SET enabled = 0 WHERE id = 'private'");
    const response = await handleSources(sourcesRequest('?channel=private', await grantedHeaders(env)), env, env.clock);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(NOT_FOUND_BYTES);
  });
});
