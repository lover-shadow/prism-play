import { hmacSign, hmacVerify } from './crypto-primitives';

export type ProxyKind = 'img' | 'media';

export const PROXY_KINDS: readonly ProxyKind[] = ['img', 'media'];

export function isProxyKind(value: unknown): value is ProxyKind {
  return value === 'img' || value === 'media';
}

/**
 * Handles are opaque ids minted by the edge, never a URL fragment: the client cannot steer the
 * upstream target, which is the whole point of API-SPEC §六 (白名单 + 防 SSRF). The 512 ceiling exists
 * because a sealed media handle carries an AES-GCM IV plus ciphertext of the upstream target.
 */
const HANDLE_PATTERN = /^[A-Za-z0-9_.:-]{1,512}$/;

export function isSafeHandle(value: string): boolean {
  return HANDLE_PATTERN.test(value);
}

export const MEDIA_HANDLE_PREFIX = 'e_';

export function episodeHandle(episodeId: number): string {
  return `${MEDIA_HANDLE_PREFIX}${episodeId}`;
}

export function episodeIdFromHandle(handle: string): number | null {
  if (!handle.startsWith(MEDIA_HANDLE_PREFIX)) return null;
  const raw = handle.slice(MEDIA_HANDLE_PREFIX.length);
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function signaturePayload(kind: ProxyKind, handle: string, expSeconds: number): string {
  // Newline separators keep (kind, handle, exp) unambiguous, so no handle can smuggle another field.
  return `${kind}\n${handle}\n${expSeconds}`;
}

export async function signProxyTarget(
  secret: string,
  kind: ProxyKind,
  handle: string,
  expSeconds: number
): Promise<string> {
  return hmacSign(secret, signaturePayload(kind, handle, expSeconds));
}

export type ProxySignatureStatus = 'valid' | 'missing' | 'invalid' | 'expired';

export async function verifyProxySignature(
  secret: string,
  input: { kind: ProxyKind; handle: string; exp: string | null; sig: string | null },
  nowSeconds: number
): Promise<ProxySignatureStatus> {
  if (input.exp === null || input.sig === null) return 'missing';
  if (!/^\d+$/.test(input.exp)) return 'invalid';
  const exp = Number(input.exp);
  if (!Number.isSafeInteger(exp)) return 'invalid';
  if (exp <= nowSeconds) return 'expired';
  const intact = await hmacVerify(secret, signaturePayload(input.kind, input.handle, exp), input.sig);
  return intact ? 'valid' : 'invalid';
}

export function proxyPath(kind: ProxyKind, handle: string): string {
  return `/proxy/${kind}/${handle}`;
}

export interface ProxyUrlOptions {
  expSeconds?: number;
  signature?: string;
}

/** `origin` always comes from the incoming request, so the built URL is same-origin by construction. */
export function buildProxyUrl(origin: string, kind: ProxyKind, handle: string, options?: ProxyUrlOptions): string {
  const url = new URL(proxyPath(kind, handle), origin);
  if (options?.expSeconds !== undefined && options.signature !== undefined) {
    url.searchParams.set('exp', String(options.expSeconds));
    url.searchParams.set('sig', options.signature);
  }
  return url.toString();
}

export interface IssuedProxyUrl {
  url: string;
  expiresInSeconds: number;
}

/**
 * A media handle is always short-lived. A public poster is deliberately stable (no exp/sig) because
 * AC-18 and API-SPEC §八 cache it by `coverVersion` + ETag; a private poster gets the same
 * short-lived signature as media, since a copyable URL must not outlive the session.
 */
export async function issueSignedProxyUrl(
  origin: string,
  secret: string,
  kind: ProxyKind,
  handle: string,
  nowSeconds: number,
  ttlSeconds: number
): Promise<IssuedProxyUrl> {
  const exp = nowSeconds + ttlSeconds;
  const signature = await signProxyTarget(secret, kind, handle, exp);
  return {
    url: buildProxyUrl(origin, kind, handle, { expSeconds: exp, signature }),
    expiresInSeconds: ttlSeconds
  };
}
