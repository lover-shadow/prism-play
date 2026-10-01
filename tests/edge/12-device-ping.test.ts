import { describe, expect, it } from 'vitest';
import { handleDevicePing } from '../../edge/src/routes/device-ping';
import { handleRedeem } from '../../edge/src/routes/redeem';
import { buildClaims, getEdgeKeyMaterial, signJwt, verifyJwt } from '../../edge/src/auth/jwt';
import { deviceRow, seedCoupon, seedDevice } from '../support/seed';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';
import type { DeviceTier } from '../../edge/src/types/api';

const DAY = 86400;
const DEVICE = 'GY-800DF614';

async function tokenFor(
  env: PrismTestEnv,
  input: { deviceId: string; tier: DeviceTier; expiresAt: number; issuedAt?: number }
): Promise<string> {
  const { signing } = await getEdgeKeyMaterial(env.JWT_PRIVATE_KEY_JWK);
  return await signJwt(
    buildClaims({
      deviceId: input.deviceId,
      tier: input.tier,
      expiresAt: input.expiresAt,
      issuedAt: input.issuedAt ?? TEST_BASE_TIME_SECONDS,
      jti: `j-${input.deviceId}-${input.issuedAt ?? TEST_BASE_TIME_SECONDS}`
    }),
    signing,
    'p2026'
  );
}

function ping(env: PrismTestEnv, authorization?: string): Promise<Response> {
  return handleDevicePing(
    new Request('http://localhost:8787/api/device/ping', {
      headers: authorization === undefined ? {} : { Authorization: authorization }
    }),
    env,
    env.clock
  );
}

function claim(env: PrismTestEnv, code: string, deviceId: string, ip: string): Promise<Response> {
  return handleRedeem(
    new Request('http://localhost:8787/api/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ code, deviceId, platform: 'android' })
    }),
    env,
    env.clock
  );
}

describe('GET /api/device/ping — D1 is the authority, not the presented token', () => {
  it('returns the current D1 tier and expiry and re-signs a verifiable credential', async () => {
    const env = await createTestEnv();
    seedCoupon(env.db, { code: 'GY-Q90D-A7F2-8899', tier: 'Q', tierName: '季度畅享卡', durationDays: 90 });
    const activated = await claim(env, 'GY-Q90D-A7F2-8899', DEVICE, '10.40.0.1');
    expect(activated.status).toBe(200);
    const issued = (await activated.json()) as Record<string, unknown>;

    env.clock.advance(DAY);
    const response = await ping(env, `Bearer ${String(issued.token)}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.tier).toBe('Q');
    expect(body.expiresAt).toBe(Number(issued.expiresAt));
    expect(Object.keys(body).sort()).toEqual(['expiresAt', 'tier', 'token']);

    const header = JSON.parse(atob(String(body.token).split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, string>;
    expect(header).toMatchObject({ alg: 'EdDSA', kid: 'p2026' });

    const verifying = (await getEdgeKeyMaterial(env.JWT_PRIVATE_KEY_JWK)).verifying;
    const previous = await verifyJwt(String(issued.token), verifying);
    const fresh = await verifyJwt(String(body.token), verifying);
    expect(fresh?.iat).toBe(env.clock.nowSeconds());
    expect(fresh?.exp).toBe(Number(body.expiresAt));
    expect(fresh?.tier).toBe('Q');
    // A fresh jti is what makes the renewed credential distinguishable from the one it replaces.
    expect(fresh?.jti).not.toBe(previous?.jti);
    expect(body.token).not.toBe(issued.token);
  });

  it('answers with the downgraded D1 row, never with the higher tier the old token still claims', async () => {
    const env = await createTestEnv();
    const liveExpiry = TEST_BASE_TIME_SECONDS + 10 * DAY;
    seedDevice(env.db, { deviceId: DEVICE, tier: 'Q', tierName: '季度畅享卡', expiresAt: liveExpiry });
    // A leaked or replayed permanent S credential must not survive a downgrade in D1.
    const forgedTier = await tokenFor(env, { deviceId: DEVICE, tier: 'S', expiresAt: -1 });

    const response = await ping(env, `Bearer ${forgedTier}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.tier).toBe('Q');
    expect(body.expiresAt).toBe(liveExpiry);

    const renewed = await verifyJwt(String(body.token), (await getEdgeKeyMaterial(env.JWT_PRIVATE_KEY_JWK)).verifying);
    expect(renewed?.tier).toBe('Q');
    expect(renewed?.exp).toBe(liveExpiry);
  });

  it('rejects a tampered token, an absent credential and a foreign-signed credential with 401', async () => {
    const env = await createTestEnv();
    seedDevice(env.db, { deviceId: DEVICE, tier: 'Q', tierName: '季度畅享卡', expiresAt: TEST_BASE_TIME_SECONDS + DAY });
    const good = await tokenFor(env, { deviceId: DEVICE, tier: 'Q', expiresAt: TEST_BASE_TIME_SECONDS + DAY });

    const [header, payload, signature] = good.split('.');
    const tamperedClaims = { ...(JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>), tier: 'S' };
    const tampered = `${header}.${btoa(JSON.stringify(tamperedClaims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.${signature}`;
    expect((await ping(env, `Bearer ${tampered}`)).status).toBe(401);
    expect((await ping(env)).status).toBe(401);
    expect((await ping(env, 'Bearer not-a-jwt')).status).toBe(401);

    const otherEnv = await createTestEnv();
    const foreign = await tokenFor(otherEnv, { deviceId: DEVICE, tier: 'Q', expiresAt: TEST_BASE_TIME_SECONDS + DAY });
    expect((await ping(env, `Bearer ${foreign}`)).status).toBe(401);

    // 401 stays inside the closed error enum: openapi.yaml gives that response no body schema.
    const denied = (await (await ping(env, `Bearer ${tampered}`)).json()) as Record<string, unknown>;
    expect(String(denied.code).length).toBeGreaterThan(0);
    expect(denied.success).toBe(false);
  });

  it('rejects a device whose row was deleted and a paid device whose authorization expired', async () => {
    const env = await createTestEnv();
    seedDevice(env.db, { deviceId: DEVICE, tier: 'Y', tierName: '年度尊享卡', expiresAt: TEST_BASE_TIME_SECONDS + DAY });
    const live = await tokenFor(env, { deviceId: DEVICE, tier: 'Y', expiresAt: TEST_BASE_TIME_SECONDS + DAY });
    expect((await ping(env, `Bearer ${live}`)).status).toBe(200);

    env.db.execute('DELETE FROM devices WHERE device_id = ?', DEVICE);
    expect((await ping(env, `Bearer ${live}`)).status).toBe(401);
    expect(env.db.count('devices')).toBe(0);

    const other = await createTestEnv();
    seedDevice(other.db, { deviceId: DEVICE, tier: 'Y', tierName: '年度尊享卡', expiresAt: TEST_BASE_TIME_SECONDS + DAY });
    const expiring = await tokenFor(other, { deviceId: DEVICE, tier: 'Y', expiresAt: TEST_BASE_TIME_SECONDS + DAY });
    other.clock.advance(2 * DAY);
    expect((await ping(other, `Bearer ${expiring}`)).status).toBe(401);
    // An expired device never receives a renewed credential, so 401 has no token to leak.
  });

  it('leaves an expired paid device untouched in D1 after a refused ping', async () => {
    const env = await createTestEnv();
    seedDevice(env.db, { deviceId: DEVICE, tier: 'B', tierName: '高级全源卡', expiresAt: TEST_BASE_TIME_SECONDS + DAY });
    const stale = await tokenFor(env, { deviceId: DEVICE, tier: 'B', expiresAt: TEST_BASE_TIME_SECONDS + DAY });
    env.clock.advance(30 * DAY);
    expect((await ping(env, `Bearer ${stale}`)).status).toBe(401);
    expect(Number(deviceRow(env.db, DEVICE)?.expires_at)).toBe(TEST_BASE_TIME_SECONDS + DAY);
  });
});
