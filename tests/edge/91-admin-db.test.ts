import { describe, expect, it, vi } from 'vitest';
import { createTestEnv } from '../support/test-env';
import {
  mintCouponCode,
  generateCouponBatch,
  claimCouponForDispatch,
  confirmCouponStock,
  revokeCoupon
} from '../../edge/src/db/coupon-admin-repo';

const DAY = 86400;
const NOW = 1_767_225_600;

/** Direct ledger insert so the test controls pre-existing stock independent of minting. */
function seedCoupon(
  env: Awaited<ReturnType<typeof createTestEnv>>,
  code: string,
  fields: Partial<{ status: string; dispatch: string; deviceCount: number }> = {}
): void {
  env.db.execute(
    `INSERT INTO card_coupons (code, tier, tier_name, duration_days, status, max_devices, device_count,
       dispatch_status, created_at, updated_at)
     VALUES (?, 'Q', '季度畅享卡', 90, ?, 10, ?, ?, ?, ?)`,
    code,
    fields.status ?? 'UNUSED',
    fields.deviceCount ?? 0,
    fields.dispatch ?? 'IDLE',
    NOW,
    NOW
  );
}

function couponRow(env: Awaited<ReturnType<typeof createTestEnv>>, code: string) {
  return env.db.selectOne('SELECT * FROM card_coupons WHERE code = ?', code);
}

const batchInput = (requestId = 'batch-regression') => ({
  requestId, tier: 'Q' as const, tierName: '季度畅享卡', durationDays: 90,
  count: 2, note: 'creation note', codes: ['GY-ZZZZ-ZZZZ-ZZZZ', 'GY-AAAA-AAAA-AAAA'], nowSeconds: NOW
});

describe('coupon admin repo — regression guards', () => {
  it('rejects bytes outside the unbiased alphabet range', () => {
    const random = vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
      (array as Uint8Array).fill(255);
      (array as Uint8Array)[0] = 35;
      return array;
    });
    try { expect(mintCouponCode()).toBe('GY-9999-9999-9999'); }
    finally { random.mockRestore(); }
  });

  it('preserves input order, ACTIVE/IDLE state and creation notes on retries', async () => {
    const env = await createTestEnv();
    const input = batchInput();
    const first = await generateCouponBatch(env.DB, input);
    const retry = await generateCouponBatch(env.DB, { ...input, codes: ['new', 'codes'] });
    expect(retry).toEqual({ codes: first.codes, created: false });
    for (const code of first.codes) {
      expect(couponRow(env, code)).toMatchObject({ status: 'ACTIVE', dispatch_status: 'IDLE', note: input.note });
    }
    await expect(generateCouponBatch(env.DB, { ...input, note: 'different' })).rejects.toThrow(/conflict/i);
  });

  it('rolls back the whole generation batch on a code collision', async () => {
    const env = await createTestEnv();
    const input = batchInput();
    seedCoupon(env, input.codes[1]);
    await expect(generateCouponBatch(env.DB, input)).rejects.toThrow();
    expect(couponRow(env, input.codes[0])).toBeUndefined();
    expect(env.db.count('coupon_batches')).toBe(0);
    expect(env.db.count('admin_audit_logs')).toBe(0);
  });

  it('recovers a concurrent UNIQUE race as the identical committed batch', async () => {
    const env = await createTestEnv();
    const original = env.DB.batch.bind(env.DB);
    let queue = Promise.resolve();
    vi.spyOn(env.DB, 'batch').mockImplementation((statements) => {
      const result = queue.then(() => original(statements));
      queue = result.then(() => undefined, () => undefined);
      return result;
    });
    const input = batchInput();
    const results = await Promise.all([
      generateCouponBatch(env.DB, input),
      generateCouponBatch(env.DB, { ...input, codes: ['other-1', 'other-2'] })
    ]);
    expect(results.map((r) => r.created)).toEqual([true, false]);
    expect(results[1].codes).toEqual(results[0].codes);
    expect(env.db.count('card_coupons')).toBe(2);
    expect(env.db.count('admin_audit_logs')).toBe(1);
  });

  it('refuses nonexistent, used, redeemed and revoked stock without audit success', async () => {
    const env = await createTestEnv();
    expect((await confirmCouponStock(env.DB, { code: 'missing', requestId: 'missing', nowSeconds: NOW })).status).toBe('not_found');
    for (const [code, fields] of [
      ['used', { deviceCount: 1 }], ['revoked', { status: 'REVOKED' }]
    ] as const) {
      seedCoupon(env, code, { ...fields, dispatch: 'UNKNOWN' });
      expect((await confirmCouponStock(env.DB, { code, requestId: code, nowSeconds: NOW })).status).not.toBe('confirmed');
      expect(couponRow(env, code)?.dispatch_status).toBe('UNKNOWN');
    }
    seedCoupon(env, 'redeemed', { dispatch: 'UNKNOWN' });
    env.db.execute('UPDATE card_coupons SET first_redeemed_at = ? WHERE code = ?', NOW, 'redeemed');
    expect((await confirmCouponStock(env.DB, { code: 'redeemed', requestId: 'redeemed', nowSeconds: NOW })).status).not.toBe('confirmed');
    expect(env.db.count('admin_audit_logs')).toBe(0);
  });

  it('rolls back each mutation when audit insertion fails', async () => {
    const env = await createTestEnv();
    env.db.handle.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON admin_audit_logs BEGIN SELECT RAISE(ABORT, 'audit constraint failed'); END");
    seedCoupon(env, 'stock', { dispatch: 'UNKNOWN' });
    seedCoupon(env, 'revoke');
    seedCoupon(env, 'dispatch');
    await confirmCouponStock(env.DB, { code: 'stock', requestId: 'audit-c', nowSeconds: NOW }).catch(() => undefined);
    await revokeCoupon(env.DB, { code: 'revoke', reason: 'x', requestId: 'audit-r', nowSeconds: NOW }).catch(() => undefined);
    await claimCouponForDispatch(env.DB, { code: 'dispatch', note: 'x', requestId: 'audit-d', nowSeconds: NOW });
    await generateCouponBatch(env.DB, batchInput()).catch(() => undefined);
    expect(couponRow(env, 'stock')?.dispatch_status).toBe('UNKNOWN');
    expect(couponRow(env, 'revoke')?.status).toBe('UNUSED');
    expect(couponRow(env, 'dispatch')?.dispatch_status).toBe('IDLE');
    expect(env.db.count('coupon_batches')).toBe(0);
    expect(env.db.count('admin_audit_logs')).toBe(0);
  });

  it('requires identical action, target and payload for request idempotency', async () => {
    const env = await createTestEnv();
    seedCoupon(env, 'one');
    seedCoupon(env, 'two', { dispatch: 'UNKNOWN' });
    const input = { code: 'one', reason: 'refund', requestId: 'repeat', nowSeconds: NOW };
    expect(await revokeCoupon(env.DB, input)).toEqual({ status: 'revoked' });
    expect(await revokeCoupon(env.DB, { ...input, nowSeconds: NOW + DAY })).toEqual({ status: 'revoked' });
    expect(await revokeCoupon(env.DB, { ...input, code: 'two' })).toEqual({ status: 'conflict' });
    expect(await revokeCoupon(env.DB, { ...input, reason: 'other' })).toEqual({ status: 'conflict' });
    expect(await confirmCouponStock(env.DB, { ...input, code: 'two' })).toEqual({ status: 'conflict' });
    expect(env.db.count('admin_audit_logs')).toBe(1);
    expect(couponRow(env, 'two')?.status).toBe('UNUSED');
    const confirm = { code: 'two', requestId: 'confirm-repeat', nowSeconds: NOW };
    expect(await confirmCouponStock(env.DB, confirm)).toEqual({ status: 'confirmed' });
    expect(await confirmCouponStock(env.DB, { ...confirm, nowSeconds: NOW + DAY })).toEqual({ status: 'confirmed' });
    expect(await confirmCouponStock(env.DB, { ...confirm, code: 'one' })).toEqual({ status: 'conflict' });
    seedCoupon(env, 'dispatch');
    const dispatch = { code: 'dispatch', note: 'a', requestId: 'dispatch-repeat', nowSeconds: NOW };
    expect((await claimCouponForDispatch(env.DB, dispatch)).status).toBe('dispatched');
    expect((await claimCouponForDispatch(env.DB, dispatch)).status).toBe('dispatched');
    expect((await claimCouponForDispatch(env.DB, { ...dispatch, note: 'b' })).status).toBe('conflict');
  });

  it('a lost conditional transition cannot produce a success audit', async () => {
    const env = await createTestEnv();
    seedCoupon(env, 'stock', { dispatch: 'UNKNOWN' });
    seedCoupon(env, 'revoked', { status: 'REVOKED' });
    env.db.handle.exec("CREATE TRIGGER skip_stock BEFORE UPDATE ON card_coupons WHEN OLD.code = 'stock' BEGIN SELECT RAISE(IGNORE); END");
    expect((await confirmCouponStock(env.DB, { code: 'stock', requestId: 'skip', nowSeconds: NOW })).status).not.toBe('confirmed');
    expect((await revokeCoupon(env.DB, { code: 'revoked', reason: 'x', requestId: 'again', nowSeconds: NOW })).status).not.toBe('revoked');
    expect(env.db.count('admin_audit_logs')).toBe(0);
  });
});

describe('coupon admin repo — mint format (AGENTS §二 anti-counterfeit)', () => {
  it('produces GY-XXXX-XXXX-XXXX with all-random body, no fixed Q90D segment', () => {
    const codes = Array.from({ length: 50 }, () => mintCouponCode());
    for (const code of codes) {
      expect(code).toMatch(/^GY-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    }
    const suffixes = new Set(codes.map((code) => code.slice(4)));
    expect(suffixes.size).toBe(codes.length);
  });
});

describe('coupon admin repo — generate batch idempotency (request_id UNIQUE)', () => {
  it('a retried request id does not mint a second batch', async () => {
    const env = await createTestEnv();
    const first = await generateCouponBatch(
      env.DB,
      { requestId: 'req-1', tier: 'Q', tierName: '季度畅享卡', durationDays: 90, count: 3, note: '社群', codes: ['GY-AAAA-AAAA-AAAA', 'GY-BBBB-BBBB-BBBB', 'GY-CCCC-CCCC-CCCC'], nowSeconds: NOW }
    );
    expect(first.created).toBe(true);
    expect(env.db.count('card_coupons')).toBe(3);

    const retry = await generateCouponBatch(
      env.DB,
      { requestId: 'req-1', tier: 'Q', tierName: '季度畅享卡', durationDays: 90, count: 3, note: '社群', codes: ['GY-DDDD-DDDD-DDDD', 'GY-EEEE-EEEE-EEEE', 'GY-FFFF-FFFF-FFFF'], nowSeconds: NOW }
    );
    expect(retry.created).toBe(false);
    expect(retry.codes).toEqual(first.codes);
    expect(env.db.count('card_coupons')).toBe(3);
  });
});

describe('coupon admin repo — dispatch claim atomicity (trip-wire rollback)', () => {
  it('dispatches only an IDLE, zero-device, non-revoked code and writes one audit row', async () => {
    const env = await createTestEnv();
    seedCoupon(env, 'GY-1111-1111-1111', { dispatch: 'IDLE' });
    const outcome = await claimCouponForDispatch(
      env.DB,
      { code: 'GY-1111-1111-1111', note: '给好友A', requestId: 'd-1', nowSeconds: NOW }
    );
    expect(outcome.status).toBe('dispatched');
    const row = couponRow(env, 'GY-1111-1111-1111');
    expect(row?.dispatch_status).toBe('DISPATCHED');
    expect(row?.dispatch_request_id).toBe('d-1');
    expect(env.db.count('admin_audit_logs')).toBe(1);
  });

  it('refuses to dispatch a code that already bound a device or is UNKNOWN stock', async () => {
    const env = await createTestEnv();
    seedCoupon(env, 'GY-2222-2222-2222', { dispatch: 'IDLE', deviceCount: 1, status: 'ACTIVE' });
    const bound = await claimCouponForDispatch(env.DB, { code: 'GY-2222-2222-2222', note: 'x', requestId: 'd-2', nowSeconds: NOW });
    expect(bound.status).toBe('conflict');
    expect(couponRow(env, 'GY-2222-2222-2222')?.dispatch_status).toBe('IDLE');

    seedCoupon(env, 'GY-3333-3333-3333', { dispatch: 'UNKNOWN' });
    const unknown = await claimCouponForDispatch(env.DB, { code: 'GY-3333-3333-3333', note: 'x', requestId: 'd-3', nowSeconds: NOW });
    expect(unknown.status).toBe('needs_confirm');
    expect(env.db.count('admin_audit_logs')).toBe(0);
  });

  it('two racing requests for one code: exactly one wins, loser leaves no audit', async () => {
    const env = await createTestEnv();
    seedCoupon(env, 'GY-4444-4444-4444', { dispatch: 'IDLE' });
    const settled = await Promise.allSettled([
      claimCouponForDispatch(env.DB, { code: 'GY-4444-4444-4444', note: 'A', requestId: 'd-A', nowSeconds: NOW }),
      claimCouponForDispatch(env.DB, { code: 'GY-4444-4444-4444', note: 'B', requestId: 'd-B', nowSeconds: NOW + DAY })
    ]);
    const statuses = settled.map((result) => (result.status === 'fulfilled' ? result.value.status : 'rejected'));
    expect(statuses.filter((s) => s === 'dispatched').length).toBe(1);
    expect(statuses.filter((s) => s === 'conflict').length).toBe(1);
    expect(env.db.count('admin_audit_logs')).toBe(1);
    expect(couponRow(env, 'GY-4444-4444-4444')?.dispatch_request_id).toMatch(/^d-[AB]$/);
  });

  it('dispatch_note is preserved and never overwrites the creation note column', async () => {
    const env = await createTestEnv();
    seedCoupon(env, 'GY-5555-5555-5555', { dispatch: 'IDLE' });
    await claimCouponForDispatch(env.DB, { code: 'GY-5555-5555-5555', note: '展会', requestId: 'd-5', nowSeconds: NOW });
    const row = couponRow(env, 'GY-5555-5555-5555');
    expect(row?.dispatch_note).toBe('展会');
    expect(row?.note).toBeFalsy();
  });
});

describe('coupon admin repo — confirm stock and revoke boundaries', () => {
  it('confirmCouponStock flips UNKNOWN to IDLE only', async () => {
    const env = await createTestEnv();
    seedCoupon(env, 'GY-6666-6666-6666', { dispatch: 'UNKNOWN' });
    await confirmCouponStock(env.DB, { code: 'GY-6666-6666-6666', requestId: 'c-1', nowSeconds: NOW });
    expect(couponRow(env, 'GY-6666-6666-6666')?.dispatch_status).toBe('IDLE');
    const already = await confirmCouponStock(env.DB, { code: 'GY-6666-6666-6666', requestId: 'c-2', nowSeconds: NOW });
    expect(already.status).toBe('noop');
  });

  it('revoke only stops future redemption and never touches bound devices or expiry', async () => {
    const env = await createTestEnv();
    seedCoupon(env, 'GY-7777-7777-7777', { dispatch: 'DISPATCHED', status: 'ACTIVE', deviceCount: 2 });
    env.db.execute(
      `INSERT INTO devices (device_id, platform, tier, tier_name, expires_at, bound_coupon, last_active_at, created_at, updated_at)
       VALUES ('GY-D0000001', 'android', 'Q', '季度畅享卡', ?, 'GY-7777-7777-7777', ?, ?, ?)`,
      NOW + 90 * DAY,
      NOW,
      NOW,
      NOW
    );
    await revokeCoupon(env.DB, { code: 'GY-7777-7777-7777', reason: '恶意退款', requestId: 'r-1', nowSeconds: NOW });
    expect(couponRow(env, 'GY-7777-7777-7777')?.status).toBe('REVOKED');
    const device = env.db.selectOne('SELECT expires_at, tier FROM devices WHERE device_id = ?', 'GY-D0000001');
    expect(device?.tier).toBe('Q');
    expect(Number(device?.expires_at)).toBe(NOW + 90 * DAY);
  });
});
