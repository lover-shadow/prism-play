import { describe, expect, it } from 'vitest';
import { handleRedeem } from '../../edge/src/routes/redeem';
import { claimCouponForNewDevice } from '../../edge/src/db/coupon-repo';
import { verifyJwt, getEdgeKeyMaterial } from '../../edge/src/auth/jwt';
import { couponRow, deviceRow, insert, seedCoupon, seedStandardChannels } from '../support/seed';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';

const CODE = 'GY-Q90D-A7F2-8899';
const DAY = 86400;

async function freshEnv(): Promise<PrismTestEnv> {
  const env = await createTestEnv();
  seedStandardChannels(env.db);
  return env;
}

/** A fresh IP per device: one client would otherwise hit the 10-per-minute ceiling mid-scenario. */
function ipFor(index: number): string {
  return `10.20.${Math.floor(index / 256) % 256}.${index % 256}`;
}

function deviceIdFor(index: number): string {
  return `GY-D${String(index).padStart(7, '0')}`;
}

function redeemRequest(env: PrismTestEnv, payload: unknown, ip: string): Promise<Response> {
  return handleRedeem(
    new Request('http://localhost:8787/api/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: typeof payload === 'string' ? payload : JSON.stringify(payload)
    }),
    env,
    env.clock
  );
}

function redeem(env: PrismTestEnv, code: string, deviceId: string, ip: string): Promise<Response> {
  return redeemRequest(env, { code, deviceId, platform: 'android' }, ip);
}

/** Seeds a device that already holds a slot, keeping `device_count` and the binding ledger equal. */
function bindExisting(env: PrismTestEnv, code: string, deviceId: string, tier: string, tierName: string): void {
  insert(env.db, 'devices', {
    device_id: deviceId,
    platform: 'android',
    tier,
    tier_name: tierName,
    expires_at: TEST_BASE_TIME_SECONDS + 90 * DAY,
    exempt_until: 0,
    bound_coupon: code,
    last_active_at: TEST_BASE_TIME_SECONDS,
    created_at: TEST_BASE_TIME_SECONDS,
    updated_at: TEST_BASE_TIME_SECONDS
  });
  insert(env.db, 'coupon_bindings', {
    coupon_code: code,
    device_id: deviceId,
    bound_at: TEST_BASE_TIME_SECONDS,
    bound_ip: '10.0.0.1',
    created_at: TEST_BASE_TIME_SECONDS,
    updated_at: TEST_BASE_TIME_SECONDS
  });
}

function counts(env: PrismTestEnv, code = CODE): { deviceCount: number; bindings: number } {
  return {
    deviceCount: Number(couponRow(env.db, code)?.device_count ?? -1),
    bindings: env.db.count('coupon_bindings')
  };
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('POST /api/redeem — atomic conditional claim (AC-14)', () => {
  it('lets the 10th device in, refuses the 11th and keeps device_count at exactly 10', async () => {
    const env = await freshEnv();
    seedCoupon(env.db, { code: CODE, tier: 'Q', tierName: '季度畅享卡', durationDays: 90, maxDevices: 10 });

    for (let index = 1; index <= 10; index += 1) {
      const response = await redeem(env, CODE, deviceIdFor(index), ipFor(index));
      expect(response.status, `device ${index}`).toBe(200);
      expect(counts(env).deviceCount).toBe(index);
    }
    expect(env.db.count('coupon_bindings')).toBe(10);
    expect(Number(couponRow(env.db, CODE)?.first_redeemed_at)).toBe(TEST_BASE_TIME_SECONDS);

    const eleventh = await redeem(env, CODE, deviceIdFor(11), ipFor(11));
    expect(eleventh.status).toBe(400);
    expect((await jsonOf(eleventh)).code).toBe('COUPON_DEVICE_LIMIT_EXCEEDED');
    // The trip-wire rolled the whole batch back: no 11th device row, no 11th binding, no counter move.
    expect(counts(env)).toEqual({ deviceCount: 10, bindings: 10 });
    expect(deviceRow(env.db, deviceIdFor(11))).toBeUndefined();
    expect(Number(couponRow(env.db, CODE)?.rejected_distinct_count)).toBe(1);
  });

  it('two concurrent claims for the last slot leave exactly one extra binding and device_count 10', async () => {
    const env = await freshEnv();
    seedCoupon(env.db, { code: CODE, tier: 'Q', tierName: '季度畅享卡', durationDays: 90, maxDevices: 10, deviceCount: 9 });
    // Nine devices already hold the nine used slots, so the reconciliation trip-wire has a ledger
    // whose count actually equals device_count to check against.
    for (let index = 1; index <= 9; index += 1) {
      bindExisting(env, CODE, deviceIdFor(index), 'Q', '季度畅享卡');
    }

    const settled = await Promise.allSettled([
      claimCouponForNewDevice(
        env.DB,
        { code: CODE, deviceId: deviceIdFor(10), tier: 'Q', tierName: '季度畅享卡', expiresAt: TEST_BASE_TIME_SECONDS + 90 * DAY, boundIp: '10.0.0.2' },
        TEST_BASE_TIME_SECONDS
      ),
      claimCouponForNewDevice(
        env.DB,
        { code: CODE, deviceId: deviceIdFor(11), tier: 'Q', tierName: '季度畅享卡', expiresAt: TEST_BASE_TIME_SECONDS + 90 * DAY, boundIp: '10.0.0.3' },
        TEST_BASE_TIME_SECONDS
      )
    ]);
    // At most one commit succeeds; the loser either loses the conditional UPDATE or is refused by
    // the driver as a second open batch. Neither may leave partial rows behind.
    expect(settled.filter((entry) => entry.status === 'fulfilled').length).toBeLessThanOrEqual(1);
    expect(counts(env)).toEqual({ deviceCount: 10, bindings: 10 });
    const bound = env.db
      .selectAll('SELECT device_id FROM coupon_bindings WHERE device_id IN (?, ?)', deviceIdFor(10), deviceIdFor(11))
      .map((row) => String(row.device_id));
    expect(bound.length).toBe(1);
  });

  it('re-redeeming with the same device is idempotent, issues a fresh credential and never counts again', async () => {
    const env = await freshEnv();
    seedCoupon(env.db, { code: CODE, tier: 'Q', tierName: '季度畅享卡', durationDays: 90 });
    const first = await redeem(env, CODE, deviceIdFor(5), '10.0.0.5');
    expect(first.status).toBe(200);
    const firstBody = await jsonOf(first);

    env.clock.advance(DAY);
    const again = await redeem(env, CODE, deviceIdFor(5), '10.0.0.5');
    expect(again.status).toBe(200);
    const againBody = await jsonOf(again);

    expect(counts(env)).toEqual({ deviceCount: 1, bindings: 1 });
    expect(againBody.tier).toBe(firstBody.tier);
    // The window never rolls: one card cannot buy extra days by re-submitting it from the same device.
    expect(againBody.expiresAt).toBe(firstBody.expiresAt);
    expect(String(againBody.token)).not.toBe(String(firstBody.token));
    expect(deviceRow(env.db, deviceIdFor(5))?.updated_at).toBe(TEST_BASE_TIME_SECONDS);

    const claims = await verifyJwt(String(againBody.token), (await getEdgeKeyMaterial(env.JWT_PRIVATE_KEY_JWK)).verifying);
    expect(claims?.exp).toBe(Number(againBody.expiresAt));
    expect(claims?.exp).toBeGreaterThan(env.clock.nowSeconds());
    expect(claims?.iat).toBe(env.clock.nowSeconds());
    expect(claims?.sub).toBe(deviceIdFor(5));
  });

  it('refuses a bound device whose window has closed instead of silently re-opening it', async () => {
    const env = await freshEnv();
    seedCoupon(env.db, { code: CODE, tier: 'Q', tierName: '季度畅享卡', durationDays: 90 });
    const first = await jsonOf(await redeem(env, CODE, deviceIdFor(6), '10.0.0.6'));
    expect(first.expiresAt).toBe(TEST_BASE_TIME_SECONDS + 90 * DAY);

    env.clock.advance(91 * DAY);
    const response = await redeem(env, CODE, deviceIdFor(6), '10.0.0.6');
    expect(response.status).toBe(401);
    expect((await jsonOf(response)).code).toBe('CREDENTIAL_EXPIRED');
    expect(deviceRow(env.db, deviceIdFor(6))?.expires_at).toBe(TEST_BASE_TIME_SECONDS + 90 * DAY);
    expect(counts(env)).toEqual({ deviceCount: 1, bindings: 1 });
  });

  it('a permanent S card keeps answering idempotently after any amount of time', async () => {
    const env = await freshEnv();
    const permanent = 'GY-S000-A7F2-8899';
    seedCoupon(env.db, { code: permanent, tier: 'S', tierName: '极客纪念卡', durationDays: -1 });
    const first = await jsonOf(await redeem(env, permanent, deviceIdFor(8), '10.0.0.8'));
    expect(first.expiresAt).toBe(-1);

    env.clock.advance(400 * DAY);
    const again = await jsonOf(await redeem(env, permanent, deviceIdFor(8), '10.0.0.8'));
    expect(again.expiresAt).toBe(-1);
    expect(counts(env, permanent)).toEqual({ deviceCount: 1, bindings: 1 });
  });

  it('re-grants a slot whose paid tier was cleared by operations, without taking a new slot', async () => {
    const env = await freshEnv();
    seedCoupon(env.db, { code: CODE, tier: 'Q', tierName: '季度畅享卡', durationDays: 90 });
    await redeem(env, CODE, deviceIdFor(12), '10.0.0.12');
    env.db.execute("UPDATE devices SET tier = '0', tier_name = '默认试用', expires_at = 0 WHERE device_id = ?", deviceIdFor(12));

    const body = await jsonOf(await redeem(env, CODE, deviceIdFor(12), '10.0.0.12'));
    expect(body.tier).toBe('Q');
    expect(body.expiresAt).toBe(TEST_BASE_TIME_SECONDS + 90 * DAY);
    expect(counts(env)).toEqual({ deviceCount: 1, bindings: 1 });
    expect(deviceRow(env.db, deviceIdFor(12))?.tier).toBe('Q');
  });

  it('refuses a revoked coupon that still has spare slots and creates no device row', async () => {
    const env = await freshEnv();
    seedCoupon(env.db, { code: CODE, tier: 'Q', tierName: '季度畅享卡', durationDays: 90, status: 'REVOKED', maxDevices: 10 });
    const response = await redeem(env, CODE, deviceIdFor(9), '10.0.0.9');
    expect(response.status).toBe(400);
    expect((await jsonOf(response)).code).toBe('COUPON_REVOKED');
    expect(env.db.count('devices')).toBe(0);
    expect(env.db.count('coupon_bindings')).toBe(0);
    expect(counts(env).deviceCount).toBe(0);
  });

  it('reports an unknown code without touching any ledger table', async () => {
    const env = await freshEnv();
    const response = await redeem(env, CODE, deviceIdFor(1), '10.0.0.1');
    expect(response.status).toBe(400);
    expect((await jsonOf(response)).code).toBe('COUPON_NOT_FOUND');
    expect(env.db.count('devices')).toBe(0);
    expect(env.db.count('coupon_rejected_devices')).toBe(0);
  });

  it('takes tier and display name from the D1 row, never from the code string', async () => {
    const env = await freshEnv();
    seedCoupon(env.db, { code: CODE, tier: 'B', tierName: '高级全源卡', durationDays: 30 });
    const response = await redeem(env, CODE, deviceIdFor(1), '10.0.0.1');
    expect(response.status).toBe(200);
    const body = await jsonOf(response);
    expect(body.tier).toBe('B');
    expect(body.tierName).toBe('高级全源卡');
    expect(body.expiresAt).toBe(TEST_BASE_TIME_SECONDS + 30 * DAY);
    expect(body.message).toBe('激活成功（有效期至 2026-01-31）');
  });

  it('marks a permanent S-tier card as -1 and says so in the message', async () => {
    const env = await freshEnv();
    const permanent = 'GY-S000-A7F2-8899';
    seedCoupon(env.db, { code: permanent, tier: 'S', tierName: '极客纪念卡', durationDays: -1 });
    const body = await jsonOf(await redeem(env, permanent, deviceIdFor(1), '10.0.0.1'));
    expect(body.expiresAt).toBe(-1);
    expect(body.message).toBe('激活成功（永久有效）');
    expect(deviceRow(env.db, deviceIdFor(1))?.expires_at).toBe(-1);
  });

  it('never leaks coupon counters or upstream addresses in the success body', async () => {
    const env = await freshEnv();
    seedCoupon(env.db, { code: CODE, tier: 'Q', tierName: '季度畅享卡', durationDays: 90 });
    const response = await redeem(env, CODE, deviceIdFor(1), '10.0.0.1');
    const text = await response.text();
    expect(Object.keys(JSON.parse(text) as Record<string, unknown>).sort()).toEqual([
      'expiresAt',
      'message',
      'success',
      'tier',
      'tierName',
      'token'
    ]);
    for (const forbidden of ['device_count', 'max_devices', 'rejected', 'is_abnormal', 'upstream', 'http://', 'https://']) {
      expect(text, `body must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});
