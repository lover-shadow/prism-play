import { describe, expect, it } from 'vitest';
import {
  RATE_LIMIT_MAX_ATTEMPTS,
  RATE_LIMIT_WINDOW_SECONDS,
  UNKNOWN_CLIENT_IP,
  clientIpOf,
  createKvRateLimiter,
  createMemoryRateLimiter,
  rateWindowBucket,
  type RateLimiter
} from '../../edge/src/core/rate-limit';
import { handleRedeem } from '../../edge/src/routes/redeem';
import { couponRow, seedCoupon, seedStandardChannels } from '../support/seed';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';

const CODE = 'GY-Q90D-A7F2-8899';

function requestWith(headers: Record<string, string>): Request {
  return new Request('http://localhost:8787/api/redeem', { method: 'POST', headers });
}

function deviceIdFor(index: number): string {
  return `GY-R${String(index).padStart(7, '0')}`;
}

async function redeemFrom(env: PrismTestEnv, deviceId: string, ip: string): Promise<Response> {
  return await handleRedeem(
    new Request('http://localhost:8787/api/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ code: CODE, deviceId, platform: 'android' })
    }),
    env,
    env.clock
  );
}

describe('client identity for the fixed window (SPEC §10)', () => {
  it('prefers CF-Connecting-IP, then the first X-Forwarded-For hop, then unknown', () => {
    expect(clientIpOf(requestWith({ 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '198.51.100.1' }))).toBe('203.0.113.7');
    expect(clientIpOf(requestWith({ 'X-Forwarded-For': '198.51.100.1, 192.0.2.9, 203.0.113.1' }))).toBe('198.51.100.1');
    expect(clientIpOf(requestWith({ 'CF-Connecting-IP': '   ', 'X-Forwarded-For': '198.51.100.1' }))).toBe('198.51.100.1');
    expect(clientIpOf(requestWith({ 'X-Forwarded-For': '' }))).toBe(UNKNOWN_CLIENT_IP);
    expect(clientIpOf(requestWith({}))).toBe(UNKNOWN_CLIENT_IP);
  });

  it('buckets the window on the epoch multiple so every isolate computes the same key', () => {
    expect(rateWindowBucket(TEST_BASE_TIME_SECONDS)).toBe(TEST_BASE_TIME_SECONDS / RATE_LIMIT_WINDOW_SECONDS);
    expect(rateWindowBucket(TEST_BASE_TIME_SECONDS + 59)).toBe(rateWindowBucket(TEST_BASE_TIME_SECONDS));
    expect(rateWindowBucket(TEST_BASE_TIME_SECONDS + 60)).toBe(rateWindowBucket(TEST_BASE_TIME_SECONDS) + 1);
  });
});

describe('fixed-window limiter implementations', () => {
  it('allows exactly 10 attempts per key per window and counts the remainder down', async () => {
    const env = await createTestEnv();
    const limiter = createMemoryRateLimiter(env.clock);
    for (let attempt = 1; attempt <= RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      const decision = await limiter.consume('203.0.113.7');
      expect(decision.allowed).toBe(true);
      expect(decision.remaining).toBe(RATE_LIMIT_MAX_ATTEMPTS - attempt);
    }
    expect(await limiter.consume('203.0.113.7')).toEqual({ allowed: false, remaining: 0 });
    // A different client sharing the window is never punished for its neighbour.
    expect((await limiter.consume('198.51.100.4')).allowed).toBe(true);
  });

  it('restores the allowance when the window rolls over, in both implementations', async () => {
    const builders: Array<(env: PrismTestEnv) => RateLimiter> = [
      (env) => createMemoryRateLimiter(env.clock),
      (env) => createKvRateLimiter(env.KV, env.clock)
    ];
    for (const build of builders) {
      const env = await createTestEnv();
      const limiter = build(env);
      for (let attempt = 0; attempt < RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
        expect((await limiter.consume('203.0.113.9')).allowed).toBe(true);
      }
      expect((await limiter.consume('203.0.113.9')).allowed).toBe(false);
      env.clock.advance(RATE_LIMIT_WINDOW_SECONDS);
      expect((await limiter.consume('203.0.113.9')).allowed).toBe(true);
    }
  });

  it('stores the KV counter under a minute-bucketed key with a window-sized TTL', async () => {
    const env = await createTestEnv();
    const limiter = createKvRateLimiter(env.KV, env.clock);
    await limiter.consume('203.0.113.10');
    await limiter.consume('203.0.113.10');
    const bucket = rateWindowBucket(TEST_BASE_TIME_SECONDS);
    expect([...env.kv.snapshot().keys()]).toEqual([`redeem:ratelimit:${bucket}:203.0.113.10`]);
    expect(env.kv.snapshot().get(`redeem:ratelimit:${bucket}:203.0.113.10`)).toBe('2');
    env.clock.advance(RATE_LIMIT_WINDOW_SECONDS);
    await limiter.consume('203.0.113.10');
    expect([...env.kv.snapshot().keys()]).toContain(`redeem:ratelimit:${bucket + 1}:203.0.113.10`);
  });
});

describe('POST /api/redeem rate limit (SPEC §10 / API-SPEC §〇)', () => {
  it('refuses the 11th attempt from one IP with 429 RATE_LIMITED while another IP proceeds', async () => {
    const env = await createTestEnv();
    seedStandardChannels(env.db);
    seedCoupon(env.db, { code: CODE, tier: 'Q', tierName: '季度畅享卡', durationDays: 90, maxDevices: 10 });

    for (let index = 1; index <= RATE_LIMIT_MAX_ATTEMPTS; index += 1) {
      const response = await redeemFrom(env, deviceIdFor(index), '203.0.113.20');
      expect(response.status, `attempt ${index}`).toBe(200);
    }

    const blocked = await redeemFrom(env, deviceIdFor(11), '203.0.113.20');
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['code', 'message', 'success']);
    expect(body.code).toBe('RATE_LIMITED');

    // Same moment, different client: reaches the ledger and is refused for the real business reason.
    const neighbour = await redeemFrom(env, deviceIdFor(12), '198.51.100.30');
    expect(neighbour.status).toBe(400);
    expect(((await neighbour.json()) as Record<string, unknown>).code).toBe('COUPON_DEVICE_LIMIT_EXCEEDED');

    // Window rollover restores the first client's allowance.
    env.clock.advance(RATE_LIMIT_WINDOW_SECONDS + 1);
    const afterRollover = await redeemFrom(env, deviceIdFor(13), '203.0.113.20');
    expect(afterRollover.status).toBe(400);
    expect(((await afterRollover.json()) as Record<string, unknown>).code).toBe('COUPON_DEVICE_LIMIT_EXCEEDED');
  });

  it('consumes the budget before validation, so malformed probing cannot skip past the limiter', async () => {
    const env = await createTestEnv();
    seedCoupon(env.db, { code: CODE, tier: 'Q', tierName: '季度畅享卡', durationDays: 90 });

    for (let attempt = 0; attempt < RATE_LIMIT_MAX_ATTEMPTS; attempt += 1) {
      const malformed = await handleRedeem(
        new Request('http://localhost:8787/api/redeem', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.21' },
          body: JSON.stringify({ code: 'JUNK', deviceId: 'nope', platform: 'android' })
        }),
        env,
        env.clock
      );
      expect(malformed.status).toBe(400);
    }
    const limited = await handleRedeem(
      new Request('http://localhost:8787/api/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.21' },
        body: JSON.stringify({ code: CODE, deviceId: deviceIdFor(1), platform: 'android' })
      }),
      env,
      env.clock
    );
    expect(limited.status).toBe(429);
  });

  it('refuses an over-limit request before any database write happens', async () => {
    const env = await createTestEnv();
    seedCoupon(env.db, { code: CODE, tier: 'Q', tierName: '季度畅享卡', durationDays: 90, maxDevices: 10, status: 'ACTIVE' });
    for (let index = 1; index <= RATE_LIMIT_MAX_ATTEMPTS; index += 1) {
      expect((await redeemFrom(env, deviceIdFor(index), '203.0.113.22')).status).toBe(200);
    }
    const before = Number(couponRow(env.db, CODE)?.device_count);
    await redeemFrom(env, deviceIdFor(99), '203.0.113.22');
    expect(Number(couponRow(env.db, CODE)?.device_count)).toBe(before);
    expect(env.db.count('devices')).toBe(RATE_LIMIT_MAX_ATTEMPTS);
    expect(env.db.count('coupon_bindings')).toBe(RATE_LIMIT_MAX_ATTEMPTS);
  });
});
