import type { Env } from '../types/env';
import type { Clock } from '../core/clock';
import type { CouponTier, DeviceTier, RedeemSuccessResponse } from '../types/api';
import { PERMANENT_EXPIRES_AT } from '../types/api';
import { systemClock } from '../core/clock';
import { COUPON_ABNORMAL_THRESHOLD } from '../core/constants';
import { isCouponTier, isValidCouponCode, isValidDeviceId } from '../core/validation';
import { errorResponse } from '../http/errors';
import { jsonResponse, readJsonBody } from '../http/json';
import { buildClaims, getEdgeKeyMaterial, signJwt } from '../auth/jwt';
import { isCredentialLive, readDeviceIdentity } from '../auth/guard';
import { clientIpOf, redeemRateLimiter } from '../core/rate-limit';
import {
  claimCouponForNewDevice,
  expiresAtFor,
  isConstraintViolation,
  readBinding,
  readCoupon,
  reactivateBoundDevice,
  recordRejectedAttempt,
  type ClaimTarget,
  type CouponRecord
} from '../db/coupon-repo';
import { settleFirstInvite } from './invite';

const DEFAULT_KID = 'p2026';

/** Message dates are calendar days in UTC+8, the shipping market's civil time; `expiresAt` stays UTC. */
const CIVIL_OFFSET_SECONDS = 8 * 3600;

function civilDateLabel(epochSeconds: number): string {
  return new Date((epochSeconds + CIVIL_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
}

export function activationMessage(expiresAt: number): string {
  if (expiresAt === PERMANENT_EXPIRES_AT) return '激活成功（永久有效）';
  return `激活成功（有效期至 ${civilDateLabel(expiresAt)}）`;
}

/** A credential is minted here and nowhere else, so redeem and ping cannot drift on claims. */
export async function signDeviceCredential(
  env: Env,
  input: { deviceId: string; tier: DeviceTier; tierName: string; expiresAt: number },
  nowSeconds: number
): Promise<string> {
  const { signing } = await getEdgeKeyMaterial(env.JWT_PRIVATE_KEY_JWK);
  const claims = buildClaims({
    deviceId: input.deviceId,
    tier: input.tier,
    expiresAt: input.expiresAt,
    issuedAt: nowSeconds,
    jti: crypto.randomUUID()
  });
  return await signJwt(claims, signing, env.JWT_KID ?? DEFAULT_KID);
}

export async function issueCredential(
  env: Env,
  input: { deviceId: string; tier: CouponTier; tierName: string; expiresAt: number },
  nowSeconds: number
): Promise<Response> {
  const body: RedeemSuccessResponse = {
    success: true,
    tier: input.tier,
    tierName: input.tierName,
    expiresAt: input.expiresAt,
    token: await signDeviceCredential(env, input, nowSeconds),
    message: activationMessage(input.expiresAt)
  };
  return jsonResponse(body);
}

function targetFor(coupon: CouponRecord, deviceId: string, expiresAt: number, boundIp: string | null): ClaimTarget {
  return {
    code: coupon.code,
    deviceId,
    // Tier and display name come from the D1 row; the code string never grants anything.
    tier: coupon.tier,
    tierName: coupon.tierName,
    expiresAt,
    boundIp
  };
}

/**
 * POST /api/redeem — AC-14.
 * Whether a new device still has room is answered only by the conditional UPDATE inside the atomic
 * batch. The coupon read below supplies tier metadata and labels a rolled-back claim; it never
 * gates the write. A code with no row at all is the single exception, because there is no row to
 * claim and no tier to write.
 */
export async function handleRedeem(request: Request, env: Env, clock: Clock = systemClock): Promise<Response> {
  const nowSeconds = clock.nowSeconds();
  const clientIp = clientIpOf(request);

  // Enforced before any database touch, so probing cannot consume D1 writes for free.
  const decision = await redeemRateLimiter(env.KV, clock).consume(clientIp);
  if (!decision.allowed) return errorResponse('RATE_LIMITED');

  const body = (await readJsonBody(request)) ?? {};
  const code = body.code;
  const deviceId = body.deviceId;
  if (!isValidCouponCode(code)) return errorResponse('COUPON_INVALID_FORMAT');
  if (!isValidDeviceId(deviceId)) return errorResponse('DEVICE_ID_INVALID');
  if (body.platform !== 'android') return errorResponse('PLATFORM_UNSUPPORTED');

  const coupon = await readCoupon(env.DB, code);
  const binding = coupon === null ? null : await readBinding(env.DB, coupon.code, deviceId);

  if (coupon === null) return errorResponse('COUPON_NOT_FOUND');

  if (binding !== null) {
    if (coupon.status === 'REVOKED') return errorResponse('COUPON_REVOKED');
    return await respondForBoundDevice(env, coupon, deviceId, nowSeconds);
  }

  const expiresAt = expiresAtFor(coupon, nowSeconds);
  try {
    await claimCouponForNewDevice(env.DB, targetFor(coupon, deviceId, expiresAt, clientIp), nowSeconds);
  } catch (error) {
    if (!isConstraintViolation(error)) throw error;
    return await handleClaimRejection(env, deviceId, coupon.code, nowSeconds);
  }

  await settleFirstInvite({
    db: env.DB,
    inviteeDeviceId: deviceId,
    inviteRef: typeof body.inviteRef === 'string' ? body.inviteRef : undefined,
    nowSeconds
  });
  return await issueCredential(env, couponPrincipal(coupon, deviceId, expiresAt), nowSeconds);
}

function couponPrincipal(coupon: CouponRecord, deviceId: string, expiresAt: number) {
  return { deviceId, tier: coupon.tier, tierName: coupon.tierName, expiresAt };
}

/**
 * AC-14 idempotency: a device that already holds a slot gets its CURRENT authorization back, read from
 * D1, with a freshly signed credential — and no write at all. Recomputing the window from `now` here
 * would let one 90-day card be extended forever by re-submitting it, so the expiry is never rolled.
 */
async function respondForBoundDevice(
  env: Env,
  coupon: CouponRecord,
  deviceId: string,
  nowSeconds: number
): Promise<Response> {
  const stored = await readDeviceIdentity(env.DB, deviceId);
  if (stored === null) {
    // `coupon_bindings.device_id` is a foreign key to `devices`, so a binding without its device row
    // cannot exist in D1; refusing without touching any ledger is the only possible answer.
    return errorResponse('DEVICE_ID_INVALID');
  }
  if (!isCouponTier(stored.tier)) {
    // The slot is held but operations cleared the paid tier: re-grant from the coupon rather than
    // lock the customer out of a card they already spent.
    const expiresAt = expiresAtFor(coupon, nowSeconds);
    await reactivateBoundDevice(env.DB, targetFor(coupon, deviceId, expiresAt, null), nowSeconds);
    return await issueCredential(env, couponPrincipal(coupon, deviceId, expiresAt), nowSeconds);
  }
  if (!isCredentialLive(stored, nowSeconds)) {
    // "不发过期旧凭证": ruling A-2 gave this case its own closed-set code.
    return errorResponse('CREDENTIAL_EXPIRED', '该卡密的授权已到期，请核销新的卡密');
  }
  return await issueCredential(
    env,
    { deviceId, tier: stored.tier, tierName: stored.tierName, expiresAt: stored.expiresAt },
    nowSeconds
  );
}

/**
 * The claim batch has already rolled back, so nothing partially landed. `coupon_bindings` is
 * re-read first: a binding that now exists means a concurrent submit for the same device won the
 * UNIQUE slot, and the contract answer is the idempotent success, not a rejection.
 * Only genuinely rejected *new* devices enter the dedupe ledger, which is what makes retries from
 * one device unable to inflate `rejected_distinct_count`.
 */
async function handleClaimRejection(env: Env, deviceId: string, code: string, nowSeconds: number): Promise<Response> {
  const concurrent = await readBinding(env.DB, code, deviceId);
  if (concurrent !== null) {
    const current = await readCoupon(env.DB, code);
    if (current === null || current.status === 'REVOKED') return errorResponse('COUPON_REVOKED');
    return await respondForBoundDevice(env, current, deviceId, nowSeconds);
  }

  const current = await readCoupon(env.DB, code);
  if (current === null) return errorResponse('COUPON_NOT_FOUND');
  const revoked = current.status === 'REVOKED';
  await recordRejectedAttempt(env.DB, code, deviceId, nowSeconds, COUPON_ABNORMAL_THRESHOLD);
  // `device_count >= max_devices` and an unexplained counter/ledger mismatch both land on the
  // limit code: the closed enum offers nothing more precise, and the trip-wire already refused.
  return errorResponse(revoked ? 'COUPON_REVOKED' : 'COUPON_DEVICE_LIMIT_EXCEEDED');
}
