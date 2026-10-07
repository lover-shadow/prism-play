import { describe, expect, it } from 'vitest';
import { readDiscoveryConfig } from '../../edge/src/search/discovery-config';
import { createS1Provider } from '../../edge/src/search/providers/s1';
import { record, router } from '../../edge/src/search/providers/parse';
import { protectedData } from '../../edge/src/search/providers/transport';
import type { DiscoveryConfig, DiscoveryResolveState } from '../../edge/src/search/discovery-provider';
import { detailHtml, firstPlayer, mediaOrigin, playerHtml, query, searchHtml, searchPage,
  serverConfigJson, sid, vids } from '../support/discovery-real-shape';

const serverConfig = readDiscoveryConfig({ SEARCH_DISCOVERY_ENABLED: 'true', SEARCH_DISCOVERY_CONFIG: serverConfigJson }).providers.provider_s1!;
const detail = record(router(detailHtml, 'detail_', (row) => !!row.seriesDetail).seriesDetail);
const budget = { maxRequests: 8, timeoutMs: 40000 };
function replay(transform?: (page: Record<string, unknown>, index: number) => void) {
  const calls: string[] = [];
  const config: DiscoveryConfig = { ...serverConfig, fetcher: async (raw) => {
    const url = new URL(raw); calls.push(url.pathname);
    if (url.pathname.startsWith('/search/')) return new Response(searchHtml);
    if (url.pathname === '/detail') return new Response(detailHtml);
    const index = vids.indexOf(url.pathname.split('/').pop()!);
    expect(index).toBeGreaterThanOrEqual(0);
    if (!transform && index === 0) return new Response(playerHtml);
    // Later player identities are synthetic extensions of the sanitized first-player shape.
    const page = structuredClone(firstPlayer); page.vid = vids[index];
    transform?.(page, index);
    return new Response(JSON.stringify({ loaderData: { 'player_(series_id)/(vid)/page': page } }));
  } };
  return { config, calls };
}
async function target(config: DiscoveryConfig) {
  expect(searchPage.searchList[0].keyword).toBe(query);
  expect(protectedData(searchPage.searchList[0])).toBe(false);
  expect(protectedData(searchPage)).toBe(false);
  const rows = await createS1Provider(config).search(query, 1);
  expect(rows).toHaveLength(10);
  const candidate = rows.find((row) => row.sourceItemId === sid)!;
  expect(candidate).toMatchObject({ title: detail.series_name, id: `drama_s_${sid}` });
  return candidate;
}
describe('provider_s1 minimal sanitized protocol shape (offline only)', () => {
  it('returns search card metadata without fetching details or players', async () => {
    const f = replay();
    const page = structuredClone(searchPage);
    Object.assign(page.searchList[0].video_data, { episode_cnt: 100, series_cover: 'https://cover.example.test/cover.jpg' });
    f.config.fetcher = async (raw) => {
      f.calls.push(new URL(raw).pathname);
      return new Response(JSON.stringify({ loaderData: { search_page: page } }));
    };
    const provider = createS1Provider(f.config);
    const rows = await provider.search(query, 1);
    const item = rows.find((entry) => entry.sourceItemId === sid)!;
    expect(item.episodeCount).toBe(100);
    expect(item.coverTargetUrl).toBeTruthy();
    expect(f.calls.every((path) => path.startsWith('/search/'))).toBe(true);
  });
  it('diagnoses a fourth-player HTTP rejection privately while keeping the result generic', async () => {
    const f = replay(), fetcher = f.config.fetcher!;
    expect(detail.accessiblecnt).toBe(3);
    const rejectedPath = `/player/${sid}/${vids[3]}`;
    const rejectedCalls: string[] = [];
    f.config.fetcher = async (raw, init) => {
      if (new URL(raw).pathname !== rejectedPath) return fetcher(raw, init);
      rejectedCalls.push(rejectedPath);
      return new Response('upstream private error body', { status: 404 });
    };
    const candidate = await target(f.config);
    const diagnostics: unknown[] = [];
    const result = await createS1Provider(f.config, (event) => diagnostics.push(event)).resolve(candidate, undefined, budget);
    expect(result).toEqual({ status: 'blocked', providerId: 'provider_s1', reason: 'unavailable' });
    expect(diagnostics).toEqual([{ stage: 'player-fetch', episodeNumber: 4, failure: 'http-rejected', httpStatus: 404 }]);
    expect(rejectedCalls).toEqual([rejectedPath]);
    expect(f.calls.slice(-3)).toEqual(vids.slice(0, 3).map((vid) => `/player/${sid}/${vid}`));
    expect(JSON.stringify(diagnostics)).not.toMatch(/https:|upstream private/);
    expect(JSON.stringify(diagnostics)).not.toContain(sid);
  });
  it('ignores a failing private diagnostic sink', async () => {
    const f = replay(), candidate = await target(f.config);
    f.config.fetcher = async () => new Response(null, { status: 404 });
    const result = await createS1Provider(f.config, () => { throw new Error('private diagnostic failure'); }).resolve(candidate, undefined, budget);
    expect(result).toEqual({ status: 'blocked', providerId: 'provider_s1', reason: 'unavailable' });
  });
  it('accepts the sanitized plaintext identity-bound first player and 100-episode detail', async () => {
    const f = replay(), candidate = await target(f.config);
    expect(vids).toHaveLength(100);
    const result = await createS1Provider(f.config).resolve(candidate, undefined, { ...budget, maxRequests: 2 });
    expect(result.status).toBe('progress');
    if (result.status !== 'progress') throw new Error('sanitized first player blocked');
    expect(firstPlayer).toMatchObject({ series_id: sid, vid: vids[0] });
    expect(protectedData(firstPlayer)).toBe(false);
    expect(result.resolvedEpisodes).toBe(1);
    expect(result.expectedEpisodes).toBe(100);
    const media = result.state.fact.episodes[0].lines[0].mediaUrl;
    if (media === undefined) throw new Error('plaintext fixture missing media URL');
    expect(new URL(media).origin).toBe(mediaOrigin);
  });
  it('resumes all 100 explicitly synthetic player identities within the eight-request budget', async () => {
    const f = replay(), candidate = await target(f.config);
    let cursor: DiscoveryResolveState | undefined;
    for (let batch = 0; batch < 15; batch++) {
      const before = f.calls.length;
      const result = await createS1Provider(f.config).resolve(candidate, cursor, budget);
      expect(f.calls.length - before).toBeLessThanOrEqual(8);
      if (result.status === 'complete') {
        expect(result.fact.episodeCount).toBe(100);
        expect(result.fact.episodes.map((ep) => ep.sourceEpisodeId)).toEqual(vids);
        return;
      }
      expect(result.status).toBe('progress');
      if (result.status !== 'progress') throw new Error('synthetic replay blocked');
      cursor = result.state;
    }
    throw new Error('replay did not complete');
  });
  it.each(['origin', 'expired', 'identity', 'protected'])('fails closed on %s without exposing upstream details', async (failure) => {
    const f = replay((page, index) => {
      if (index !== 1) return;
      const info = record(page.video_player_info);
      if (failure === 'origin') info.main_url = 'https://unverified.example.test/video.mp4';
      if (failure === 'expired') info.main_url = `${mediaOrigin}/video.mp4?expires=1`;
      if (failure === 'identity') page.vid = '1';
      if (failure === 'protected') info.drm = true;
    });
    const candidate = await target(f.config);
    expect(await createS1Provider(f.config).resolve(candidate, undefined, budget)).toEqual({ status: 'blocked', providerId: 'provider_s1', reason: 'unavailable' });
  });
});
