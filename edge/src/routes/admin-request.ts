import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import { adminVersion, type AdminEnv } from '../auth/admin-session';
import { guardAdmin } from '../auth/admin-guard';
import { adminJson, handleAdminAuth } from './admin-auth';
import { handleAdminCouponRead } from './admin-coupons';
import { handleAdminDashboard } from './admin-dashboard';
import { handleAdminOperations } from './admin-operations';
import { handleAdminCouponWrite } from './admin-coupon-write';
import { renderAdminPage, adminScript, adminStyles } from '../html/admin-page';

export function isAdminPath(path: string): boolean {
  return path === '/admin' || path.startsWith('/admin/') || path === '/api/admin' || path.startsWith('/api/admin/');
}

export async function handleAdminRequest(request: Request, env: Env & AdminEnv, clock: Clock): Promise<Response> {
  try {
    if (adminVersion(env) === null) return adminJson({ code: 'UNAVAILABLE' }, 503);
    const path = new URL(request.url).pathname;
    if (request.method === 'GET' && ['/admin', '/admin/', '/admin/assets/app.js', '/admin/assets/app.css'].includes(path)) {
      const script = path.endsWith('.js');
      const style = path.endsWith('.css');
      return new Response(script ? adminScript : style ? adminStyles : renderAdminPage(), { headers: {
        'Content-Type': script ? 'application/javascript; charset=utf-8' : style ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
      } });
    }
    if (['/api/admin/login', '/api/admin/session', '/api/admin/logout'].includes(path)) return await handleAdminAuth(request, env, clock);
    const refusal = await guardAdmin(request, env, clock);
    if (refusal) return refusal;
    if (request.method === 'POST' && path.startsWith('/api/admin/coupons/')) return await handleAdminCouponWrite(request, env, clock);
    if (request.method !== 'GET') return adminJson({ code: 'METHOD_NOT_ALLOWED' }, 405);
    if (path === '/api/admin/coupons' || /^\/api\/admin\/coupons\/[a-f0-9]{64}$/.test(path)) return await handleAdminCouponRead(request, env);
    if (path === '/api/admin/dashboard') return await handleAdminDashboard(request, env, clock);
    if (path === '/api/admin/operations') return await handleAdminOperations(request, env, clock);
    return adminJson({ code: 'NOT_FOUND' }, 404);
  } catch {
    return adminJson({ code: 'UNAVAILABLE' }, 503);
  }
}
