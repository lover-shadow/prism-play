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
import { readVersionRelease } from '../config/kv-config';
import { buildErrorResponse, HTTP_STATUS_BY_ERROR_CODE } from '../http/errors';
import { jsonResponse } from '../http/json';
import { originOf } from '../http/serialize';
import { renderDownloadPage, type DownloadAudience } from '../html/dl-page';
import { renderLandingPage, type LandingRelease } from '../html/landing-page';
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
export const ANDROID_APK_KEY = 'releases/android/latest.apk';
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

/**
 * The only public base we will redirect to: an absolute http(s) origin with no credentials, no query
 * and no fragment. Anything else is treated as unconfigured, because a malformed base is how a
 * redirect to an unverified host would start.
 */
export function resolveApkLocation(rawBase: string | undefined): string | null {
  if (rawBase === undefined || rawBase.trim() === '') return null;
  let base: URL;
  try {
    base = new URL(rawBase.trim());
  } catch {
    return null;
  }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') return null;
  if (base.username !== '' || base.password !== '') return null;
  if (base.search !== '' || base.hash !== '') return null;
  const location = new URL(ANDROID_APK_KEY, `${base.origin}${base.pathname.replace(/\/+$/, '')}/`);
  return location.origin === base.origin ? location.toString() : null;
}

async function artifactExists(bucket: R2Bucket | undefined): Promise<boolean> {
  if (bucket === undefined) return false;
  const object = await bucket.head(ANDROID_APK_KEY);
  return object !== null && object !== undefined;
}

export async function handleApkDownload(
  request: Request,
  env: DlEnv,
  _clock: Clock
): Promise<Response> {
  const platform = platformFromPath(new URL(request.url).pathname);
  if (platform !== ANDROID_PLATFORM) return downloadNotFoundResponse();

  const location = resolveApkLocation(env.APK_PUBLIC_BASE_URL);
  if (location === null) return downloadNotFoundResponse();
  if (!(await artifactExists(env.APK_BUCKET))) return downloadNotFoundResponse();

  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store' }
  });
}

/**
 * The portal states two facts it can actually verify: the published version (KV bulletin, the same
 * source `/api/version` answers from) and the byte length of the object in the bucket. Either may be
 * absent, and the page then says so instead of printing a number nobody configured (SPEC 10).
 */
async function publishedRelease(kv: KVNamespace, origin: string): Promise<LandingRelease | null> {
  const response = await readVersionRelease(kv, origin);
  if (response === null) return null;
  return { versionName: response.android.versionName, versionCode: response.android.versionCode };
}

async function publishedApkSizeBytes(bucket: R2Bucket | undefined): Promise<number | null> {
  if (bucket === undefined) return null;
  const object = await bucket.head(ANDROID_APK_KEY);
  if (object === null || object === undefined) return null;
  const size = (object as { size?: unknown }).size;
  return typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : null;
}

/** One document for every visitor, so unlike `/dl` this response does not Vary on User-Agent. */
const PORTAL_CACHE_CONTROL = 'public, max-age=300';

export async function handlePortal(request: Request, env: DlEnv, _clock: Clock): Promise<Response> {
  const origin = originOf(request);
  const [release, apkSizeBytes] = await Promise.all([
    publishedRelease(env.KV, origin),
    publishedApkSizeBytes(env.APK_BUCKET)
  ]);
  const html = renderLandingPage({ release, apkSizeBytes });
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': PORTAL_CACHE_CONTROL,
      'X-Content-Type-Options': 'nosniff'
    }
  });
}
