import { describe, expect, it, vi } from 'vitest';
import { createDiscoveryProviders } from '../../edge/src/search/discovery-config';
import type { DiscoveryConfig } from '../../edge/src/search/discovery-provider';
const candidate = { providerId: 'provider_s1' as const, sourceItemId: '10', id: 'drama_s_10', title: '故事', channelId: 'drama' as const };
function fixture(extra = {}) {
  const fetcher = vi.fn(async (_url: string) => new Response(JSON.stringify({ loaderData: { detail_page: { seriesDetail: {
    series_id_str: '10', series_title: '故事', episode_cnt: 2, vid_list: ['100', '101'], ...extra
  } } } })));
  const config: DiscoveryConfig = { origin: 'https://api.example', originAllowlist: new Set(['https://api.example']),
    coverAllowlist: new Set(['https://cover.example']), mediaAllowlist: new Set(['https://media.example']), fetcher };
  return { fetcher, provider: createDiscoveryProviders({ enabled: true, providers: { provider_s1: config } })[0] };
}
describe('production S1 directory adapter', () => {
  it('ignores old media cursors and fetches only the directory', async () => {
    const f = fixture();
    const result = await f.provider.resolve(candidate, 'old-checkpoint', { maxRequests: 8, timeoutMs: 15000 });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') throw new Error('directory blocked');
    expect(result.fact.episodes[0].lines[0]).toEqual({ providerId: 'provider_s1', native: { kind: 's1-cenc', videoId: '100' } });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(new URL(f.fetcher.mock.calls[0][0] as string).pathname).toBe('/detail');
  });
  it('honors caller request budget across redirects instead of hardcoding four requests', async () => {
    let calls = 0;
    const cfg: DiscoveryConfig = { origin: 'https://api.example', originAllowlist: new Set(['https://api.example']),
      coverAllowlist: new Set(['https://cover.example']), mediaAllowlist: new Set(['https://media.example']),
      fetcher: async () => { calls++; return calls <= 2 ? new Response(null, { status: 302, headers: { Location: '/next' } })
        : new Response(JSON.stringify({ loaderData: { detail_page: { seriesDetail: {
          series_id_str: '10', series_title: '故事', episode_cnt: 1, vid_list: ['100']
        } } } })); } };
    const provider = createDiscoveryProviders({ enabled: true, providers: { provider_s1: cfg } })[0];
    expect((await provider.resolve(candidate, undefined, { maxRequests: 2, timeoutMs: 3000 })).status).toBe('blocked');
    expect(calls).toBe(2);
  });
  it.each([{ vid_list: ['100', '100'] }, { vid_list: ['100', 101] }, { episode_cnt: 3 },
    { series_id_str: '11' }, { series_title: '另一部剧' }])('rejects inconsistent directory %j', async (extra) => {
    const f = fixture(extra);
    expect((await f.provider.resolve(candidate, undefined, { maxRequests: 8, timeoutMs: 15000 })).status).toBe('blocked');
  });
});
