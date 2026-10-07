import type { Clock } from '../core/clock';
import { digestToken, equalDigest, randomToken } from './admin-password';

export interface AdminEnv {
  DB: D1Database;
  ADMIN_PASSWORD_HASH?: string;
  ADMIN_AUTH_VERSION?: string;
}

export const ADMIN_COOKIE = '__Host-prism_admin_session';
const LIFETIME = 43200;

export function adminVersion(env: AdminEnv): number | null {
  if (!env.ADMIN_PASSWORD_HASH || !env.ADMIN_AUTH_VERSION || !/^[1-9][0-9]{0,8}$/.test(env.ADMIN_AUTH_VERSION)) return null;
  return Number(env.ADMIN_AUTH_VERSION);
}

export function cookieToken(request: Request): string | null {
  const matches = (request.headers.get('Cookie') ?? '').split(';')
    .map((part) => part.trim()).filter((part) => part.startsWith(`${ADMIN_COOKIE}=`));
  if (matches.length !== 1) return null;
  const token = matches[0].slice(ADMIN_COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}

export function sameOrigin(request: Request): boolean {
  return request.headers.get('Origin') === new URL(request.url).origin;
}

export async function issueAdminSession(env: AdminEnv, clock: Clock) {
  const version = adminVersion(env);
  if (version === null) throw new Error('Admin configuration unavailable');
  const token = randomToken();
  // Deriving CSRF from the opaque token lets reloads recover it without storing either plaintext.
  const csrf = await digestToken(`admin-csrf:${token}`);
  const expiresAt = clock.nowSeconds() + LIFETIME;
  await env.DB.prepare('INSERT INTO admin_sessions (token_hash, csrf_hash, created_at, expires_at, auth_version) VALUES (?, ?, ?, ?, ?)')
    .bind(await digestToken(token), await digestToken(csrf), clock.nowSeconds(), expiresAt, version).run();
  return { token, csrf, expiresAt };
}

export async function readAdminSession(request: Request, env: AdminEnv, clock: Clock) {
  const token = cookieToken(request);
  const version = adminVersion(env);
  if (!token || version === null) return null;
  const row = await env.DB.prepare('SELECT csrf_hash, expires_at, auth_version FROM admin_sessions WHERE token_hash = ?')
    .bind(await digestToken(token)).first<{ csrf_hash: string; expires_at: number; auth_version: number }>();
  if (!row || row.expires_at <= clock.nowSeconds() || row.auth_version !== version) return null;
  const csrf = await digestToken(`admin-csrf:${token}`);
  if (!equalDigest(await digestToken(csrf), row.csrf_hash)) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const provided = request.headers.get('X-CSRF-Token');
    if (!sameOrigin(request) || !provided || provided.length !== 64 || !equalDigest(await digestToken(provided), row.csrf_hash)) return null;
  }
  return { token, csrf, expiresAt: row.expires_at };
}

export async function revokeAdminSession(db: D1Database, token: string): Promise<void> {
  await db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(await digestToken(token)).run();
}

export function sessionCookie(token: string, maxAge = LIFETIME): string {
  return `${ADMIN_COOKIE}=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
