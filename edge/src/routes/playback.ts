import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import type { PlaybackInfo } from '../types/api';
import type { ContentRow } from '../db/content-repo';
import { resolvePrivateAccess } from '../core/admission';
import { PLAYBACK_HANDLE_TTL_SECONDS } from '../core/constants';
import { createMediaHandleCodec } from '../core/media-handle';
import { buildProxyUrl, signProxyTarget } from '../core/proxy-signature';
import { findContentRow, findEpisodeRow, findPlaybackCandidate, isPrivateChannel } from '../db/content-repo';
import { buildErrorResponse } from '../http/errors';
import { jsonResponse, noStoreJson } from '../http/json';
import { originOf } from '../http/serialize';

/**
 * `GET /api/episodes/{episodeId}/playback` (API-SPEC §一.4).
 *
 * Exactly one candidate is resolved server-side (`findPlaybackCandidate`: enabled source, healthy
 * provider, lowest Cron latency) and handed back as a single same-origin short-lived proxy URL. Neither
 * the provider id, nor its name, nor the upstream media address may appear in the body: the sealed
 * handle is the only carrier of the target, and it is encrypted.
 *
 * Check order is visibility-first (404) and source-second (503), because an unknown episode must be
 * indistinguishable from a private one that the caller may not see, while 503 is reserved by the
 * contract for "exists, admitted, but no playable source right now".
 * The response is always `no-store`: the body carries a bearer-like signed URL.
 */
export const PLAYBACK_PATH_PATTERN = /^\/api\/episodes\/(\d+)\/playback$/;

/** Only extensions we can name truthfully; anything else omits `mimeType` rather than guessing (openapi optional). */
const MIME_BY_SUFFIX: readonly (readonly [RegExp, string])[] = [
  [/\.m3u8(?:$|[?#])/i, 'application/vnd.apple.mpegurl'],
  [/\.mpd(?:$|[?#])/i, 'application/dash+xml'],
  [/\.mp4(?:$|[?#])/i, 'video/mp4'],
  [/\.ts(?:$|[?#])/i, 'video/mp2t']
];

function mimeTypeOf(targetUrl: string): string | null {
  const found = MIME_BY_SUFFIX.find(([pattern]) => pattern.test(targetUrl));
  return found === undefined ? null : found[1];
}

/**
 * The tier set, the bearer identity and the predicate are composed once in `core/admission.ts`, so no
 * route can pass an empty or hardcoded tier set and quietly dismantle the first AC-02 condition.
 */
async function privateAdmitted(request: Request, env: Env, clock: Clock): Promise<boolean> {
  return (await resolvePrivateAccess(request, env, clock)).granted;
}

function isPrivateRow(row: ContentRow): boolean {
  return row.is_private === 1 || isPrivateChannel(row);
}

function notFound(): Response {
  // Byte-identical to every other 404 here, and no-store like the proxy, so neither body nor header
  // distinguishes "unknown" from "private" from "withdrawn".
  return jsonResponse(buildErrorResponse('NOT_FOUND'), 404, { 'Cache-Control': 'no-store' });
}

export async function handlePlayback(request: Request, env: Env, clock: Clock): Promise<Response> {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
  const matched = PLAYBACK_PATH_PATTERN.exec(new URL(request.url).pathname);
  if (matched === null) return notFound();
  const episodeId = Number(matched[1]);
  if (!Number.isSafeInteger(episodeId) || episodeId <= 0) return notFound();

  const episode = await findEpisodeRow(env.DB, episodeId);
  if (episode === null) return notFound();
  const content = await findContentRow(env.DB, episode.content_id);
  if (content === null || content.enabled !== 1) return notFound();
  if (isPrivateRow(content) && !(await privateAdmitted(request, env, clock))) return notFound();

  const candidate = await findPlaybackCandidate(env.DB, episodeId);
  if (candidate === null) {
    // Contract-pinned: admitted and existing, but every candidate source is unhealthy or disabled.
    return jsonResponse(buildErrorResponse('SERVICE_UNAVAILABLE'), 503, { 'Cache-Control': 'no-store' });
  }

  const codec = await createMediaHandleCodec(env.PROXY_SIGNING_SECRET);
  const sealed = await codec.mint(episodeId, candidate.upstreamMediaUrl);
  const expiresAt = clock.nowSeconds() + PLAYBACK_HANDLE_TTL_SECONDS;
  const signature = await signProxyTarget(env.PROXY_SIGNING_SECRET, 'media', sealed, expiresAt);
  const info: PlaybackInfo = {
    episodeId,
    url: buildProxyUrl(originOf(request), 'media', sealed, { expSeconds: expiresAt, signature }),
    expiresInSeconds: PLAYBACK_HANDLE_TTL_SECONDS
  };
  const mimeType = mimeTypeOf(candidate.upstreamMediaUrl);
  if (mimeType !== null) info.mimeType = mimeType;
  if (episode.duration_seconds !== null) info.durationSeconds = Number(episode.duration_seconds);
  return noStoreJson(info);
}
