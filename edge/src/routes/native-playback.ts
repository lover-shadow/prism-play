import type { Clock } from '../core/clock';
import type { Env, RequestContext } from '../types/env';
import { handleTitleBootstrap } from './title-bootstrap';
import { noStoreJson } from '../http/json';
import { undifferentiatedNotFound } from './catalog';
import { handleTitles } from './titles';
import { parseTitleAsset } from '../library/title-asset';

export const NATIVE_PLAYBACK_PATH = /^\/api\/titles\/([A-Za-z0-9_.:-]{1,128})\/episodes\/([1-9]\d{0,6})\/native-playback$/;

export async function handleNativePlayback(request: Request, env: Env, clock: Clock, ctx?: RequestContext): Promise<Response> {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET', 'Cache-Control': 'no-store' } });
  const url = new URL(request.url), matched = NATIVE_PLAYBACK_PATH.exec(url.pathname);
  if (!matched) return undifferentiatedNotFound();
  const params = [...url.searchParams.entries()];
  if (params.length !== 1 || params[0][0] !== 'line' || !/^(0|[1-9]\d{0,3})$/.test(params[0][1])) {
    return undifferentiatedNotFound();
  }
  const workId = matched[1], episodeNumber = Number(matched[2]), lineIndex = Number(params[0][1]);
  if (ctx) {
    const targetUrl = new URL(`/api/titles/${encodeURIComponent(workId)}/bootstrap?ep=${episodeNumber}`, url.origin);
    const response = await handleTitleBootstrap(new Request(targetUrl, { headers: request.headers }), env, clock, ctx);
    if (!response.ok) return response;
    const body = await response.json() as { targetEpisode: { lines: { providerId: string; lineIndex: number; native?: { kind: string; videoId: string } }[] } };
    const line = body.targetEpisode.lines.find(entry => entry.lineIndex === lineIndex);
    if (line?.providerId !== 'provider_s1' || line.native?.kind !== 's1-cenc') return undifferentiatedNotFound();
    return noStoreJson({ workId, episodeNumber, lineIndex, native: line.native, checkedAt: clock.nowSeconds() });
  }
  const titleUrl = new URL(`/api/titles/${encodeURIComponent(workId)}`, url.origin);
  const titleRequest = new Request(titleUrl, { method: 'GET', headers: request.headers });
  const response = await handleTitles(titleRequest, env, clock);
  if (!response.ok) {
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  }
  const parsed = parseTitleAsset(await response.text(), workId);
  if (!parsed.ok) return undifferentiatedNotFound();
  const episode = parsed.value.episodes.find((entry) => entry.episodeNumber === episodeNumber);
  const line = episode?.lines[lineIndex];
  if (line?.providerId !== 'provider_s1' || line.native?.kind !== 's1-cenc') return undifferentiatedNotFound();
  return noStoreJson({
    workId, episodeNumber, lineIndex,
    native: { kind: line.native.kind, videoId: line.native.videoId },
    checkedAt: clock.nowSeconds()
  });
}
