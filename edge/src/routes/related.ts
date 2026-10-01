/**
 * `GET /api/titles/{titleId}/related` — 同类公开作品推荐 (API-SPEC §八, F-13).
 *
 * Two arms, in contract order: same `content_items.category` first, then works that share a controlled
 * `content_tags` term (ranked by how many tags they share). The source work, private works and
 * unpublished works are excluded, and the whole list is capped by `RELATED_MAX_ITEMS`.
 *
 * Anti-probing (API-SPEC §一.3): an unknown id, a withdrawn id and a private id answer the *same* 404
 * with the same body. This route never authenticates and never accepts a session header, so 个人探索
 * cannot be probed through it at all — a private work is simply "not related to anything public".
 *
 * Cost note: the category arm has no index behind it (`content_items` indexes channel/visibility only,
 * SPEC §6), so it is bounded by LIMIT and must be re-measured on real Cloudflare D1.
 */

import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import { PUBLIC_CHANNEL_IDS, type RelatedResponse } from '../types/api';
import { findContentRow, findContentRowsByIds, isPubliclyVisible, listTagsOfContent } from '../db/content-repo';
import { notFoundResponse } from '../http/errors';
import { jsonResponse } from '../http/json';
import { originOf, toContentItem } from '../http/serialize';
import { publicVisibilityClause } from '../search/correct';

/** Contract does not pin a size; 10 matches the suggestion cap and one card row on the client grid. */
export const RELATED_MAX_ITEMS = 10;

/** Same reason as `/api/search`: a takedown must be invisible on the very next request. */
const RELATED_CACHE_CONTROL = 'no-store';

const RELATED_PATH = /^\/api\/titles\/([^/]+)\/related$/;

function titleIdFromPath(pathname: string): string | null {
  const match = RELATED_PATH.exec(pathname);
  if (match === null) return null;
  try {
    const decoded = decodeURIComponent(match[1] as string).trim();
    // An over-long path segment is not an id worth querying: same 404 as any other unknown work.
    return decoded === '' || decoded.length > 128 ? null : decoded;
  } catch {
    return null;
  }
}

async function idsByCategory(db: D1Database, category: string, excludeId: string): Promise<string[]> {
  const visibility = publicVisibilityClause({});
  const rows = await db
    .prepare(
      `SELECT c.id AS content_id FROM content_items c WHERE c.category = ? AND c.id <> ?${visibility.sql}` +
        ' ORDER BY c.first_published_at DESC, c.id ASC LIMIT ?'
    )
    .bind(category, excludeId, ...visibility.values, RELATED_MAX_ITEMS)
    .all<{ content_id: string }>();
  return rows.results.map((row) => row.content_id);
}

/** Shared-vocabulary arm: the more controlled tags two works share, the closer they are. */
async function idsBySharedTags(db: D1Database, tags: readonly string[], excludeId: string): Promise<string[]> {
  if (tags.length === 0) return [];
  const placeholders = tags.map(() => '?').join(', ');
  const visibility = publicVisibilityClause({});
  const rows = await db
    .prepare(
      `SELECT c.id AS content_id, COUNT(DISTINCT t.tag) AS shared FROM content_tags t ` +
        `JOIN content_items c ON c.id = t.content_id WHERE t.tag IN (${placeholders}) AND t.content_id <> ?${visibility.sql}` +
        ' GROUP BY c.id ORDER BY shared DESC, c.first_published_at DESC, c.id ASC LIMIT ?'
    )
    .bind(...tags, excludeId, ...visibility.values, RELATED_MAX_ITEMS)
    .all<{ content_id: string }>();
  return rows.results.map((row) => row.content_id);
}

export async function handleRelated(request: Request, env: Env, _clock: Clock): Promise<Response> {
  const titleId = titleIdFromPath(new URL(request.url).pathname);
  if (titleId === null) return notFoundResponse();

  const source = await findContentRow(env.DB, titleId);
  const isPublicChannel = source !== null && (PUBLIC_CHANNEL_IDS as readonly string[]).includes(source.channel_id);
  if (source === null || !isPubliclyVisible(source) || !isPublicChannel) {
    // One indistinguishable answer for "unknown", "withdrawn" and "private without admission".
    return notFoundResponse();
  }

  const tags = await listTagsOfContent(env.DB, titleId);
  const categoryIds = await idsByCategory(env.DB, source.category, titleId);
  const tagIds = await idsBySharedTags(env.DB, tags, titleId);
  const ids = [...new Set([...categoryIds, ...tagIds])].slice(0, RELATED_MAX_ITEMS);
  if (ids.length === 0) return jsonResponse({ items: [] } satisfies RelatedResponse, 200, { 'Cache-Control': RELATED_CACHE_CONTROL });

  const rows = await findContentRowsByIds(env.DB, ids);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const origin = originOf(request);
  // `flatMap` rather than `filter`: still-visible rows only, and the arm order survives the lookup.
  const items = ids.flatMap((id) => {
    const row = byId.get(id);
    return row !== undefined && isPubliclyVisible(row) ? [toContentItem(row, { origin })] : [];
  });

  return jsonResponse({ items } satisfies RelatedResponse, 200, { 'Cache-Control': RELATED_CACHE_CONTROL });
}
