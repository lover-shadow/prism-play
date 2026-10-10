import type { Clock } from '../core/clock';
import type { Env, RequestContext } from '../types/env';
import { noStoreJson, jsonResponse } from '../http/json';
import { errorResponseNoStore } from '../http/errors';
import { readPublicManifest } from '../library/manifest';
import { isSafeWorkId } from '../library/contract';
import { publicDiscoveryContext, readPublicFact } from '../search/public-facts';
import { readDiscoveryCard } from '../search/discovery-cards';
import { readDiscoveryConfig } from '../search/discovery-config';
import { prepareCardDetail } from '../search/discovery-prepared';
import { DISCOVERY_BACKGROUND_BUDGET } from '../search/discovery-budget';
import { acquireDiscoveryLease, releaseDiscoveryLease, renewDiscoveryLease, consumeDiscoveryRate, discoveryQueryKey } from '../search/discovery-query';
import { handleTitles } from './titles';
import type { TitleAssetResponse, TitleAsset } from '../library/title-asset';

interface PrefetchInput { requestId: string; episodeNumbers: number[]; reason: 'lookahead' | 'resume' }
async function inputOf(request: Request): Promise<PrefetchInput | null> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json') || !request.body) return null;
  const reader = request.body.getReader(); let bytes = 0, text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length; if (bytes > 4096) { await reader.cancel(); return null; }
      text += decoder.decode(part.value, { stream: true });
    }
    const body = JSON.parse(text + decoder.decode()) as PrefetchInput;
    if (!body || Object.keys(body).sort().join(',') !== 'episodeNumbers,reason,requestId' ||
      typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(body.requestId) ||
      !['lookahead', 'resume'].includes(body.reason) || !Array.isArray(body.episodeNumbers) ||
      !body.episodeNumbers.length || body.episodeNumbers.length > 4 ||
      body.episodeNumbers.some(n => !Number.isSafeInteger(n) || n < 1 || n > 5000) ||
      new Set(body.episodeNumbers).size !== body.episodeNumbers.length ||
      Math.max(...body.episodeNumbers) - Math.min(...body.episodeNumbers) > 3) return null;
    return body;
  } catch { return null; } finally { reader.releaseLock(); }
}

/** Public metadata preparation only: never fetch video segments, private keys or private facts. */
export async function handleTitlePrefetch(request: Request, env: Env, clock: Clock, ctx?: RequestContext): Promise<Response> {
  try { return await prefetch(request, env, clock, ctx); }
  catch { return errorResponseNoStore('SERVICE_UNAVAILABLE'); }
}
async function prefetch(request: Request, env: Env, clock: Clock, ctx?: RequestContext): Promise<Response> {
  const url = new URL(request.url), match = /^\/api\/titles\/([^/]+)\/prefetch\/?$/.exec(url.pathname);
  let workId: string;
  try { workId = decodeURIComponent(match?.[1] ?? ''); } catch { return errorResponseNoStore('NOT_FOUND'); }
  if (!isSafeWorkId(workId)) return errorResponseNoStore('NOT_FOUND');
  const input = await inputOf(request);
  if (!input || url.search) return errorResponseNoStore('VALIDATION_ERROR');
  const manifest = await readPublicManifest(env.KV);
  if (!manifest) return errorResponseNoStore('SERVICE_UNAVAILABLE');
  const reply = (accepted: number, deduped: boolean, status = 202, reason?: string) =>
    noStoreJson({ schema: 1, requestId: input.requestId, accepted, deduped, ...(reason ? { reason } : {}), servedAt: clock.nowSeconds() }, status);
  const caller = await discoveryQueryKey(request.headers.get('CF-Connecting-IP') ?? 'unknown', 'prefetch-caller:v1');
  const rate = await consumeDiscoveryRate(env.DB, `prefetch:${caller.qhash}`, clock.nowSeconds(), 12, 60);
  if (!rate.allowed) return jsonResponse({ success: false, code: 'RATE_LIMITED', message: '预热请求过于频繁，请稍后重试' }, 429,
    { 'Cache-Control': 'no-store', 'Retry-After': String(rate.retryAfter) });
  const context = publicDiscoveryContext(env, manifest, () => clock.nowSeconds());
  const read = manifest.workFacts ? await readPublicFact(env, manifest, workId, clock.nowSeconds()) : null;
  let asset: Pick<TitleAsset, 'episodes' | 'isPrivate' | 'channelId'> | null = read?.status === 'ok' ? read.fact.asset : null;
  if (!manifest.workFacts) {
    // The legacy title reader remains useful for stored public facts; no cold on-demand path is allowed here.
    const response = await handleTitles(new Request(new URL(`/api/titles/${encodeURIComponent(workId)}`, url.origin)),
      env, clock, { resolveCard: async () => null });
    if (response.status === 200) asset = await response.json() as TitleAssetResponse;
    else if (response.status === 503) return errorResponseNoStore('SERVICE_UNAVAILABLE');
  }
  if (read?.status === 'rejected') return errorResponseNoStore('SERVICE_UNAVAILABLE');
  if (asset) {
    if (asset.isPrivate || asset.channelId === 'private') return errorResponseNoStore('NOT_FOUND');
    const latest = await readPublicManifest(env.KV);
    if (!latest || latest.revision !== manifest.revision) return errorResponseNoStore('SERVICE_UNAVAILABLE');
    if (!input.episodeNumbers.every(n => asset!.episodes.some(ep => ep.episodeNumber === n && ep.lines.length > 0))) return errorResponseNoStore('NOT_FOUND');
    return reply(0, false, 200, 'already_ready');
  }
  if (env.SEARCH_DISCOVERY_ENABLED !== 'true' || !env.DISCOVERY_BUCKET) return errorResponseNoStore('NOT_FOUND');
  const stored = await readDiscoveryCard(context, workId);
  if (!stored || (stored.candidate.episodeCount !== undefined && input.episodeNumbers.some(n => n > stored.candidate.episodeCount!))) return errorResponseNoStore('NOT_FOUND');
  if (!ctx) return errorResponseNoStore('SERVICE_UNAVAILABLE');
  const lease = await acquireDiscoveryLease(env.DB, `prefetch:${workId}`, clock.nowSeconds(), 30);
  if (!lease) return reply(0, true);
  const acceptedEpisodes: number[] = [];
  try {
    for (const episode of input.episodeNumbers) {
      if ((await consumeDiscoveryRate(env.DB, `prefetch-episode:${workId}:${episode}`, clock.nowSeconds(), 1, 30)).allowed) acceptedEpisodes.push(episode);
    }
    if (!acceptedEpisodes.length) { await releaseDiscoveryLease(env.DB, lease); return reply(0, true); }
  } catch { await releaseDiscoveryLease(env.DB, lease); return errorResponseNoStore('SERVICE_UNAVAILABLE'); }
  // Only metadata for this bounded work is queued. An owner check fences every final fact publication.
  let start!: (registered: boolean) => void;
  const registration = new Promise<boolean>(resolve => { start = resolve; });
  const task = (async () => {
    if (!await registration) return;
    let lost = false, renewal: Promise<void> = Promise.resolve();
    const heartbeat = setInterval(() => {
      renewal = renewal.then(async () => { if (!await renewDiscoveryLease(env.DB, lease, clock.nowSeconds(), 30)) lost = true; })
        .catch(() => { lost = true; });
    }, 10000);
    try {
      context.authority = async identity => {
        const latest = await readPublicManifest(env.KV);
        return latest ? publicDiscoveryContext(env, latest, () => clock.nowSeconds()).authority(identity)
          : { authoritative: true, read: { status: 'rejected' } };
      };
      const prepared = await prepareCardDetail(context, workId, readDiscoveryConfig(env).providers, DISCOVERY_BACKGROUND_BUDGET);
      if (!prepared || lost || !await renewDiscoveryLease(env.DB, lease, clock.nowSeconds(), 30)) return;
      if (!input.episodeNumbers.every(n => prepared.validated.asset.episodes.some(ep => ep.episodeNumber === n && ep.lines.length))) return;
      await prepared.publish(lease);
    } catch { console.error('metadata prefetch failed'); }
    finally {
      clearInterval(heartbeat); await renewal;
      try { await releaseDiscoveryLease(env.DB, lease); } catch { console.error('metadata prefetch lease cleanup failed'); }
    }
  })();
  try { ctx.waitUntil(task); start(true); }
  catch { start(false); await releaseDiscoveryLease(env.DB, lease); return errorResponseNoStore('SERVICE_UNAVAILABLE'); }
  return reply(acceptedEpisodes.length, false);
}
