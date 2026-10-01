import type { CouponTier } from '../types/api';
import { PERMANENT_EXPIRES_AT } from '../types/api';

export const COUPON_STATUS_VALUES = ['UNUSED', 'ACTIVE', 'REVOKED'] as const;
export type CouponStatus = (typeof COUPON_STATUS_VALUES)[number];

export interface CouponRecord {
  code: string;
  tier: CouponTier;
  tierName: string;
  durationDays: number;
  status: CouponStatus;
  maxDevices: number;
  deviceCount: number;
  rejectedDistinctCount: number;
  isAbnormal: boolean;
  firstRedeemedAt: number | null;
}

export interface BindingRecord {
  couponCode: string;
  deviceId: string;
  boundAt: number;
}

/** Why an atomic claim refused a brand-new device; the route maps these to contract codes. */
export type ClaimBlockReason = 'coupon_not_found' | 'coupon_revoked' | 'device_limit_exceeded';

export interface ClaimTarget {
  code: string;
  deviceId: string;
  tier: CouponTier;
  tierName: string;
  expiresAt: number;
  boundIp: string | null;
}

interface CouponRow {
  code: string;
  tier: string;
  tier_name: string;
  duration_days: number;
  status: string;
  max_devices: number;
  device_count: number;
  rejected_distinct_count: number;
  is_abnormal: number;
  first_redeemed_at: number | null;
}

const COUPON_COLUMNS =
  'code, tier, tier_name, duration_days, status, max_devices, device_count, rejected_distinct_count, is_abnormal, first_redeemed_at';

function toCouponRecord(row: CouponRow): CouponRecord {
  return {
    code: row.code,
    tier: row.tier as CouponTier,
    tierName: row.tier_name,
    durationDays: Number(row.duration_days),
    status: row.status as CouponStatus,
    maxDevices: Number(row.max_devices),
    deviceCount: Number(row.device_count),
    rejectedDistinctCount: Number(row.rejected_distinct_count),
    isAbnormal: Number(row.is_abnormal) === 1,
    firstRedeemedAt: row.first_redeemed_at === null ? null : Number(row.first_redeemed_at)
  };
}

/**
 * Only used to build the write and to label a failure; the counter decision itself lives in the
 * conditional UPDATE below, so this read can never gate a write (SPEC §11 "先查计数再写入").
 */
export async function readCoupon(db: D1Database, code: string): Promise<CouponRecord | null> {
  const row = await db
    .prepare(`SELECT ${COUPON_COLUMNS} FROM card_coupons WHERE code = ?`)
    .bind(code)
    .first<CouponRow>();
  return row === null ? null : toCouponRecord(row);
}

export async function readBinding(
  db: D1Database,
  couponCode: string,
  deviceId: string
): Promise<BindingRecord | null> {
  const row = await db
    .prepare('SELECT coupon_code, device_id, bound_at FROM coupon_bindings WHERE coupon_code = ? AND device_id = ?')
    .bind(couponCode, deviceId)
    .first<{ coupon_code: string; device_id: string; bound_at: number }>();
  if (row === null) return null;
  return { couponCode: row.coupon_code, deviceId: row.device_id, boundAt: Number(row.bound_at) };
}

/** -1 is the contract sentinel for "permanent"; anything else is a day count from now. */
export function expiresAtFor(coupon: CouponRecord, nowSeconds: number): number {
  return coupon.durationDays === PERMANENT_EXPIRES_AT
    ? PERMANENT_EXPIRES_AT
    : nowSeconds + coupon.durationDays * 86400;
}

/**
 * Claim, device row and binding are one atomic unit. Batch statements cannot branch on each
 * other's rowcount, so the fourth statement is a reconciliation trip-wire: it rewrites
 * `device_count` as NULL unless it equals the binding count, and because the column is NOT NULL
 * that raises a constraint error and rolls the whole batch back. A silent no-op claim therefore
 * cannot leave a partial binding or device row behind — an 11th device, a revoked coupon or a
 * lost race all collapse to "nothing happened". `CHECK(device_count BETWEEN 0 AND max_devices)`
 * in the schema is the second wall.
 *
 * Order note: the device row is written before the binding because `coupon_bindings.device_id`
 * carries a foreign key to `devices`; binding first aborts on that key for a brand-new device.
 */
export async function claimCouponForNewDevice(db: D1Database, target: ClaimTarget, nowSeconds: number): Promise<void> {
  await db.batch([
    db.prepare(
      "UPDATE card_coupons SET device_count = device_count + 1, status = 'ACTIVE', " +
        'first_redeemed_at = COALESCE(first_redeemed_at, ?), updated_at = ? ' +
        "WHERE code = ? AND status IN ('UNUSED','ACTIVE') AND device_count < max_devices"
    ).bind(nowSeconds, nowSeconds, target.code),
    db.prepare(
      'INSERT INTO devices (device_id, platform, tier, tier_name, expires_at, bound_coupon, registered_ip, ' +
        'last_active_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(device_id) DO UPDATE SET tier = excluded.tier, tier_name = excluded.tier_name, ' +
        'expires_at = excluded.expires_at, bound_coupon = excluded.bound_coupon, ' +
        'last_active_at = excluded.last_active_at, updated_at = excluded.updated_at'
    ).bind(
      target.deviceId,
      'android',
      target.tier,
      target.tierName,
      target.expiresAt,
      target.code,
      target.boundIp,
      nowSeconds,
      nowSeconds,
      nowSeconds
    ),
    db.prepare(
      'INSERT INTO coupon_bindings (coupon_code, device_id, bound_at, bound_ip, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(target.code, target.deviceId, nowSeconds, target.boundIp, nowSeconds, nowSeconds),
    db.prepare(
      'UPDATE card_coupons SET device_count = (SELECT CASE WHEN ' +
        '(SELECT COUNT(*) FROM coupon_bindings WHERE coupon_code = ?) = device_count THEN device_count ELSE NULL END), ' +
        'updated_at = ? WHERE code = ?'
    ).bind(target.code, nowSeconds, target.code)
  ]);
}

/**
 * Rewrites a slot's device row from its coupon. Used only when the row exists but operations cleared
 * its paid tier, so the holder is not locked out of a slot they legitimately occupy. It never touches
 * `device_count` (AC-14 idempotency) and is never reached by an ordinary repeat redemption.
 */
export async function reactivateBoundDevice(
  db: D1Database,
  target: ClaimTarget,
  nowSeconds: number
): Promise<void> {
  await db
    .prepare(
      'UPDATE devices SET tier = ?, tier_name = ?, expires_at = ?, bound_coupon = ?, last_active_at = ?, updated_at = ? ' +
        'WHERE device_id = ?'
    )
    .bind(target.tier, target.tierName, target.expiresAt, target.code, nowSeconds, nowSeconds, target.deviceId)
    .run();
}

/**
 * SQLite raises constraint violations for everything this path can hit (missing coupon row,
 * duplicate binding, trip-wire NOT NULL). Anything else is a real defect and must surface.
 */
export function isConstraintViolation(error: unknown): boolean {
  return error instanceof Error && /constraint failed/i.test(error.message);
}

/**
 * Separate write: the claim batch above has already rolled back, and the rejection ledger must
 * survive that rollback so supervision can see brute-force probing. `INSERT OR IGNORE` on the
 * (coupon_code, device_id) primary key is what keeps retries from one device counted once.
 */
export async function recordRejectedAttempt(
  db: D1Database,
  couponCode: string,
  deviceId: string,
  nowSeconds: number,
  abnormalThreshold: number
): Promise<void> {
  const recompute =
    'UPDATE card_coupons SET rejected_distinct_count = ' +
    '(SELECT COUNT(*) FROM coupon_rejected_devices WHERE coupon_code = ?), is_abnormal = (SELECT CASE WHEN ' +
    '(SELECT COUNT(*) FROM coupon_rejected_devices WHERE coupon_code = ?) > ? THEN 1 ELSE 0 END), updated_at = ? ' +
    'WHERE code = ?';
  await db.batch([
    db.prepare(
      'INSERT OR IGNORE INTO coupon_rejected_devices (coupon_code, device_id, first_rejected_at, created_at, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?)'
    ).bind(couponCode, deviceId, nowSeconds, nowSeconds, nowSeconds),
    db.prepare(recompute).bind(couponCode, couponCode, abnormalThreshold, nowSeconds, couponCode)
  ]);
}
