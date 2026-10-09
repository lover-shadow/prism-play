/**
 * Strict readers for the cloud-delivered commercial and OTA configuration (KV is their only home:
 * SPEC 6 has no table for them, and ARCHITECTURE keeps KV for public, delay-tolerant data only).
 *
 * The rule this file exists to enforce comes from SPEC 10: 「接口无有效配置时不显示付费入口，不启用本地
 * 猜测价格」. So a missing, malformed or contradictory stored value is *rejected*, never repaired:
 * the route answers 503 and the client shows no paywall and no nudge. A fallback price here would be
 * a second, hardcoded 口径 for money, which M-3 forbids.
 *
 * Validation is also the leak boundary: nothing from the stored value is echoed back to the caller,
 * and only whitelisted fields are re-emitted (a stray `windows` key in the version blob cannot reach
 * the wire, because the response object is rebuilt field by field).
 */

import type {
  AndroidRelease,
  CouponTier,
  MonetizationConfig,
  MonetizationTier,
  NudgePolicy,
  PrivateEligibleTier,
  VersionResponse
} from '../types/api';
import { COUPON_TIERS, PRIVATE_ELIGIBLE_TIERS } from '../types/api';
import { HTTP_STATUS_BY_ERROR_CODE, buildErrorResponse } from '../http/errors';
import { jsonResponse } from '../http/json';
import { MONETIZATION_KV_KEY, VERSION_KV_KEY } from '../core/constants';

/** Public, delay-tolerant configuration may be cached briefly; a rejection must never be cached. */
export const CONFIG_MAX_AGE_SECONDS = 60;

export function publicConfigHeaders(): Record<string, string> {
  return { 'Cache-Control': `public, max-age=${CONFIG_MAX_AGE_SECONDS}` };
}

/**
 * 503 `SERVICE_UNAVAILABLE` with the shared error shape and `no-store`.
 * Same body as `errorResponse('SERVICE_UNAVAILABLE')`; the status is taken from the single mapping
 * table in `http/errors.ts` so a route can never invent its own status for the same code.
 */
export function configUnavailableResponse(): Response {
  return jsonResponse(buildErrorResponse('SERVICE_UNAVAILABLE'), HTTP_STATUS_BY_ERROR_CODE.SERVICE_UNAVAILABLE, {
    'Cache-Control': 'no-store'
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/** Exported for `library/manifest.ts`: one JSON-dialect for every KV value, corrupt reads as absent. */
export function parseStoredJson(raw: string | null): unknown {
  if (raw === null || raw.trim() === '') return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // A corrupt KV value is indistinguishable from an absent one to the caller.
    return null;
  }
}

/** Exported for `library/manifest.ts`: the KV read is text-or-nothing, never a guessed default. */
export async function readKvText(kv: KVNamespace, key: string): Promise<string | null> {
  const value = await kv.get(key);
  return typeof value === 'string' ? value : null;
}

function isCouponTierValue(value: unknown): value is CouponTier {
  return typeof value === 'string' && (COUPON_TIERS as readonly string[]).includes(value);
}

function validateTier(value: unknown): MonetizationTier | null {
  if (!isRecord(value)) return null;
  if (!isCouponTierValue(value.tier)) return null;
  if (!isNonEmptyString(value.name)) return null;
  // `durationDays` stays an integer without a lower bound: tier S is permanent and stores -1
  // (PERMANENT_EXPIRES_AT semantics), so a `> 0` check would reject a valid permanent card.
  if (!isInteger(value.durationDays)) return null;
  if (!isFiniteNumber(value.priceYuan) || value.priceYuan <= 0) return null;
  if (!isOptionalString(value.desc)) return null;
  const tier: MonetizationTier = {
    tier: value.tier,
    name: value.name.trim(),
    durationDays: value.durationDays,
    priceYuan: value.priceYuan
  };
  if (typeof value.desc === 'string' && value.desc.trim() !== '') tier.desc = value.desc.trim();
  return tier;
}

function validateNudgePolicy(value: unknown): NudgePolicy | null {
  if (!isRecord(value)) return null;
  const freeTrial = value.freeTrialSeconds;
  const stage1Until = value.stage1UntilSeconds;
  const stage2Until = value.stage2UntilSeconds;
  const intervals = [value.stage1IntervalSeconds, value.stage2IntervalSeconds, value.stage3IntervalSeconds];
  if (!isInteger(freeTrial) || freeTrial < 0) return null;
  if (!isInteger(stage1Until) || !isInteger(stage2Until)) return null;
  // openapi pins every stage bound and interval to `minimum: 1`, and the stage order is the whole
  // point of the three-tier nudge ladder: freeTrial < stage1Until < stage2Until.
  if (stage1Until < 1 || stage2Until < 1) return null;
  if (!(freeTrial < stage1Until && stage1Until < stage2Until)) return null;
  for (const interval of intervals) {
    if (!isInteger(interval) || interval < 1) return null;
  }
  if (!isNonEmptyString(value.dialogTitle) || !isNonEmptyString(value.dialogBody)) return null;
  const policy: NudgePolicy = {
    freeTrialSeconds: freeTrial,
    stage1UntilSeconds: stage1Until,
    stage2UntilSeconds: stage2Until,
    stage1IntervalSeconds: intervals[0] as number,
    stage2IntervalSeconds: intervals[1] as number,
    stage3IntervalSeconds: intervals[2] as number,
    dialogTitle: (value.dialogTitle as string).trim(),
    dialogBody: (value.dialogBody as string).trim()
  };
  return policy;
}

/**
 * Ruling A-3 / M-3: `privateAccessTiers` is passed through only when the operator stored it. An
 * absent field stays absent, because defaulting it here would move 个人探索 eligibility out of cloud
 * configuration and into code. Every entry must be inside the closed B/Y/S set.
 */
function validatePrivateAccessTiers(value: unknown): PrivateEligibleTier[] | null | 'invalid' {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return 'invalid';
  const unique: PrivateEligibleTier[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !(PRIVATE_ELIGIBLE_TIERS as readonly string[]).includes(entry)) {
      return 'invalid';
    }
    const cast = entry as PrivateEligibleTier;
    if (!unique.includes(cast)) unique.push(cast);
  }
  return unique;
}

export function validateMonetizationConfig(raw: unknown): MonetizationConfig | null {
  if (!isRecord(raw)) return null;
  if (!Array.isArray(raw.activeTiers) || raw.activeTiers.length === 0) return null;
  const tiers: MonetizationTier[] = [];
  for (const entry of raw.activeTiers) {
    const tier = validateTier(entry);
    if (tier === null) return null;
    tiers.push(tier);
  }
  const nudgePolicy = validateNudgePolicy(raw.nudgePolicy);
  if (nudgePolicy === null) return null;
  const privateAccessTiers = validatePrivateAccessTiers(raw.privateAccessTiers);
  if (privateAccessTiers === 'invalid') return null;
  const config: MonetizationConfig = { activeTiers: tiers, nudgePolicy };
  if (privateAccessTiers !== null) config.privateAccessTiers = privateAccessTiers;
  return config;
}

export async function readMonetizationConfig(kv: KVNamespace): Promise<MonetizationConfig | null> {
  const raw = await readKvText(kv, MONETIZATION_KV_KEY);
  if (raw === null) return null;
  return validateMonetizationConfig(parseStoredJson(raw));
}

function validateAndroidRelease(value: unknown, origin: string): AndroidRelease | null {
  if (!isRecord(value)) return null;
  if (!isInteger(value.versionCode) || value.versionCode < 1) return null;
  if (!isNonEmptyString(value.versionName)) return null;
  if (!isOptionalString(value.changelog)) return null;
  if (value.minVersionCode !== undefined && (!isInteger(value.minVersionCode) || value.minVersionCode < 0)) {
    return null;
  }
  if (value.force !== undefined && typeof value.force !== 'boolean') return null;
  const downloadUrl = value.downloadUrl;
  if (typeof downloadUrl !== 'string' || !isSameOriginDownloadUrl(downloadUrl, origin)) return null;
  const release: AndroidRelease = {
    versionCode: value.versionCode,
    versionName: (value.versionName as string).trim(),
    downloadUrl
  };
  if (typeof value.changelog === 'string' && value.changelog !== '') release.changelog = value.changelog;
  if (isInteger(value.minVersionCode)) release.minVersionCode = value.minVersionCode;
  if (typeof value.force === 'boolean') release.force = value.force;
  if (value.artifact !== undefined) {
    const a = value.artifact;
    if (!isRecord(a) || typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.sha256) ||
        !isInteger(a.bytes) || a.bytes <= 0 || a.key !== `releases/android/${release.versionCode}/${a.sha256}.apk`) return null;
    release.artifact = { key: a.key as string, bytes: a.bytes, sha256: a.sha256 };
  }
  return release;
}

/**
 * The OTA bulletin may only ever point at our own funnel: same origin AND the exact
 * `/dl/latest/android` path that `/dl` owns. A cross-origin configured value is a mis-provisioned or
 * hijacked KV entry and must not be forwarded to every device that polls for updates.
 */
export function isSameOriginDownloadUrl(value: string, origin: string): boolean {
  if (!value.startsWith(`${origin}/`)) return false;
  try {
    const parsed = new URL(value);
    return parsed.origin === origin && parsed.pathname === '/dl/latest/android' && parsed.search === '' && parsed.hash === '';
  } catch {
    return false;
  }
}

/** Rebuilt from validated fields only, so a stored `windows` key can never reach the response. */
export function validateVersionResponse(raw: unknown, origin: string): VersionResponse | null {
  if (!isRecord(raw)) return null;
  const android = validateAndroidRelease(raw.android, origin);
  if (android === null) return null;
  return { android };
}

export async function readVersionRelease(kv: KVNamespace, origin: string): Promise<VersionResponse | null> {
  const raw = await readKvText(kv, VERSION_KV_KEY);
  if (raw === null) return null;
  return validateVersionResponse(parseStoredJson(raw), origin);
}
