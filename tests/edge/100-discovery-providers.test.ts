import { describe, expect, it } from 'vitest';
import { createM1Provider } from '../../edge/src/search/providers/m1';
import { createS1Provider } from '../../edge/src/search/providers/s1';
import { fetchAllowed } from '../../edge/src/search/providers/transport';
import type { DiscoveryConfig, DiscoveryResult } from '../../edge/src/search/discovery-provider';

const router = (key: string, value: unknown) => `<script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { [key]: value } })};</script>`;
const row = (id = '10', title = '故事') => ({ series_id_str: id, series_title: title, series_intro: '<b>故事介绍</b>' });
const cms = (extra = {}) => ({ vod_id: 10, type_id: 38, vod_name: '故事', vod_total: 2,
  vod_play_from: 'upstream-brand', vod_play_url: '第1集$https://media.example/1.mp4#第2集$https://media.example/2.mp4', ...extra });
function config(handler: (url: URL) => string | Response | Promise<Response>): DiscoveryConfig {
  return { origin: 'https://api.example', originAllowlist: new Set(['https://api.example']),
    mediaAllowlist: new Set(['https://media.example']), coverAllowlist: new Set(['https://cover.example']),
    fetcher: async (url, init) => {
      expect(init?.method).toBe('GET'); expect(init?.redirect).toBe('manual');
      const value = await handler(new URL(String(url)));
      return typeof value === 'string' ? new Response(value) : value;
    } };
}
const budget = { maxRequests: 32, timeoutMs: 1000 };
function s1Fixture(count = 2, change: (value: Record<string, unknown>) => void = () => {}) {
  let players = 0;
  const cfg = config((url) => {
    if (url.pathname.startsWith('/search/')) return router('search_page', { query: decodeURIComponent(url.pathname.slice(8)), isSuccess: true, searchList: [{ video_data: row() }] });
    if (url.pathname === '/detail') return router('detail_page', { seriesDetail: { ...row(), episode_cnt: count, vid_list: Array.from({ length: count }, (_, i) => String(i + 100)) } });
    players++;
    const value = { series_id: '10', vid: url.pathname.split('/').pop(), video_player_info: { main_url: `https://media.example/${players}.mp4` } };
    change(value); return router('player_page', value);
  });
  return { cfg, players: () => players };
}
async function firstResult(cfg: DiscoveryConfig): Promise<DiscoveryResult> {
  const provider = createS1Provider(cfg), candidates = await provider.search('故事', 1);
  return provider.resolve(candidates[0], undefined, budget);
}
describe('controlled discovery adapters', () => {
  it('m1 encodes query and uses detail/ids with stable identities and all lines', async () => {
    const cfg = config((url) => {
      expect(url.searchParams.get('ac')).toBe('detail');
      if (!url.searchParams.has('ids')) { expect(url.searchParams.get('wd')).toBe('故事&x=/'); expect(url.searchParams.get('pg')).toBe('2'); }
      return JSON.stringify({ code: 1, list: [cms({ vod_play_url: cms().vod_play_url + '$$$' + cms().vod_play_url })] });
    });
    const provider = createM1Provider(cfg), [candidate] = await provider.search('故事&x=/', 2);
    const result = await provider.resolve(candidate, undefined, budget);
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    expect(result.fact.id).toBe('drama_m_10'); expect(result.fact.episodeCount).toBe(2);
    expect(result.fact.episodes[0].lines).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('upstream-brand');
    expect(result.fact.category).toBeUndefined(); expect(result.fact.isAi).toBeUndefined();
  });
  it.each([6, 39, 8, 5, 999])('m1 rejects private or unsupported type %s', async (type_id) => {
    const provider = createM1Provider(config(() => JSON.stringify({ code: 1, list: [cms({ type_id })] })));
    expect(await provider.search('故事', 1)).toEqual([]);
  });
  it('m1 maps explicit movie genre and AI classification without title guesses', async () => {
    const provider = createM1Provider(config(() => JSON.stringify({ code: 1, list: [cms({ type_id: 10 }), cms({ vod_id: 11, type_id: 42 })] })));
    const candidates = await provider.search('故事', 1);
    expect(candidates[0]).toMatchObject({ id: 'movie_m_10', category: '动作' });
    expect(candidates[1]).toMatchObject({ id: 'drama_m_11', isAi: true });
  });
  it.each([{ vod_total: 3 }, { vod_play_url: '第1集$https://media.example/1.mp4#第3集$https://media.example/3.mp4' },
    { vod_play_url: '第1集$http://media.example/1.mp4' }, { vod_pic: 'https://api.example/cover.jpg' }])('m1 blocks incomplete/unsafe facts %j', async (extra) => {
    const provider = createM1Provider(config(() => JSON.stringify({ code: 1, list: [cms(extra)] })));
    const [candidate] = await provider.search('故事', 1);
    expect((await provider.resolve(candidate, undefined, budget)).status).toBe('blocked');
  });
  it('s1 binds detail and each player and sanitizes public facts', async () => {
    const result = await firstResult(s1Fixture().cfg);
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    expect(result.fact).toMatchObject({ id: 'drama_s_10', episodeCount: 2, isPrivate: false });
    expect(result.fact.episodes.every((ep) => ep.lines[0].providerId === 'provider_s1')).toBe(true);
    expect(result.fact.category).toBeUndefined(); expect(JSON.stringify(result)).not.toContain('<b>');
  });
  it('s1 never exposes subtitle-only candidates as complete playback facts', async () => {
    const cfg = config((url) => url.pathname.startsWith('/search/') ? router('search_page', { query: '故事', isSuccess: true,
      searchList: [{ video_data: row(), subtitle: '名称命中' }] }) : router('detail_page', { seriesDetail: { ...row(), vid_list: [] } }));
    expect((await firstResult(cfg)).status).toBe('blocked');
  });
  it('s1 returns private JSON progress, caps each batch at eight player GETs, and resumes across instances', async () => {
    const fixture = s1Fixture(10), provider = createS1Provider(fixture.cfg), [candidate] = await provider.search('故事', 1);
    const first = await provider.resolve(candidate, undefined, budget);
    expect(first.status).toBe('progress'); expect(fixture.players()).toBe(8);
    if (first.status !== 'progress') return;
    expect(JSON.parse(first.cursor)).toEqual(first.state);
    const second = await createS1Provider(fixture.cfg).resolve(candidate, first.cursor, budget);
    expect(second.status).toBe('complete'); expect(fixture.players()).toBe(10);
    expect((await createS1Provider(fixture.cfg).resolve(candidate, first.state, budget)).status).toBe('complete');
    expect((await provider.resolve(candidate, 'old-random-instance-token', budget)).status).toBe('blocked');
  });
  it.each(['drm', 'encrypt', 'encrypted', 'key', 'key_id', 'kid', 'spade_a'])('blocks %s flags and player mismatch', async (flag) => {
    const fixture = s1Fixture(1, (value) => { (value.video_player_info as Record<string, unknown>)[flag] = true; });
    expect((await firstResult(fixture.cfg)).status).toBe('blocked');
  });
  it('blocks wrong identity, unsafe media and detail duplicates', async () => {
    for (const change of [(v: Record<string, unknown>) => { v.vid = '999'; },
      (v: Record<string, unknown>) => { v.video_player_info = { main_url: 'https://evil.example/a.mp4' }; }]) {
      expect((await firstResult(s1Fixture(1, change).cfg)).status).toBe('blocked');
    }
    const fixture = s1Fixture();
    const original = fixture.cfg.fetcher;
    fixture.cfg.fetcher = async (url, init) => String(url).includes('/detail?') ? new Response(router('detail_page', { seriesDetail: { ...row(), vid_list: ['100', '100'] } })) : original!(url, init);
    expect((await firstResult(fixture.cfg)).status).toBe('blocked');
  });
  it('checks search query identity and fills only missing seasons within observed maximum', async () => {
    const queries: string[] = [];
    const provider = createS1Provider(config((url) => {
      const query = decodeURIComponent(url.pathname.slice(8)); queries.push(query);
      return router('search_page', { query, isSuccess: true, searchList: (query === '故事' ? [row('1', '故事第一季'), row('3', '故事第三季')] : [row('2', '故事第二季')]).map((video_data) => ({ video_data })) });
    }));
    expect(await provider.search('故事', 1)).toHaveLength(3);
    expect(queries).toEqual(['故事', '故事第二季']);
    await expect(createS1Provider(config(() => router('search_page', { query: '错误', isSuccess: true, searchList: [] }))).search('故事', 1)).rejects.toThrow('discovery-invalid');
  });
  it('refreshes an explicitly expired player URL once, never loops', async () => {
    let calls = 0;
    const fixture = s1Fixture(1, (value) => { calls++; value.video_player_info = { main_url: `https://media.example/a.mp4?expires=${calls === 1 ? 1 : 4102444800}` }; });
    expect((await firstResult(fixture.cfg)).status).toBe('complete'); expect(calls).toBe(2);
    const expired = s1Fixture(1, (value) => { value.video_player_info = { main_url: 'https://media.example/a.mp4?expires=1' }; });
    expect((await firstResult(expired.cfg)).status).toBe('blocked'); expect(expired.players()).toBe(2);
  });
  it('validates each manual redirect hop and rejects HTTP even on allowlist', async () => {
    let requests = 0;
    const cfg = config(() => { requests++; return new Response(null, { status: 302, headers: { Location: 'https://evil.example/a' } }); });
    await expect(fetchAllowed(cfg, 'https://api.example/a', budget)).rejects.toThrow('discovery-invalid'); expect(requests).toBe(1);
    await expect(fetchAllowed({ ...cfg, originAllowlist: new Set(['http://api.example']) }, 'http://api.example/a', budget)).rejects.toThrow();
  });
  it('counts redirects against the player batch cap and continues with a cursor', async () => {
    let playerGets = 0;
    const fixture = s1Fixture(5), original = fixture.cfg.fetcher!;
    fixture.cfg.fetcher = async (url, init) => {
      const target = new URL(url);
      if (target.pathname.startsWith('/player/')) {
        playerGets++;
        if (!target.search) return new Response(null, { status: 302, headers: { Location: `${target.pathname}?terminal=1` } });
      }
      return original(url, init);
    };
    const provider = createS1Provider(fixture.cfg), [candidate] = await provider.search('故事', 1);
    const result = await provider.resolve(candidate, undefined, budget);
    expect(result.status).toBe('progress'); expect(playerGets).toBe(8);
    if (result.status === 'progress') expect((await provider.resolve(candidate, result.cursor, budget)).status).toBe('complete');
  });
  it('binds cursors to series and blocks wrong detail identity or count', async () => {
    const fixture = s1Fixture(10), provider = createS1Provider(fixture.cfg), [candidate] = await provider.search('故事', 1);
    const result = await provider.resolve(candidate, undefined, { maxRequests: 2, timeoutMs: 1000 });
    expect(result.status).toBe('progress');
    if (result.status === 'progress') expect((await provider.resolve({ ...candidate, sourceItemId: '11', id: 'drama_s_11' }, result.cursor, budget)).status).toBe('blocked');
    for (const extra of [{ series_id_str: '11' }, { episode_cnt: 3 }]) {
      const f = s1Fixture(), original = f.cfg.fetcher!;
      f.cfg.fetcher = async (url, init) => url.includes('/detail?') ? new Response(router('detail_page', { seriesDetail: { ...row(), vid_list: ['100', '101'], ...extra } })) : original(url, init);
      expect((await firstResult(f.cfg)).status).toBe('blocked');
    }
  });
  it('rejects invalid input without making requests and times out stalled stream reads', async () => {
    let calls = 0;
    const provider = createS1Provider(config(() => { calls++; return ''; }));
    for (const query of ['', 'a\nb', 'a'.repeat(81), '\ud800']) await expect(provider.search(query, 1)).rejects.toThrow();
    expect(calls).toBe(0);
    const stalled = config(() => new Response(new ReadableStream({ pull() { return new Promise(() => {}); } })));
    await expect(fetchAllowed(stalled, 'https://api.example/a', { maxRequests: 1, timeoutMs: 10 })).rejects.toThrow('discovery-invalid');
  });
  it('enforces streamed byte limit and a hard timeout even when fetch ignores abort', async () => {
    const large = config(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4194305)); controller.close(); } })));
    await expect(fetchAllowed(large, 'https://api.example/a', budget)).rejects.toThrow('discovery-invalid');
    const hanging = config(() => new Promise<Response>(() => {}));
    await expect(fetchAllowed(hanging, 'https://api.example/a', { maxRequests: 1, timeoutMs: 10 })).rejects.toThrow('discovery-invalid');
  });
});
