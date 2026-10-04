import { COUPON_TIERS, type MonetizationConfig } from '../../edge/src/types/api';
import type { PreferenceStore } from './state/theme';

// Backup-safe preference scalars only: never content IDs, private time or credentials.
export const WATCH_TIME_KEYS = { total: 'prism.watch_seconds_total', lastNudge: 'prism.watch_seconds_last_nudge' } as const;
export type WatchScope = 'public' | 'private' | 'unknown';
export type WatchStop = 'pause' | 'ended' | 'error' | 'blur' | 'waiting' | 'stalled' | 'seeking' | 'seeked' | 'resume' | 'switch';
const nonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Fail closed on incomplete/malformed cloud policy; no local business defaults. */
export function validMonetization(value: unknown): value is MonetizationConfig {
  if (!value || typeof value !== 'object') return false;
  const c = value as MonetizationConfig, p = c.nudgePolicy;
  if (!p || !Array.isArray(c.activeTiers) || c.activeTiers.length === 0) return false;
  return nonnegative(p.freeTrialSeconds) && nonnegative(p.stage1UntilSeconds) &&
    nonnegative(p.stage2UntilSeconds) && p.freeTrialSeconds < p.stage1UntilSeconds &&
    p.stage1UntilSeconds < p.stage2UntilSeconds &&
    [p.stage1IntervalSeconds, p.stage2IntervalSeconds, p.stage3IntervalSeconds].every(v => nonnegative(v) && v > 0) &&
    text(p.dialogTitle) && text(p.dialogBody) && c.activeTiers.every(t => t && COUPON_TIERS.includes(t.tier) &&
      text(t.name) && nonnegative(t.priceYuan) && nonnegative(t.durationDays) &&
      (t.desc === undefined || typeof t.desc === 'string'));
}

export interface WatchTimeOptions {
  prefs: PreferenceStore;
  /** Monotonic milliseconds, default performance.now. Never media currentTime/Date.now. */
  clock?: () => number;
  isAuthorized: () => boolean;
}

/** Await hydration before connecting events; read failure rejects rather than overwriting totals. */
export async function createWatchTime({ prefs, clock = () => performance.now(), isAuthorized }: WatchTimeOptions) {
  async function read(key: string): Promise<number> {
    const raw = await prefs.get(key);
    if (raw === null) return 0;
    const value = raw.trim() === '' ? NaN : Number(raw);
    if (!nonnegative(value)) throw new Error('Invalid watch-time preference');
    return value;
  }
  let total = await read(WATCH_TIME_KEYS.total), lastNudge = await read(WATCH_TIME_KEYS.lastNudge);
  if (lastNudge > total) throw new Error('Invalid watch-time preference order');
  let savedTotal = total, savedNudge = lastNudge, scope: WatchScope = 'unknown';
  let started: number | null = null, dead = false, boundary = false, offered = false;
  let pending = 0, failure: unknown = null, queue = Promise.resolve();

  function sample(stop: boolean): void {
    if (started === null) return;
    const now = clock();
    if (Number.isFinite(now) && now >= started && scope === 'public') total += (now - started) / 1000;
    // Bad/reset clocks discard the unknown interval; never retroactively fill it.
    started = stop || !Number.isFinite(now) ? null : now;
  }
  function flush(): Promise<void> {
    sample(false);
    const targetTotal = total, targetNudge = lastNudge;
    pending++;
    queue = queue.then(async () => {
      try {
        if (targetTotal !== savedTotal) { await prefs.set(WATCH_TIME_KEYS.total, String(targetTotal)); savedTotal = targetTotal; }
        if (targetNudge !== savedNudge) { await prefs.set(WATCH_TIME_KEYS.lastNudge, String(targetNudge)); savedNudge = targetNudge; }
        failure = null;
      } catch (error) { failure = error; }
      finally { pending--; }
    });
    return queue;
  }
  function suspend(reason: WatchStop): Promise<void> {
    if (dead) return queue;
    boundary = reason === 'ended' && started !== null && scope === 'public';
    sample(true);
    return flush();
  }
  return {
    /** Flush old scope before replacing a source; unknown/private are deliberately inert. */
    setScope(next: WatchScope): Promise<void> {
      if (dead) return queue;
      const result = suspend('switch'); scope = next; return result;
    },
    /** Only actual playing + decoded first frame. After seek/blur/resume require fresh evidence. */
    playing(firstFrame: boolean): void {
      if (dead || !firstFrame || scope !== 'public' || started !== null) return;
      boundary = false;
      const now = clock(); if (Number.isFinite(now)) started = now;
    },
    suspend, flush,
    /** Call only on ended→next-episode AUTO transition, before setScope; never hand selection. */
    naturalBoundary(config: unknown): MonetizationConfig | null {
      const eligibleBoundary = boundary; boundary = false;
      if (dead || !eligibleBoundary || scope !== 'public' || offered || isAuthorized() || !validMonetization(config)) return null;
      const p = config.nudgePolicy;
      const interval = total < p.stage1UntilSeconds ? p.stage1IntervalSeconds :
        total < p.stage2UntilSeconds ? p.stage2IntervalSeconds : p.stage3IntervalSeconds;
      if (total < p.freeTrialSeconds || (lastNudge > 0 && total - lastNudge < interval)) return null;
      offered = true; return config;
    },
    /** Close/action records the measured total, even if disk fails; inspect state and retry flush. */
    dismissNudge(): Promise<void> {
      if (!offered) return queue;
      sample(false); lastNudge = total; offered = false; return flush();
    },
    state() {
      return { totalSeconds: total, lastNudgeSeconds: lastNudge, persistedSeconds: savedTotal,
        persistedLastNudgeSeconds: savedNudge, persistence: failure ? 'error' as const : pending ? 'pending' as const :
          total === savedTotal && lastNudge === savedNudge ? 'saved' as const : 'dirty' as const, error: failure };
    },
    destroy(): Promise<void> {
      if (dead) return queue;
      const result = suspend('switch'); dead = true; return result;
    }
  };
}
export type WatchTime = Awaited<ReturnType<typeof createWatchTime>>;
