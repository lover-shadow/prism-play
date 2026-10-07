import type { Clock } from '../core/clock';
import { digestToken, equalDigest, verifyPassword } from '../auth/admin-password';
import { adminVersion, cookieToken, issueAdminSession, readAdminSession, revokeAdminSession, sameOrigin, sessionCookie, type AdminEnv } from '../auth/admin-session';

export function adminJson(data: unknown, status = 200, cookie?: string): Response {
  const headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" });
  if (cookie) headers.set('Set-Cookie', cookie);
  return new Response(JSON.stringify(data), { status, headers });
}

async function reserveAttempt(env: AdminEnv, ipHash: string, now: number): Promise<boolean> {
  const blocked = await env.DB.prepare('SELECT MAX(blocked_until) AS until FROM admin_login_limits WHERE ip_hash = ?')
    .bind(ipHash).first<{ until: number | null }>();
  if ((blocked?.until ?? 0) > now) return false;
  const row = await env.DB.prepare(
    'INSERT INTO admin_login_limits (ip_hash, window_start, attempts, failed_count, blocked_until, updated_at) ' +
    'SELECT ?, ?, 1, 0, 0, ? WHERE NOT EXISTS (SELECT 1 FROM admin_login_limits WHERE ip_hash = ? AND blocked_until > ?) ' +
    'ON CONFLICT(ip_hash, window_start) DO UPDATE SET attempts = attempts + 1, updated_at = excluded.updated_at ' +
    'WHERE attempts < 10 AND failed_count < 5 AND blocked_until <= ? RETURNING attempts'
  ).bind(ipHash, Math.floor(now / 900) * 900, now, ipHash, now, now).first<{ attempts: number }>();
  return row !== null;
}

async function login(request: Request, env: AdminEnv, clock: Clock): Promise<Response> {
  if (!sameOrigin(request)) return adminJson({ code: 'FORBIDDEN' }, 403);
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json') return adminJson({ code: 'VALIDATION_ERROR' }, 400);
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return adminJson({ code: 'UNAVAILABLE' }, 503);
  const ipHash = await digestToken(ip);
  const now = clock.nowSeconds();
  if (!await reserveAttempt(env, ipHash, now)) return adminJson({ code: 'RATE_LIMITED' }, 429);
  const reader = request.body?.getReader();
  if (!reader) return adminJson({ code: 'VALIDATION_ERROR' }, 400);
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > 8192) {
      await reader.cancel();
      return adminJson({ code: 'VALIDATION_ERROR' }, 400);
    }
    chunks.push(next.value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(combined)); }
  catch { return adminJson({ code: 'VALIDATION_ERROR' }, 400); }
  const password = value && typeof value === 'object' ? (value as { password?: unknown }).password : undefined;
  if (typeof password !== 'string' || password.length < 1 || password.length > 1024) return adminJson({ code: 'VALIDATION_ERROR' }, 400);
  if (!await verifyPassword(password, env.ADMIN_PASSWORD_HASH!)) {
    await env.DB.prepare('UPDATE admin_login_limits SET failed_count = failed_count + 1, ' +
      'blocked_until = CASE WHEN failed_count + 1 >= 5 THEN ? ELSE blocked_until END WHERE ip_hash = ? AND window_start = ?')
      .bind(now + 900, ipHash, Math.floor(now / 900) * 900).run();
    return adminJson({ code: 'UNAUTHENTICATED' }, 401);
  }
  const previous = cookieToken(request);
  if (previous) await revokeAdminSession(env.DB, previous);
  const session = await issueAdminSession(env, clock);
  return adminJson({ csrf: session.csrf, expiresAt: session.expiresAt }, 200, sessionCookie(session.token));
}

export async function handleAdminAuth(request: Request, env: AdminEnv, clock: Clock): Promise<Response> {
  try {
    if (adminVersion(env) === null) return adminJson({ code: 'UNAVAILABLE' }, 503);
    if ((request.headers.has('Origin') && !sameOrigin(request)) || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
      return adminJson({ code: 'FORBIDDEN' }, 403);
    }
    const path = new URL(request.url).pathname;
    if (path === '/api/admin/login' && request.method === 'POST') return await login(request, env, clock);
    if (path !== '/api/admin/session' && path !== '/api/admin/logout') return adminJson({ code: 'NOT_FOUND' }, 404);
    if ((path.endsWith('/session') && request.method !== 'GET') || (path.endsWith('/logout') && request.method !== 'POST')) return adminJson({ code: 'METHOD_NOT_ALLOWED' }, 405);
    if (request.method === 'POST' && !sameOrigin(request)) return adminJson({ code: 'FORBIDDEN' }, 403);
    const session = await readAdminSession(request, env, clock);
    if (!session) {
      const token = cookieToken(request);
      const supplied = request.headers.get('X-CSRF-Token');
      if (path.endsWith('/logout') && token && supplied && equalDigest(await digestToken(`admin-csrf:${token}`), supplied)) {
        await revokeAdminSession(env.DB, token);
        return adminJson({ success: true }, 200, sessionCookie('', 0));
      }
      return adminJson({ code: 'UNAUTHENTICATED' }, 401);
    }
    if (path.endsWith('/session')) return adminJson({ csrf: session.csrf, expiresAt: session.expiresAt });
    await revokeAdminSession(env.DB, session.token);
    return adminJson({ success: true }, 200, sessionCookie('', 0));
  } catch {
    return adminJson({ code: 'UNAVAILABLE' }, 503);
  }
}
