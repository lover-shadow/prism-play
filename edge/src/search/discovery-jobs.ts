import { factsHash } from '../library/work-facts';
import type { DiscoveryCandidate } from './discovery-provider';
import type { DiscoveryContext } from './discovery-store';
import type { DiscoveryLease, DiscoveryQueryKey } from './discovery-query';

export interface DiscoveryJob {
  job_id: string; qhash: string; ordinal: number; provider_id: DiscoveryCandidate['providerId'];
  work_id: string; candidate_json: string; cursor_key: string | null;
  status: 'pending' | 'published' | 'skipped' | 'failed';
}
export interface DiscoveryJobQuery {
  status: 'pending' | 'complete' | 'failed'; search_failed: number; provider_has_more: number; expires_at: number;
}
/** Whitelist metadata rather than serializing an adapter's arbitrary object into D1. */
export function safeDiscoveryCandidate(raw: DiscoveryCandidate): DiscoveryCandidate {
  if (!['provider_s1', 'provider_m1'].includes(raw.providerId) ||
    !['drama', 'movie', 'anime', 'documentary'].includes(raw.channelId) ||
    [raw.sourceItemId, raw.id, raw.title].some((s) => typeof s !== 'string' || !s.trim() || s.length > 512) ||
    (raw.category !== undefined && (typeof raw.category !== 'string' || raw.category.length > 512)) ||
    (raw.isAi !== undefined && typeof raw.isAi !== 'boolean') ||
    (raw.episodeCount !== undefined && (!Number.isSafeInteger(raw.episodeCount) || raw.episodeCount < 1 || raw.episodeCount > 5000)) ||
    (raw.synopsis !== undefined && (typeof raw.synopsis !== 'string' || raw.synopsis.length > 4096))) throw new Error('Unsafe discovery candidate');
  if (raw.coverTargetUrl !== undefined) {
    const cover = new URL(raw.coverTargetUrl);
    if (cover.protocol !== 'https:' || cover.username || cover.password) throw new Error('Unsafe discovery cover');
  }
  return { providerId: raw.providerId, sourceItemId: raw.sourceItemId, id: raw.id, title: raw.title,
    channelId: raw.channelId, ...(raw.category === undefined ? {} : { category: raw.category }),
    ...(raw.isAi === undefined ? {} : { isAi: raw.isAi }),
    ...(raw.episodeCount === undefined ? {} : { episodeCount: raw.episodeCount }),
    ...(raw.synopsis === undefined ? {} : { synopsis: raw.synopsis }),
    ...(raw.coverTargetUrl === undefined ? {} : { coverTargetUrl: raw.coverTargetUrl }) };
}
export async function readDiscoveryJobQuery(db: D1Database, key: DiscoveryQueryKey): Promise<DiscoveryJobQuery | null> {
  return db.prepare('SELECT * FROM discovery_job_queries WHERE qhash = ? AND normalized_key = ?')
    .bind(key.qhash, key.normalizedKey).first<DiscoveryJobQuery>();
}
export async function readDiscoveryJobs(db: D1Database, qhash: string): Promise<DiscoveryJob[]> {
  return (await db.prepare('SELECT * FROM discovery_jobs WHERE qhash = ? ORDER BY ordinal').bind(qhash)
    .all<DiscoveryJob>()).results;
}
const leaseGuard = 'EXISTS (SELECT 1 FROM discovery_leases WHERE lease_key = ? AND owner_token = ? AND expires_at > ?)';
export async function initializeDiscoveryJobs(db: D1Database, key: DiscoveryQueryKey, lease: DiscoveryLease,
  candidates: readonly { candidate: DiscoveryCandidate; workId: string }[], searchFailed: boolean,
  providerHasMore: boolean, now: number): Promise<boolean> {
  if (candidates.length > 256) throw new Error('Too many discovery jobs');
  const statements = [
    db.prepare(`DELETE FROM discovery_job_queries WHERE qhash = ? AND ${leaseGuard}`)
      .bind(key.qhash, lease.key, lease.token, now),
    db.prepare(`INSERT INTO discovery_job_queries(qhash, normalized_key, status, search_failed, provider_has_more, updated_at, expires_at)
      SELECT ?, ?, 'pending', ?, ?, ?, ? WHERE ${leaseGuard}`)
      .bind(key.qhash, key.normalizedKey, Number(searchFailed), Number(providerHasMore), now, now + 3600, lease.key, lease.token, now)
  ];
  candidates.forEach(({ candidate, workId }, ordinal) => statements.push(db.prepare(`INSERT INTO discovery_jobs
    (job_id, qhash, ordinal, provider_id, work_id, candidate_json, status, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, 'pending', ? WHERE ${leaseGuard}`)
    .bind(`${key.qhash}:${ordinal}`, key.qhash, ordinal, candidate.providerId, workId,
      JSON.stringify(safeDiscoveryCandidate(candidate)), now, lease.key, lease.token, now)));
  return (await db.batch(statements))[1].meta.changes === 1;
}
export async function claimDiscoveryJob(db: D1Database, job: DiscoveryJob, lease: DiscoveryLease, now: number): Promise<boolean> {
  return (await db.prepare(`UPDATE discovery_jobs SET lease_token = ?, lease_until =
    (SELECT expires_at FROM discovery_leases WHERE lease_key = ? AND owner_token = ?)
    WHERE job_id = ? AND status = 'pending' AND lease_until <= ? AND ${leaseGuard}`)
    .bind(lease.token, lease.key, lease.token, job.job_id, now, lease.key, lease.token, now).run()).meta.changes === 1;
}
export async function renewDiscoveryJob(db: D1Database, job: DiscoveryJob, lease: DiscoveryLease, now: number): Promise<boolean> {
  return (await db.prepare(`UPDATE discovery_jobs SET lease_until =
    (SELECT expires_at FROM discovery_leases WHERE lease_key = ? AND owner_token = ?)
    WHERE job_id = ? AND status = 'pending' AND lease_token = ? AND lease_until > ? AND ${leaseGuard}`)
    .bind(lease.key, lease.token, job.job_id, lease.token, now, lease.key, lease.token, now).run()).meta.changes === 1;
}
export async function releaseDiscoveryJob(db: D1Database, job: DiscoveryJob, lease: DiscoveryLease): Promise<boolean> {
  return (await db.prepare(`UPDATE discovery_jobs SET lease_token = NULL, lease_until = 0
    WHERE job_id = ? AND lease_token = ?`).bind(job.job_id, lease.token).run()).meta.changes === 1;
}
function cursorBucket(context: DiscoveryContext): R2Bucket {
  const bucket = context.bindings.DISCOVERY_BUCKET;
  if (!bucket || bucket === context.bindings.APK_BUCKET) throw new Error('Independent private bucket required');
  return bucket;
}
const MAX_CURSOR_BYTES = 1048576;
export async function readDiscoveryCursor(context: DiscoveryContext, key: string | null): Promise<string | undefined> {
  if (!key) return undefined;
  const match = /^discovery\/jobs\/([a-f0-9]{64})\.json$/.exec(key);
  if (!match) throw new Error('Invalid discovery checkpoint key');
  const object = await cursorBucket(context).get(key);
  if (!object || object.size > MAX_CURSOR_BYTES) throw new Error('Missing discovery checkpoint');
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== object.size || await factsHash(bytes) !== match[1]) throw new Error('Corrupt discovery checkpoint');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
}
/** Upload before guarded pointer publication; a lost lease can leave only an unreferenced private object. */
export async function saveDiscoveryJob(context: DiscoveryContext, job: DiscoveryJob, lease: DiscoveryLease,
  status: DiscoveryJob['status'], cursor?: string): Promise<boolean> {
  let cursorKey = job.cursor_key;
  if (cursor !== undefined) {
    const bytes = new TextEncoder().encode(cursor);
    if (!bytes.length || bytes.length > MAX_CURSOR_BYTES) throw new Error('Discovery checkpoint too large');
    const hash = await factsHash(bytes);
    cursorKey = `discovery/jobs/${hash}.json`;
    const bucket = cursorBucket(context), existing = await bucket.get(cursorKey);
    if (existing) {
      if (existing.size !== bytes.length || await factsHash(new Uint8Array(await existing.arrayBuffer())) !== hash)
        throw new Error('Corrupt immutable checkpoint');
    } else if (!await bucket.put(cursorKey, bytes, { httpMetadata: { contentType: 'application/json' } })) {
      throw new Error('Checkpoint upload failed');
    }
  }
  const now = context.nowSeconds();
  return (await context.bindings.DB.prepare(`UPDATE discovery_jobs SET status = ?, cursor_key = ?, updated_at = ?,
    lease_token = NULL, lease_until = 0 WHERE job_id = ? AND lease_token = ? AND lease_until > ? AND ${leaseGuard}`)
    .bind(status, status === 'pending' ? cursorKey : null, now, job.job_id, lease.token, now,
      lease.key, lease.token, now).run()).meta.changes === 1;
}
export async function finishDiscoveryJobs(db: D1Database, key: DiscoveryQueryKey, lease: DiscoveryLease,
  failed: boolean, ttl: number, now: number): Promise<boolean> {
  return (await db.prepare(`UPDATE discovery_job_queries SET status = ?, updated_at = ?, expires_at = ?
    WHERE qhash = ? AND ${leaseGuard}`)
    .bind(failed ? 'failed' : 'complete', now, now + ttl, key.qhash, lease.key, lease.token, now).run()).meta.changes === 1;
}
