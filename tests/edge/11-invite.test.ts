import { describe, expect, it } from 'vitest';
import { handleRedeem } from '../../edge/src/routes/redeem';
import { settleFirstInvite } from '../../edge/src/routes/invite';
import { INVITE_REWARD_DAYS } from '../../edge/src/core/constants';
import { couponRow, deviceRow, seedCoupon, seedDevice } from '../support/seed';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';

const DAY = 86400;
const REWARD_SECONDS = INVITE_REWARD_DAYS * DAY;
const INVITER = 'GY-INV00001';
const INVITEE = 'GY-NEW00001';
const CODE_A = 'GY-Q90D-A7F2-8899';
const CODE_B = 'GY-A30D-A7F2-8899';

function redeemWithRef(env: PrismTestEnv, code: string, deviceId: string, inviteRef?: string): Promise<Response> {
  return handleRedeem(
    new Request('http://localhost:8787/api/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': `10.30.${code.charCodeAt(4) % 250}.${deviceId.slice(-2)}` },
      body: JSON.stringify({ code, deviceId, platform: 'android', ...(inviteRef ? { inviteRef } : {}) })
    }),
    env,
    env.clock
  );
}

function logs(env: PrismTestEnv): Record<string, unknown>[] {
  return env.db.selectAll('SELECT * FROM invitation_logs ORDER BY id');
}

describe('M-4 invite settlement — reward branch is decided by the inviter', () => {
  it('gives a non-member inviter three days of exempt_until and logs NUDGE_FREE', async () => {
    const env = await createTestEnv();
    seedCoupon(env.db, { code: CODE_A, tier: 'Q', tierName: '季度畅享卡', durationDays: 90 });
    seedDevice(env.db, { deviceId: INVITER, tier: '0', tierName: '默认试用', expiresAt: 0, exemptUntil: 0 });

    const response = await redeemWithRef(env, CODE_A, INVITEE, INVITER);
    expect(response.status).toBe(200);

    const row = deviceRow(env.db, INVITER);
    expect(Number(row?.exempt_until)).toBe(TEST_BASE_TIME_SECONDS + REWARD_SECONDS);
    expect(Number(row?.expires_at)).toBe(0);
    expect(logs(env)).toMatchObject([{ inviter_device_id: INVITER, invitee_device_id: INVITEE, reward_type: 'NUDGE_FREE', reward_days: 3, settled: 1 }]);
    expect(deviceRow(env.db, INVITEE)?.invited_by).toBe(INVITER);
  });

  it('stacks the nudge on top of an exempt_until that is already in the future', async () => {
    const env = await createTestEnv();
    seedCoupon(env.db, { code: CODE_A, tier: 'Q', tierName: '季度畅享卡', durationDays: 90 });
    const already = TEST_BASE_TIME_SECONDS + 10 * DAY;
    seedDevice(env.db, { deviceId: INVITER, tier: '0', exemptUntil: already });

    await redeemWithRef(env, CODE_A, INVITEE, INVITER);
    expect(Number(deviceRow(env.db, INVITER)?.exempt_until)).toBe(already + REWARD_SECONDS);
  });

  it('gives a live member inviter three days on expires_at and logs TIER_EXTEND', async () => {
    const env = await createTestEnv();
    seedCoupon(env.db, { code: CODE_A, tier: 'Q', tierName: '季度畅享卡', durationDays: 90 });
    const currentExpiry = TEST_BASE_TIME_SECONDS + 30 * DAY;
    seedDevice(env.db, { deviceId: INVITER, tier: 'Q', tierName: '季度畅享卡', expiresAt: currentExpiry });

    await redeemWithRef(env, CODE_A, INVITEE, INVITER);
    const row = deviceRow(env.db, INVITER);
    expect(Number(row?.expires_at)).toBe(currentExpiry + REWARD_SECONDS);
    // The nudge field belongs to the non-member branch only.
    expect(Number(row?.exempt_until)).toBe(0);
    expect(logs(env)[0]?.reward_type).toBe('TIER_EXTEND');
  });

  it('treats an expired paid inviter as a non-member, per the M-4 default口径', async () => {
    const env = await createTestEnv();
    seedCoupon(env.db, { code: CODE_A, tier: 'Q', tierName: '季度畅享卡', durationDays: 90 });
    seedDevice(env.db, { deviceId: INVITER, tier: 'Q', tierName: '季度畅享卡', expiresAt: TEST_BASE_TIME_SECONDS - DAY });

    await redeemWithRef(env, CODE_A, INVITEE, INVITER);
    const row = deviceRow(env.db, INVITER);
    expect(Number(row?.exempt_until)).toBe(TEST_BASE_TIME_SECONDS + REWARD_SECONDS);
    expect(Number(row?.expires_at)).toBe(TEST_BASE_TIME_SECONDS - DAY);
    expect(logs(env)[0]?.reward_type).toBe('NUDGE_FREE');
  });

  it('keeps a permanent inviter at -1 and still logs the settlement', async () => {
    const env = await createTestEnv();
    seedCoupon(env.db, { code: CODE_A, tier: 'Q', tierName: '季度畅享卡', durationDays: 90 });
    seedCoupon(env.db, { code: CODE_B, tier: 'S', tierName: '极客纪念卡', durationDays: -1 });
    seedDevice(env.db, { deviceId: INVITER, tier: 'S', tierName: '极客纪念卡', expiresAt: -1 });

    await redeemWithRef(env, CODE_B, INVITEE, INVITER);
    expect(Number(deviceRow(env.db, INVITER)?.expires_at)).toBe(-1);
    expect(logs(env)).toMatchObject([{ reward_type: 'TIER_EXTEND', reward_days: 3, settled: 1 }]);
  });

  it('the invitation increment lives on devices only and is never written back to card_coupons', async () => {
    const env = await createTestEnv();
    seedCoupon(env.db, { code: CODE_A, tier: 'Q', tierName: '季度畅享卡', durationDays: 90 });
    seedDevice(env.db, { deviceId: INVITER, tier: 'Q', tierName: '季度畅享卡', expiresAt: TEST_BASE_TIME_SECONDS + 30 * DAY });

    await redeemWithRef(env, CODE_A, INVITEE, INVITER);
    const coupon = couponRow(env.db, CODE_A) ?? {};
    expect(Object.keys(coupon).filter((key) => /invite|refer/.test(key))).toEqual([]);
    expect(Number(coupon.device_count)).toBe(1);
    expect(Number(coupon.rejected_distinct_count)).toBe(0);
  });

  it('revoking the invitee coupon does not claw back the days the inviter earned', async () => {
    const env = await createTestEnv();
    seedCoupon(env.db, { code: CODE_A, tier: 'Q', tierName: '季度畅享卡', durationDays: 90 });
    const currentExpiry = TEST_BASE_TIME_SECONDS + 30 * DAY;
    seedDevice(env.db, { deviceId: INVITER, tier: 'Q', tierName: '季度畅享卡', expiresAt: currentExpiry });

    await redeemWithRef(env, CODE_A, INVITEE, INVITER);
    env.db.execute("UPDATE card_coupons SET status = 'REVOKED' WHERE code = ?", CODE_A);

    expect(Number(deviceRow(env.db, INVITER)?.expires_at)).toBe(currentExpiry + REWARD_SECONDS);
    // The invitee now loses its own authorization, which is the intended revocation effect.
    const after = await redeemWithRef(env, CODE_A, INVITEE, INVITER);
    expect(after.status).toBe(400);
    expect(Number(deviceRow(env.db, INVITER)?.expires_at)).toBe(currentExpiry + REWARD_SECONDS);
    expect(logs(env).length).toBe(1);
  });
});

describe('M-4 invite settlement — attribution refusals never break a valid redemption', () => {
  it('settles exactly once per invitee: a second new claim with the same ref is caught, not crashed', async () => {
    const env = await createTestEnv();
    seedCoupon(env.db, { code: CODE_A, tier: 'Q', tierName: '季度畅享卡', durationDays: 90 });
    seedCoupon(env.db, { code: CODE_B, tier: 'A', tierName: '普通激活卡', durationDays: 30 });
    const currentExpiry = TEST_BASE_TIME_SECONDS + 30 * DAY;
    seedDevice(env.db, { deviceId: INVITER, tier: 'Q', tierName: '季度畅享卡', expiresAt: currentExpiry });

    expect((await redeemWithRef(env, CODE_A, INVITEE, INVITER)).status).toBe(200);
    const second = await redeemWithRef(env, CODE_B, INVITEE, INVITER);
    expect(second.status).toBe(200);

    expect(Number(deviceRow(env.db, INVITER)?.expires_at)).toBe(currentExpiry + REWARD_SECONDS);
    expect(logs(env).length).toBe(1);
  });

  it('refuses self-invite, unknown inviters and unusable refs while still activating the card', async () => {
    const env = await createTestEnv();
    seedCoupon(env.db, { code: CODE_A, tier: 'Q', tierName: '季度畅享卡', durationDays: 90 });

    const self = await redeemWithRef(env, CODE_A, INVITEE, INVITEE);
    expect(self.status).toBe(200);
    expect(logs(env).length).toBe(0);
    expect(deviceRow(env.db, INVITEE)).toBeDefined();

    const unknown = await redeemWithRef(env, CODE_A, 'GY-NEW00002', 'GY-ZZZZZZZZ');
    expect(unknown.status).toBe(200);
    expect(logs(env).length).toBe(0);

    const malformed = await redeemWithRef(env, CODE_A, 'GY-NEW00003', 'not-a-device');
    expect(malformed.status).toBe(200);
    expect(logs(env).length).toBe(0);
  });

  it('reports each refusal reason from the settlement helper itself for supervision evidence', async () => {
    const env = await createTestEnv();
    seedDevice(env.db, { deviceId: INVITER });
    seedDevice(env.db, { deviceId: INVITEE });

    expect(await settleFirstInvite({ db: env.DB, inviteeDeviceId: INVITEE, inviteRef: undefined, nowSeconds: TEST_BASE_TIME_SECONDS })).toBe('skipped_no_ref');
    expect(await settleFirstInvite({ db: env.DB, inviteeDeviceId: INVITEE, inviteRef: 'bad', nowSeconds: TEST_BASE_TIME_SECONDS })).toBe('skipped_invalid_ref');
    expect(await settleFirstInvite({ db: env.DB, inviteeDeviceId: INVITEE, inviteRef: INVITEE, nowSeconds: TEST_BASE_TIME_SECONDS })).toBe('skipped_self_invite');
    expect(await settleFirstInvite({ db: env.DB, inviteeDeviceId: INVITEE, inviteRef: 'GY-ZZZZZZZZ', nowSeconds: TEST_BASE_TIME_SECONDS })).toBe('skipped_unknown_inviter');
    expect(await settleFirstInvite({ db: env.DB, inviteeDeviceId: INVITEE, inviteRef: INVITER, nowSeconds: TEST_BASE_TIME_SECONDS })).toBe('settled_nudge_free');
    expect(await settleFirstInvite({ db: env.DB, inviteeDeviceId: INVITEE, inviteRef: INVITER, nowSeconds: TEST_BASE_TIME_SECONDS })).toBe('skipped_already_settled');
    expect(logs(env).length).toBe(1);
  });

  it('rolls the ledger row and the inviter grant back together when the UNIQUE guard fires', async () => {
    const env = await createTestEnv();
    seedDevice(env.db, { deviceId: INVITER, tier: '0' });
    seedDevice(env.db, { deviceId: INVITEE, tier: '0' });

    await settleFirstInvite({ db: env.DB, inviteeDeviceId: INVITEE, inviteRef: INVITER, nowSeconds: TEST_BASE_TIME_SECONDS });
    const granted = Number(deviceRow(env.db, INVITER)?.exempt_until);
    expect(granted).toBe(TEST_BASE_TIME_SECONDS + REWARD_SECONDS);

    const again = await settleFirstInvite({ db: env.DB, inviteeDeviceId: INVITEE, inviteRef: INVITER, nowSeconds: TEST_BASE_TIME_SECONDS + DAY });
    expect(again).toBe('skipped_already_settled');
    // No half-applied reward: the batch rolled back, so the inviter keeps the single grant.
    expect(Number(deviceRow(env.db, INVITER)?.exempt_until)).toBe(granted);
    expect(deviceRow(env.db, INVITEE)?.invited_by).toBe(INVITER);
  });
});
