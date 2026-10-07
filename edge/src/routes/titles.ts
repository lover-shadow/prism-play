import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import type { PrivateSessionPayload } from '../auth/private-session';
import { PRIVATE_SESSION_HEADER, resolvePrivateAccess } from '../core/admission';
import { PRIVATE_SESSION_TTL_SECONDS } from '../core/constants';
import { configUnavailableResponse } from '../config/kv-config';
import { jsonResponse, noStoreJson } from '../http/json';
import { originOf, publicCoverProxyUrl, signedCoverProxyUrl } from '../http/serialize';
import type { TitleAsset, TitleRead } from '../library/title-asset';
import { readTitleAt, titleAssetResponse } from '../library/title-asset';
import { readPrivateManifest, readPublicManifest } from '../library/manifest';
import { publicDiscoveryContext, readPublicFact } from '../search/public-facts';
import { readDiscoveryConfig } from '../search/discovery-config';
import { resolveCardDetail } from '../search/discovery-cards';
import { isKeySafeWorkId, privateTitleKey, stablePrivateTitleKey, stableTitleKey, titleKey } from '../library/paths';
import { findTitleAssetFromDb } from '../db/content-repo';
import { undifferentiatedNotFound } from './catalog';

/**
 * `GET /api/titles/{titleId}` — the R2 episode manifest for one work (§C-3b, SPEC §3.2).
 *
 * The route no longer joins `content_items` to `content_episodes`: it follows the public manifest to
 * `library/v{revision}/titles/{id}.json`, and only if that misses does it knock on the private door.
 * That ordering is the whole anti-probing story (AC-C3b-2): an id that is not public is answered with
 * the same `undifferentiatedNotFound()` bytes as any unknown id, so probing for a 个人探索 work costs the
 * caller exactly one R2 read and yields nothing distinguishable — and the private object is never even
 * fetched without a granted double admission.
 *
 * Unknown id, a delisted work, a private work the caller is not admitted to, and a private asset that
 * somehow sits under the public prefix all collapse into that one byte sequence (§12.1 item 4).
 */

/**
 * §C-3b-1 pins the public manifest at a day of CDN freshness. The honest cost of that is a takedown
 * window: a work withdrawn by the next CI pass stays playable from a warm CDN edge until the object ages
 * out, because the URL carries no revision. Delisting inside the hour is therefore a KV-manifest job
 * (the directory stops listing it at once), not a detail-page one.
 */
const PUBLIC_TITLE_CACHE_SECONDS = 86_400;

const TITLE_PATH_PREFIX = '/api/titles/';

/**
 * Ids are `d…`-style opaque strings. Anything else — an empty segment, a percent-encoded `/`, or the
 * `/related` sub-resource another Stage 2 work owns — is answered as "does not exist" here instead of
 * round-tripping a value the catalogue can never hold.
 */
const TITLE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** Two credentials decide a private body, so a shared cache must never merge the outcomes (AC-02-3). */
const TITLE_VARY = `Authorization, ${PRIVATE_SESSION_HEADER}`;

function titleIdFrom(pathname: string): string | null {
  if (!pathname.startsWith(TITLE_PATH_PREFIX)) return null;
  const tail = pathname.slice(TITLE_PATH_PREFIX.length).replace(/\/+$/, '');
  if (tail === '') return null;
  try {
    const decoded = decodeURIComponent(tail);
    return TITLE_ID_PATTERN.test(decoded) && isKeySafeWorkId(decoded) ? decoded : null;
  } catch {
    // A malformed percent-escape is a bad path, not a bad credential.
    return null;
  }
}

async function admittedSession(request: Request, env: Env, clock: Clock): Promise<PrivateSessionPayload | null> {
  const access = await resolvePrivateAccess(request, env, clock);
  return access.granted ? access.session : null;
}

function publicTitleResponse(body: unknown): Response {
  return jsonResponse(body, 200, {
    'Cache-Control': `public, max-age=${PUBLIC_TITLE_CACHE_SECONDS}`,
    Vary: TITLE_VARY
  });
}

/** A stored object that fails §3.2 under a manifest pointer is a broken publish, not a missing work. */
function assetIntegrityFailure(context: string, reason: string): Response {
  console.error('title asset integrity failure', context, reason);
  return configUnavailableResponse();
}

/**
 * Versioned key first, revision-free stable alias second (the contract CI spells in
 * `config-sources.mjs`). A bootstrap ships every title once under the stable key; a daily run also
 * writes the versioned copy for the titles it touched, so the versioned read wins whenever it exists.
 * `rejected` never falls through: a corrupt versioned asset is an integrity failure, and quietly
 * serving a different stable copy would hide it.
 */
async function readTitleWithFallback(
  bucket: R2Bucket, versionedKey: string, stableKey: string, workId: string
): Promise<TitleRead> {
  const versioned = await readTitleAt(bucket, versionedKey, workId);
  if (versioned.status !== 'absent') return versioned;
  return await readTitleAt(bucket, stableKey, workId);
}

async function servePrivateTitle(
  request: Request,
  env: Env,
  clock: Clock,
  bucket: R2Bucket,
  titleId: string,
  origin: string
): Promise<Response> {
  const session = await admittedSession(request, env, clock);
  if (session === null) return undifferentiatedNotFound();

  const manifest = await readPrivateManifest(env.KV);
  if (manifest === null) return undifferentiatedNotFound();

  const key = privateTitleKey(manifest.revision, titleId);
  const read = await readTitleWithFallback(bucket, key, stablePrivateTitleKey(titleId), titleId);
  if (read.status === 'absent') return undifferentiatedNotFound();
  if (read.status === 'rejected') return assetIntegrityFailure(key, read.reason);

  const now = clock.nowSeconds();
  let coverUrl: string | undefined;
  if (read.asset.hasCover) {
    // Session-bound: the signature carries only (kind, handle, exp), so what this layer can guarantee is
    // that the URL never outlives the credential that made it readable; `/proxy` re-checks per fetch.
    const ttl = Math.max(1, Math.min(PRIVATE_SESSION_TTL_SECONDS, session.exp - now));
    coverUrl = await signedCoverProxyUrl(origin, env.PROXY_SIGNING_SECRET, titleId, now, ttl);
  }
  return noStoreJson(titleAssetResponse(read.asset, coverUrl));
}

export async function handleTitles(request: Request, env: Env, clock: Clock): Promise<Response> {
  const { pathname } = new URL(request.url);
  const titleId = titleIdFrom(pathname);
  if (titleId === null) return undifferentiatedNotFound();

  const bucket = env.APK_BUCKET;
  if (bucket === undefined) return configUnavailableResponse();
  const origin = originOf(request);

  const manifest = await readPublicManifest(env.KV);
  if (manifest === null) return configUnavailableResponse();

  if (manifest.workFacts !== undefined) {
    const read = await readPublicFact(env, manifest, titleId, clock.nowSeconds());
    if (read.status === 'rejected') return configUnavailableResponse();
    if (read.status === 'ok') return publicTitleResponse(titleAssetResponse(read.fact.asset, read.fact.asset.hasCover ? publicCoverProxyUrl(origin, titleId) : undefined));
  } else {
    const publicRead = await readTitleWithFallback(bucket, titleKey(manifest.revision, titleId), stableTitleKey(titleId), titleId);
    if (publicRead.status === 'ok') {
      if (publicRead.asset.isPrivate) {
        console.error('private title stored under the public prefix', titleId);
      } else {
        const asset: TitleAsset = publicRead.asset;
        return publicTitleResponse(titleAssetResponse(asset, asset.hasCover ? publicCoverProxyUrl(origin, titleId) : undefined));
      }
    } else if (publicRead.status === 'rejected') {
      return assetIntegrityFailure(titleKey(manifest.revision, titleId), publicRead.reason);
    }
  }

  if (env.SEARCH_DISCOVERY_ENABLED === 'true' && env.DISCOVERY_BUCKET) {
    try {
      const context = publicDiscoveryContext(env, manifest, () => clock.nowSeconds());
      const serverConfig = readDiscoveryConfig(env);
      const onDemandAsset = await resolveCardDetail(context, titleId, serverConfig.providers);
      if (onDemandAsset) {
        return publicTitleResponse(titleAssetResponse(onDemandAsset, onDemandAsset.hasCover ? publicCoverProxyUrl(origin, titleId) : undefined));
      }
    } catch {
      console.error('[titles] on-demand detail resolution failed');
      return configUnavailableResponse();
    }
  }

  if (manifest.workFacts === undefined && env.DB !== undefined) {
    const d1Asset = await findTitleAssetFromDb(env.DB, titleId, clock.nowSeconds());
    if (d1Asset !== null && !d1Asset.isPrivate) {
      return publicTitleResponse(titleAssetResponse(d1Asset, d1Asset.hasCover ? publicCoverProxyUrl(origin, titleId) : undefined));
    }
  }

  return await servePrivateTitle(request, env, clock, bucket, titleId, origin);
}
