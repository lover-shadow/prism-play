/**
 * `GET /dl`, `GET /dl/latest/{platform}` and `GET /` - the only download funnel in the system.
 *
 * The landing page branches on the User-Agent alone (API-SPEC 五.2): WeChat gets the compliant
 * "open in a browser" guidance, Android gets a real download card, Windows and everything else get an
 * honest statement that this release ships Android only. There is no PC package this period, so there
 * is no PC link, and `/dl/latest/pc` answers 404 like any other non-android platform (openapi enum is
 * `[android]`).
 *
 * `GET /` (SPEC-STATIC-PAGES v2 S-4) is the official portal and is deliberately UA-blind: one
 * responsive document for every visitor, whose device matrix states the published version and size
 * rather than a link per platform. It answers 200 where it used to answer 404.
 *
 * `?ref=` is display-only attribution. It is dropped when the visitor is redirected to the artifact,
 * because a browser download does not carry a URL parameter into the installed app and no reward can
 * be settled from it (SPEC 6 invitation_logs).
 *
 * The redirect target is never invented: it is built from the operator-configured public base and
 * only after `head()` confirms the object exists. No bucket, no base, no object => 404.
 */

import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import { configUnavailableResponse, readVersionRelease } from '../config/kv-config';
import { buildErrorResponse, HTTP_STATUS_BY_ERROR_CODE } from '../http/errors';
import { jsonResponse } from '../http/json';
import { originOf } from '../http/serialize';
import { renderDownloadPage, type DownloadAudience } from '../html/dl-page';
import { renderLandingPage } from '../html/landing-page';
import { sanitizeDisplayToken } from '../html/escape';

/**
 * Env already declares `APK_BUCKET` (optional). `APK_PUBLIC_BASE_URL` is NOT in
 * `edge/src/types/env.ts` and that file is frozen for me, so the R2 public domain is read through
 * this local narrow type instead. Reported to the Chief Builder: it should become a declared optional
 * string in Env plus a wrangler `[vars]` entry, provisioned by the supervision agent.
 */
export interface ApkDeliveryBindings {
  APK_BUCKET?: R2Bucket;
  APK_PUBLIC_BASE_URL?: string;
}

export type DlEnv = Env & ApkDeliveryBindings;

/** Release key convention for the Android artifact; owned by the supervision agent's R2 provisioning. */
export const ANDROID_PLATFORM = 'android';

/** Denials stay `no-store`: a 404 that becomes a 302 the next minute must not be cached at the edge. */
export function downloadNotFoundResponse(): Response {
  return jsonResponse(buildErrorResponse('NOT_FOUND'), HTTP_STATUS_BY_ERROR_CODE.NOT_FOUND, {
    'Cache-Control': 'no-store'
  });
}

/**
 * WeChat is checked before Android on purpose: WeChat on an Android phone still runs the embedded
 * WebView, and that visitor needs the guidance page, not a link the WebView cannot download.
 */
export function detectAudience(userAgent: string | null): DownloadAudience {
  const ua = userAgent ?? '';
  if (/micromessenger/i.test(ua)) return 'wechat';
  if (/android/i.test(ua)) return 'android';
  if (/windows\snt|win32|win64|wow64|msie|trident/i.test(ua)) return 'windows';
  return 'other';
}

/** Landing page is identical for everyone in the same UA bucket, but UA decides it, so it must Vary. */
const LANDING_CACHE_CONTROL = 'public, max-age=300';

export async function handleDownloadLanding(
  request: Request,
  _env: Env,
  _clock: Clock
): Promise<Response> {
  const url = new URL(request.url);
  const audience = detectAudience(request.headers.get('User-Agent'));
  const html = renderDownloadPage(audience, {
    ref: sanitizeDisplayToken(url.searchParams.get('ref')),
    origin: url.origin
  });
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': LANDING_CACHE_CONTROL,
      Vary: 'User-Agent',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export function platformFromPath(pathname: string): string | null {
  const prefix = '/dl/latest/';
  if (!pathname.startsWith(prefix)) return null;
  const raw = pathname.slice(prefix.length);
  if (raw === '' || raw.includes('/')) return null;
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return null;
  }
}

async function releaseObject(env: DlEnv, release: import("../types/api").AndroidRelease): Promise<R2Object | null> {
  if (!env.APK_BUCKET || !release.artifact) return null;
  const object = await env.APK_BUCKET.head(release.artifact.key), metadata = object?.customMetadata;
  return object && object.size === release.artifact.bytes && metadata?.sha256 === release.artifact.sha256 &&
    metadata.versionCode === String(release.versionCode) && metadata.versionName === release.versionName ? object : null;
}
export async function handleApkDownload(request: Request, env: DlEnv, _clock: Clock): Promise<Response> {
  if (platformFromPath(new URL(request.url).pathname) !== ANDROID_PLATFORM) return downloadNotFoundResponse();
  const origin = originOf(request), published = await readVersionRelease(env.KV, origin);
  if (!published?.android.artifact || !await releaseObject(env, published.android)) return configUnavailableResponse();
  const release = published.android;
  return new Response(null, { status: 302, headers: {
    Location: `${origin}/dl/artifacts/${release.versionCode}/${release.artifact!.sha256}.apk`, "Cache-Control": "no-store"
  } });
}

/** One document for every visitor, so unlike `/dl` this response does not Vary on User-Agent. */
const PORTAL_CACHE_CONTROL = 'public, max-age=300';

export async function handlePortal(request: Request, env: DlEnv, _clock: Clock): Promise<Response> {
  const published = await readVersionRelease(env.KV, originOf(request));
  const object = published ? await releaseObject(env, published.android) : null;
  return new Response(renderLandingPage({
    release: published ? { versionName: published.android.versionName, versionCode: published.android.versionCode } : null,
    apkSizeBytes: object?.size ?? null
  }), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": PORTAL_CACHE_CONTROL, "X-Content-Type-Options": "nosniff" } });
}
export async function handleApkArtifact(request: Request, env: DlEnv, _clock: Clock): Promise<Response> {
  const match = /^\/dl\/artifacts\/([1-9]\d*)\/([0-9a-f]{64})\.apk$/.exec(new URL(request.url).pathname);
  if (!match || !Number.isSafeInteger(Number(match[1]))) return downloadNotFoundResponse();
  if (!env.APK_BUCKET) return configUnavailableResponse();
  const key = `releases/android/${match[1]}/${match[2]}.apk`;
  const headers = { "Content-Type": "application/vnd.android.package-archive",
    "Content-Disposition": `attachment; filename=prism-play-${match[1]}.apk`, "Accept-Ranges": "none",
    "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" };
  if (request.method === "HEAD") {
    const object = await env.APK_BUCKET.head(key);
    return object ? new Response(null, { headers: { ...headers, "Content-Length": String(object.size) } }) : downloadNotFoundResponse();
  }
  const object = await env.APK_BUCKET.get(key);
  if (!object) return downloadNotFoundResponse();
  return new Response(object.body, { headers: { ...headers, "Content-Length": String(object.size) } });
}
