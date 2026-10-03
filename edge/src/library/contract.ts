/**
 * Shared primitives for the R2 catalogue assets described in SPEC-CLOUD-REFACTOR v2 §3.
 *
 * These files are the read side of a contract that Track 2a writes: the schema in §3.1/§3.2 is the
 * authority, and this module is the single place that decides whether a stored object satisfies it.
 * A reader that repairs a broken asset would create a second 口径 for the same data, so an asset
 * that fails validation is *rejected* (the route answers 503) and never rewritten into plausibility.
 *
 * Two red lines are enforced here rather than trusted downstream:
 *  - 私密隔离: a public-prefix object must not carry a private item (§2.2 工程后果, AC-C2b-1);
 *  - 上游零暴露: a cover handle must be same-origin or relative, never an upstream address (§3.1).
 */

export type AssetRejection =
  | 'malformed'
  | 'private-in-public'
  | 'upstream-address';

export type AssetVerdict<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: AssetRejection };

export function accept<T>(value: T): AssetVerdict<T> {
  return { ok: true, value };
}

export function reject<T>(reason: AssetRejection): AssetVerdict<T> {
  return { ok: false, reason };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `^\d+$`-style integers: no sign, no exponent, inside the safe-integer range. */
export function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isOptionalCount(value: unknown): boolean {
  return value === undefined || isCount(value);
}

/** Ids double as R2 key segments, so the charset is the path-safety boundary as well as a type check. */
export const WORK_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

export function isSafeWorkId(value: unknown): value is string {
  return typeof value === 'string' && WORK_ID_PATTERN.test(value);
}

export function isNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

export function isOptionalText(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}
/**
 * `true` when the value is absent, empty, or a same-origin proxy handle (`/proxy/…` or the absolute
 * form on `origin`). An upstream host inside a public asset is the exact leak §3.1 forbids, so it is
 * rejected at the edge instead of being shipped to every client that asks for the page.
 */
export function isControlledCoverHandle(value: unknown, origin: string): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed === '') return true;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return true;
  try {
    const parsed = new URL(trimmed, origin);
    return parsed.origin === origin && parsed.pathname.startsWith('/proxy/');
  } catch {
    return false;
  }
}

/** Media addresses are the payload of §3.2: absolute http(s) only, so a `javascript:` URI can never ride along. */
export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}
