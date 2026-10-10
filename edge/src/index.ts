import type { Env, RequestContext, ScheduledController } from './types/env';
import type { Clock } from './core/clock';
import { systemClock } from './core/clock';
import { errorResponse } from './http/errors';
import { pruneExpiredRevocations } from './auth/private-session';
import type { ProviderAdapter } from './ingest/adapter';
import { runIngestCycle } from './ingest/cron';
import { handleChannels } from './routes/channels';
import { handleCatalog } from './routes/catalog';
import { handleChanges } from './routes/changes';
import { handleDevicePing } from './routes/device-ping';
import { handleApkArtifact, handleApkDownload, handleDownloadLanding, handlePortal } from './routes/dl';
import { handleStaticAsset } from './routes/assets';
import { handleMonetizationConfig } from './routes/monetization';
import { handlePlayback } from './routes/playback';
import { handleNativePlayback } from './routes/native-playback';
import { handlePrivateSessions } from './routes/private-sessions';
import { handleProxy } from './routes/proxy';
import { handleCleanHls } from './routes/hls-clean';
import { handleRedeem } from './routes/redeem';
import { handleRelated } from './routes/related';
import { handleSearch } from './routes/search';
import { runScheduledDiscoveryRefresh, refreshOpenedPublicWork } from './search/scheduled-discovery';
import { handleSearchDiscoveries } from './routes/search-discovery';
import { handleSearchSuggestions } from './routes/search-suggestions';
import { handleShare } from './routes/share';
import { handleSources } from './routes/sources';
import { handleTitles } from './routes/titles';
import { handleTitleBootstrap } from './routes/title-bootstrap';
import { handleTitlePrefetch } from './routes/title-prefetch';
import { handleUserSync } from './routes/user-sync';
import { handleTelemetryLines } from './routes/telemetry';
import { handleVersion } from './routes/version';
import { handleAnnouncements } from './routes/announcements';
import { handleRobots, handleSitemap } from './routes/seo';
import { handleAdminRequest, isAdminPath } from './routes/admin-request';
import { collectAnalytics, analyticsFailure } from './analytics/collect';
import { cleanupAnalytics } from './analytics/cleanup';
import { handleAnalyticsConsent, privacyPage } from './routes/analytics-consent';

type RouteHandler = (request: Request, env: Env, clock: Clock) => Promise<Response>;

interface Route {
  /** Literal segments and `{param}` wildcards; a param matches exactly one non-empty segment. */
  readonly pattern: readonly string[];
  readonly allow: readonly string[];
  readonly handle: RouteHandler;
}

/**
 * All 19 endpoints of openapi.yaml are mounted here plus the two SPEC-STATIC-PAGES v2 surfaces
 * (`/` portal and `/assets/{file}`), in declaration order. Patterns that carry extra
 * segments are listed before their shorter prefixes so `/api/titles/{id}/related` cannot be swallowed
 * by `/api/titles/{id}`. `/proxy/{kind}/{handle}` keeps its multi-segment shape and is never collapsed
 * into a single `{path}` wildcard (dispatch package §四.4).
 */
const ROUTES: readonly Route[] = [
  { pattern: ['api', 'channels'], allow: ['GET'], handle: handleChannels },
  { pattern: ['api', 'sources'], allow: ['GET'], handle: handleSources },
  { pattern: ['api', 'catalog', 'changes'], allow: ['GET'], handle: handleChanges },
  { pattern: ['api', 'catalog'], allow: ['GET'], handle: handleCatalog },
  { pattern: ['api', 'search', 'suggestions'], allow: ['GET'], handle: handleSearchSuggestions },
  { pattern: ['api', 'search', 'discoveries'], allow: ['GET'], handle: handleSearchDiscoveries },
  { pattern: ['api', 'search'], allow: ['GET'], handle: handleSearch },
  { pattern: ['api', 'titles', '{titleId}', 'episodes', '{episodeNumber}', 'native-playback'], allow: ['GET'], handle: handleNativePlayback },
  { pattern: ['api', 'titles', '{titleId}', 'related'], allow: ['GET'], handle: handleRelated },
  { pattern: ['api', 'titles', '{titleId}', 'bootstrap'], allow: ['GET'], handle: handleTitleBootstrap },
  { pattern: ['api', 'titles', '{titleId}', 'prefetch'], allow: ['POST'], handle: handleTitlePrefetch },
  { pattern: ['api', 'titles', '{titleId}'], allow: ['GET'], handle: handleTitles },
  { pattern: ['api', 'episodes', '{episodeId}', 'playback'], allow: ['GET'], handle: handlePlayback },
  { pattern: ['api', 'private-sessions'], allow: ['POST', 'DELETE'], handle: handlePrivateSessions },
  { pattern: ['api', 'config', 'monetization'], allow: ['GET'], handle: handleMonetizationConfig },
  { pattern: ['api', 'redeem'], allow: ['POST'], handle: handleRedeem },
  { pattern: ['api', 'device', 'ping'], allow: ['GET'], handle: handleDevicePing },
  { pattern: ['api', 'user', 'sync'], allow: ['GET', 'POST'], handle: handleUserSync },
  { pattern: ['api', 'telemetry', 'lines'], allow: ['POST'], handle: handleTelemetryLines },
  { pattern: ['api', 'version'], allow: ['GET'], handle: handleVersion },
  { pattern: ['api', 'announcements'], allow: ['GET'], handle: handleAnnouncements },
  { pattern: ['robots.txt'], allow: ['GET'], handle: handleRobots },
  { pattern: ['sitemap.xml'], allow: ['GET'], handle: handleSitemap },
  { pattern: ['s', '{dramaId}'], allow: ['GET'], handle: handleShare },
  { pattern: ['dl', 'latest', '{platform}'], allow: ['GET'], handle: handleApkDownload },
  { pattern: ['dl', 'artifacts', '{versionCode}', '{file}'], allow: ['GET', 'HEAD'], handle: handleApkArtifact },
  { pattern: ['dl'], allow: ['GET'], handle: handleDownloadLanding },
  { pattern: ['assets', '{file}'], allow: ['GET'], handle: handleStaticAsset },
  { pattern: [], allow: ['GET'], handle: handlePortal },
  { pattern: ['proxy', 'hls', 'clean'], allow: ['GET'], handle: handleCleanHls },
  { pattern: ['proxy', '{kind}', '{handle}'], allow: ['GET'], handle: handleProxy }
];

function segmentsOf(pathname: string): string[] | null {
  if (pathname === '/') return [];
  // One trailing slash is tolerated because a shared `/s/<id>` link is pasted by hand; `//` is not.
  const cleaned = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (cleaned === '' || cleaned.includes('//')) return null;
  return cleaned.replace(/^\//, '').split('/');
}

function matches(pattern: readonly string[], segments: string[]): boolean {
  if (pattern.length !== segments.length) return false;
  return pattern.every((entry, index) => entry.startsWith('{') || entry === segments[index]);
}

function notFound(): Response {
  return errorResponse('NOT_FOUND');
}

function methodNotAllowed(allow: readonly string[]): Response {
  // Same shape as the sibling private-sessions route: a 405 carries no ErrorResponse body, because the
  // closed error enum pins each code to one status and 405 is not among them.
  return new Response(null, { status: 405, headers: { Allow: allow.join(', ') } });
}

function withCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin || '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Private-Session, Range');
  headers.set('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function routeRequest(request: Request, env: Env, clock: Clock, ctx?: RequestContext): Response | Promise<Response> {
  const origin = request.headers.get('Origin');
  if (request.method === 'OPTIONS') {
    return withCors(new Response(null, { status: 204 }), origin);
  }
  const segments = segmentsOf(new URL(request.url).pathname);
  if (segments === null) return withCors(notFound(), origin);
  const route = ROUTES.find((candidate) => matches(candidate.pattern, segments));
  if (route === undefined) return withCors(notFound(), origin);
  if (!route.allow.includes(request.method)) return withCors(methodNotAllowed(route.allow), origin);
  const outcome = route.handle === handleTitleBootstrap
    ? handleTitleBootstrap(request, env, clock, ctx) : route.handle === handleNativePlayback
      ? handleNativePlayback(request, env, clock, ctx) : route.handle === handleTitlePrefetch
        ? handleTitlePrefetch(request, env, clock, ctx) : route.handle(request, env, clock);
  return outcome instanceof Promise ? outcome.then((r) => withCors(r, origin)) : withCors(outcome, origin);
}

/**
 * Ingestion is adapter-injection only: the Worker performs no upstream call and knows no URL, so the
 * registry stays empty until Stage 2 registers an authorized source adapter (SPEC §12.2 需授权来源样本).
 */
export const PROVIDER_ADAPTERS: ReadonlyMap<string, ProviderAdapter> = new Map();

export interface ScheduledWorkReport {
  pruned: number;
  sources: number;
  recordsInserted: number;
}

/** The UTC 04:00 / 16:00 wake-up, exported so the suite can drive it without a Workers runtime. */
export async function runScheduledWork(env: Env, clock: Clock = systemClock): Promise<ScheduledWorkReport> {
  const pruned = await pruneExpiredRevocations(env.DB, clock.nowSeconds());
  const ingest = await runIngestCycle({ db: env.DB, adapters: PROVIDER_ADAPTERS, clock });
  const recordsInserted = ingest.sources.reduce((total, source) => total + source.recordsInserted, 0);
  return { pruned, sources: ingest.sources.length, recordsInserted };
}

export default {
  async fetch(request: Request, env: Env, ctx: RequestContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (isAdminPath(path)) return handleAdminRequest(request, env, systemClock);
    if (path === '/api/analytics/consent') return handleAnalyticsConsent(request, env, systemClock);
    if (path === '/privacy') return request.method === 'GET' ? privacyPage() : new Response(null, { status: 405 });
    const origin = request.headers.get('Origin');
    try {
      const response = await routeRequest(request, env, systemClock, ctx);
      if (env.SEARCH_DISCOVERY_ENABLED === 'true' && env.DISCOVERY_BUCKET && /^\/api\/titles\/[^/]+$/.test(path) && response.status === 200) {
        ctx.waitUntil(refreshOpenedPublicWork(request, response.clone(), env, systemClock).catch(() => { console.error('opened work refresh failed'); }));
      }
      return collectAnalytics(request, response, env, systemClock, ctx);
    } catch (error) {
      // A thrown defect must not answer 200 or leak a stack trace to the client.
      console.error('unhandled edge failure', request.method, new URL(request.url).pathname, error);
      return withCors(errorResponse('SERVICE_UNAVAILABLE'), origin);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: RequestContext): Promise<void> {
    ctx.waitUntil(runScheduledWork(env, systemClock));
    if (env.SEARCH_DISCOVERY_ENABLED === 'true' && env.DISCOVERY_BUCKET) {
      ctx.waitUntil(runScheduledDiscoveryRefresh(env, systemClock).catch(() => { console.error('discovery refresh failed'); }));
    }
    if (env.ANALYTICS_ENABLED === 'true') ctx.waitUntil(cleanupAnalytics(env, systemClock).catch(() => analyticsFailure('analytics_write_failed')));
  }
};
