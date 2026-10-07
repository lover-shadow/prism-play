import type { Clock } from '../core/clock';
import { analyticsDay, analyticsNow, type AnalyticsEnv } from './visitor';

/** One bounded pass; callers may schedule further passes, never an unbounded drain loop. */
export async function cleanupAnalytics(env: Pick<AnalyticsEnv, 'DB'>, clock: Clock): Promise<void> {
  const now = analyticsNow(clock);
  const day = (age: number) => analyticsDay(now - age * 86400);
  // The existing migration has no time index for login limits. Install only this additive index;
  // all remaining subqueries use existing retention indexes. No business rows/tables are touched.
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_admin_login_limits_window ON admin_login_limits(window_start)').run();
  const bounded = (table: string, column: string, cutoff: string | number, inclusive = false) =>
    env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN (` +
      `SELECT rowid FROM ${table} WHERE ${column} ${inclusive ? '<=' : '<'} ? ORDER BY ${column} LIMIT 1000)`)
      .bind(cutoff);
  await env.DB.batch([
    bounded('analytics_visitor_days', 'day', day(90)),
    // Maximum identity lifetime is based on frozen first-seen day, not sliding last_seen_at.
    bounded('analytics_visitors', 'first_seen_day', day(180)),
    bounded('analytics_daily', 'day', day(365)),
    bounded('admin_audit_logs', 'created_at', now - 365 * 86400),
    bounded('admin_sessions', 'expires_at', now, true),
    bounded('admin_login_limits', 'window_start', now - 86400)
  ]);
}
