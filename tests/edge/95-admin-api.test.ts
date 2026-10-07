import { describe, expect, it } from 'vitest';
import { createTestEnv } from '../support/test-env';
import { issueAdminSession } from '../../edge/src/auth/admin-session';
import { handleAdminRequest, isAdminPath } from '../../edge/src/routes/admin-request';

async function fixture() {
  const env = { ...await createTestEnv(), ADMIN_PASSWORD_HASH: 'configured', ADMIN_AUTH_VERSION: '1' };
  const session = await issueAdminSession(env, env.clock);
  const headers = { Cookie: `__Host-prism_admin_session=${session.token}` };
  return { env, headers, session };
}

const origin = 'https://play.prismos.org';

describe('admin route boundary', () => {
  it('recognizes only whole admin path segments', () => {
    for (const path of ['/admin', '/admin/assets/script', '/api/admin/session']) expect(isAdminPath(path)).toBe(true);
    for (const path of ['/administrator', '/api/administrator', '/api/redeem', '/proxy/video/a']) expect(isAdminPath(path)).toBe(false);
  });

  it('requires a server session, refuses cross-site reads and never reflects CORS', async () => {
    const { env, headers } = await fixture();
    const denied = await handleAdminRequest(new Request(`${origin}/api/admin/dashboard`), env, env.clock);
    expect(denied.status).toBe(401);
    const cross = await handleAdminRequest(new Request(`${origin}/api/admin/dashboard`, { headers: { ...headers, Origin: 'https://other.test' } }), env, env.clock);
    expect(cross.status).toBe(403);
    expect(cross.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(cross.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('admin read APIs', () => {
  it('masks coupon codes, bounds pagination, and exposes binding details without IPs', async () => {
    const { env, headers } = await fixture();
    const code = 'GY-ABCD-EFGH-IJKL';
    env.db.execute("INSERT INTO card_coupons (code,tier,tier_name,duration_days,created_at,updated_at) VALUES (?,'Q','季度畅享卡',90,?,?)", code, env.clock.nowSeconds(), env.clock.nowSeconds());
    const response = await handleAdminRequest(new Request(`${origin}/api/admin/coupons`, { headers }), env, env.clock);
    const raw = await response.text();
    expect(response.status).toBe(200);
    expect(raw).not.toContain(code);
    const data = JSON.parse(raw) as { items: { id: string }[]; total: number };
    expect(data.total).toBe(1);
    expect(data.items[0].id).toMatch(/^[a-f0-9]{64}$/);
    const detail = await handleAdminRequest(new Request(`${origin}/api/admin/coupons/${data.items[0].id}`, { headers }), env, env.clock);
    expect(detail.status).toBe(200);
    expect(await detail.text()).not.toContain(code);
    const bad = await handleAdminRequest(new Request(`${origin}/api/admin/coupons?limit=100000`, { headers }), env, env.clock);
    expect(bad.status).toBe(400);
  });

  it('returns honest empty analytics and read-only operation state', async () => {
    const { env, headers } = await fixture();
    const response = await handleAdminRequest(new Request(`${origin}/api/admin/dashboard?days=7`, { headers }), env, env.clock);
    const data = await response.json() as { conversionRate: number | null; uv: number; updatedAt: number | null };
    expect(data).toMatchObject({ conversionRate: null, uv: 0, updatedAt: null });
    const operations = await handleAdminRequest(new Request(`${origin}/api/admin/operations`, { headers }), env, env.clock);
    expect(await operations.json()).toMatchObject({ version: null, lineSignals: [] });
    const bad = await handleAdminRequest(new Request(`${origin}/api/admin/dashboard?days=365`, { headers }), env, env.clock);
    expect(bad.status).toBe(400);
  });

  it('rejects CSRF-free writes and cross-site OPTIONS without public CORS headers', async () => {
    const { env, headers } = await fixture();
    const response = await handleAdminRequest(new Request(`${origin}/api/admin/coupons/generate`, {
      method: 'POST', headers: { ...headers, Origin: origin }, body: '{}'
    }), env, env.clock);
    expect(response.status).toBe(401);
    const preflight = await handleAdminRequest(new Request(`${origin}/api/admin/coupons`, {
      method: 'OPTIONS', headers: { Origin: 'https://other.test' }
    }), env, env.clock);
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('generates idempotent stock, rejects conflicting retries and audits reveal', async () => {
    const { env, headers, session } = await fixture();
    const post = (path: string, body: unknown) => handleAdminRequest(new Request(`${origin}/api/admin/${path}`, {
      method: 'POST', headers: { ...headers, Origin: origin, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }), env, env.clock);
    const body = { requestId: 'generate-001', tier: 'Q', count: 2, note: 'test batch' };
    const first = await post('coupons/generate', body);
    expect(first.status).toBe(200);
    const firstData = await first.json() as { codes: string[] };
    const retry = await post('coupons/generate', body);
    expect(await retry.json()).toMatchObject({ codes: firstData.codes, created: false });
    expect((await post('coupons/generate', { ...body, count: 3 })).status).toBe(409);
    const list = await handleAdminRequest(new Request(`${origin}/api/admin/coupons`, { headers }), env, env.clock);
    const data = await list.json() as { items: { id: string }[] };
    const id = data.items[0].id;
    expect((await post(`coupons/${id}/reveal`, { requestId: 'reveal-001' })).status).toBe(200);
    expect(env.db.selectOne("SELECT COUNT(*) AS n FROM admin_audit_logs WHERE action='COUPON_REVEAL'")?.n).toBe(1);
    expect((await post(`coupons/${id}/dispatch`, { requestId: 'dispatch-001', note: 'friend' })).status).toBe(200);
    expect((await post(`coupons/${id}/dispatch`, { requestId: 'dispatch-002', note: 'other' })).status).toBe(409);
    expect((await post(`coupons/${id}/revoke`, { requestId: 'revoke-001', reason: 'test' })).status).toBe(200);
  });

  it('limits expensive generation requests by session', async () => {
    const { env, headers, session } = await fixture();
    for (let i = 0; i < 6; i++) {
      const response = await handleAdminRequest(new Request(`${origin}/api/admin/coupons/generate`, {
        method: 'POST', headers: { ...headers, Origin: origin, 'X-CSRF-Token': session.csrf, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: `limited-00${i}`, tier: 'Q', count: 1 })
      }), env, env.clock);
      expect(response.status).toBe(i < 5 ? 200 : 429);
    }
  });

  it('returns 503 without leaking database faults', async () => {
    const { env, headers } = await fixture();
    env.db.prepare = () => { throw new Error('sensitive database details'); };
    const response = await handleAdminRequest(new Request(`${origin}/api/admin/coupons`, { headers }), env, env.clock);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('sensitive');
  });
});
