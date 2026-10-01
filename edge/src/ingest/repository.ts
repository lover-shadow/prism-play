/**
 * All D1 access for the F-14 ingest tables, so the state machine, the publisher and the scheduled run
 * never hand-write SQL against them.
 *
 * Two shapes on purpose: `*Statement` builders compose into one atomic `db.batch`, while readers and
 * read-modify-write helpers are for steps that must observe what a previous statement actually wrote.
 */

export const SOURCE_RECORD_STATUSES = ['received', 'enriched', 'linked', 'published', 'retry', 'rejected'] as const;
export type SourceRecordStatus = (typeof SOURCE_RECORD_STATUSES)[number];

export const LINK_EVIDENCE_VALUES = ['same_source_id', 'trusted_cross_source_map', 'new_work'] as const;
export type LinkEvidence = (typeof LINK_EVIDENCE_VALUES)[number];

export const CATALOG_OPERATIONS = ['upsert', 'delete'] as const;
export type CatalogOperation = (typeof CATALOG_OPERATIONS)[number];

export interface SourceRecordRow {
  id: number;
  provider_id: string;
  source_item_id: string;
  source_revision: string;
  content_id: string | null;
  link_evidence: LinkEvidence | null;
  title: string;
  metadata_json: string;
  status: SourceRecordStatus;
  error_code: string | null;
  attempt_count: number;
  next_attempt_at: number | null;
  updated_at: number;
}

export interface IngestSourceRow {
  provider_id: string;
  enabled: number;
  cursor: string | null;
  last_success_at: number | null;
  updated_at: number;
}

export interface ContentItemRow {
  id: string;
  channel_id: string;
  title: string;
  category: string;
  cover_url: string | null;
  cover_version: string | null;
  synopsis: string | null;
  enabled: number;
  first_published_at: number | null;
}

export interface TrustedMappingRow {
  provider_id: string;
  source_item_id: string;
  content_id: string;
  evidence_ref: string;
}

export interface EpisodeLinkRow {
  source_episode_id: string;
  episode_id: number | null;
}

export interface NewSourceRecord {
  providerId: string;
  sourceItemId: string;
  sourceRevision: string;
  title: string;
  metadataJson: string;
  nowSeconds: number;
}

export interface ContentMetadata {
  contentId: string;
  title: string;
  coverUrl: string | null;
  coverVersion: string | null;
  synopsis: string | null;
  nowSeconds: number;
}

export interface FailureWrite {
  recordId: number;
  status: SourceRecordStatus;
  errorCode: string;
  attemptCount: number;
  nextAttemptAt: number | null;
  nowSeconds: number;
}

const RECORD_COLUMNS =
  'id, provider_id, source_item_id, source_revision, content_id, link_evidence, title, metadata_json, ' +
  'status, error_code, attempt_count, next_attempt_at, updated_at';

const CONTENT_COLUMNS = 'id, channel_id, title, category, cover_url, cover_version, synopsis, enabled, first_published_at';

function toRecord(row: SourceRecordRow): SourceRecordRow {
  return {
    ...row,
    id: Number(row.id),
    attempt_count: Number(row.attempt_count),
    next_attempt_at: row.next_attempt_at === null ? null : Number(row.next_attempt_at),
    updated_at: Number(row.updated_at)
  };
}

export async function listEnabledIngestSources(db: D1Database): Promise<IngestSourceRow[]> {
  const sql = 'SELECT provider_id, enabled, cursor, last_success_at, updated_at FROM ingest_sources WHERE enabled = 1 ORDER BY provider_id';
  return (await db.prepare(sql).all<IngestSourceRow>()).results;
}

/** The channel a provider writes into is configured in `source_providers`, never inferred from a payload. */
export async function readProviderChannelId(db: D1Database, providerId: string): Promise<string | null> {
  const row = await db.prepare('SELECT channel_id FROM source_providers WHERE id = ?').bind(providerId).first<{ channel_id: string }>();
  return row === null ? null : row.channel_id;
}

export async function readSourceRecord(db: D1Database, providerId: string, sourceItemId: string, sourceRevision: string): Promise<SourceRecordRow | null> {
  const sql = `SELECT ${RECORD_COLUMNS} FROM source_records WHERE provider_id = ? AND source_item_id = ? AND source_revision = ?`;
  const row = await db.prepare(sql).bind(providerId, sourceItemId, sourceRevision).first<SourceRecordRow>();
  return row === null ? null : toRecord(row);
}

/**
 * Work list for one provider: rows never processed plus retry rows whose backoff elapsed.
 * `rejected` rows are absent by construction, which is what makes quarantine permanent.
 */
export async function listPendingSourceRecords(db: D1Database, providerId: string, nowSeconds: number, limit: number): Promise<SourceRecordRow[]> {
  const sql =
    `SELECT ${RECORD_COLUMNS} FROM source_records WHERE provider_id = ? ` +
    "AND (status = 'received' OR (status = 'retry' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))) ORDER BY id LIMIT ?";
  return (await db.prepare(sql).bind(providerId, nowSeconds, limit).all<SourceRecordRow>()).results.map(toRecord);
}

/**
 * Idempotency key is `(provider_id, source_item_id, source_revision)`, so repeating a page adds no row.
 * `classification_json` and `model_version` stay NULL by contract (M-5); the source category travels in
 * `metadata_json` until it lands on `content_items.category`.
 */
export function insertSourceRecordStatement(db: D1Database, record: NewSourceRecord): D1PreparedStatement {
  const sql =
    'INSERT INTO source_records (provider_id, source_item_id, source_revision, title, metadata_json, ' +
    "status, classification_json, model_version, attempt_count, updated_at) VALUES (?, ?, ?, ?, ?, 'received', NULL, NULL, 0, ?) " +
    'ON CONFLICT(provider_id, source_item_id, source_revision) DO NOTHING';
  return db
    .prepare(sql)
    .bind(record.providerId, record.sourceItemId, record.sourceRevision, record.title, record.metadataJson, record.nowSeconds);
}

export function markRecordLinkedStatement(db: D1Database, recordId: number, contentId: string, evidence: LinkEvidence, nowSeconds: number): D1PreparedStatement {
  const sql =
    "UPDATE source_records SET status = 'linked', content_id = ?, link_evidence = ?, error_code = NULL, next_attempt_at = NULL, updated_at = ? " +
    'WHERE id = ?';
  return db.prepare(sql).bind(contentId, evidence, nowSeconds, recordId);
}

/** Guarded on `linked` so a record can never skip a lifecycle step. */
export function markRecordPublishedStatement(db: D1Database, recordId: number, nowSeconds: number): D1PreparedStatement {
  const sql = "UPDATE source_records SET status = 'published', updated_at = ? WHERE id = ? AND status = 'linked'";
  return db.prepare(sql).bind(nowSeconds, recordId);
}

export function recordAttemptFailureStatement(db: D1Database, input: FailureWrite): D1PreparedStatement {
  const sql = 'UPDATE source_records SET status = ?, error_code = ?, attempt_count = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?';
  return db.prepare(sql).bind(input.status, input.errorCode, input.attemptCount, input.nextAttemptAt, input.nowSeconds, input.recordId);
}

export function advanceSourceCursorStatement(db: D1Database, providerId: string, cursor: string | null, nowSeconds: number): D1PreparedStatement {
  const sql = 'UPDATE ingest_sources SET cursor = ?, last_success_at = ?, updated_at = ? WHERE provider_id = ? AND enabled = 1';
  return db.prepare(sql).bind(cursor, nowSeconds, nowSeconds, providerId);
}

/** Evidence must be recorded and non-blank; a blank `evidence_ref` is not trusted evidence. */
export async function readTrustedMapping(db: D1Database, providerId: string, sourceItemId: string): Promise<TrustedMappingRow | null> {
  const sql =
    'SELECT provider_id, source_item_id, content_id, evidence_ref FROM trusted_work_mappings ' +
    "WHERE provider_id = ? AND source_item_id = ? AND evidence_ref IS NOT NULL AND trim(evidence_ref) <> ''";
  const row = await db.prepare(sql).bind(providerId, sourceItemId).first<TrustedMappingRow>();
  return row === null ? null : { ...row };
}

/** Same `(provider_id, source_item_id)` on another revision is the strongest identity evidence there is. */
export async function findContentIdForSourceItem(db: D1Database, providerId: string, sourceItemId: string, excludeRecordId: number): Promise<string | null> {
  const sql =
    'SELECT content_id FROM source_records WHERE provider_id = ? AND source_item_id = ? ' +
    'AND content_id IS NOT NULL AND id <> ? ORDER BY id DESC LIMIT 1';
  const row = await db.prepare(sql).bind(providerId, sourceItemId, excludeRecordId).first<{ content_id: string }>();
  return row === null ? null : row.content_id;
}

export async function readContentItem(db: D1Database, contentId: string): Promise<ContentItemRow | null> {
  const row = await db.prepare(`SELECT ${CONTENT_COLUMNS} FROM content_items WHERE id = ?`).bind(contentId).first<ContentItemRow>();
  if (row === null) return null;
  const firstPublished = row.first_published_at === null ? null : Number(row.first_published_at);
  return { ...row, enabled: Number(row.enabled), first_published_at: firstPublished };
}

/**
 * `is_private` and `shareable` derive from `channel_id` alone, which is what the DDL CHECK demands; a
 * provider payload never sets them. New works start `enabled = 0` because raw source records must not
 * become catalogue rows until publish.ts is called explicitly.
 */
export function insertContentItemStatement(db: D1Database, input: ContentMetadata & { channelId: string; category: string }): D1PreparedStatement {
  const sql =
    'INSERT INTO content_items (id, channel_id, title, cover_url, cover_version, synopsis, category, is_private, shareable, enabled, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?) ON CONFLICT(id) DO NOTHING';
  const isPrivate = input.channelId === 'private' ? 1 : 0;
  return db
    .prepare(sql)
    .bind(
      input.contentId, input.channelId, input.title, input.coverUrl, input.coverVersion, input.synopsis,
      input.category, isPrivate, input.nowSeconds, input.nowSeconds
    );
}

export function updateContentItemMetadataStatement(db: D1Database, input: ContentMetadata): D1PreparedStatement {
  const sql = 'UPDATE content_items SET title = ?, cover_url = ?, cover_version = ?, synopsis = ?, updated_at = ? WHERE id = ?';
  return db.prepare(sql).bind(input.title, input.coverUrl, input.coverVersion, input.synopsis, input.nowSeconds, input.contentId);
}

/**
 * Episodes are UNIQUE per `(content_id, episode_number)`. A row is written once and its duration is
 * touched only when the source corrected it, so re-running a page leaves `updated_at` untouched.
 */
export async function ensureContentEpisode(db: D1Database, contentId: string, episodeNumber: number, durationSeconds: number | null, nowSeconds: number): Promise<number> {
  const lookup = 'SELECT id, duration_seconds FROM content_episodes WHERE content_id = ? AND episode_number = ?';
  const existing = await db.prepare(lookup).bind(contentId, episodeNumber).first<{ id: number; duration_seconds: number | null }>();
  if (existing !== null) {
    const episodeId = Number(existing.id);
    const stored = existing.duration_seconds === null ? null : Number(existing.duration_seconds);
    if (durationSeconds !== null && stored !== durationSeconds) {
      const sql = 'UPDATE content_episodes SET duration_seconds = ?, updated_at = ? WHERE id = ?';
      await db.prepare(sql).bind(durationSeconds, nowSeconds, episodeId).run();
    }
    return episodeId;
  }
  const insert = 'INSERT INTO content_episodes (content_id, episode_number, title, duration_seconds, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?)';
  await db.prepare(insert).bind(contentId, episodeNumber, durationSeconds, nowSeconds, nowSeconds).run();
  const created = await db.prepare(lookup).bind(contentId, episodeNumber).first<{ id: number }>();
  if (created === null) throw new Error(`episode row for ${contentId}#${episodeNumber} was not persisted`);
  return Number(created.id);
}

/** Composite PK keeps the source-episode mapping idempotent across re-processing. */
export function linkSourceEpisodeStatement(db: D1Database, sourceRecordId: number, sourceEpisodeId: string, episodeId: number): D1PreparedStatement {
  const sql =
    'INSERT INTO source_episode_links (source_record_id, source_episode_id, episode_id) VALUES (?, ?, ?) ' +
    'ON CONFLICT(source_record_id, source_episode_id) DO UPDATE SET episode_id = excluded.episode_id';
  return db.prepare(sql).bind(sourceRecordId, sourceEpisodeId, episodeId);
}

export async function listSourceEpisodeLinks(db: D1Database, sourceRecordId: number): Promise<EpisodeLinkRow[]> {
  const sql = 'SELECT source_episode_id, episode_id FROM source_episode_links WHERE source_record_id = ? ORDER BY source_episode_id';
  return (await db.prepare(sql).bind(sourceRecordId).all<EpisodeLinkRow>()).results;
}

/**
 * Visibility flip, composed by publish.ts into one batch with the change row below.
 * `first_published_at` is stamped through COALESCE on publish and left alone on unpublish: a NULL stamp
 * cannot overwrite an existing first-public time, and unlisting a never-published work must not fake one.
 * `channel_id <> 'private'` is the storage-side half of the AC-02 isolation.
 */
export function setContentEnabledStatement(db: D1Database, contentId: string, enabled: number, firstPublishedStamp: number | null, nowSeconds: number): D1PreparedStatement {
  const sql =
    'UPDATE content_items SET enabled = ?, first_published_at = COALESCE(first_published_at, ?), updated_at = ? WHERE id = ? ' +
    "AND channel_id <> 'private'";
  return db.prepare(sql).bind(enabled, firstPublishedStamp, nowSeconds, contentId);
}

/**
 * The change row carries an EXISTS guard that re-reads the content row inside the same transaction, so a
 * private work can never obtain a public tombstone even if a caller skips the pre-check, and a vanished
 * content id leaves the batch as a no-op instead of writing a dangling event.
 */
export function insertCatalogChangeStatement(db: D1Database, contentId: string, operation: CatalogOperation, requiredEnabled: number, nowSeconds: number): D1PreparedStatement {
  const sql =
    'INSERT INTO public_catalog_changes (content_id, operation, changed_at) SELECT ?, ?, ? ' +
    "WHERE EXISTS (SELECT 1 FROM content_items WHERE id = ? AND enabled = ? AND channel_id <> 'private')";
  return db.prepare(sql).bind(contentId, operation, nowSeconds, contentId, requiredEnabled);
}

/** Private-catalogue visibility flip: one statement, and by construction never a public change row. */
export function setPrivateEnabledStatement(db: D1Database, contentId: string, enabled: number, nowSeconds: number): D1PreparedStatement {
  const sql = "UPDATE content_items SET enabled = ?, updated_at = ? WHERE id = ? AND channel_id = 'private'";
  return db.prepare(sql).bind(enabled, nowSeconds, contentId);
}
