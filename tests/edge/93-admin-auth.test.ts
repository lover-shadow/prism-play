import { describe, expect, it } from 'vitest';
import { createTestEnv } from '../support/test-env';
import { createPasswordHash, verifyPassword } from '../../edge/src/auth/admin-password';
import { issueAdminSession, readAdminSession, revokeAdminSession } from '../../edge/src/auth/admin-session';
import { handleAdminAuth } from '../../edge/src/routes/admin-auth';

const origin = 'https://play.prismos.org';
const password = 'test-only-long-admin-password';

async function fixture() {
  const env = await createTestEnv();
  return { ...env, ADMIN_PASSWORD_HASH: await createPasswordHash(password), ADMIN_AUTH_VERSION: '1' };
}

function request(path: string, body?: unknown, cookie?: string, csrf?: string, source = origin) {
  return new Request(`${origin}/api/admin/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Origin: source, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1',
      ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

describe('admin password verification', () => {
  it('verifies only correct passwords and rejects malformed parameters', async () => {
    const hash = await createPasswordHash(password);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword('incorrect', hash)).toBe(false);
    expect(await verifyPassword(password, 'invalid')).toBe(false);
  });
});

describe('admin server sessions', () => {
  it('stores only digests, validates CSRF and supports server-side logout', async () => {
    const env = await fixture();
    const session = await issueAdminSession(env, env.clock);
    const cookie = `__Host-prism_admin_session=${session.token}`;
    const row = env.db.selectOne('SELECT * FROM admin_sessions');
    expect(JSON.stringify(row)).not.toContain(session.token);
    expect(JSON.stringify(row)).not.toContain(session.csrf);
    expect(await readAdminSession(request('session', undefined, cookie), env, env.clock)).not.toBeNull();
    expect(await readAdminSession(request('logout', {}, cookie, 'wrong'), env, env.clock)).toBeNull();
    expect(await readAdminSession(request('logout', {}, cookie, session.csrf), env, env.clock)).not.toBeNull();
    await revokeAdminSession(env.DB, session.token);
    expect(await readAdminSession(request('session', undefined, cookie), env, env.clock)).toBeNull();
  });

  it('rejects expired, rotated, duplicate-cookie and App bearer credentials', async () => {
    const env = await fixture();
    const session = await issueAdminSession(env, env.clock);
    const cookie = `__Host-prism_admin_session=${session.token}`;
    expect(await readAdminSession(request('session', undefined, `${cookie}; ${cookie}`), env, env.clock)).toBeNull();
    const bearer = request('session');
    bearer.headers.set('Authorization', `Bearer ${session.token}`);
    expect(await readAdminSession(bearer, env, env.clock)).toBeNull();
    env.ADMIN_AUTH_VERSION = '2';
    expect(await readAdminSession(request('session', undefined, cookie), env, env.clock)).toBeNull();
    env.ADMIN_AUTH_VERSION = '1';
    env.clock.advance(43200);
    expect(await readAdminSession(request('session', undefined, cookie), env, env.clock)).toBeNull();
  });
});

describe('admin auth handlers', () => {
  it('logs in, exposes session CSRF, rejects cross-site writes and revokes on logout', async () => {
    const env = await fixture();
    const login = await handleAdminAuth(request('login', { password }), env, env.clock);
    expect(login.status).toBe(200);
    const cookie = login.headers.get('Set-Cookie')!.split(';')[0];
    expect(login.headers.get('Set-Cookie')).toContain('HttpOnly');
    expect(login.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const data = await login.json() as { csrf: string };
    expect((await handleAdminAuth(request('session', undefined, cookie), env, env.clock)).status).toBe(200);
    expect((await handleAdminAuth(request('logout', {}, cookie, data.csrf, 'https://example.test'), env, env.clock)).status).toBe(403);
    expect((await handleAdminAuth(request('logout', {}, cookie, data.csrf), env, env.clock)).status).toBe(200);
    expect((await handleAdminAuth(request('session', undefined, cookie), env, env.clock)).status).toBe(401);
    expect((await handleAdminAuth(request('logout', {}, cookie, data.csrf), env, env.clock)).status).toBe(200);
  });

  it('limits failed login attempts even across a fixed-window boundary', async () => {
    const env = await fixture();
    env.clock.set(Math.floor(env.clock.nowSeconds() / 900) * 900 + 850);
    for (let i = 0; i < 5; i++) {
      expect((await handleAdminAuth(request('login', { password: 'incorrect' }), env, env.clock)).status).toBe(401);
    }
    env.clock.advance(100);
    expect((await handleAdminAuth(request('login', { password }), env, env.clock)).status).toBe(429);
  });

  it('refuses cross-origin session reads even with a valid cookie', async () => {
    const env = await fixture();
    const session = await issueAdminSession(env, env.clock);
    const response = await handleAdminAuth(request('session', undefined,
      `__Host-prism_admin_session=${session.token}`, undefined, 'https://other.test'), env, env.clock);
    expect(response.status).toBe(403);
  });

  it('fails closed without configuration and when D1 is unavailable', async () => {
    const env = await fixture();
    expect((await handleAdminAuth(request('login', { password }), { ...env, ADMIN_AUTH_VERSION: undefined }, env.clock)).status).toBe(503);
    const broken = { ...env, DB: { prepare() { throw new Error('database unavailable'); } } as unknown as D1Database };
    expect((await handleAdminAuth(request('login', { password }), broken, env.clock)).status).toBe(503);
  });
});
