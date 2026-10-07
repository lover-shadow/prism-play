import { factsHash } from '../library/work-facts';
import { isSafeWorkId } from '../library/contract';
import { discoveryJsonBytes } from './discovery-facts';

/** All timestamps and durations are Unix seconds. Query key includes filters/provider contract version. */
export interface DiscoveryQueryKey { qhash: string; normalizedKey: string }
export interface DiscoveryLease { key: string; token: string }
export interface DiscoveryQueryHit { ids: string[]; status: 'success' | 'empty'; freshUntil: number }
export function discoveryTime(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid discovery time');
  return value;
}
function boundedKey(key: string): string {
  if (!key || key.length > 1024) throw new Error('Invalid discovery key');
  return key;
}
export async function discoveryQueryKey(query: string, scope = 'public:v1'): Promise<DiscoveryQueryKey> {
  if (query.length > 512 || scope.length > 256) throw new Error('Discovery query too large');
  const normalized = query.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
  if (!normalized) throw new Error('Empty discovery query');
  const normalizedKey = boundedKey(JSON.stringify([scope, normalized]));
  return { normalizedKey, qhash: await factsHash(discoveryJsonBytes(normalizedKey)) };
}
function validQuery(key: DiscoveryQueryKey): void {
  boundedKey(key.normalizedKey);
  if (!/^[a-f0-9]{64}$/.test(key.qhash)) throw new Error('Invalid query hash');
}
export async function readDiscoveryQuery(db: D1Database, key: DiscoveryQueryKey, now: number): Promise<DiscoveryQueryHit | null> {
  validQuery(key); discoveryTime(now);
  const row = await db.prepare(`SELECT ids_json, status, fresh_until FROM discovery_queries
    WHERE qhash = ? AND normalized_key = ? AND fresh_until > ?`).bind(key.qhash, key.normalizedKey, now)
    .first<{ ids_json: string; status: 'success' | 'empty'; fresh_until: number }>();
  if (!row) return null;
  return { ids: JSON.parse(row.ids_json) as string[], status: row.status, freshUntil: row.fresh_until };
}
/** Single atomic INSERT/conditional UPSERT: parallel isolates cannot both own a live lease. */
export async function acquireDiscoveryLease(db: D1Database, key: string, now: number, ttl = 30): Promise<DiscoveryLease | null> {
  boundedKey(key); discoveryTime(now);
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 300) throw new Error('Invalid lease TTL');
  const token = crypto.randomUUID();
  const result = await db.prepare(`INSERT INTO discovery_leases(lease_key, owner_token, expires_at) VALUES (?, ?, ?)
    ON CONFLICT(lease_key) DO UPDATE SET owner_token = excluded.owner_token, expires_at = excluded.expires_at
    WHERE discovery_leases.expires_at <= ?`).bind(key, token, now + ttl, now).run();
  return result.meta.changes === 1 ? { key, token } : null;
}
export async function releaseDiscoveryLease(db: D1Database, lease: DiscoveryLease): Promise<boolean> {
  boundedKey(lease.key); boundedKey(lease.token);
  const result = await db.prepare('DELETE FROM discovery_leases WHERE lease_key = ? AND owner_token = ?')
    .bind(lease.key, lease.token).run();
  return result.meta.changes === 1;
}
/** Only successful provider responses reach here. Failure: release lease, DO NOT call with []. */
export async function completeDiscoveryQuery(db: D1Database, key: DiscoveryQueryKey, lease: DiscoveryLease,
  ids: readonly string[], now: number, successTtl = 300, emptyTtl = 30): Promise<boolean> {
  validQuery(key); discoveryTime(now);
  if (lease.key !== `query:${key.qhash}` || !lease.token) throw new Error('Query lease mismatch');
  if (ids.length > 256 || ids.some((id) => !isSafeWorkId(id)) || new Set(ids).size !== ids.length ||
    discoveryJsonBytes(ids).length > 32768) throw new Error('Invalid discovery query results');
  if (!Number.isSafeInteger(successTtl) || successTtl < 1 || successTtl > 3600 ||
    !Number.isSafeInteger(emptyTtl) || emptyTtl < 1 || emptyTtl > 60) throw new Error('Invalid query TTL');
  const results = await db.batch([
    db.prepare(`INSERT INTO discovery_queries(qhash, normalized_key, ids_json, status, fresh_until, updated_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM discovery_leases
        WHERE lease_key = ? AND owner_token = ? AND expires_at > ?)
      ON CONFLICT(qhash) DO UPDATE SET normalized_key = excluded.normalized_key, ids_json = excluded.ids_json,
        status = excluded.status, fresh_until = excluded.fresh_until, updated_at = excluded.updated_at`)
      .bind(key.qhash, key.normalizedKey, JSON.stringify(ids), ids.length ? 'success' : 'empty',
        now + (ids.length ? successTtl : emptyTtl), now, lease.key, lease.token, now),
    db.prepare('DELETE FROM discovery_leases WHERE lease_key = ? AND owner_token = ?').bind(lease.key, lease.token)
  ]);
  return results[0].meta.changes === 1;
}
/** Fixed D1 window. Scope is a caller-hashed device/IP+purpose, not a KV read/modify/write counter. */
export async function consumeDiscoveryRate(db: D1Database, scopeKey: string, now: number, limit: number,
  windowSeconds = 60): Promise<{ allowed: boolean; retryAfter: number }> {
  boundedKey(scopeKey); discoveryTime(now);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000 || !Number.isSafeInteger(windowSeconds) ||
    windowSeconds < 1 || windowSeconds > 86400) throw new Error('Invalid discovery rate window');
  const start = Math.floor(now / windowSeconds) * windowSeconds, end = start + windowSeconds;
  const result = await db.prepare(`INSERT INTO discovery_rate_windows(scope_key, window_start, hits, expires_at)
    VALUES (?, ?, 1, ?) ON CONFLICT(scope_key, window_start) DO UPDATE SET hits = hits + 1
    WHERE discovery_rate_windows.hits < ?`).bind(scopeKey, start, end, limit).run();
  const allowed = result.meta.changes === 1;
  return { allowed, retryAfter: allowed ? 0 : end - now };
}
/** Bounded housekeeping; changes/tombstones are deliberately never pruned by this helper. */
export async function pruneDiscoveryCoordination(db: D1Database, now: number): Promise<void> {
  discoveryTime(now);
  await db.batch([
    db.prepare('DELETE FROM discovery_queries WHERE qhash IN (SELECT qhash FROM discovery_queries WHERE fresh_until <= ? LIMIT 256)').bind(now),
    db.prepare('DELETE FROM discovery_leases WHERE lease_key IN (SELECT lease_key FROM discovery_leases WHERE expires_at <= ? LIMIT 256)').bind(now),
    db.prepare(`DELETE FROM discovery_rate_windows WHERE (scope_key, window_start) IN
      (SELECT scope_key, window_start FROM discovery_rate_windows WHERE expires_at <= ? LIMIT 256)`).bind(now)
  ]);
}
