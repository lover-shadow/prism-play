/**
 * `GET /s/{drama_id}` - the anonymous single-episode share surface.
 *
 * Denial rules (SPEC 5 /s/:drama_id, AC-02-6, API-SPEC 五.1 404 铁律):
 *   unknown id | enabled != 1 | shareable != 1 | private  ->  the byte-identical NOT_FOUND response.
 * `shareable` is a deliberate extra gate on top of `enabled`: the DDL defaults it to 0, so publishing
 * a work and allowing it to be shared are two separate operator acts. Without this gate a share link
 * would turn any public-but-unshareable row into a metadata oracle (title, episode list, playable
 * source) purely by guessing an id.
 *
 * Private rows can never be shared at all (DDL CHECK forces is_private=1 => shareable=0), and they
 * answer with the same 404 bytes as an unknown id, so a probe cannot tell the causes apart.
 *
 * Caching decision:
 *   - 200 (a shareable public work): `public, max-age=60`. The document is identical for every
 *     visitor, and 60s keeps a takedown or a source flip visible quickly;
 *   - every denial and the no-source state: `no-store`. Because all four denial causes share one
 *     response, private paths are `no-store` by construction rather than by a special case.
 */

import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import { PLAYBACK_HANDLE_TTL_SECONDS, SHARE_DEFAULT_EPISODE } from '../core/constants';
import { createMediaHandleCodec } from '../core/media-handle';
import { buildProxyUrl, signProxyTarget } from '../core/proxy-signature';
import {
  findContentRow,
  findEpisodeByNumber,
  findPlaybackCandidate,
  isPrivateChannel,
  isPubliclyVisible
} from '../db/content-repo';
import type { ContentRow, EpisodeRow, PlaybackCandidate } from '../db/content-repo';
import { HTTP_STATUS_BY_ERROR_CODE, buildErrorResponse } from '../http/errors';
import { jsonResponse } from '../http/json';
import { originOf } from '../http/serialize';
import { HLS_MIME_TYPE, renderSharePage } from '../html/share-page';
import { sanitizeDisplayToken } from '../html/escape';

/** The signed window for a share page equals the playback handle TTL; the proxy re-checks D1 anyway. */
const SHARE_CACHE_CONTROL = 'public, max-age=60';
const MAX_DRAMA_ID_LENGTH = 120;

/**
 * One 404 shape for all four denial causes. The body is byte-identical to `notFoundResponse()`; only
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

/** HLS-first platform: an `.m3u8` target is declared as HLS, everything else as the mp4 fallback. */
function guessMimeType(targetUrl: string): string {
  let pathname = targetUrl;
  try {
    pathname = new URL(targetUrl).pathname;
  } catch {
    // A relative configured target keeps its own text; the extension check still applies.
  }
  return pathname.includes('.m3u8') ? HLS_MIME_TYPE : 'video/mp4';
}

async function mintSealedMediaUrl(
  env: Env,
  origin: string,
  episodeId: number,
  upstreamMediaUrl: string,
  nowSeconds: number
): Promise<string> {
  const codec = await createMediaHandleCodec(env.PROXY_SIGNING_SECRET);
  const handle = await codec.mint(episodeId, upstreamMediaUrl);
  const exp = nowSeconds + PLAYBACK_HANDLE_TTL_SECONDS;
  const signature = await signProxyTarget(env.PROXY_SIGNING_SECRET, 'media', handle, exp);
  // Same-origin by construction (origin comes from the incoming request), and the payload behind the
  // handle is AES-GCM sealed, so the upstream host is absent from the document by design.
  return buildProxyUrl(origin, 'media', handle, { expSeconds: exp, signature });
}

/** `shareable` is an explicit operator act; `enabled` alone is not enough to expose a share link. */
function isShareable(row: ContentRow): boolean {
  return isPubliclyVisible(row) && row.shareable === 1 && !isPrivateChannel(row);
}

interface ShareEpisode {
  readonly row: ContentRow;
  readonly episode: EpisodeRow;
  readonly candidate: PlaybackCandidate | null;
}

/**
 * Resolution order is fixed so that every denial exits through the same response: row visibility
 * first, then the requested episode, then the source pick. `candidate === null` is NOT a denial: the
 * work is public and shareable, only the media is momentarily unavailable.
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
  const candidate = await findPlaybackCandidate(db, episode.id);
  return { row, episode, candidate };
}

export async function handleShare(request: Request, env: Env, clock: Clock): Promise<Response> {
  const url = new URL(request.url);
  const dramaId = dramaIdFromPath(url.pathname);
  const episodeNumber = dramaId === null ? null : parseRequestedEpisode(url.searchParams.get('ep'));
  if (dramaId === null || episodeNumber === null) return shareNotFoundResponse();

  const resolved = await resolveShareableEpisode(env.DB, dramaId, episodeNumber);
  if (resolved === null) return shareNotFoundResponse();

  // `?ref=` is display-only attribution: a URL parameter cannot survive the APK install, so it is
  // never treated as a settled invite and never reaches invitation_logs from this route.
  const ref = sanitizeDisplayToken(url.searchParams.get('ref'));
  const origin = originOf(request);
  const pageInput = {
    dramaId: resolved.row.id,
    title: resolved.row.title,
    episodeNumber: resolved.episode.episode_number,
    episodeTitle: resolved.episode.title,
    durationSeconds: resolved.episode.duration_seconds,
    ref
  };

  if (resolved.candidate === null) {
    // No healthy candidate: 503 like `/api/episodes/{id}/playback` (API-SPEC 一.4 候选穷尽返回 503), but
    // rendered as the same HTML document so a browser visitor sees an honest state instead of JSON.
    // The work itself is public and shareable, so nothing private is disclosed by the title here.
    return htmlResponse(
      renderSharePage({ ...pageInput, mediaUrl: null }),
      'no-store',
      HTTP_STATUS_BY_ERROR_CODE.SERVICE_UNAVAILABLE
    );
  }

  const mediaUrl = await mintSealedMediaUrl(
    env,
    origin,
    resolved.episode.id,
    resolved.candidate.upstreamMediaUrl,
    clock.nowSeconds()
  );
  return htmlResponse(
    renderSharePage({
      ...pageInput,
      mediaUrl,
      mimeType: guessMimeType(resolved.candidate.upstreamMediaUrl)
    }),
    SHARE_CACHE_CONTROL
  );
}
