import type { ContentItem, TitleDetail } from '../types/api';
import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import type { PrivateSessionPayload } from '../auth/private-session';
import { PRIVATE_SESSION_HEADER, resolvePrivateAccess } from '../core/admission';
import { PRIVATE_SESSION_TTL_SECONDS } from '../core/constants';
import { findContentRow, isPrivateChannel, listEpisodeRows } from '../db/content-repo';
import { PRIVATE_CHANNEL_ID } from '../db/channel-repo';
import { jsonResponse, noStoreJson } from '../http/json';
import { originOf, signedCoverProxyUrl, toContentItem, toEpisodeItem } from '../http/serialize';
import { undifferentiatedNotFound } from './catalog';

/**
 * `GET /api/titles/{titleId}` — detail plus the episode list (API-SPEC §一.3, openapi `TitleDetail`).
 *
 * Unknown id, unpublished (`enabled != 1`) row and a private row the caller is not admitted to all
 * answer through the same `undifferentiatedNotFound()` bytes as `/api/catalog`, so the endpoint cannot
 * be used to enumerate the catalogue or to confirm that a private id exists (AC-02-3, §12.1 item 4).
 */

const PUBLIC_TITLE_CACHE_SECONDS = 60;

const TITLE_PATH_PREFIX = '/api/titles/';

/**
 * Ids are `d_…`-style opaque strings. Anything else — an empty segment, a percent-encoded `/`, or the
 * `/related` sub-resource another Stage 2 work owns — is answered as "does not exist" here instead of
 * round-tripping a value the catalogue can never hold.
 */
const TITLE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

function titleIdFrom(pathname: string): string | null {
  if (!pathname.startsWith(TITLE_PATH_PREFIX)) return null;
  const tail = pathname.slice(TITLE_PATH_PREFIX.length).replace(/\/+$/, '');
  if (tail === '') return null;
  try {
    const decoded = decodeURIComponent(tail);
    return TITLE_ID_PATTERN.test(decoded) ? decoded : null;
  } catch {
    // A malformed percent-escape is a bad path, not a bad credential.
    return null;
  }
}

/** The system's single private predicate, reached only for a row that actually is private. */
async function admitPrivate(request: Request, env: Env, clock: Clock): Promise<PrivateSessionPayload | null> {
  const access = await resolvePrivateAccess(request, env, clock);
  return access.session;
}

function publicTitleResponse(body: TitleDetail): Response {
  return jsonResponse(body, 200, {
    'Cache-Control': `public, max-age=${PUBLIC_TITLE_CACHE_SECONDS}`,
    Vary: `Authorization, ${PRIVATE_SESSION_HEADER}`
  });
}

export async function handleTitles(request: Request, env: Env, clock: Clock): Promise<Response> {
  const { pathname } = new URL(request.url);
  const titleId = titleIdFrom(pathname);
  if (titleId === null) return undifferentiatedNotFound();

  const row = await findContentRow(env.DB, titleId);
  if (row === null) return undifferentiatedNotFound();

  const isPrivate = row.is_private === 1 || isPrivateChannel(row) || row.channel_id === PRIVATE_CHANNEL_ID;
  const session = isPrivate ? await admitPrivate(request, env, clock) : null;
  if (isPrivate && session === null) return undifferentiatedNotFound();
  // Checked after the gate, so a delisted private work and an unknown id share one byte sequence.
  if (row.enabled !== 1) return undifferentiatedNotFound();

  const origin = originOf(request);
  const now = clock.nowSeconds();
  let coverUrl: string | undefined;
  if (isPrivate && session !== null && row.cover_url !== null && row.cover_url !== '') {
    // Session-bound: the signature carries only (kind, handle, exp), so what this layer can guarantee is
    // that the URL never outlives the credential that made it readable; `/proxy` re-checks per fetch.
    const ttl = Math.max(1, Math.min(PRIVATE_SESSION_TTL_SECONDS, session.exp - now));
    coverUrl = await signedCoverProxyUrl(origin, env.PROXY_SIGNING_SECRET, row.id, now, ttl);
  }

  const item: ContentItem = toContentItem(row, { origin, coverUrl });
  const episodes = (await listEpisodeRows(env.DB, row.id)).map(toEpisodeItem);
  const body: TitleDetail = { item, episodes };

  return isPrivate ? noStoreJson(body) : publicTitleResponse(body);
}
