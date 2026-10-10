import type { Clock } from '../core/clock';
import type { Env, RequestContext } from '../types/env';
import { handleTitles } from './titles';
import { errorResponseNoStore as errorResponse } from '../http/errors';
import { readPublicManifest } from '../library/manifest';
import { publicDiscoveryContext } from '../search/public-facts';
import { readDiscoveryCard } from '../search/discovery-cards';
import { noStoreJson } from '../http/json';
import { factsHash } from '../library/work-facts';
import type { TitleAssetResponse } from '../library/title-asset';
import { prepareCardDetail, type PreparedDiscovery } from '../search/discovery-prepared';

/** Same admission and full-fact validation as title; only target lines are returned. */
export async function handleTitleBootstrap(request: Request, env: Env, clock: Clock, ctx?: RequestContext): Promise<Response> {
  const url = new URL(request.url), values = url.searchParams.getAll('ep');
  if ([...url.searchParams.keys()].some(key => key !== 'ep') || values.length > 1 ||
    (values.length === 1 && !/^[1-9]\d{0,3}$/.test(values[0])) || Number(values[0] ?? 1) > 5000) {
    return errorResponse('VALIDATION_ERROR');
  }
  const ep = Number(values[0] ?? 1);
  const match = /^\/api\/titles\/([^/]+)\/bootstrap\/?$/.exec(url.pathname);
  if (!match) return errorResponse('NOT_FOUND');
  url.pathname = `/api/titles/${match[1]}`; url.search = '';
  let revision = 0, prepared: PreparedDiscovery | null = null;
  const titleRequest = new Request(url, request);
  const response = await handleTitles(titleRequest, env, clock, {
    onRevision: value => { revision = value; },
    resolveCard: async (context, workId, configs) => {
      if (!ctx) throw new Error('Background context required for cold bootstrap');
      prepared = await prepareCardDetail(context, workId, configs);
      return prepared?.validated.asset ?? null;
    }
  });
  if (response.status !== 200) {
    const headers = new Headers(response.headers); headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  }
  const full = await response.json() as TitleAssetResponse;
  const target = full.episodes.find(episode => episode.episodeNumber === ep);
  if (!target) return errorResponse('NOT_FOUND');
  if (!target.lines.length || target.lines.length > 32) return errorResponse('SERVICE_UNAVAILABLE');
  const factVersion = await factsHash(new TextEncoder().encode(JSON.stringify(full)));
  const manifest = await readPublicManifest(env.KV);
  if (!manifest || manifest.revision !== revision) return errorResponse('SERVICE_UNAVAILABLE');
  if (prepared) {
    const live = await readDiscoveryCard(publicDiscoveryContext(env, manifest, () => clock.nowSeconds()), full.workId);
    if (!live || JSON.stringify(live.candidate) !== (prepared as PreparedDiscovery).candidateJson) return errorResponse('NOT_FOUND');
  }
  // Registration is not a persistence receipt: waitUntil failure leaves normal full title retryable.
  const pending = prepared as PreparedDiscovery | null;
  if (pending) ctx!.waitUntil(pending.publish().catch(() => { console.error('bootstrap background publication failed'); }));
  return noStoreJson({ schema: 1, workId: full.workId, revision, factVersion, item: full.item,
    targetEpisode: { ...target, lines: target.lines.map((line, lineIndex) => ({ ...line, lineIndex })) },
    catalogStatus: 'complete', persistenceStatus: pending ? 'scheduled' : 'stored',
    generatedAt: full.generatedAt, servedAt: clock.nowSeconds() });
}
