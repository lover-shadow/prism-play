import type { Clock } from '../core/clock';
import { recordAnalytics, type AnalyticsKind, type AnalyticsSurface } from '../db/analytics-repo';
import { detectAudience } from '../routes/dl';
import { dramaIdFromPath, parseRequestedEpisode } from '../routes/share';
import { analyticsDay, analyticsNow, hashVisitor, privacyOptOut, readVisitor, type AnalyticsEnv } from './visitor';

export interface AnalyticsContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Only these pre-registered codes may reach D1; never preserve arbitrary query/Referer values. */
export const ANALYTICS_CHANNELS = ['direct', 'unknown'] as const;
export function analyticsChannel(url: URL): typeof ANALYTICS_CHANNELS[number] {
  const channels = url.searchParams.getAll('ch');
  if (channels.length === 0) return 'direct';
  return channels.length === 1 && channels[0] === 'direct' ? 'direct' : 'unknown';
}

function eligible(request: Request, response: Response, url: URL): { surface: AnalyticsSurface; kind: AnalyticsKind } | null {
  if (request.method !== 'GET') return null;
  if (/bot|crawler|spider|slurp|facebookexternalhit|facebot|ia_archiver|headless|preview|embedly|validator/i
    .test(request.headers.get('User-Agent') ?? '')) return null;
  if (url.pathname === '/dl/latest/android' && response.status === 302) return { surface: 'dl', kind: 'download' };
  if (response.status !== 200 || !/^text\/html(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '')) return null;
  if (url.pathname === '/') return { surface: 'portal', kind: 'page' };
  if (url.pathname === '/dl') return { surface: 'dl', kind: 'page' };
  // The supplied successful route response is the public/shareable visibility proof. No second DB
  // lookup here: the wrapper must only be applied after the normal share handler's denial gates.
  if (dramaIdFromPath(url.pathname) !== null && parseRequestedEpisode(url.searchParams.get('ep')) !== null) {
    return { surface: 'share', kind: 'page' };
  }
  return null;
}

/** Fixed signal only: never attach exceptions, request URLs, cookie values or content ids. */
export function analyticsFailure(signal: 'analytics_write_failed' | 'analytics_revoke_failed'): void {
  console.warn(signal);
}

/** Synchronous response wrapper; all hashing and SQL are deferred into a caught waitUntil promise. */
export function collectAnalytics(
  request: Request, response: Response, env: AnalyticsEnv, clock: Clock, ctx: AnalyticsContext
): Response {
  if (env.ANALYTICS_ENABLED !== 'true') return response;
  const url = new URL(request.url);
  const scope = eligible(request, response, url);
  if (scope === null) return response;
  const seconds = analyticsNow(clock);
  const day = analyticsDay(seconds);
  const channel = analyticsChannel(url);
  const terminal = detectAudience(request.headers.get('User-Agent'));
  const visitor = privacyOptOut(request) ? null : readVisitor(request);
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  // Do not let CDN-specific cache directives override the browser cache policy.
  headers.delete('CDN-Cache-Control');
  headers.delete('Cloudflare-CDN-Cache-Control');
  const wrapped = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  const task = Promise.resolve().then(async () => {
    const visitorHash = visitor !== null && env.ANALYTICS_HASH_SECRET
      ? await hashVisitor(visitor, env.ANALYTICS_HASH_SECRET) : null;
    await recordAnalytics(env.DB, { day, ...scope, channel, terminal, visitorHash }, seconds);
  }).catch(() => { analyticsFailure('analytics_write_failed'); });
  try { ctx.waitUntil(task); } catch { analyticsFailure('analytics_write_failed'); }
  return wrapped;
}
