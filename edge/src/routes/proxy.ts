import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import type { ContentRow } from '../db/content-repo';
import type { ErrorCode } from '../types/api';
import type { ProxyKind, ProxySignatureStatus } from '../core/proxy-signature';
import type { UpstreamFetcher } from '../media/upstream';
import { resolvePrivateAccess } from '../core/admission';
import { PUBLIC_POSTER_MAX_AGE_SECONDS } from '../core/constants';
import { createMediaHandleCodec } from '../core/media-handle';
import { buildProxyUrl, isProxyKind, isSafeHandle, signProxyTarget, verifyProxySignature } from '../core/proxy-signature';
import { findContentRow, findPlaybackCandidate, isPrivateChannel, listAllowedUpstreamOrigins } from '../db/content-repo';
import { buildErrorResponse } from '../http/errors';
import { jsonResponse } from '../http/json';
import { originOf } from '../http/serialize';
import { HLS_MANIFEST_CONTENT_TYPE, HlsReferenceUnresolvableError, isHlsManifest, rewriteMediaPlaylist } from '../media/hls-rewrite';
import { assertAllowedTarget, globalFetcher, openUpstream, UpstreamFetchFailure, UpstreamTargetRejectedError } from '../media/upstream';

/**
 * `GET /proxy/{kind}/{handle}` — the client's only media entry point (API-SPEC §六).
 *
 * Authorization is re-derived on *every* request, including each HLS child, key, subtitle and Range:
 * D1 row visibility, the private double-admission predicate, the D1 upstream whitelist, and for `media`
 * the short-lived signature over (kind, handle, exp). A sealed handle is trusted as data only, never as
 * authority, because a copyable URL must not outlive the state that minted it.
 *
 * Refusal shapes (documented contract gap — see the G2 report):
 * - `404` + `no-store`, undifferentiated: unknown row, unpublished row, private row without admission,
 *   unparseable or tampered sealed handle, episode whose source is gone. Private must never answer
 *   403/401, or the status itself becomes a probe for "there is a private thing here".
 * - `403` + `no-store`, one body for expired/invalid/missing: a `media` signature that does not verify,
 *   or a target origin that left the whitelist. openapi pins 403 to 「代理签名失效」, but the closed
 *   error enum has no proxy member, so `CREDENTIAL_EXPIRED` carries it and no message names the target.
 * Nothing here reads or writes KV: a CDN/KV tier in front of the proxy is deliberately not part of G2.
 */

/** Public posters are revalidated by ETag, so a long max-age would only delay a cover swap. */
/** Only `Range` is forwarded upstream: a client header must never steer the outbound request further. */
const FORWARDED_REQUEST_HEADERS = ['Range'] as const;

/** Response headers we may echo. Everything else — `Set-Cookie`, `Location`, `Server` — is dropped. */
const FORWARDABLE_RESPONSE_HEADERS = [
  'Content-Type',
  'Content-Length',
  'Content-Range',
  'Accept-Ranges',
  'Cache-Control',
  'ETag',
  'Last-Modified'
] as const;

/** Multi-segment on purpose (指令包 §四.4): never collapse this to a single `{path}` parameter. */
export const PROXY_PATH_PATTERN = /^\/proxy\/([^/]+)\/([^/]+)$/;

export interface ProxyRouteDeps {
  fetcher?: UpstreamFetcher;
}

class ProxyRefusal extends Error {
  readonly response: Response;

  constructor(response: Response) {
    super('proxy request refused');
    this.name = 'ProxyRefusal';
    this.response = response;
  }
}

/** Every refusal is no-store: a cached 404 would outlive the revocation that produced it. */
function refusalResponse(code: ErrorCode, status: number): Response {
  return jsonResponse(buildErrorResponse(code), status, { 'Cache-Control': 'no-store' });
}

function refusal(code: ErrorCode, status: number): never {
  throw new ProxyRefusal(refusalResponse(code, status));
}

/*
 * openapi.yaml pins only the 403 status for a failed proxy signature, and no member of the closed
 * `ErrorResponse.code` enum means "proxy signature invalid" (`CREDENTIAL_EXPIRED` is contract-mapped
 * to 401 for `/api/device/ping`). A body would either break the enum or break the one-status-per-code
 * rule, so this answers the status alone; every failure cause stays byte-identical either way.
 */
function refusalStatus(): never {
  refusal('PROXY_SIGNATURE_INVALID', 403);
}

/** SPEC §5 谓词 — the single private gate, with the tier set read from D1 configuration. */
async function privateAdmitted(request: Request, env: Env, clock: Clock): Promise<boolean> {
  return (await resolvePrivateAccess(request, env, clock)).granted;
}

function isPrivateRow(row: ContentRow): boolean {
  return row.is_private === 1 || isPrivateChannel(row);
}

async function signatureStatus(
  env: Env,
  clock: Clock,
  kind: ProxyKind,
  handle: string,
  url: URL
): Promise<ProxySignatureStatus> {
  return await verifyProxySignature(
    env.PROXY_SIGNING_SECRET,
    { kind, handle, exp: url.searchParams.get('exp'), sig: url.searchParams.get('sig') },
    clock.nowSeconds()
  );
}

/** ETag is derived from `cover_version` (AC-18) and sanitized so it can never inject header characters. */
function posterEtag(row: ContentRow): string | null {
  if (row.cover_version === null) return null;
  const fingerprint = row.cover_version.replace(/[^A-Za-z0-9_.:-]/g, '');
  const id = row.id.replace(/[^A-Za-z0-9_.:-]/g, '');
  return fingerprint === '' ? null : `"img-${id}-${fingerprint}"`;
}

function ifNoneMatchHits(header: string | null, etag: string): boolean {
  if (header === null) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((candidate) => candidate.trim().replace(/^W\//, '') === etag);
}

function posterCacheHeaders(etag: string | null, isPrivate: boolean): Headers {
  const headers = new Headers({
    'Cache-Control': isPrivate ? 'no-store' : `public, max-age=${PUBLIC_POSTER_MAX_AGE_SECONDS}`,
    'X-Content-Type-Options': 'nosniff'
  });
  if (etag !== null) headers.set('ETag', etag);
  return headers;
}

function upstreamRequestHeaders(request: Request): Headers {
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

/**
 * Copies the allowlisted subset of an upstream response. A private target is forced to `no-store`
 * whatever upstream said; a public one keeps upstream's directive, and a missing directive stays
 * uncacheable rather than inheriting a shared cache's default.
 */
function mediaResponseHeaders(upstream: Headers, isPrivate: boolean, fullResponse: boolean): Headers {
  const headers = new Headers();
  for (const name of FORWARDABLE_RESPONSE_HEADERS) {
    const value = upstream.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (isPrivate || headers.get('Cache-Control') === null) headers.set('Cache-Control', 'no-store');
  if (fullResponse) headers.set('Accept-Ranges', headers.get('Accept-Ranges') ?? 'bytes');
  headers.set('X-Content-Type-Options', 'nosniff');
  return headers;
}

/** Rewrites a complete HLS manifest; relays any other target with the allowlisted headers only. */
async function relay(input: {
  request: Request;
  env: Env;
  fetcher: UpstreamFetcher;
  targetUrl: string;
  isPrivate: boolean;
  childMinter?: (childTargetUrl: string) => Promise<string>;
}): Promise<Response> {
  const allowedOrigins = await listAllowedUpstreamOrigins(input.env.DB);
  let target: URL;
  let upstream: Response;
  try {
    target = assertAllowedTarget(input.targetUrl, allowedOrigins);
    upstream = await openUpstream({
      url: target.toString(),
      allowedOrigins,
      fetcher: input.fetcher,
      headers: upstreamRequestHeaders(input.request)
    });
  } catch (error) {
    if (error instanceof UpstreamTargetRejectedError) refusalStatus();
    if (error instanceof UpstreamFetchFailure) refusal('SERVICE_UNAVAILABLE', 503);
    throw error;
  }
  if (!upstream.ok) refusal('SERVICE_UNAVAILABLE', 503);

  const isManifest = isHlsManifest(target, upstream.headers.get('Content-Type'));
  const rangeRequested = input.request.headers.get('Range') !== null;
  // A playlist we cannot rewrite would hand the client upstream child URIs, so it is never relayed:
  // not for `img` at all, and not for a partial (`206`) or Range-sliced manifest.
  if (isManifest && (input.childMinter === undefined || upstream.status !== 200 || rangeRequested)) {
    refusal('SERVICE_UNAVAILABLE', 503);
  }
  if (isManifest && input.childMinter !== undefined) {
    let rewritten: string;
    try {
      rewritten = await rewriteMediaPlaylist(
        {
          playlistUrl: target.toString(),
          allowedOrigins,
          mintChildUrl: input.childMinter as (childTargetUrl: string) => Promise<string>
        },
        await upstream.text()
      );
    } catch (error) {
      if (error instanceof UpstreamTargetRejectedError) refusalStatus();
      if (error instanceof HlsReferenceUnresolvableError) refusal('SERVICE_UNAVAILABLE', 503);
      throw error;
    }
    // Rewritten bytes differ in length from upstream's, so its Content-Length is dropped rather than
    // wrong, and ranges into the manifest no longer address the same bytes, hence `none` is honest.
    return new Response(rewritten, {
      status: 200,
      headers: new Headers({
        'Content-Type': HLS_MANIFEST_CONTENT_TYPE,
        'Cache-Control': 'no-store',
        'Accept-Ranges': 'none',
        'X-Content-Type-Options': 'nosniff'
      })
    });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    headers: mediaResponseHeaders(upstream.headers, input.isPrivate, upstream.status === 200 && !rangeRequested)
  });
}

/**
 * `img`: the handle is the content id and D1 is consulted on every request. A public, published poster
 * stays unsigned so AC-18 caches it by `coverVersion` + ETag; a private poster additionally requires a
 * valid signature, and every denial is the same 404 so privacy is never announced.
 */
async function servePoster(request: Request, env: Env, clock: Clock, url: URL, handle: string, fetcher: UpstreamFetcher) {
  const row = await findContentRow(env.DB, handle);
  if (row === null || row.enabled !== 1) refusal('NOT_FOUND', 404);
  const coverUrl = row.cover_url;
  if (coverUrl === null || coverUrl === '') refusal('NOT_FOUND', 404);
  const isPrivate = isPrivateRow(row);
  if (isPrivate) {
    if (!(await privateAdmitted(request, env, clock))) refusal('NOT_FOUND', 404);
    if ((await signatureStatus(env, clock, 'img', handle, url)) !== 'valid') refusal('NOT_FOUND', 404);
  }
  const etag = posterEtag(row);
  if (etag !== null && ifNoneMatchHits(request.headers.get('If-None-Match'), etag)) {
    return new Response(null, { status: 304, headers: posterCacheHeaders(etag, isPrivate) });
  }
  const relayed = await relay({ request, env, fetcher, targetUrl: coverUrl, isPrivate });
  if (etag !== null) relayed.headers.set('ETag', etag);
  relayed.headers.set('Cache-Control', isPrivate ? 'no-store' : `public, max-age=${PUBLIC_POSTER_MAX_AGE_SECONDS}`);
  return relayed;
}

/**
 * `media`: signature first (cheapest, and a refusal there can not reveal anything about the target),
 * then the sealed handle, then D1 visibility plus private admission, then the upstream whitelist for
 * the decoded target. Each HLS child is a fresh request that walks this identical path.
 */
async function serveMedia(request: Request, env: Env, clock: Clock, url: URL, handle: string, fetcher: UpstreamFetcher) {
  if ((await signatureStatus(env, clock, 'media', handle, url)) !== 'valid') refusalStatus();
  const codec = await createMediaHandleCodec(env.PROXY_SIGNING_SECRET);
  const parsed = await codec.parse(handle);
  if (parsed === null) refusal('NOT_FOUND', 404);
  const candidate = await findPlaybackCandidate(env.DB, parsed.episodeId);
  if (candidate === null || candidate.content.enabled !== 1) refusal('NOT_FOUND', 404);
  const isPrivate = isPrivateRow(candidate.content);
  if (isPrivate && !(await privateAdmitted(request, env, clock))) refusal('NOT_FOUND', 404);

  // Children inherit the manifest's expiry: a sub-request may never outlive the URL that named it.
  const expiresAt = Number(url.searchParams.get('exp'));
  const origin = originOf(request);
  const childMinter = async (childTargetUrl: string): Promise<string> => {
    const sealed = await codec.mint(parsed.episodeId, childTargetUrl);
    const signature = await signProxyTarget(env.PROXY_SIGNING_SECRET, 'media', sealed, expiresAt);
    return buildProxyUrl(origin, 'media', sealed, { expSeconds: expiresAt, signature });
  };
  return await relay({ request, env, fetcher, targetUrl: parsed.targetUrl, isPrivate, childMinter });
}

export async function handleProxy(request: Request, env: Env, clock: Clock, deps: ProxyRouteDeps = {}): Promise<Response> {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
  const url = new URL(request.url);
  try {
    const matched = PROXY_PATH_PATTERN.exec(url.pathname);
    // A kind outside `img|media`, an unsafe handle or a stray segment is the same 404 as nothing there.
    if (matched === null) return refusalResponse('NOT_FOUND', 404);
    const [, kind, handle] = matched;
    if (!isProxyKind(kind) || !isSafeHandle(handle)) return refusalResponse('NOT_FOUND', 404);
    const fetcher = deps.fetcher ?? globalFetcher;
    return kind === 'img'
      ? await servePoster(request, env, clock, url, handle, fetcher)
      : await serveMedia(request, env, clock, url, handle, fetcher);
  } catch (error) {
    if (error instanceof ProxyRefusal) return error.response;
    // Never answer 200 or name the upstream cause; the cause is logged server-side only.
    console.error('proxy failure', url.pathname, error);
    return refusalResponse('SERVICE_UNAVAILABLE', 503);
  }
}
