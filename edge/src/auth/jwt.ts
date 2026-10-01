import type { AuthTokenClaims } from '../types/api';
import { JWT_AUDIENCE, JWT_ISSUER } from '../core/constants';
import {
  base64UrlToBytes,
  base64UrlToString,
  bytesToBase64Url,
  stringToBase64Url,
  textEncoder
} from '../core/crypto-primitives';

export interface JwtHeader {
  alg: 'EdDSA';
  typ: 'JWT';
  kid: string;
}

const ED25519_ALGORITHM = { name: 'Ed25519', namedCurve: 'Ed25519' } as const;

function normalizeJwk(jwk: Record<string, unknown>, usages: ('sign' | 'verify')[]): JsonWebKey {
  return { ...jwk, alg: 'EdDSA', key_ops: usages } as unknown as JsonWebKey;
}

/** The edge is the only holder of the signing key; clients ship the public half baked into the APK. */
export async function importSigningKey(privateJwkJson: string): Promise<CryptoKey> {
  const parsed = JSON.parse(privateJwkJson) as Record<string, unknown>;
  if (parsed.kty !== 'OKP' || parsed.crv !== 'Ed25519') {
    throw new Error('JWT_PRIVATE_KEY_JWK must be an OKP/Ed25519 JWK');
  }
  return crypto.subtle.importKey('jwk', normalizeJwk(parsed, ['sign']), ED25519_ALGORITHM, true, ['sign']);
}

export async function deriveVerificationKey(privateKey: CryptoKey): Promise<CryptoKey> {
  const exported = await crypto.subtle.exportKey('jwk', privateKey);
  const privateJwk = exported as unknown as Record<string, unknown>;
  const { d: _d, key_ops: _ops, ...rest } = privateJwk;
  return crypto.subtle.importKey('jwk', normalizeJwk(rest, ['verify']), ED25519_ALGORITHM, true, ['verify']);
}

const keyCache = new Map<string, { signing: CryptoKey; verifying: CryptoKey }>();

export async function getEdgeKeyMaterial(privateJwkJson: string): Promise<{ signing: CryptoKey; verifying: CryptoKey }> {
  const cached = keyCache.get(privateJwkJson);
  if (cached) return cached;
  const signing = await importSigningKey(privateJwkJson);
  const verifying = await deriveVerificationKey(signing);
  const material = { signing, verifying };
  keyCache.set(privateJwkJson, material);
  return material;
}

/** Keys are derived per isolate and only ever for the configured JWK; the cache holds no secret beyond it. */
export function clearKeyCacheForTests(): void {
  keyCache.clear();
}

export function buildClaims(input: {
  deviceId: string;
  tier: AuthTokenClaims['tier'];
  expiresAt: number;
  issuedAt: number;
  jti: string;
}): AuthTokenClaims {
  return {
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    sub: input.deviceId,
    tier: input.tier,
    exp: input.expiresAt,
    iat: input.issuedAt,
    jti: input.jti
  };
}

export async function signJwt(claims: AuthTokenClaims, signingKey: CryptoKey, kid: string): Promise<string> {
  const header: JwtHeader = { alg: 'EdDSA', typ: 'JWT', kid };
  const signingInput = `${stringToBase64Url(JSON.stringify(header))}.${stringToBase64Url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign('Ed25519', signingKey, textEncoder.encode(signingInput));
  return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function parseClaims(value: unknown): AuthTokenClaims | null {
  if (value === null || typeof value !== 'object') return null;
  const claims = value as Record<string, unknown>;
  if (typeof claims.sub !== 'string' || typeof claims.tier !== 'string') return null;
  if (typeof claims.exp !== 'number' || typeof claims.iat !== 'number') return null;
  return {
    iss: String(claims.iss ?? ''),
    aud: String(claims.aud ?? ''),
    sub: claims.sub,
    tier: claims.tier as AuthTokenClaims['tier'],
    exp: claims.exp,
    iat: claims.iat,
    jti: typeof claims.jti === 'string' ? claims.jti : ''
  };
}

/** Returns the verified claims, or null for any malformed or forged token (never a partial claim set). */
export async function verifyJwt(token: string, verifyingKey: CryptoKey): Promise<AuthTokenClaims | null> {
  const segments = token.split('.');
  if (segments.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  let header: JwtHeader;
  try {
    header = JSON.parse(base64UrlToString(encodedHeader)) as JwtHeader;
  } catch {
    return null;
  }
  if (header.alg !== 'EdDSA') return null;
  let signature: Uint8Array;
  try {
    signature = base64UrlToBytes(encodedSignature);
  } catch {
    return null;
  }
  const intact = await crypto.subtle.verify(
    'Ed25519',
    verifyingKey,
    signature,
    textEncoder.encode(`${encodedHeader}.${encodedPayload}`)
  );
  if (!intact) return null;
  let claims: AuthTokenClaims | null;
  try {
    claims = parseClaims(JSON.parse(base64UrlToString(encodedPayload)));
  } catch {
    return null;
  }
  if (claims === null) return null;
  return claims.aud === JWT_AUDIENCE ? claims : null;
}
