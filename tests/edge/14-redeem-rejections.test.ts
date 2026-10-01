import { describe, expect, it } from 'vitest';
import { handleRedeem } from '../../edge/src/routes/redeem';
import { readCoupon } from '../../edge/src/db/coupon-repo';
import { couponRow, deviceRow, insert, seedCoupon, seedStandardChannels } from '../support/seed';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';

const CODE = 'GY-Q90D-A7F2-8899';

async function freshEnv(): Promise<PrismTestEnv> {
  const env = await createTestEnv();
  seedStandardChannels(env.db);
  return env;
}

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
    expires_at: TEST_BASE_TIME_SECONDS + 90 * 86400,
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

describe('POST /api/redeem — rejection ledger and abnormal marking (AC-14)', () => {
  it('marks is_abnormal only once the distinct rejected devices are strictly above 20', async () => {
    const env = await freshEnv();
    const full = 'GY-A30D-A7F2-8899';
    seedCoupon(env.db, { code: full, tier: 'A', tierName: '普通激活卡', durationDays: 30, maxDevices: 1, deviceCount: 1 });
    bindExisting(env, full, deviceIdFor(0), 'A', '普通激活卡');

    for (let index = 1; index <= 20; index += 1) {
      const response = await redeem(env, full, deviceIdFor(index), ipFor(index));
      expect(response.status).toBe(400);
      expect((await jsonOf(response)).code).toBe('COUPON_DEVICE_LIMIT_EXCEEDED');
      expect(Number(couponRow(env.db, full)?.rejected_distinct_count)).toBe(index);
      expect(Number(couponRow(env.db, full)?.is_abnormal)).toBe(0);
    }

    const twentyFirst = await redeem(env, full, deviceIdFor(21), ipFor(21));
    expect((await jsonOf(twentyFirst)).code).toBe('COUPON_DEVICE_LIMIT_EXCEEDED');
    expect(Number(couponRow(env.db, full)?.rejected_distinct_count)).toBe(21);
    expect(Number(couponRow(env.db, full)?.is_abnormal)).toBe(1);

    // Retries from an already rejected device reuse the primary key and must not push the count up.
    for (let retry = 0; retry < 4; retry += 1) {
      expect((await redeem(env, full, deviceIdFor(21), ipFor(21))).status).toBe(400);
    }
    expect(Number(couponRow(env.db, full)?.rejected_distinct_count)).toBe(21);
    expect(env.db.count('coupon_rejected_devices')).toBe(21);
    expect(counts(env, full)).toEqual({ deviceCount: 1, bindings: 1 });
  });

  it('a rejected device never persists in devices or coupon_bindings', async () => {
    const env = await freshEnv();
    const full = 'GY-A30D-A7F2-8899';
    seedCoupon(env.db, { code: full, tier: 'A', tierName: '普通激活卡', durationDays: 30, maxDevices: 1, deviceCount: 1 });
    bindExisting(env, full, deviceIdFor(0), 'A', '普通激活卡');
    const response = await redeem(env, full, deviceIdFor(7), '10.0.0.7');
    expect(response.status).toBe(400);
    expect(deviceRow(env.db, deviceIdFor(7))).toBeUndefined();
    expect(counts(env, full)).toEqual({ deviceCount: 1, bindings: 1 });
    expect((await readCoupon(env.DB, full))?.deviceCount).toBe(1);
  });
});

describe('POST /api/redeem — request validation', () => {
  it('rejects malformed codes and device ids with their own contract codes', async () => {
    const env = await freshEnv();
    seedCoupon(env.db, { code: CODE, tier: 'Q', tierName: '季度畅享卡', durationDays: 90 });
    const badCode = await redeem(env, 'NOT-A-CARD', deviceIdFor(1), '10.0.0.1');
    expect(badCode.status).toBe(400);
    expect((await jsonOf(badCode)).code).toBe('COUPON_INVALID_FORMAT');

    const badDevice = await redeem(env, CODE, 'gy-lowercase', '10.0.0.2');
    expect(badDevice.status).toBe(400);
    expect((await jsonOf(badDevice)).code).toBe('DEVICE_ID_INVALID');

    const unparsable = await redeemRequest(env, 'not json at all', '10.0.0.3');
    expect(unparsable.status).toBe(400);
    expect((await jsonOf(unparsable)).code).toBe('COUPON_INVALID_FORMAT');
    expect(env.db.count('devices')).toBe(0);
  });

  it('refuses a non-android platform with 400 PLATFORM_UNSUPPORTED and names the Android-only boundary', async () => {
    const env = await freshEnv();
    seedCoupon(env.db, { code: CODE, tier: 'Q', tierName: '季度畅享卡', durationDays: 90 });
    const response = await redeemRequest(env, { code: CODE, deviceId: deviceIdFor(1), platform: 'ios' }, '10.0.0.1');
    expect(response.status).toBe(400);
    const body = await jsonOf(response);
    expect(body.code).toBe('PLATFORM_UNSUPPORTED');
    expect(String(body.message)).toContain('Android');
    expect(env.db.count('devices')).toBe(0);
  });
});
