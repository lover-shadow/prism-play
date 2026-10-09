import { describe, expect, it, vi } from 'vitest';
import { createTestEnv, TestClock } from '../support/test-env';
import { collectAnalytics } from '../../edge/src/analytics/collect';
import { handleAnalyticsConsent, privacyPage } from '../../edge/src/routes/analytics-consent';
import { hashVisitor } from '../../edge/src/analytics/visitor';
import { cleanupAnalytics } from '../../edge/src/analytics/cleanup';

const UUID = '550e8400-e29b-41d4-a716-446655440000';
const SECRET = 'independent-test-analytics-secret';
const ORIGIN = 'https://play.prismos.org';
const DAY = 86400;
const NOW = 1_791_244_800;
const clock = new TestClock(NOW);
const html = () => new Response('<main>public</main>', {
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' }
});
function context() {
  const tasks: Promise<unknown>[] = [];
  return { tasks, waitUntil: vi.fn((task: Promise<unknown>) => { tasks.push(task); }) };
}
async function enabled() {
  return { ...await createTestEnv(), ANALYTICS_ENABLED: 'true', ANALYTICS_HASH_SECRET: SECRET };
}
function consent(action: string, headers: Record<string, string> = {}, body?: string) {
  return new Request(`${ORIGIN}/api/analytics/consent`, {
    method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers },
    body: body ?? JSON.stringify({ action })
  });
}

 describe('analytics collection: explicit successful public responses only', () => {
  it.each(['/', '/dl', '/s/public?ep=2'])('counts HTML %s in waitUntil, preserves body, disables shared caching', async (path) => {
    const env = await enabled();
    const ctx = context();
    const result = collectAnalytics(new Request(ORIGIN + path), html(), env, clock, ctx);
    expect(result).toBeInstanceOf(Response);
    expect(result.headers.get('Cache-Control')).toBe('private, no-store');
    expect(result.headers.has('Set-Cookie')).toBe(false);
    expect(await result.text()).toBe('<main>public</main>');
    expect(ctx.waitUntil).toHaveBeenCalledOnce();
    await Promise.all(ctx.tasks);
    expect(env.db.count('analytics_daily')).toBe(1);
    expect(env.db.count('analytics_visitors')).toBe(0);
  });

  it.each([
    ['/api/redeem', 'GET', 200, ''], ['/api/catalog', 'GET', 200, ''],
    ['/api/device/ping', 'POST', 200, ''], ['/proxy/media', 'GET', 200, ''],
    ['/assets/a', 'GET', 200, ''], ['/admin', 'GET', 200, ''],
    ['/s/private', 'GET', 404, ''], ['/s/unknown', 'GET', 404, ''],
    ['/s/a/b', 'GET', 200, ''], ['/s/%00', 'GET', 200, ''],
    ['/s/public?ep=0', 'GET', 200, ''], ['/s/public?ep=abc', 'GET', 200, ''],
    ['/', 'HEAD', 200, ''], ['/', 'OPTIONS', 200, ''],
    ['/', 'GET', 200, 'Googlebot/2.1'], ['/', 'GET', 200, 'facebookexternalhit'],
    ['/dl/latest/android', 'GET', 404, ''], ['/dl/latest/pc', 'GET', 302, '']
  ])('leaves excluded %s %s %s unchanged', async (path, method, status, ua) => {
    const env = await enabled();
    const ctx = context();
    const response = new Response(null, { status, headers: { 'Cache-Control': 'public', 'Content-Type': 'text/html' } });
    expect(collectAnalytics(new Request(ORIGIN + path, { method, headers: { 'User-Agent': ua } }), response, env, clock, ctx)).toBe(response);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(env.db.count('analytics_daily')).toBe(0);
  });

  it.each([undefined, 'false', 'TRUE', '1'])('is disabled for flag %s', async (flag) => {
    const env = { ...await enabled(), ANALYTICS_ENABLED: flag };
    const response = html();
    const ctx = context();
    expect(collectAnalytics(new Request(ORIGIN), response, env, clock, ctx)).toBe(response);
    expect(ctx.tasks).toHaveLength(0);
  });

  it('counts downloads separately; HMAC identity and finite channels, Shanghai midnight', async () => {
    const env = await enabled();
    const ctx = context();
    const midnight = new TestClock(Date.parse('2026-10-05T16:00:00Z') / 1000);
    const headers = { Cookie: `__Host-p_vid=${UUID}`, 'User-Agent': 'Android MicroMessenger' };
    collectAnalytics(new Request(`${ORIGIN}/?ch=external-name&ref=secret`, { headers }), html(), env, midnight, ctx);
    midnight.advance(-1);
    collectAnalytics(new Request(`${ORIGIN}/dl/latest/android?ch=direct`, { headers }),
      new Response(null, { status: 302, headers: { Location: 'https://artifact.invalid/latest.apk' } }), env, midnight, ctx);
    await Promise.all(ctx.tasks);
    const rows = await env.DB.prepare('SELECT * FROM analytics_daily ORDER BY day').all();
    expect(rows.results).toMatchObject([
      { day: '2026-10-05', channel: 'direct', downloads: 1, requests: 0, terminal: 'wechat' },
      { day: '2026-10-06', channel: 'unknown', downloads: 0, requests: 1 }
    ]);
    const visitor = await env.DB.prepare('SELECT visitor_hash FROM analytics_visitors').first();
    expect(visitor).toEqual({ visitor_hash: await hashVisitor(UUID, SECRET) });
    expect(JSON.stringify(rows.results)).not.toContain('secret');
    expect(JSON.stringify(visitor)).not.toContain(UUID);
  });

  it.each<Record<string, string>>([{ 'Sec-GPC': '1' }, { DNT: '1' }, { Cookie: '__Host-p_vid=corrupt' },
    { Cookie: `__Host-p_vid=${UUID}; __Host-p_vid=${UUID}` }])('ignores opted-out/corrupted identity %j', async (extra) => {
    const env = await enabled();
    const ctx = context();
    collectAnalytics(new Request(ORIGIN, { headers: { Cookie: `__Host-p_vid=${UUID}`, ...extra } }), html(), env, clock, ctx);
    await Promise.all(ctx.tasks);
    expect(env.db.count('analytics_daily')).toBe(1);
    expect(env.db.count('analytics_visitors')).toBe(0);
  });

  it.each(['sync', 'async'])('sanitizes %s DB failures without breaking the response or waitUntil', async (mode) => {
    const signal = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const env = await enabled();
      const db = { prepare: () => { if (mode === 'sync') throw new Error('private-url-cookie'); return env.DB.prepare('SELECT 1'); },
        batch: () => Promise.reject(new Error('private-url-cookie')) } as unknown as D1Database;
      const ctx = context();
      const result = collectAnalytics(new Request(ORIGIN), html(), { ...env, DB: db }, clock, ctx);
      expect(result.status).toBe(200);
      expect(ctx.waitUntil).toHaveBeenCalledOnce();
      await expect(Promise.all(ctx.tasks)).resolves.toBeDefined();
      expect(signal).toHaveBeenCalledWith('analytics_write_failed');
      expect(JSON.stringify(signal.mock.calls)).not.toContain('private-url-cookie');
    } finally { signal.mockRestore(); }
  });
});

 describe('explicit same-origin consent and script-free privacy workflow', () => {
  it('agree issues only a random host cookie, does not persist plaintext', async () => {
    const env = await enabled();
    const response = await handleAnalyticsConsent(consent('agree'), env, clock);
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toMatch(/^__Host-p_vid=[0-9a-f-]{36};.*Secure.*HttpOnly.*SameSite=Lax.*Path=\/.*Max-Age=15552000/);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(env.db.count('analytics_visitors')).toBe(0);
  });

  it('revoke awaits deletion, clears cookie, keeps anonymous totals', async () => {
    const env = await enabled();
    const ctx = context();
    collectAnalytics(new Request(ORIGIN, { headers: { Cookie: `__Host-p_vid=${UUID}` } }), html(), env, clock, ctx);
    await Promise.all(ctx.tasks);
    const response = await handleAnalyticsConsent(consent('revoke', { Cookie: `__Host-p_vid=${UUID}` }), env, clock);
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect(env.db.count('analytics_visitors')).toBe(0);
    expect(env.db.count('analytics_visitor_days')).toBe(0);
    expect(env.db.count('analytics_daily')).toBe(1);
  });

  it('revoke cannot claim success on DB failure (even when collection is disabled)', async () => {
    const env = await enabled();
    const signal = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = await handleAnalyticsConsent(consent('revoke', { Cookie: `__Host-p_vid=${UUID}` }),
        { ...env, ANALYTICS_ENABLED: 'false', DB: { batch: () => Promise.reject(new Error('secret')), prepare: env.DB.prepare.bind(env.DB) } as unknown as D1Database }, clock);
      expect(response.status).toBe(503);
      expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
      expect(await response.text()).not.toContain('secret');
    } finally { signal.mockRestore(); }
  });

  it.each<Record<string, string>>([{ Origin: 'https://evil.invalid' }, { Origin: 'null' }, { Origin: '' },
    { 'Sec-GPC': '1' }, { DNT: '1' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'none' }])('does not grant consent for %j', async (headers) => {
    const response = await handleAnalyticsConsent(consent('agree', headers), await enabled(), clock);
    expect(response.status).toBe(403);
    expect(response.headers.get('Set-Cookie') ?? '').not.toContain('Max-Age=15552000');
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
  });

  it.each(['same-origin', 'same-site'])('grants consent when Sec-Fetch-Site is %j with exact-origin', async (fetchSite) => {
    const response = await handleAnalyticsConsent(consent('agree', { 'Sec-Fetch-Site': fetchSite }), await enabled(), clock);
    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie') ?? '').toContain('Max-Age=15552000');
  });

  it.each(['{}', 'null', '[]', '{', '{"action":"other"}', '{"action":"agree","extra":1}'])('rejects malformed input %s', async (body) => {
    expect((await handleAnalyticsConsent(consent('', {}, body), await enabled(), clock)).status).toBe(400);
  });

  it('accepts 8192 bytes, rejects 8193 bytes independently of Content-Length', async () => {
    const env = await enabled();
    const body = JSON.stringify({ action: 'agree' });
    expect((await handleAnalyticsConsent(consent('', {}, body + ' '.repeat(8192 - body.length)), env, clock)).status).toBe(200);
    expect((await handleAnalyticsConsent(consent('', { 'Content-Length': '1' }, body + ' '.repeat(8193 - body.length)), env, clock)).status).toBe(413);
  });

  it('privacy GET exposes two same-origin form actions; form POST returns usable HTML without script', async () => {
    const page = privacyPage();
    expect(page.status).toBe(200);
    const markup = await page.text();
    expect(markup).toContain('action="/api/analytics/consent"');
    expect(markup).toContain('value="agree"');
    expect(markup).toContain('value="revoke"');
    expect(markup).not.toMatch(/<script|\son\w+\s*=/i);
    const response = await handleAnalyticsConsent(consent('', { 'Content-Type': 'application/x-www-form-urlencoded' }, 'action=agree'), await enabled(), clock);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(await response.text()).toContain('/privacy');
    expect((await handleAnalyticsConsent(consent('', { 'Content-Type': 'application/x-www-form-urlencoded' }, 'action=agree&action=revoke'), await enabled(), clock)).status).toBe(400);
  });

  it('fails closed without feature/secret; GET never grants consent', async () => {
    const env = await enabled();
    expect((await handleAnalyticsConsent(consent('agree'), { ...env, ANALYTICS_ENABLED: undefined }, clock)).status).toBe(503);
    expect((await handleAnalyticsConsent(consent('agree'), { ...env, ANALYTICS_HASH_SECRET: undefined }, clock)).status).toBe(503);
    expect((await handleAnalyticsConsent(new Request(`${ORIGIN}/api/analytics/consent`), env, clock)).status).toBe(405);
  });
});

 describe('bounded indexed retention cleanup', () => {
  it('uses supplied now, retains boundary rows, deletes at most 1000 per table including expired sessions', async () => {
    const env = await enabled();
    const dayAt = (seconds: number) => new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 10);
    const oldDay = dayAt(NOW - 366 * DAY);
    const dailyBoundary = dayAt(NOW - 365 * DAY);
    const visitorBoundary = dayAt(NOW - 180 * DAY);
    const vdBoundary = dayAt(NOW - 90 * DAY);
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < 1002; i++) {
      statements.push(env.DB.prepare('INSERT INTO analytics_visitors VALUES (?, ?, ?, ?)').bind(`v${i}`, oldDay, NOW, 'direct'));
      statements.push(env.DB.prepare('INSERT INTO analytics_visitor_days VALUES (?, ?, ?, 1, 0, ?)').bind(oldDay, `v${i}`, 'portal', NOW));
      statements.push(env.DB.prepare('INSERT INTO admin_login_limits VALUES (?, ?, 1, 0, 0, ?)').bind(`ip${i}`, NOW - DAY - 1, NOW));
    }
    statements.push(env.DB.prepare('INSERT INTO analytics_visitors VALUES (?, ?, ?, ?)').bind('keep', visitorBoundary, NOW, 'direct'));
    statements.push(env.DB.prepare('INSERT INTO analytics_visitor_days VALUES (?, ?, ?, 1, 0, ?)').bind(vdBoundary, 'keep', 'portal', NOW));
    for (const day of [oldDay, dailyBoundary]) statements.push(env.DB.prepare('INSERT INTO analytics_daily VALUES (?, ?, ?, ?, 1, 0, ?)').bind(day, 'portal', 'direct', 'other', NOW));
    for (const expiry of [NOW, NOW + 1]) statements.push(env.DB.prepare('INSERT INTO admin_sessions VALUES (?, ?, ?, ?, 1)').bind(`s${expiry}`, 'csrf', NOW - 100, expiry));
    statements.push(env.DB.prepare('INSERT INTO admin_login_limits VALUES (?, ?, 1, 0, 0, ?)').bind('keep', NOW - DAY, NOW));
    statements.push(env.DB.prepare('INSERT INTO admin_audit_logs (action, created_at) VALUES (?, ?)').bind('TEST', NOW - 365 * DAY - 1));
    await env.DB.batch(statements);
    await cleanupAnalytics(env, clock);
    expect(env.db.count('analytics_visitors')).toBe(3);
    expect(env.db.count('analytics_visitor_days')).toBe(3);
    expect(env.db.count('analytics_daily')).toBe(1);
    expect(env.db.count('admin_sessions')).toBe(1);
    expect(env.db.count('admin_login_limits')).toBe(3);
    expect(env.db.count('admin_audit_logs')).toBe(0);
    const plan = await env.DB.prepare('EXPLAIN QUERY PLAN SELECT rowid FROM admin_login_limits WHERE window_start < ? ORDER BY window_start LIMIT 1000').bind(NOW - DAY).all();
    expect(JSON.stringify(plan.results)).toContain('INDEX');
  });
});
