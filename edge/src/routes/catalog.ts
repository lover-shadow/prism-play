import type { CatalogResponse, ContentItem } from '../types/api';
import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import { PRIVATE_SESSION_HEADER, resolvePrivateAccess } from '../core/admission';
import { CATALOG_DEFAULT_PAGE_SIZE, CATALOG_MAX_PAGE_SIZE, PRIVATE_SESSION_TTL_SECONDS } from '../core/constants';
import { isChannelId } from '../core/validation';
import { listPrivateChannelContent, listPublicContent, readPublicRevision } from '../db/content-repo';
import { PRIVATE_CHANNEL_ID } from '../db/channel-repo';
import { buildErrorResponse, errorResponseNoStore } from '../http/errors';
import { jsonResponse, noStoreJson } from '../http/json';
import { originOf, signedCoverProxyUrl, toContentItem } from '../http/serialize';

/**
 * `GET /api/catalog` — paged title cards for one channel (SPEC §5, openapi `/api/catalog`).
 *
 * The public revision is read **before** the rows on purpose. If a publish lands in between, the page
 * already reflects it while the reported revision predates it, so the client replays one change it has
 * applied already — idempotent. The opposite order would report a revision newer than the rows and the
 * client would skip a change permanently, which is why this ordering is load-bearing and not stylistic.
 */

/** Short TTL for public pages only; every private or denied answer is `no-store`. */
const PUBLIC_CATALOG_CACHE_SECONDS = 60;

/** Two credentials decide this body, so a shared cache must never merge the outcomes (AC-02-3). */
const CATALOG_VARY = `Authorization, ${PRIVATE_SESSION_HEADER}`;

/*
 * openapi.yaml's 409 for this endpoint declares no body, and no member of the closed
 * `ErrorResponse.code` enum means "revision conflict". The status alone carries the whole contract
 * instruction (re-pull a snapshot), so nothing outside the ratified enum goes on the wire.
 */

/**
 * One implementation of the anti-probing 404, reused by `/api/titles/{id}` and `/api/sources`, so the
 * bytes of "does not exist" and "exists but you are not admitted" cannot drift apart between routes.
 * Same body as `notFoundResponse()` by construction (`buildErrorResponse`), plus `no-store`.
 */
export function undifferentiatedNotFound(): Response {
  return jsonResponse(buildErrorResponse('NOT_FOUND'), 404, { 'Cache-Control': 'no-store' });
}

function parsePage(raw: string | null): number {
  if (raw === null || !/^\d+$/.test(raw)) return 1;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
}

/**
 * A `pageSize` above the ceiling is clamped rather than rejected (openapi caps it at 50, and a client
 * asking for more is asking for the same page, not for an error); garbage falls back to the default.
 */
function parsePageSize(raw: string | null): number {
  if (raw === null || !/^\d+$/.test(raw)) return CATALOG_DEFAULT_PAGE_SIZE;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return CATALOG_DEFAULT_PAGE_SIZE;
  return Math.min(parsed, CATALOG_MAX_PAGE_SIZE);
}

/** An unparseable `revision` is treated as absent: garbage must never be able to force a 409 storm. */
function parseRevision(raw: string | null): number | null {
  if (raw === null || !/^-?\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function publicCatalogResponse(body: CatalogResponse): Response {
  return jsonResponse(body, 200, {
    'Cache-Control': `public, max-age=${PUBLIC_CATALOG_CACHE_SECONDS}`,
    Vary: CATALOG_VARY
  });
}

function revisionConflictResponse(): Response {
  // Deliberately no catalogue data: the only correct client move is to re-pull a snapshot.
  return errorResponseNoStore('CATALOG_REVISION_CONFLICT');
}

export async function handleCatalog(request: Request, env: Env, clock: Clock): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const channel = params.get('channel');

  // 404 rather than 400 for a missing or unknown channel: a 400 would confirm which channel ids the
  // catalogue knows, while 404 is the same answer an unknown resource gets everywhere else (AC-02-3).
  if (!isChannelId(channel)) return undifferentiatedNotFound();

  const category = params.get('category') ?? undefined;
  const page = parsePage(params.get('page'));
  const pageSize = parsePageSize(params.get('pageSize'));
  const offset = (page - 1) * pageSize;
  const origin = originOf(request);
  const revision = await readPublicRevision(env.DB);
  const requestedRevision = parseRevision(params.get('revision'));

  if (channel === PRIVATE_CHANNEL_ID) {
    return await handlePrivateCatalog(request, env, clock, { category, page, pageSize, offset, origin, revision });
  }

  // A stale cursor on a later page means the snapshot the client is walking is no longer coherent.
  if (requestedRevision !== null && requestedRevision !== revision) return revisionConflictResponse();

  const { rows, total } = await listPublicContent(env.DB, { channelId: channel, category, offset, limit: pageSize });
  const body: CatalogResponse = {
    items: rows.map((row) => toContentItem(row, { origin })),
    page,
    pageSize,
    total,
    revision
  };
  return publicCatalogResponse(body);
}

interface PrivatePageContext {
  category: string | undefined;
  page: number;
  pageSize: number;
  offset: number;
  origin: string;
  revision: number;
}

/**
 * `channel=private` is admitted by the single private predicate and nothing else. The public revision
 * is echoed unchanged in the body because it is exactly what its schema says it is — the private page
 * simply never participates in it: private rows do not enter `public_catalog_changes` (SPEC §6).
 */
async function handlePrivateCatalog(
  request: Request,
  env: Env,
  clock: Clock,
  context: PrivatePageContext
): Promise<Response> {
  const access = await resolvePrivateAccess(request, env, clock);
  if (!access.granted || access.session === null) return undifferentiatedNotFound();

  const { rows, total } = await listPrivateChannelContent(env.DB, { channelId: PRIVATE_CHANNEL_ID, category: context.category, offset: context.offset, limit: context.pageSize });

  const now = clock.nowSeconds();
  // Session-bound: the signature itself carries only (kind, handle, exp), so the binding this layer can
  // express is "never outlives the credential that produced it"; `/proxy` still re-checks per request.
  const ttl = Math.max(1, Math.min(PRIVATE_SESSION_TTL_SECONDS, access.session.exp - now));
  const items: ContentItem[] = [];
  for (const row of rows) {
    const hasCover = row.cover_url !== null && row.cover_url !== '';
    const coverUrl = hasCover ? await signedCoverProxyUrl(context.origin, env.PROXY_SIGNING_SECRET, row.id, now, ttl) : undefined;
    items.push(toContentItem(row, { origin: context.origin, coverUrl }));
  }

  const body: CatalogResponse = { items, page: context.page, pageSize: context.pageSize, total, revision: context.revision };
  return noStoreJson(body);
}
