import type { Clock } from '../core/clock';

/** Narrow bindings keep collection isolated from App authentication and configuration. */
export interface AnalyticsEnv {
  readonly DB: D1Database;
  readonly ANALYTICS_HASH_SECRET?: string;
  readonly ANALYTICS_ENABLED?: string;
}

export const VISITOR_COOKIE = '__Host-p_vid';
export const VISITOR_MAX_AGE = 180 * 86400;

export function privacyOptOut(request: Request): boolean {
  return request.headers.get('Sec-GPC') === '1' || request.headers.get('DNT') === '1';
}

/** Do not decode, repair or pick a winner among duplicate cookies. */
export function readVisitor(request: Request): string | null {
  const values = (request.headers.get('Cookie') ?? '').split(';')
    .map((part) => part.trim()).filter((part) => part.split('=')[0] === VISITOR_COOKIE);
  if (values.length !== 1) return null;
  const value = values[0].slice(VISITOR_COOKIE.length + 1);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value) ? value : null;
}

export async function hashVisitor(visitor: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(visitor));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function visitorCookie(value: string, maxAge = VISITOR_MAX_AGE): string {
  return `${VISITOR_COOKIE}=${value}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function analyticsDay(seconds: number): string {
  return new Date((seconds + 8 * 3600) * 1000).toISOString().slice(0, 10);
}

export function analyticsNow(clock: Clock): number {
  return Math.floor(clock.nowSeconds());
}
