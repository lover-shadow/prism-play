import type { ContentItem } from '../types/api';
import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import { PRIVATE_SESSION_HEADER, resolvePrivateAccess } from '../core/admission';
import { PRIVATE_SESSION_TTL_SECONDS } from '../core/constants';
import { configUnavailableResponse } from '../config/kv-config';
import { PRIVATE_CHANNEL_ID } from '../db/channel-repo';
import { isChannelId } from '../core/validation';
import { buildErrorResponse, errorResponseNoStore } from '../http/errors';
import { jsonResponse, noStoreJson } from '../http/json';
import { originOf, signedCoverProxyUrl } from '../http/serialize';
import { emptyShardResponse, filterShardByCategory, readShardAt, shardResponse } from '../library/chunk';
import { FIRST_SCREEN_CACHE_SECONDS, publicMaxAgeHeaders, readFromEdgeCache, writeToEdgeCache } from '../library/edge-cache';
import type { CatalogManifest } from '../library/manifest';
import { CATALOG_PAGE_SIZE, inventoryOf, readPrivateManifest, readPublicManifest } from '../library/manifest';
import { chunkKey, privateChunkKey } from '../library/paths';

/**
 * `GET /api/catalog` — one R2 directory shard, pointed at by one KV manifest (§C-3, SPEC §3.1).
 *
 * The route no longer plans a query: `catalog:manifest` gives the revision and the per-channel shard
 * inventory, `page = N` maps to `library/v{revision}/{channel}/chunk-(N-1)`, and a validated shard
 * leaves the edge byte-for-byte as CI wrote it. That is what makes AC-C3-1 (`/api/catalog` costs zero
 * D1 row reads) true rather than aspirational, and it replaces the v1 "fall back to D1" hatch, which
 * C-5 forbids: a fallback reader would keep every deprecated table warm forever and quietly undo the
 * whole fuse-line fix.
 *
 * The manifest is read before the shard on purpose, and the shard must agree with it: a publish that
 * lands in between leaves the reported revision newer than the page, so the client replays one change
 * it has already applied — idempotent. The opposite order would report a revision older than the page
 * and the client would skip a change permanently, which is why this ordering is load-bearing.
 */

/** Short TTL for non-first pages; every private or denied answer stays `no-store`. */
const PUBLIC_CATALOG_CACHE_SECONDS = 60;

/** Two credentials decide private bodies, so a shared cache must never merge the outcomes (AC-02-3). */
const CATALOG_VARY = `Authorization, ${PRIVATE_SESSION_HEADER}`;

/*
 * openapi.yaml's 409 for this endpoint declares no body, and no member of the closed
 * `ErrorResponse.code` enum means "revision conflict". The status alone carries the whole contract
 * instruction (re-pull a snapshot), so nothing outside the ratified enum goes on the wire.
 */

/**
 * One implementation of the anti-probing 404, reused by `/api/titles/{id}` and `/api/sources`, so the
 * bytes of "does not exist" and "exists but you are not admitted" cannot drift apart between routes.
 */
export function undifferentiatedNotFound(): Response {
  return jsonResponse(buildErrorResponse('NOT_FOUND'), 404, { 'Cache-Control': 'no-store' });
}

function parsePage(raw: string | null): number {
  if (raw === null || !/^\d+$/.test(raw)) return 1;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : 1;
}

/** An unparseable `revision` is treated as absent: garbage must never be able to force a 409 storm. */
function parseRevision(raw: string | null): number | null {
  if (raw === null || !/^-?\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function revisionConflictResponse(): Response {
  // Deliberately no catalogue data: the only correct client move is to re-pull a snapshot.
  return errorResponseNoStore('CATALOG_REVISION_CONFLICT');
}

/**
 * An asset the manifest promises but the bucket cannot produce is an integrity failure, not an empty
 * page: 503 says "the publish is half-done", while an empty page would tell every client that the
 * channel went quiet and let the catalogues on every device silently rot.
 */
function assetIntegrityFailure(context: string, detail: string): Response {
  console.error('catalog asset integrity failure', context, detail);
  return configUnavailableResponse();
}

function publicPageHeaders(page: number): Record<string, string> {
  // §C-3-1: only the first screen is written into the edge cache, and only at 300s.
  return publicMaxAgeHeaders(page === 1 ? FIRST_SCREEN_CACHE_SECONDS : PUBLIC_CATALOG_CACHE_SECONDS, CATALOG_VARY);
}

async function publicCatalogPage(
  request: Request,
  manifest: CatalogManifest,
  bucket: R2Bucket,
  channelId: string,
  page: number,
  category: string | undefined,
  origin: string
): Promise<Response> {
  if (page === 1) {
    const cached = await readFromEdgeCache(request);
    if (cached !== null) return cached;
  }
  const inventory = inventoryOf(manifest, channelId);
  if (page - 1 >= inventory.chunks) {
    return jsonResponse(emptyShardResponse(manifest, channelId, page), 200, publicPageHeaders(page));
  }
  const key = chunkKey(manifest.revision, channelId, page - 1);
  const read = await readShardAt(bucket, key, manifest.revision, origin);
  if (read.status !== 'ok') {
    return assetIntegrityFailure(key, read.status === 'rejected' ? read.reason : 'absent');
  }
  const headers = publicPageHeaders(page);
  if (category !== undefined && category !== '') {
    // §3.1 shards carry no category index, so the filter narrows the served page and the paging fields
    // stay the shard's own; the client still walks every page and therefore loses no match.
    return jsonResponse(filterShardByCategory(read.shard, category), 200, headers);
  }
  const response = shardResponse(read.shard, headers);
  if (page === 1) await writeToEdgeCache(request, response);
  return response;
}

export async function handleCatalog(request: Request, env: Env, clock: Clock): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const channel = params.get('channel');

  // 404 rather than 400 for a missing or unknown channel: a 400 would confirm which channel ids the
  // catalogue knows, while 404 is the same answer an unknown resource gets everywhere else (AC-02-3).
  if (!isChannelId(channel)) return undifferentiatedNotFound();

  const page = parsePage(params.get('page'));
  const category = params.get('category') ?? undefined;
  const origin = originOf(request);
  const bucket = env.APK_BUCKET;
  if (bucket === undefined) return configUnavailableResponse();

  if (channel === PRIVATE_CHANNEL_ID) {
    return await handlePrivateCatalog(request, env, clock, { page, category, origin, bucket });
  }

  const manifest = await readPublicManifest(env.KV);
  if (manifest === null) return configUnavailableResponse();

  // A stale cursor on a later page means the snapshot the client is walking is no longer coherent.
  const requestedRevision = parseRevision(params.get('revision'));
  if (requestedRevision !== null && requestedRevision !== manifest.revision) return revisionConflictResponse();

  return await publicCatalogPage(request, manifest, bucket, channel, page, category, origin);
}

interface PrivatePageContext {
  page: number;
  category: string | undefined;
  origin: string;
  bucket: R2Bucket;
}

/**
 * `channel=private` is admitted by the single private predicate and nothing else.
 *
 * §C-2b publishes private *episode manifests* only — 私密频道不做批量目录下发 — so the honest answer for
 * a directory request today is an empty page for an admitted caller (never a 404, which would make the
 * feature indistinguishable from broken, and never D1, which C-5 stops). The key grammar is already
 * defined (`privateChunkKey`), so the moment the pipeline ships private shards this route serves them
 * without a contract change, with every cover re-signed against the caller's own session.
 */
async function handlePrivateCatalog(
  request: Request,
  env: Env,
  clock: Clock,
  context: PrivatePageContext
): Promise<Response> {
  const access = await resolvePrivateAccess(request, env, clock);
  if (!access.granted || access.session === null) return undifferentiatedNotFound();

  const manifest = await readPrivateManifest(env.KV);
  if (manifest === null) {
    return noStoreJson({ items: [], page: context.page, pageSize: CATALOG_PAGE_SIZE, total: 0, revision: 0 });
  }
  if (context.page - 1 >= inventoryOf(manifest, PRIVATE_CHANNEL_ID).chunks) {
    return noStoreJson(emptyShardResponse(manifest, PRIVATE_CHANNEL_ID, context.page));
  }

  const key = privateChunkKey(manifest.revision, context.page - 1);
  const read = await readShardAt(context.bucket, key, manifest.revision, context.origin, 'private');
  // §C-2b publishes no private directory, and the private manifest's `chunks` counts episode manifests,
  // not shards — so an absent private shard is "no directory", answered as the empty page the pipeline
  // actually produces. A shard that *is* there but fails §3.1 is a broken publish and stays a 503.
  if (read.status === 'absent') {
    return noStoreJson(emptyShardResponse({ ...manifest, channels: {} }, PRIVATE_CHANNEL_ID, context.page));
  }
  if (read.status === 'rejected') {
    return assetIntegrityFailure(key, read.reason);
  }

  const now = clock.nowSeconds();
  // Session-bound: the signature itself carries only (kind, handle, exp), so the binding this layer can
  // express is "never outlives the credential that produced it"; `/proxy` still re-checks per request.
  const ttl = Math.max(1, Math.min(PRIVATE_SESSION_TTL_SECONDS, access.session.exp - now));
  const items: ContentItem[] = [];
  for (const item of read.shard.items) {
    if (context.category !== undefined && context.category !== '' && item.category !== context.category) continue;
    const card: ContentItem = { ...item };
    if (item.coverUrl !== undefined && item.coverUrl !== '') {
      card.coverUrl = await signedCoverProxyUrl(context.origin, env.PROXY_SIGNING_SECRET, item.id, now, ttl);
    } else {
      delete card.coverUrl;
    }
    items.push(card);
  }
  return noStoreJson({
    items,
    page: read.shard.page,
    pageSize: read.shard.pageSize,
    total: read.shard.total,
    revision: read.shard.revision
  });
}
