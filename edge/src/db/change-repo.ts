import type { CatalogChange, CatalogChangesResponse } from '../types/api';
import { CHANGES_RETENTION_SECONDS } from '../core/constants';
import { findContentRowsByIds, isPrivateChannel, isPubliclyVisible, type ContentRow } from './content-repo';
import { toContentItem } from '../http/serialize';

/**
 * Read side of the public incremental catalogue (`public_catalog_changes`) — SPEC §6, API-SPEC §八.
 *
 * Three invariants live here because they are protocol, not presentation:
 *  1. private content and private tombstones are filtered **in SQL**, so a row that was written to
 *     the public log by mistake can never be read back through this endpoint;
 *  2. an `upsert` payload is rebuilt from the **current** `content_items` row, never from the log,
 *     so a stale log entry can never serve superseded or unlistable metadata;
 *  3. the page cursor is the last returned revision — never `after + 1` — and an empty page repeats
 *     `after` (API-SPEC §八 「客户端不自行加 1」).
 */

export interface CatalogChangeRow {
  revision: number;
  content_id: string;
  operation: string;
  changed_at: number;
}

/**
 * `LEFT JOIN` on purpose: a change row whose content row is gone still has to be delivered, degraded
 * to a tombstone, because "remove it" is the client's only correct end state for such a row.
 * The private predicate keeps NULL rows (missing content) but drops any row whose content is private.
 */
const PUBLIC_CHANGE_FILTER = " AND (c.id IS NULL OR (c.channel_id <> 'private' AND c.is_private = 0))";

function normalizeRow(row: CatalogChangeRow): CatalogChangeRow {
  return {
    revision: Number(row.revision),
    content_id: String(row.content_id),
    operation: String(row.operation),
    changed_at: Number(row.changed_at)
  };
}

/** One extra row answers `hasMore` without a second COUNT pass over the log. */
export async function listPublicChangeRowsAfter(
  db: D1Database,
  after: number,
  fetchLimit: number
): Promise<CatalogChangeRow[]> {
  const result = await db
    .prepare(
      'SELECT ch.revision, ch.content_id, ch.operation, ch.changed_at FROM public_catalog_changes ch ' +
        'LEFT JOIN content_items c ON c.id = ch.content_id' +
        ` WHERE ch.revision > ?${PUBLIC_CHANGE_FILTER} ORDER BY ch.revision ASC LIMIT ?`
    )
    .bind(after, fetchLimit)
    .all<CatalogChangeRow>();
  return result.results.map(normalizeRow);
}

/**
 * Retention rule: the revision this cursor still needs that has already aged out of the replay window,
 * or `null` when the replay from `after` is complete.
 *
 * This is deliberately NOT the simpler "`after` below `MIN(revision)` of the retained rows" formulation.
 * That one 410s every fresh client: the first revision is `1`, so a cursor of `0` is always below the
 * floor even when the whole log is retained, and a brand-new device could never sync without a 410
 * round-trip. What actually matters is whether a row *this client still needs* is expired — holes never
 * are, because a hole holds no row at all (API-SPEC §八 「revision 可有数字空洞，不得当作缺页」).
 * Rows below the window that the client has already passed are likewise ignored, so a client that is
 * merely old but not blind keeps resyncing until the pruned rows really are in front of it.
 */
export async function readExpiredNeededRevision(db: D1Database, after: number, nowSeconds: number): Promise<number | null> {
  const cutoff = Math.trunc(nowSeconds - CHANGES_RETENTION_SECONDS);
  const row = await db
    .prepare(
      'SELECT ch.revision FROM public_catalog_changes ch LEFT JOIN content_items c ON c.id = ch.content_id' +
        ` WHERE ch.revision > ? AND ch.changed_at < ?${PUBLIC_CHANGE_FILTER} ORDER BY ch.revision ASC LIMIT 1`
    )
    .bind(after, cutoff)
    .first<{ revision: number }>();
  if (row === null || row.revision === null || row.revision === undefined) return null;
  return Number(row.revision);
}

function deleteTombstone(row: CatalogChangeRow): CatalogChange {
  // Exactly three keys: an unknown-but-deleted work must not leak a single field of its metadata.
  return { revision: row.revision, contentId: row.content_id, operation: 'delete' };
}

/**
 * An `upsert` whose current row is gone, unpublished or private degrades to a delete tombstone.
 * Judgement call, and the only leak-free option: emitting the stored metadata would serve content the
 * catalogue no longer publishes, while dropping the row would leave stale clients stale forever.
 * Any operation string outside the D1 CHECK set degrades to a tombstone too — fail closed.
 */
export function toCatalogChange(row: CatalogChangeRow, byId: Map<string, ContentRow>, origin: string): CatalogChange {
  if (row.operation !== 'upsert') return deleteTombstone(row);
  const content = byId.get(row.content_id);
  if (content === undefined || !isPubliclyVisible(content) || isPrivateChannel(content)) return deleteTombstone(row);
  return { revision: row.revision, contentId: row.content_id, operation: 'upsert', item: toContentItem(content, { origin }) };
}

/** One replayable page of the public change feed. `limit` is already validated by the route. */
export async function readChangePage(
  db: D1Database,
  after: number,
  limit: number,
  origin: string
): Promise<CatalogChangesResponse> {
  const rows = await listPublicChangeRowsAfter(db, after, limit + 1);
  const hasMore = rows.length > limit;
  const visible = hasMore ? rows.slice(0, limit) : rows;
  const upsertIds = visible.filter((row) => row.operation === 'upsert').map((row) => row.content_id);

  // One batched read for the whole page: the log stores no payload, so every upsert is rebuilt here.
  const byId = new Map<string, ContentRow>();
  for (const content of await findContentRowsByIds(db, upsertIds)) byId.set(content.id, content);

  const last = visible[visible.length - 1];
  return {
    changes: visible.map((row) => toCatalogChange(row, byId, origin)),
    nextRevision: last === undefined ? after : last.revision,
    hasMore
  };
}
