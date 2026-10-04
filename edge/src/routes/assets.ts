/**
 * `GET /assets/{file}` - the same-origin static surface (SPEC-STATIC-PAGES v2 S-3).
 *
 * Why this exists: the share page has to be able to start an HLS stream on a Chromium host, and the
 * only engine that does that is hls.js. Pulling it from a public CDN is not an option for a page whose
 * main battlefield is the WeChat WebView, where third-party CDNs are intermittently unreachable - so
 * the same file is served from our own origin (v2 §1.2-4). The portal's hero render is served the same
 * way for the same reason: a landing page that has to reach a phone in WeChat does not get to depend
 * on somebody else's image host.
 *
 * Where the bytes come from: R2. `tests/scan_p0.py` and SPEC 8 keep a 620KB vendor bundle out of the
 * repository, and CI uploads the build-time copy to the same bucket the APK already lives in under
 * `assets/hls.min.js`; the two hero crops are tracked next to the Worker for the same job. No bucket,
 * or no object, is a 404 - this route never fabricates a script from an embedded fallback, because a
 * stale inline copy of a decoder is exactly the thing that cannot be revoked once `immutable` has been
 * cached by a client.
 *
 * What is servable is a closed table, not a directory listing: a path that resolves outside it is a
 * 404 before the bucket is touched, so this handler cannot be turned into an R2 reader by guessing.
 *
 * Caching: `public, max-age=31536000, immutable`. That is only strictly safe while the URL is
 * content-addressed, so both filename forms are accepted (`hls.min.js` and `hls.<hash>.min.js`) and
 * they map to the one object CI publishes: to replace the engine without waiting for CDN expiry,
 * upload it and flip `HLS_SCRIPT_PATH` in `html/share-page.ts` to the hashed form - one line, and the
 * share page picks it up on its next 60s-cached render.
 */

import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import type { ApkDeliveryBindings } from './dl';
import { HLS_SCRIPT_PATH } from '../html/share-page';
import { buildErrorResponse, HTTP_STATUS_BY_ERROR_CODE } from '../http/errors';
import { jsonResponse } from '../http/json';

export type AssetEnv = Env & ApkDeliveryBindings;

/**
 * The share page owns the public path - it is the only document that references it, and
 * `edge/src/html/**` must not import from `routes/**` - so the bucket key is derived from it here and
 * the two can never drift apart.
 */
export const HLS_R2_KEY = HLS_SCRIPT_PATH.slice(1);
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const ASSET_PREFIX = '/assets/';
/** Optional `.<hex>` content tag: every name below is safe to cache forever, and taggable to revoke. */
const HASH_TAG = '(?:\\.[0-9a-f]{6,64})?';

/** Closed set of servable objects: name pattern -> the one bucket key and type it resolves to. */
const ASSET_TABLE: readonly { readonly pattern: RegExp; readonly key: (name: string) => string; readonly contentType: string }[] = [
  {
    // Both `hls.min.js` and `hls.<hash>.min.js` map to the single object CI publishes.
    pattern: new RegExp(`^hls${HASH_TAG}\\.min\\.js$`),
    key: () => HLS_R2_KEY,
    contentType: 'application/javascript; charset=utf-8'
  },
  {
    // The portal hero render; the public name is the bucket key, so each crop is its own object.
    pattern: new RegExp(`^hero-showcase-(?:768|1280)${HASH_TAG}\\.webp$`),
    key: (name) => `${ASSET_PREFIX.slice(1)}${name}`,
    contentType: 'image/webp'
  },
  {
    // The pre-packaged library bundles for instant client seed and one-shot download.
    pattern: new RegExp(`^(?:library\\.db|catalog-bundle\\.json)${HASH_TAG}\\.gz$`),
    key: (name) => `${ASSET_PREFIX.slice(1)}${name}`,
    contentType: 'application/gzip'
  },
  {
    // Uncompressed JSON bundle for direct fetch by web or clients.
    pattern: new RegExp(`^catalog-bundle${HASH_TAG}\\.json$`),
    key: (name) => `${ASSET_PREFIX.slice(1)}${name}`,
    contentType: 'application/json; charset=utf-8'
  }
];

/** The one bucket key and response type a public path resolves to, or `null` for anything else. */
export function assetTargetFrom(pathname: string): { key: string; contentType: string } | null {
  if (!pathname.startsWith(ASSET_PREFIX)) return null;
  const raw = pathname.slice(ASSET_PREFIX.length);
  if (raw === '' || raw.includes('/')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  for (const asset of ASSET_TABLE) {
    if (asset.pattern.test(decoded)) return { key: asset.key(decoded), contentType: asset.contentType };
  }
  return null;
}

function assetNotFound(): Response {
  return jsonResponse(buildErrorResponse('NOT_FOUND'), HTTP_STATUS_BY_ERROR_CODE.NOT_FOUND, {
    'Cache-Control': 'no-store'
  });
}

export async function handleStaticAsset(
  request: Request,
  env: AssetEnv,
  _clock: Clock
): Promise<Response> {
  const { pathname } = new URL(request.url);
  const target = assetTargetFrom(pathname);
  if (target === null) return assetNotFound();
  const bucket = env.APK_BUCKET;
  if (bucket === undefined) return assetNotFound();

  const object = await bucket.get(target.key);
  if (object === null || object === undefined) return assetNotFound();
  const body = (object as { body?: ReadableStream }).body;
  if (body === undefined || body === null) return assetNotFound();

  const headers: Record<string, string> = {
    'Content-Type': target.contentType,
    'Cache-Control': /(?:library\.db|catalog-bundle(?:\.[0-9a-f]+)?\.json)/.test(target.key)
      ? 'public, max-age=0, must-revalidate' : IMMUTABLE_CACHE_CONTROL,
    // Sniffing a script is the whole point of serving it, so say what it is and mean it.
    'X-Content-Type-Options': 'nosniff',
    Vary: 'Accept-Encoding'
  };
  if (typeof object.etag === 'string' && object.etag !== '') headers.ETag = `W/"${object.etag}"`;
  return new Response(body as ReadableStream, { status: 200, headers });
}
