import type { Clock } from './clock';
import { REDEEM_MAX_ATTEMPTS_PER_WINDOW, REDEEM_RATE_WINDOW_SECONDS } from './constants';

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
}

export interface RateLimiter {
  consume(key: string): Promise<RateLimitDecision>;
}

/** SPEC §10 pins one口径: 10 attempts per IP per 60s. A second number anywhere is a contract break. */
export const RATE_LIMIT_WINDOW_SECONDS = REDEEM_RATE_WINDOW_SECONDS;
export const RATE_LIMIT_MAX_ATTEMPTS = REDEEM_MAX_ATTEMPTS_PER_WINDOW;
export const UNKNOWN_CLIENT_IP = 'unknown';

export interface RateLimitOptions {
  windowSeconds?: number;
  maxAttempts?: number;
}

/**
 * `CF-Connecting-IP` is set by Cloudflare and cannot be forged by the client, so it wins over
 * `X-Forwarded-For`, which is attacker-controlled whenever the Worker is reached directly.
 */
export function clientIpOf(request: Request): string {
  const direct = request.headers.get('CF-Connecting-IP');
  if (direct !== null && direct.trim() !== '') return direct.trim();
  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded !== null && forwarded.trim() !== '') {
    const first = forwarded.split(',')[0].trim();
    if (first !== '') return first;
  }
  return UNKNOWN_CLIENT_IP;
}

/**
 * Bucket id for the fixed window. Buckets align to the epoch multiple of the window, so every
 * isolate agrees on the same key without exchanging messages.
 */
export function rateWindowBucket(nowSeconds: number, windowSeconds = RATE_LIMIT_WINDOW_SECONDS): number {
  return Math.floor(nowSeconds / windowSeconds);
}

function windowOptions(options?: RateLimitOptions): { windowSeconds: number; maxAttempts: number } {
  return {
    windowSeconds: options?.windowSeconds ?? RATE_LIMIT_WINDOW_SECONDS,
    maxAttempts: options?.maxAttempts ?? RATE_LIMIT_MAX_ATTEMPTS
  };
}

function allow(used: number, maxAttempts: number): RateLimitDecision {
  return { allowed: true, remaining: Math.max(maxAttempts - used, 0) };
}

/**
 * Fixed window in Worker isolate memory. Correct for tests and `wrangler dev`; a deployed Worker
 * has many isolates, so this is only ever the local-dev implementation.
 */
export function createMemoryRateLimiter(clock: Clock, options?: RateLimitOptions): RateLimiter {
  const { windowSeconds, maxAttempts } = windowOptions(options);
  const counters = new Map<string, { bucket: number; used: number }>();
  return {
    async consume(key: string): Promise<RateLimitDecision> {
      const bucket = rateWindowBucket(clock.nowSeconds(), windowSeconds);
      const current = counters.get(key);
      const used = current === undefined || current.bucket !== bucket ? 0 : current.used;
      if (used >= maxAttempts) {
        counters.set(key, { bucket, used });
        return { allowed: false, remaining: 0 };
      }
      counters.set(key, { bucket, used: used + 1 });
      return allow(used + 1, maxAttempts);
    }
  };
}

/**
 * Cross-isolate counter. Cloudflare KV is eventually consistent, so a boundary request that two
 * isolates read concurrently can both be allowed: the window is best-effort at its edge. Proving
 * strict D1/KV concurrency behaviour is a Gate G1 item for the supervision agent, not this file.
 * `expirationTtl` equals the window, which also satisfies KV's 60s minimum.
 */
export function createKvRateLimiter(kv: KVNamespace, clock: Clock, options?: RateLimitOptions): RateLimiter {
  const { windowSeconds, maxAttempts } = windowOptions(options);
  const prefix = 'redeem:ratelimit';
  return {
    async consume(key: string): Promise<RateLimitDecision> {
      const bucketKey = `${prefix}:${rateWindowBucket(clock.nowSeconds(), windowSeconds)}:${key}`;
      const raw = await kv.get(bucketKey);
      // Real KV yields null for a miss; the in-memory stand-in yields undefined, and parseInt of
      // either non-numeric result is NaN, which is treated as "no attempts used".
      const parsed = Number.parseInt(raw ?? '', 10);
      const used = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      if (used >= maxAttempts) return { allowed: false, remaining: 0 };
      await kv.put(bucketKey, String(used + 1), { expirationTtl: windowSeconds });
      return allow(used + 1, maxAttempts);
    }
  };
}

/** The limiter `/api/redeem` must use, so no route can quietly invent its own strategy. */
export function redeemRateLimiter(kv: KVNamespace, clock: Clock): RateLimiter {
  return createKvRateLimiter(kv, clock, {
    windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
    maxAttempts: RATE_LIMIT_MAX_ATTEMPTS
  });
}
