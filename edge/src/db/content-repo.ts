import type { ChannelId } from '../types/api';

/**
 * Read-only access to the trusted content catalogue. Nothing here decides visibility policy beyond
 * the `enabled` / `is_private` columns; the private double-admission stays in `core/admission.ts`,
 * so a caller can never accidentally get a second implementation of the gate.
 */

export interface ContentRow {
  id: string;
  channel_id: string;
  title: string;
  cover_url: string | null;
  cover_version: string | null;
  synopsis: string | null;
  category: string;
  is_private: number;
  shareable: number;
  enabled: number;
  first_published_at: number | null;
  updated_at: number;
  episode_count: number | null;
  /** 客观属性（0002 迁移扩列）。测试中可能缺失，故按可选声明并由序列化层兜底为 0。 */
  is_ai?: number;
  is_hot?: number;
  hot_score?: number;
}

export interface EpisodeRow {
  id: number;
  content_id: string;
  episode_number: number;
  title: string | null;
  duration_seconds: number | null;
}

export interface ProviderRow {
  id: string;
  name: string;
  channel_id: string;
  upstream_url: string;
  priority: number;
  latency_ms: number;
  healthy: number;
  last_checked_at: number;
}

export interface PlaybackCandidate {
  episode: EpisodeRow;
  content: ContentRow;
  provider: ProviderRow;
  upstreamMediaUrl: string;
}

const CONTENT_SELECT =
  'SELECT c.id, c.channel_id, c.title, c.cover_url, c.cover_version, c.synopsis, c.category, c.is_private, ' +
  'c.shareable, c.enabled, c.first_published_at, c.updated_at, ' +
  'c.is_ai, c.is_hot, c.hot_score, ' +
  '(SELECT COUNT(*) FROM content_episodes e WHERE e.content_id = c.id) AS episode_count FROM content_items c';

const PRIVATE_CHANNEL_ID: ChannelId = 'private';

function normalizeRow(row: ContentRow): ContentRow {
  return { ...row };
}

export async function findContentRow(db: D1Database, contentId: string): Promise<ContentRow | null> {
  const row = await db.prepare(`${CONTENT_SELECT} WHERE c.id = ?`).bind(contentId).first<ContentRow>();
  return row === null ? null : normalizeRow(row);
}

export function isPubliclyVisible(row: ContentRow): boolean {
  return row.enabled === 1 && row.is_private === 0;
}

export function isPrivateChannel(row: ContentRow): boolean {
  return row.channel_id === PRIVATE_CHANNEL_ID;
}

export interface CatalogQuery {
  channelId: string;
  category?: string;
  offset: number;
  limit: number;
}

/**
 * Public listing: only rows that are both published and non-private. A private channel must be
 * requested through `listPrivateChannelContent`, which the caller may only reach after admission.
 */
export async function listPublicContent(db: D1Database, query: CatalogQuery): Promise<{ rows: ContentRow[]; total: number }> {
  const filter = query.category === undefined || query.category === '' ? '' : ' AND c.category = ?';
  const where = ` WHERE c.channel_id = ? AND c.enabled = 1 AND c.is_private = 0${filter}`;
  const bindValues = query.category === undefined || query.category === ''
    ? [query.channelId]
    : [query.channelId, query.category];

  const counted = await db
    .prepare('SELECT COUNT(*) AS n FROM content_items c' + where)
    .bind(...bindValues)
    .first<{ n: number }>();
  const rows = await db
    .prepare(`${CONTENT_SELECT}${where} ORDER BY c.updated_at DESC, c.id ASC LIMIT ? OFFSET ?`)
    .bind(...bindValues, query.limit, query.offset)
    .all<ContentRow>();
  return { rows: rows.results.map(normalizeRow), total: Number(counted?.n ?? 0) };
}

/** Private-channel listing. Admission MUST already be granted by `evaluatePrivateAdmission`. */
export async function listPrivateChannelContent(
  db: D1Database,
  query: CatalogQuery
): Promise<{ rows: ContentRow[]; total: number }> {
  const filter = query.category === undefined || query.category === '' ? '' : ' AND c.category = ?';
  const where = ` WHERE c.channel_id = 'private' AND c.enabled = 1${filter}`;
  const bindValues =
    query.category === undefined || query.category === '' ? [] : [query.category];

  const counted = await db
    .prepare('SELECT COUNT(*) AS n FROM content_items c' + where)
    .bind(...bindValues)
    .first<{ n: number }>();
  const rows = await db
    .prepare(`${CONTENT_SELECT}${where} ORDER BY c.updated_at DESC, c.id ASC LIMIT ? OFFSET ?`)
    .bind(...bindValues, query.limit, query.offset)
    .all<ContentRow>();
  return { rows: rows.results.map(normalizeRow), total: Number(counted?.n ?? 0) };
}

/** Used by the incremental change feed to rebuild an `upsert` payload from the current row. */
export async function findContentRowsByIds(db: D1Database, ids: readonly string[]): Promise<ContentRow[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await db
    .prepare(`${CONTENT_SELECT} WHERE c.id IN (${placeholders})`)
    .bind(...ids)
    .all<ContentRow>();
  return rows.results.map(normalizeRow);
}

export async function listEpisodeRows(db: D1Database, contentId: string): Promise<EpisodeRow[]> {
  const rows = await db
    .prepare(
      'SELECT id, content_id, episode_number, title, duration_seconds FROM content_episodes ' +
        'WHERE content_id = ? ORDER BY episode_number ASC'
    )
    .bind(contentId)
    .all<EpisodeRow>();
  return rows.results;
}

export async function findEpisodeByNumber(
  db: D1Database,
  contentId: string,
  episodeNumber: number
): Promise<EpisodeRow | null> {
  const row = await db
    .prepare(
      'SELECT id, content_id, episode_number, title, duration_seconds FROM content_episodes ' +
        'WHERE content_id = ? AND episode_number = ?'
    )
    .bind(contentId, episodeNumber)
    .first<EpisodeRow>();
  return row === null ? null : row;
}

export async function findEpisodeRow(db: D1Database, episodeId: number): Promise<EpisodeRow | null> {
  const row = await db
    .prepare('SELECT id, content_id, episode_number, title, duration_seconds FROM content_episodes WHERE id = ?')
    .bind(episodeId)
    .first<EpisodeRow>();
  return row === null ? null : row;
}

/**
 * Server-side source pick (API-SPEC §一.4): the caller gets exactly one candidate, ordered by the
 * Cron-measured latency and then priority, and only from a provider that is healthy, enabled and
 * whose channel matches the content. The upstream URL never leaves this layer except through the
 * proxy, which re-checks visibility per request.
 */
export async function findPlaybackCandidate(db: D1Database, episodeId: number): Promise<PlaybackCandidate | null> {
  const row = await db
    .prepare(
      'SELECT es.upstream_media_url AS upstream_media_url, e.id AS episode_id, ' +
        'p.id AS provider_id ' +
        'FROM episode_sources es ' +
        'JOIN content_episodes e ON e.id = es.episode_id ' +
        'JOIN source_providers p ON p.id = es.provider_id ' +
        'WHERE es.episode_id = ? AND es.enabled = 1 AND p.healthy = 1 ' +
        'ORDER BY p.latency_ms ASC, p.priority ASC LIMIT 1'
    )
    .bind(episodeId)
    .first<{ upstream_media_url: string; episode_id: number; provider_id: string }>();
  if (row === null) return null;

  const episode = await findEpisodeRow(db, Number(row.episode_id));
  if (episode === null) return null;
  const content = await findContentRow(db, episode.content_id);
  if (content === null) return null;
  const provider = await findProviderRow(db, row.provider_id);
  if (provider === null) return null;

  return { episode, content, provider, upstreamMediaUrl: row.upstream_media_url };
}

export async function findProviderRow(db: D1Database, providerId: string): Promise<ProviderRow | null> {
  return await db
    .prepare(
      'SELECT id, name, channel_id, upstream_url, priority, latency_ms, healthy, last_checked_at FROM source_providers WHERE id = ?'
    )
    .bind(providerId)
    .first<ProviderRow>();
}

export async function listProvidersForChannel(db: D1Database, channelId: string): Promise<ProviderRow[]> {
  const rows = await db
    .prepare(
      'SELECT id, name, channel_id, upstream_url, priority, latency_ms, healthy, last_checked_at FROM source_providers ' +
        'WHERE channel_id = ? ORDER BY healthy DESC, latency_ms ASC, priority ASC'
    )
    .bind(channelId)
    .all<ProviderRow>();
  return rows.results;
}

/** Origins that the proxy may ever contact; the whitelist is D1 configuration, never the request. */
export async function listAllowedUpstreamOrigins(db: D1Database): Promise<Set<string>> {
  const rows = await db
    .prepare('SELECT DISTINCT upstream_url FROM source_providers WHERE healthy = 1')
    .all<{ upstream_url: string }>();
  const origins = new Set<string>();
  for (const row of rows.results) {
    try {
      origins.add(new URL(row.upstream_url).origin);
    } catch {
      // A malformed configured URL cannot widen the whitelist; it is simply not a usable origin.
    }
  }
  return origins;
}

/** Current public revision: the newest allocated revision, 0 when the log is empty. */
export async function readPublicRevision(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT MAX(revision) AS revision FROM public_catalog_changes').first<{ revision: number | null }>();
  if (row === null || row.revision === null || row.revision === undefined) return 0;
  return Number(row.revision);
}

export async function listTagsOfContent(db: D1Database, contentId: string): Promise<string[]> {
  const rows = await db.prepare('SELECT tag FROM content_tags WHERE content_id = ? ORDER BY tag ASC').bind(contentId).all<{ tag: string }>();
  return rows.results.map((row) => row.tag);
}
