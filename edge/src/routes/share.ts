/**
 * `GET /s/{drama_id}` - the anonymous single-episode share surface.
 *
 * Denial rules (SPEC 5 /s/:drama_id, AC-02-6, API-SPEC 五.1 404 铁律, AC-S1-3):
 *   unknown id | enabled != 1 | shareable != 1 | private | missing/illegal `?ep=`
 *     ->  the byte-identical NOT_FOUND response.
 * `shareable` is a deliberate extra gate on top of `enabled`: the DDL defaults it to 0, so publishing
 * a work and allowing it to be shared are two separate operator acts. Without this gate a share link
 * would turn any public-but-unshareable row into a metadata oracle (title, episode list, playable
 * source) purely by guessing an id.
 *
 * A malformed `?ep=` is a 404 and never a fallback to episode 1: the URL, the client 断点 and the
 * manifest all key on the SAME episode, so silently rewriting it would break the one promise a share
 * link makes.
 *
 * What this route no longer does (SPEC-STATIC-PAGES v2 §1.2):
 *   - it reads no playback source. `episode_sources` is retired (Track 2 C-5), so the document is
 *     rendered from the row plus the requested episode number, and the player script fetches the
 *     media address from `/api/titles/{workId}` at run time (v2 §2.1). Consequence: the page carries
 *     no media URL of any kind, sealed or otherwise, and there is no server-side "no source" state to
 *     answer 503 for - an unavailable line is now a client-side card;
 *   - it mints no `/proxy/media` handle. The stream goes to the CDN directly; the reason the upstream
 *     host still never appears in the document is that the document simply does not name a URL.
 *
 * Caching decision:
 *   - 200 (a shareable public work): `public, max-age=60`. The document is identical for every
 *     visitor, and 60s keeps a takedown visible quickly;
 *   - every denial: `no-store`, so a cached denial can never outlive an operator's takedown. Because
 *     all denial causes share one response, private paths are `no-store` by construction.
 */

import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import { SHARE_DEFAULT_EPISODE } from '../core/constants';
import { findContentRow, findEpisodeByNumber, isPrivateChannel, isPubliclyVisible } from '../db/content-repo';
import type { ContentRow, EpisodeRow } from '../db/content-repo';
import { HTTP_STATUS_BY_ERROR_CODE, buildErrorResponse } from '../http/errors';
import { jsonResponse } from '../http/json';
import { renderSharePage } from '../html/share-page';
import { sanitizeDisplayToken } from '../html/escape';

/** The document is public and short-lived: a takedown must be visible within a minute. */
const SHARE_CACHE_CONTROL = 'public, max-age=60';
const MAX_DRAMA_ID_LENGTH = 120;

/**
 * One 404 shape for all denial causes. The body is byte-identical to `notFoundResponse()`; only
 * `Cache-Control: no-store` is added, so a cached denial can never outlive an operator's takedown.
 */
export function shareNotFoundResponse(): Response {
  return jsonResponse(buildErrorResponse('NOT_FOUND'), HTTP_STATUS_BY_ERROR_CODE.NOT_FOUND, {
    'Cache-Control': 'no-store'
  });
}

export function dramaIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith('/s/')) return null;
  const encoded = pathname.slice('/s/'.length);
  if (encoded === '' || encoded.includes('/')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  if (decoded === '' || decoded.length > MAX_DRAMA_ID_LENGTH) return null;
  // Control characters and separators have no place in a content id and would only muddy logs.
  if (/[\u0000-\u001F\u007F\\]/.test(decoded)) return null;
  return decoded;
}

/**
 * `?ep=` is 1..999999 as a decimal integer; anything else answers 404 like a missing episode.
 * A malformed episode number must not become a second response shape, and falling back to episode 1
 * would silently break the contract that the URL, the client and the 断点 all key on the SAME episode.
 */
export function parseRequestedEpisode(raw: string | null): number | null {
  if (raw === null) return SHARE_DEFAULT_EPISODE;
  if (!/^\d{1,6}$/.test(raw)) return null;
  const parsed = Number(raw);
  return parsed >= 1 && Number.isSafeInteger(parsed) ? parsed : null;
}

function htmlResponse(body: string, cacheControl: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': cacheControl }
  });
}

/** `shareable` is an explicit operator act; `enabled` alone is not enough to expose a share link. */
function isShareable(row: ContentRow): boolean {
  return isPubliclyVisible(row) && row.shareable === 1 && !isPrivateChannel(row);
}

interface ShareEpisode {
  readonly row: ContentRow;
  readonly episode: EpisodeRow;
}

/**
 * Resolution order is fixed so that every denial exits through the same response: row visibility
 * first, then the requested episode. A missing row, an unpublished row, a private row and an episode
 * that does not exist are one byte sequence, so a probe cannot tell the causes apart.
 */
async function resolveShareableEpisode(
  db: D1Database,
  dramaId: string,
  episodeNumber: number
): Promise<ShareEpisode | null> {
  const row = await findContentRow(db, dramaId);
  if (row === null || !isShareable(row)) return null;
  const episode = await findEpisodeByNumber(db, row.id, episodeNumber);
  if (episode === null) return null;
  return { row, episode };
}

export async function handleShare(request: Request, env: Env, _clock: Clock): Promise<Response> {
  const url = new URL(request.url);
  const dramaId = dramaIdFromPath(url.pathname);
  const episodeNumber = dramaId === null ? null : parseRequestedEpisode(url.searchParams.get('ep'));
  if (dramaId === null || episodeNumber === null) return shareNotFoundResponse();

  const resolved = await resolveShareableEpisode(env.DB, dramaId, episodeNumber);
  if (resolved === null) return shareNotFoundResponse();

  // `?ref=` is display-only attribution: a URL parameter cannot survive the APK install, so it is
  // never treated as a settled invite and never reaches invitation_logs from this route.
  const ref = sanitizeDisplayToken(url.searchParams.get('ref'));
  return htmlResponse(
    renderSharePage({
      dramaId: resolved.row.id,
      title: resolved.row.title,
      episodeNumber: resolved.episode.episode_number,
      episodeTitle: resolved.episode.title,
      durationSeconds: resolved.episode.duration_seconds,
      ref
    }),
    SHARE_CACHE_CONTROL
  );
}
