import type { ContentItem } from '../types/api';
import { itemFromAsset } from '../library/title-asset';
import type { FactRead } from '../library/work-facts';
import { factsHash } from '../library/work-facts';
import { isSafeWorkId } from '../library/contract';
import { discoveryJsonBytes, discoveryWorkId, discoveryCanonicalId, validateDiscoveryFact, MAX_DISCOVERY_FACT_BYTES, type ValidatedDiscoveryFact } from './discovery-facts';
import { acquireDiscoveryLease, releaseDiscoveryLease, discoveryTime } from './discovery-query';

export interface DiscoveryIdentity { workId: string; providerId?: string; sourceId?: string }
/** Authoritative even when withdrawn/private: never downgrade a baseline denial to a discovery fallback.
 * The resolver must use the CURRENT manifest/mappings, and fail closed when that source is unavailable.
 */
export type DiscoveryAuthority = (identity: DiscoveryIdentity) => Promise<
  { authoritative: true; read: FactRead; overlayEligible?: true; canonicalId?: string } | { authoritative: false }>;
type Authority = Awaited<ReturnType<DiscoveryAuthority>>;
function eligible(base: Authority): boolean {
  return base.authoritative && base.overlayEligible === true && base.read.status === 'ok' &&
    base.read.fact.row.enabled === 1 && base.read.fact.row.is_private === 0;
}
function safeOverlay(base: Authority, value: ValidatedDiscoveryFact): boolean {
  if (!base.authoritative) return true;
  if (!eligible(base) || base.read.status !== 'ok') return false;
  const asset = base.read.fact.asset;
  return value.asset.workId === (base.canonicalId ?? asset.workId) && value.asset.title === asset.title &&
    value.asset.channelId === asset.channelId && value.asset.episodes.length >= asset.episodes.length &&
    value.asset.generatedAt > asset.generatedAt;
}
/** DISCOVERY_BUCKET MUST be independently provisioned with r2.dev/custom-domain public access OFF.
 * Never substitute APK_BUCKET. Env/wrangler wiring is owned by the coordinating session.
 */
export interface DiscoveryBindings { DB: D1Database; DISCOVERY_BUCKET?: R2Bucket; APK_BUCKET?: R2Bucket }
export interface DiscoveryContext {
  bindings: DiscoveryBindings;
  authority: DiscoveryAuthority;
  /** Live server clock, re-sampled after R2 IO to reject an expired lease owner. */
  nowSeconds: () => number;
}
export interface DiscoveryIndexRow {
  work_id: string; provider_id: string; source_id: string; card_json: string;
  enabled: number; updated_at: number; expires_at: number;
  fact_key: string; fact_hash: string; fact_bytes: number;
}
export type DiscoveryPublish = { status: 'published'; workId: string } |
  { status: 'baseline' | 'rejected' | 'busy' | 'superseded'; workId: string };
function privateBucket(bindings: DiscoveryBindings): R2Bucket {
  if (!bindings.DISCOVERY_BUCKET || bindings.DISCOVERY_BUCKET === bindings.APK_BUCKET) {
    throw new Error('Independent private DISCOVERY_BUCKET required');
  }
  return bindings.DISCOVERY_BUCKET;
}
async function indexRow(db: D1Database, id: string): Promise<DiscoveryIndexRow | null> {
  return db.prepare('SELECT * FROM discovery_works WHERE work_id = ?').bind(id).first<DiscoveryIndexRow>();
}
/** Provider uses stable provider/source identity and supplies an ENTIRE validated public fact, not a card. */
export async function publishDiscoveryFact(context: DiscoveryContext, providerId: string, sourceId: string,
  raw: unknown, now: number, ttl = 86400, canonicalId?: string, expectedUpdatedAt?: number, expectedFactHash?: string): Promise<DiscoveryPublish> {
  discoveryTime(now);
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 604800) throw new Error('Invalid fact TTL');
  const workId = canonicalId ?? await discoveryWorkId(providerId, sourceId), identity = { workId, providerId, sourceId };
  if (canonicalId && !discoveryCanonicalId(providerId, sourceId, canonicalId)) return { status: 'rejected', workId };
  const baseline = await context.authority(identity);
  if (baseline.authoritative && !eligible(baseline)) return { status: 'baseline', workId };
  const validated = validateDiscoveryFact(raw, workId);
  if (!validated || (canonicalId && !canonicalId.startsWith(`${validated.asset.channelId}_${providerId === 'provider_s1' ? 's' : 'm'}_`)) ||
    !safeOverlay(baseline, validated)) return { status: 'rejected', workId };
  const bucket = privateBucket(context.bindings), db = context.bindings.DB;
  const lease = await acquireDiscoveryLease(db, `work:${workId}`, now, 300);
  if (!lease) return { status: 'busy', workId };
  try {
    const bytes = discoveryJsonBytes(validated.stored), hash = await factsHash(bytes);
    const key = `discovery/facts/${hash}.json`;
    // Content-addressed immutable object. Existing objects must verify; never overwrite corruption.
    const existing = await bucket.get(key);
    if (existing) {
      if (existing.size !== bytes.length || await factsHash(new Uint8Array(await existing.arrayBuffer())) !== hash) {
        throw new Error('Discovery immutable object mismatch');
      }
    } else {
      const uploaded = await bucket.put(key, bytes, { httpMetadata: { contentType: 'application/json' },
        customMetadata: { sha256: hash } });
      if (!uploaded) throw new Error('Discovery upload failed');
    }
    // Check again after slow object IO. A baseline takeover cannot be overwritten by this layer.
    const currentBase = await context.authority(identity);
    if (currentBase.authoritative && !eligible(currentBase)) return { status: 'baseline', workId };
    if (!safeOverlay(currentBase, validated)) return { status: 'rejected', workId };
    const completedAt = discoveryTime(context.nowSeconds());
    // D1 batch is transactional. The trigger appends a sequence only if this guarded write happens.
    const result = await db.batch([
      db.prepare(`INSERT INTO discovery_works(work_id, provider_id, source_id, card_json, enabled,
        updated_at, expires_at, fact_key, fact_hash, fact_bytes)
        SELECT ?, ?, ?, ?, 1, ?, ?, ?, ?, ? WHERE EXISTS
          (SELECT 1 FROM discovery_leases WHERE lease_key = ? AND owner_token = ? AND expires_at > ?)
          AND (? IS NULL OR EXISTS (SELECT 1 FROM discovery_works WHERE work_id = ? AND enabled = 1 AND updated_at = ? AND fact_hash = ?))
        ON CONFLICT(work_id) DO UPDATE SET card_json = excluded.card_json, enabled = 1,
          updated_at = excluded.updated_at, expires_at = excluded.expires_at, fact_key = excluded.fact_key,
          fact_hash = excluded.fact_hash, fact_bytes = excluded.fact_bytes
        WHERE discovery_works.updated_at <= excluded.updated_at AND
          (? IS NULL OR (discovery_works.enabled = 1 AND discovery_works.updated_at = ?)) AND
          (? IS NULL OR discovery_works.fact_hash = ?)`)
        .bind(workId, providerId, sourceId, JSON.stringify(validated.card), now, now + ttl, key, hash,
          bytes.length, lease.key, lease.token, completedAt, expectedUpdatedAt ?? null, workId, expectedUpdatedAt ?? null, expectedFactHash ?? null,
          expectedUpdatedAt ?? null, expectedUpdatedAt ?? null, expectedFactHash ?? null, expectedFactHash ?? null),
      db.prepare('DELETE FROM discovery_leases WHERE lease_key = ? AND owner_token = ?').bind(lease.key, lease.token)
    ]);
    return { status: result[0].meta.changes === 1 ? 'published' : 'superseded', workId };
  } finally { await releaseDiscoveryLease(db, lease); }
}
/** Internal only: returns WorkFact for the existing title/cover/share route machinery. Never JSON-echo row. */
export async function readDiscoveryFact(context: DiscoveryContext, workId: string, now: number): Promise<FactRead> {
  discoveryTime(now);
  if (!isSafeWorkId(workId)) return { status: 'absent' };
  let fallback: FactRead = { status: 'rejected' };
  try {
    const row = await indexRow(context.bindings.DB, workId);
    const baseline = await context.authority({ workId, providerId: row?.provider_id, sourceId: row?.source_id });
    fallback = baseline.authoritative ? baseline.read : { status: 'rejected' };
    if (baseline.authoritative && !eligible(baseline)) return baseline.read;
    if (!row || row.enabled !== 1 || row.expires_at <= now) return baseline.authoritative ? baseline.read : { status: 'absent' };
    if (row.fact_bytes < 1 || row.fact_bytes > MAX_DISCOVERY_FACT_BYTES ||
      !/^[a-f0-9]{64}$/.test(row.fact_hash) || row.fact_key !== `discovery/facts/${row.fact_hash}.json`) return fallback;
    const bucket = privateBucket(context.bindings), object = await bucket.get(row.fact_key);
    if (!object || object.size !== row.fact_bytes) return fallback;
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.length !== row.fact_bytes || await factsHash(bytes) !== row.fact_hash) return fallback;
    const parsed = validateDiscoveryFact(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)), workId);
    if (!parsed || JSON.stringify(parsed.card) !== row.card_json) return fallback;
    // No warm-pointer cache: recheck withdrawal or republish that happened while reading R2.
    const current = await indexRow(context.bindings.DB, workId);
    const authority = await context.authority({ workId, providerId: row.provider_id, sourceId: row.source_id });
    if (authority.authoritative && !safeOverlay(authority, parsed)) return authority.read;
    if (!current || current.enabled !== 1 || current.expires_at <= Math.max(now, discoveryTime(context.nowSeconds()))) return authority.authoritative ? authority.read : { status: 'absent' };
    if (current.fact_hash !== row.fact_hash || current.card_json !== row.card_json) return authority.authoritative ? authority.read : { status: 'rejected' };
    parsed.fact.row.updated_at = current.updated_at;
    return { status: 'ok', fact: parsed.fact };
  } catch { return fallback; }
}
export async function readDiscoveryCards(context: DiscoveryContext, ids: readonly string[], now: number): Promise<ContentItem[]> {
  if (ids.length > 256) throw new Error('Too many discovery ids');
  const cards: ContentItem[] = [];
  for (const id of new Set(ids)) {
    const read = await readDiscoveryFact(context, id, now);
    if (read.status !== 'ok') continue;
    const item = itemFromAsset(read.fact.asset, read.fact.asset.hasCover ? `/proxy/img/${encodeURIComponent(read.fact.asset.workId)}` : undefined);
    item.enabled = true; item.shareable = read.fact.shareable; cards.push(item);
  }
  return cards;
}
/** Withdrawal invalidates an in-flight publisher's lease and emits an explicit metadata-free tombstone. */
export async function withdrawDiscoveryFact(db: D1Database, workId: string, now: number): Promise<boolean> {
  discoveryTime(now);
  if (!isSafeWorkId(workId)) throw new Error('Invalid discovery id');
  const result = await db.batch([
    db.prepare('DELETE FROM discovery_leases WHERE lease_key = ?').bind(`work:${workId}`),
    db.prepare('UPDATE discovery_works SET enabled = 0, updated_at = ? WHERE work_id = ? AND enabled = 1 AND updated_at <= ?')
      .bind(now, workId, now)
  ]);
  return result[1].meta.changes === 1;
}
/** Expiry is itself a withdrawal, not just disappearance from the next query. Call before changes paging. */
export async function expireDiscoveryFacts(db: D1Database, now: number): Promise<number> {
  discoveryTime(now);
  const result = await db.prepare(`UPDATE discovery_works SET enabled = 0, updated_at = ?
    WHERE work_id IN (SELECT work_id FROM discovery_works WHERE enabled = 1 AND expires_at <= ? LIMIT 256)`)
    .bind(now, now).run();
  return result.meta.changes;
}
export interface DiscoveryChange {
  seq: number; workId: string; operation: 'upsert' | 'withdraw'; updatedAt: number; card?: ContentItem;
}
/** Independent append-only sequence, NOT a catalog revision. Same work may appear multiple times. */
export async function readDiscoveryChanges(context: DiscoveryContext, cursor: number, now: number, limit = 60): Promise<
  { changes: DiscoveryChange[]; cursor: number; hasMore: boolean }> {
  discoveryTime(cursor); discoveryTime(now);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid changes limit');
  // limit is an upper bound; smaller pages keep cold-pack verification within the CPU budget.
  limit = Math.min(limit, 10);
  await expireDiscoveryFacts(context.bindings.DB, now);
  const result = await context.bindings.DB.prepare(`SELECT c.seq, c.work_id, c.operation, c.updated_at,
    w.work_id AS current_id, w.provider_id, w.source_id, w.enabled, w.expires_at,
    w.card_json AS fact_card, k.card_json AS discovery_card
    FROM discovery_changes c LEFT JOIN discovery_works w ON w.work_id = c.work_id
    LEFT JOIN discovery_cards k ON k.work_id = c.work_id
    WHERE c.seq > ? ORDER BY c.seq LIMIT ?`).bind(cursor, limit + 1)
    .all<{ seq: number; work_id: string; operation: 'upsert' | 'withdraw'; updated_at: number;
      current_id: string | null; provider_id: string | null; source_id: string | null;
      enabled: number | null; expires_at: number | null; fact_card: string | null; discovery_card: string | null }>();
  const page = result.results.slice(0, limit), changes: DiscoveryChange[] = [];
  const authCache = new Map<string, ReturnType<typeof context.authority>>();
  for (const row of page) {
    if (row.operation === 'withdraw') {
      changes.push({ seq: row.seq, workId: row.work_id, operation: 'withdraw', updatedAt: row.updated_at });
      continue;
    }
    // A historical upsert can never resurrect a now withdrawn/expired/baseline-owned work.
    const identityKey = `${row.work_id}:${row.provider_id ?? ''}:${row.source_id ?? ''}`;
    let baselinePromise = authCache.get(identityKey);
    if (!baselinePromise) {
      baselinePromise = context.authority({ workId: row.work_id, providerId: row.provider_id ?? undefined, sourceId: row.source_id ?? undefined });
      authCache.set(identityKey, baselinePromise);
    }
    const baseline = await baselinePromise;
    const visible = (!baseline.authoritative || eligible(baseline)) &&
      (row.enabled === 1 && row.expires_at! > now || row.current_id === null && row.discovery_card !== null);
    const operation = row.operation === 'upsert' && visible ? 'upsert' : 'withdraw';
    const change: DiscoveryChange = { seq: row.seq, workId: row.work_id, operation, updatedAt: row.updated_at };
    if (operation === 'upsert') change.card = JSON.parse(row.fact_card ?? row.discovery_card!) as ContentItem;
    changes.push(change);
  }
  return { changes, cursor: page.at(-1)?.seq ?? cursor, hasMore: result.results.length > limit };
}
