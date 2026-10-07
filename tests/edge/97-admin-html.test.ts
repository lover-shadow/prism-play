import { describe, expect, it } from 'vitest';
// jsdom is installed; the edge project intentionally has no browser DOM typings.
// @ts-expect-error jsdom has no declaration package in this workspace
import { JSDOM } from 'jsdom';
import { Script } from 'node:vm';
import { renderAdminPage, adminScript, adminStyles } from '../../edge/src/html/admin-page';
import { inlineThemeStyles, inlineDayPaletteStyles } from '../../edge/src/html/theme';

type HTMLInputElement = { value: string; checked: boolean };
type HTMLTextAreaElement = { value: string };
type HTMLButtonElement = { disabled: boolean };
type HTMLFormElement = { elements: { namedItem(name: string): unknown } };
type TestElement = { dispatchEvent(event: unknown): unknown };

const settle = async () => { for (let index = 0; index < 20; index++) await new Promise(resolve => setTimeout(resolve, 0)); };
function harness(clipboardFails = false) {
  const dom = new JSDOM(renderAdminPage(), { url: 'https://example.test/admin', runScripts: 'outside-only' });
  const { window } = dom;
  const calls: { path: string; body?: Record<string, unknown>; csrf?: string }[] = [];
  const malicious = '<img src=x onerror=alert(1)>';
  const id = 'a'.repeat(64);
  const fullCode = 'GY-ABCD-EFGH-IJKL';
  let authorized = false;
  Object.defineProperty(window, 'isSecureContext', { value: true });
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => { if (clipboardFails) throw new Error('denied'); } } });
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  Object.assign(window, { fetch: async (url: string, init: RequestInit) => {
    const path = url.replace('/api/admin/', '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body, csrf: (init.headers as Record<string, string>)['X-CSRF-Token'] });
    if (path === 'login') authorized = body.password === 'test-password';
    if (path === 'logout') authorized = false;
    if (!authorized && path !== 'logout') return { status: 401, ok: false };
    let data: unknown = {};
    if (path === 'login' || path === 'session') data = { csrf: 'test-csrf', expiresAt: Math.floor(Date.now() / 1000) + 3600 };
    if (path.startsWith('dashboard')) data = { fromDay: '2026-10-01', toDay: '2026-10-06', series: [{ day: '2026-10-01', requests: 4, downloads: 1 }], uv: 2, conversionRate: 0.5 };
    if (path.startsWith('coupons?')) data = { items: [{ id, maskedCode: 'GY-****-****-IJKL', tier: 'Q', tier_name: malicious, status: 'ACTIVE', device_count: 0, max_devices: 10, dispatch_status: 'UNKNOWN', note: malicious }], page: 1, limit: 20, total: 1 };
    if (path === 'operations') data = { authorizedDevices: [], lineSignals: [], lineSignalNotice: malicious, version: { name: malicious } };
    if (path === 'coupons/generate') data = { codes: [fullCode], created: true };
    if (path.endsWith('/reveal')) data = { code: fullCode };
    if (path === 'coupons/' + id) data = { bindings: [{ device_id: malicious, bound_at: 1 }] };
    if (path.endsWith('/confirm-stock')) data = { status: 'confirmed' };
    return { status: 200, ok: true, json: async () => data };
  } });
  window.eval(adminScript);
  const click = (element: TestElement) => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const submit = (id: string) => window.document.getElementById(id)!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  const login = async () => {
    await settle();
    (window.document.querySelector('[name=password]') as HTMLInputElement).value = 'test-password';
    submit('login'); await settle();
  };
  return { dom, window, calls, fullCode, malicious, click, submit, login };
}

describe('admin HTML and same-origin assets', () => {
  it('renders a public shell with external assets, proper login and no protected payload', () => {
    const dom = new JSDOM(renderAdminPage());
    const doc = dom.window.document;
    expect(doc.querySelector('html')?.lang).toBe('zh-CN');
    expect(doc.querySelector('script')?.getAttribute('src')).toBe('/admin/assets/app.js');
    expect(doc.querySelector('link[rel=stylesheet]')?.getAttribute('href')).toBe('/admin/assets/app.css');
    expect(doc.querySelector('form#login')?.getAttribute('action')).toBe('/api/admin/login');
    expect(doc.querySelector('form#login')?.getAttribute('method')).toBe('post');
    expect(doc.querySelector('[name=password]')?.getAttribute('type')).toBe('password');
    expect(doc.querySelector('#workspace')?.hasAttribute('hidden')).toBe(true);
    expect(doc.querySelectorAll('style,[style],[onclick]').length).toBe(0);
    expect(doc.querySelector('script')?.textContent).toBe('');
    expect(doc.querySelector('#coupon-rows')?.textContent).toBe('');
    expect(doc.querySelector('#full-codes')?.textContent).toBe('');
    expect(doc.querySelector('#detail')?.textContent).toBe('');
    expect(renderAdminPage()).not.toMatch(/GY-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/);
    for (const svg of doc.querySelectorAll('svg')) {
      expect(['16', '20', '24']).toContain(svg.getAttribute('width'));
      expect(svg.getAttribute('stroke-width')).toBe('2');
    }
    dom.window.close();
  });
  it('compiles as native JavaScript and reuses the existing visual token palettes', () => {
    expect(() => new Script(adminScript)).not.toThrow();
    expect(adminScript).not.toMatch(/innerHTML|localStorage|sessionStorage|eval\(|document\.write/);
    expect(adminStyles).toContain(inlineThemeStyles());
    expect(adminStyles).toContain(inlineDayPaletteStyles());
    expect(adminStyles).toContain('@media (max-width: 600px)');
    expect(adminStyles).not.toContain('gradient');
  });
  it('refreshes session, sends JSON login, renders API text safely and clears on logout', async () => {
    const h = harness();
    try {
      await h.login();
      expect(h.calls.find(call => call.path === 'login')?.body).toEqual({ password: 'test-password' });
      expect(h.window.document.getElementById('workspace')?.hidden).toBe(false);
      expect(h.window.document.querySelector('[name=password]')?.getAttribute('value')).toBeNull();
      expect((h.window.document.querySelector('[name=password]') as HTMLInputElement).value).toBe('');
      expect(h.window.document.querySelectorAll('img').length).toBe(0);
      expect(h.window.document.getElementById('coupon-rows')?.textContent).toContain(h.malicious);
      expect(h.window.document.getElementById('metrics')?.textContent).toContain('50.0%');
      h.click(h.window.document.getElementById('logout')!); await settle();
      expect(h.calls.find(call => call.path === 'logout')?.csrf).toBe('test-csrf');
      expect(h.window.document.getElementById('workspace')?.hidden).toBe(true);
      expect(h.window.document.getElementById('coupon-rows')?.textContent).toBe('');
    } finally { h.window.close(); }
  });
  it('generates idempotent batches and offers an honest manual clipboard fallback without dispatch', async () => {
    const h = harness(true);
    try {
      await h.login();
      const form = h.window.document.getElementById('generate') as HTMLFormElement;
      const request = (form.elements.namedItem('requestId') as HTMLInputElement).value;
      h.submit('generate'); await settle();
      expect(h.calls.find(call => call.path === 'coupons/generate')?.body).toMatchObject({ tier: 'Q', count: 1, requestId: request });
      expect((form.elements.namedItem('requestId') as HTMLInputElement).value).toBe(request);
      expect((h.window.document.getElementById('full-codes') as HTMLTextAreaElement).value).toBe(h.fullCode);
      h.click(h.window.document.getElementById('copy')!); await settle();
      expect(h.window.document.getElementById('copy-status')?.textContent).toContain('未确认复制成功');
      expect(h.calls.some(call => call.path.endsWith('/dispatch'))).toBe(false);
      h.click(h.window.document.querySelector('[data-close=code-dialog]')!);
      expect((h.window.document.getElementById('full-codes') as HTMLTextAreaElement).value).toBe('');
    } finally { h.window.close(); }
  });
  it('requires explicit UNKNOWN stock confirmation and uses CSRF plus an opaque target', async () => {
    const h = harness();
    try {
      await h.login();
      const stock = [...h.window.document.querySelectorAll('#coupon-rows button')].find(button => button.textContent === '确认库存')!;
      const dispatch = [...h.window.document.querySelectorAll('#coupon-rows button')].find(button => button.textContent === '确认分发') as HTMLButtonElement;
      expect(dispatch.disabled).toBe(true);
      h.click(stock); await settle();
      h.submit('mutation'); await settle();
      expect(h.calls.some(call => call.path.endsWith('/confirm-stock'))).toBe(false);
      (h.window.document.querySelector('[name=confirmed]') as HTMLInputElement).checked = true;
      h.submit('mutation'); await settle();
      const call = h.calls.find(call => call.path.endsWith('/confirm-stock'))!;
      expect(call.path).toMatch(/^coupons\/[a-f0-9]{64}\/confirm-stock$/);
      expect(call.body?.requestId).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
      expect(call.csrf).toBe('test-csrf');
    } finally { h.window.close(); }
  });
});
