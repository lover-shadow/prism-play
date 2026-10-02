import { describe, expect, it } from 'vitest';
import { buildClaims, getEdgeKeyMaterial, signJwt } from '../../edge/src/auth/jwt';
import { handleUserSync } from '../../edge/src/routes/user-sync';
import { seedContent, seedCoupon, seedDevice, seedStandardChannels } from '../support/seed';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';
import type { DeviceTier } from '../../edge/src/types/api';

/**
 * `GET|POST /api/user/sync` (CLOUD-SYNC-JIT-PIPELINE-SPEC §2).
 *
 * The load-bearing assertion here is the byte-equality one: an unknown content id, a private content
 * id and a public content id must all produce identical bytes. If the private path is "silently
 * skipped" while the unknown path trips the foreign key, any card holder can enumerate which private
 * works exist — exactly what AC-02-3 forbids (independent audit A-3).
 */

const DEVICE = 'GY-AAAA0001';
const COUPON = 'GY-Q90D-A7F2-8899';
const OTHER_COUPON = 'GY-B365D-A7F2-8899';
const LIVE_UNTIL = TEST_BASE_TIME_SECONDS + 86_400;

async function bearer(env: PrismTestEnv, deviceId: string, tier: DeviceTier = 'Q'): Promise<string> {
  const { signing } = await getEdgeKeyMaterial(env.JWT_PRIVATE_KEY_JWK);
  const claims = buildClaims({
    deviceId,
    tier,
    expiresAt: LIVE_UNTIL,
    issuedAt: TEST_BASE_TIME_SECONDS,
    jti: `j-${deviceId}`
  });
  return `Bearer ${await signJwt(claims, signing, 'p2026')}`;
}

function post(token: string, body: unknown): Request {
  return new Request('http://localhost:8787/api/user/sync', {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function get(token: string): Request {
  return new Request('http://localhost:8787/api/user/sync', { headers: { Authorization: token } });
}

function syncBody(contentId: string | null) {
  return {
    history: contentId === null ? null : { contentId, episodeNumber: 3, positionSeconds: 42.5, durationSeconds: 300 },
    preferences: { genres: { 战神: 12.5, 逆袭: 8 }, totalPlays: 20 }
  };
}

async function fixture(overrides?: { boundCoupon?: string | null }) {
  const env = await createTestEnv();
  seedStandardChannels(env.db);
  seedCoupon(env.db, { code: COUPON, tier: 'Q', tierName: '季度畅享卡', durationDays: 90, status: 'ACTIVE' });
  seedCoupon(env.db, { code: OTHER_COUPON, tier: 'B', tierName: '高级全源卡', durationDays: 365, status: 'ACTIVE' });
  seedDevice(env.db, {
    deviceId: DEVICE,
    tier: 'Q',
    tierName: '季度畅享卡',
    expiresAt: LIVE_UNTIL,
    boundCoupon: overrides?.boundCoupon === undefined ? COUPON : overrides.boundCoupon
  });
  seedContent(env.db, { id: 'd_pub', channelId: 'drama', title: '公开剧' });
  seedContent(env.db, {
    id: 'd_priv',
    channelId: 'private',
    title: '私密剧',
    isPrivate: 1,
    shareable: 0
  });
  return env;
}

describe('POST /api/user/sync — private content never reaches the cloud', () => {
  it('answers unknown, private and public content ids with byte-identical responses', async () => {
    const env = await fixture();
    const token = await bearer(env, DEVICE);

    const unknown = await handleUserSync(post(token, syncBody('does_not_exist')), env, env.clock);
    const priv = await handleUserSync(post(token, syncBody('d_priv')), env, env.clock);
    const pub = await handleUserSync(post(token, syncBody('d_pub')), env, env.clock);

    expect(unknown.status).toBe(200);
    expect(priv.status).toBe(200);
    expect(pub.status).toBe(200);

    const unknownBytes = await unknown.text();
    const privBytes = await priv.text();
    const pubBytes = await pub.text();
    // The whole point: no status, body or header may distinguish "private exists" from "unknown".
    expect(privBytes).toBe(unknownBytes);
    expect(pubBytes).toBe(unknownBytes);
    expect(unknown.headers.get('content-type')).toBe(priv.headers.get('content-type'));
  });

  it('writes the public row and leaves no private row behind', async () => {
    const env = await fixture();
    const token = await bearer(env, DEVICE);

    await handleUserSync(post(token, syncBody('d_priv')), env, env.clock);
    await handleUserSync(post(token, syncBody('d_pub')), env, env.clock);

    const stored = env.db
      .selectAll('SELECT content_id FROM cloud_watch_history WHERE coupon_code = ?', COUPON)
      .map((row) => String(row.content_id));
    expect(stored).toEqual(['d_pub']);
  });

  it('replays the accepted shape for a device with no coupon, without writing anything', async () => {
    const env = await fixture({ boundCoupon: null });
    const token = await bearer(env, DEVICE);
    const response = await handleUserSync(post(token, syncBody('d_pub')), env, env.clock);
    expect(response.status).toBe(200);
    const rows = env.db.selectAll('SELECT content_id FROM cloud_watch_history');
    expect(rows.length).toBe(0);
  });
});

describe('POST /api/user/sync — validation, auth and throttle', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const env = await fixture();
    const response = await handleUserSync(post('Bearer not-a-token', syncBody('d_pub')), env, env.clock);
    expect(response.status).toBe(401);
  });

  it('rejects a malformed payload with 400 and writes nothing', async () => {
    const env = await fixture();
    const token = await bearer(env, DEVICE);
    const bad = new Request('http://localhost:8787/api/user/sync', {
      method: 'POST',
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ history: null, preferences: { genres: { 战神: -1 }, totalPlays: 1 } })
    });
    const response = await handleUserSync(bad, env, env.clock);
    expect(response.status).toBe(400);
    expect(env.db.selectAll('SELECT content_id FROM cloud_watch_history').length).toBe(0);
  });

  it('stops a device that exceeds the write window', async () => {
    const env = await fixture();
    const token = await bearer(env, DEVICE);
    let lastStatus = 200;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const response = await handleUserSync(post(token, syncBody('d_pub')), env, env.clock);
      lastStatus = response.status;
      if (response.status === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});

describe('GET /api/user/sync — multi-device state', () => {
  it('returns history scoped to the bound coupon', async () => {
    const env = await fixture();
    const token = await bearer(env, DEVICE);
    await handleUserSync(post(token, syncBody('d_pub')), env, env.clock);

    const response = await handleUserSync(get(token), env, env.clock);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      history: { contentId: string; episodeNumber: number }[];
      preferences: { genres: Record<string, number>; totalPlays: number; updatedAt: number } | null;
    };
    expect(body.history.length).toBe(1);
    expect(body.history[0].contentId).toBe('d_pub');
    expect(body.preferences?.totalPlays).toBe(20);
    expect(body.preferences?.genres.战神).toBe(12.5);
  });

  it('reports an empty history for a coupon with no rows instead of an error', async () => {
    const env = await fixture();
    const token = await bearer(env, DEVICE);
    const response = await handleUserSync(get(token), env, env.clock);
    const body = (await response.json()) as { history: unknown[]; preferences: unknown };
    expect(response.status).toBe(200);
    expect(body.history).toEqual([]);
    expect(body.preferences).toBeNull();
  });
});

describe('coupon anchor is resolved server-side (audit A-1)', () => {
  it('derives the shared domain from devices.bound_coupon, not from any token claim', async () => {
    const env = await fixture();
    const token = await bearer(env, DEVICE);
    await handleUserSync(post(token, syncBody('d_pub')), env, env.clock);

    // Re-binding the same device to another coupon moves its sync domain, which is the documented
    // behaviour: history follows the current bound_coupon and old rows stay under the old code.
    env.db.execute('UPDATE devices SET bound_coupon = ? WHERE device_id = ?', OTHER_COUPON, DEVICE);
    await handleUserSync(post(token, syncBody('d_pub')), env, env.clock);

    const underOld = env.db
      .selectAll('SELECT content_id FROM cloud_watch_history WHERE coupon_code = ?', COUPON)
      .length;
    const underNew = env.db
      .selectAll('SELECT content_id FROM cloud_watch_history WHERE coupon_code = ?', OTHER_COUPON)
      .length;
    expect(underOld).toBe(1);
    expect(underNew).toBe(1);
  });
});
