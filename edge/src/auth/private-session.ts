import { base64UrlToString, hmacSign, hmacVerify, randomHex, sha256Hex, stringToBase64Url } from '../core/crypto-primitives';

export interface PrivateSessionPayload {
  /** Random per-issue id, also the revocation lookup seed. */
  sid: string;
  dev: string;
  exp: number;
}

export interface IssuedPrivateSession {
  token: string;
  expiresInSeconds: number;
  payload: PrivateSessionPayload;
}

/**
 * Private-session credentials are HMAC-SHA256, not Ed25519: the client never verifies them, so a
 * server-only symmetric key is strictly better (AC-02 keeps the credential unforgeable while the
 * Ed25519 rule in API-SPEC §七 only forbids shipping a symmetric key to the client).
 * Nothing about the user's viewing content is embedded — the payload carries id, device and expiry.
 */
export async function issuePrivateSession(
  secret: string,
  deviceId: string,
  nowSeconds: number,
  ttlSeconds: number
): Promise<IssuedPrivateSession> {
  const payload: PrivateSessionPayload = { sid: randomHex(16), dev: deviceId, exp: nowSeconds + ttlSeconds };
  const body = stringToBase64Url(JSON.stringify(payload));
  return {
    token: `${body}.${await hmacSign(secret, body)}`,
    expiresInSeconds: ttlSeconds,
    payload
  };
}

/** Any failure — forged, malformed, expired — answers null, never a reason the caller could probe. */
export async function verifyPrivateSession(
  token: string,
  secret: string,
  nowSeconds: number
): Promise<PrivateSessionPayload | null> {
  const segments = token.split('.');
  if (segments.length !== 2) return null;
  const [body, signature] = segments;
  let payload: PrivateSessionPayload;
  try {
    payload = JSON.parse(base64UrlToString(body)) as PrivateSessionPayload;
  } catch {
    return null;
  }
  if (typeof payload.sid !== 'string' || typeof payload.dev !== 'string' || typeof payload.exp !== 'number') {
    return null;
  }
  if (payload.exp <= nowSeconds) return null;
  return (await hmacVerify(secret, body, signature)) ? payload : null;
}

/** Revocation tombstones store only this digest — never the credential, never content identity. */
export function hashPrivateSessionToken(token: string): Promise<string> {
  return sha256Hex(token);
}

export async function isSessionRevoked(db: D1Database, tokenHash: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT token_hash FROM private_session_revocations WHERE token_hash = ?')
    .bind(tokenHash)
    .first<{ token_hash: string }>();
  return row !== null;
}

export async function revokeSession(
  db: D1Database,
  tokenHash: string,
  expiresAt: number,
  nowSeconds: number
): Promise<void> {
  await db
    .prepare('INSERT OR REPLACE INTO private_session_revocations (token_hash, expires_at, revoked_at) VALUES (?, ?, ?)')
    .bind(tokenHash, expiresAt, nowSeconds)
    .run();
}

/** A tombstone only protects its credential until that credential expires; after that it is pure weight. */
export async function pruneExpiredRevocations(db: D1Database, nowSeconds: number): Promise<number> {
  const result = await db
    .prepare('DELETE FROM private_session_revocations WHERE expires_at <= ?')
    .bind(nowSeconds)
    .run();
  return result.meta.changes;
}
