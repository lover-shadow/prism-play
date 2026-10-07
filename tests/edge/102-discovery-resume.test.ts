import { describe, expect, it, vi } from 'vitest';
import { createS1Provider } from '../../edge/src/search/providers/s1';
import type { DiscoveryCandidate, DiscoveryConfig, DiscoveryResolveState } from '../../edge/src/search/discovery-provider';

const candidate: DiscoveryCandidate = { providerId: 'provider_s1', sourceItemId: '10', id: 'drama_s_10', title: '故事', channelId: 'drama' };
const budget = { maxRequests: 32, timeoutMs: 1000 };
const router = (key: string, value: unknown) => JSON.stringify({ loaderData: { [key]: value } });
function fixture(count: number, signature = (_vid: string) => '') {
  const calls: string[] = [];
  const config: DiscoveryConfig = {
    origin: 'https://api.example', originAllowlist: new Set(['https://api.example']),
    mediaAllowlist: new Set(['https://media.example']), coverAllowlist: new Set(['https://cover.example']),
    fetcher: async (raw) => {
      const url = new URL(raw); calls.push(url.pathname);
      if (url.pathname === '/detail') return new Response(router('detail_page', { seriesDetail: {
        series_id_str: '10', series_title: '故事', episode_cnt: count,
        vid_list: Array.from({ length: count }, (_, i) => String(100 + i))
      } }));
      const vid = url.pathname.split('/').pop()!;
      return new Response(router('player_page', { series_id: '10', vid,
        video_player_info: { main_url: `https://media.example/${vid}.mp4${signature(vid)}` } }));
    }
  };
  return { config, calls };
}
describe('private resumable discovery checkpoints', () => {
  it.each([9, 95])('completes %s episodes after replacing every adapter without restarting detail or prefix', async (count) => {
    const f = fixture(count);
    let checkpoint: string | DiscoveryResolveState | undefined;
    for (let batch = 0; batch < 20; batch++) {
      const before = f.calls.length;
      const result = await createS1Provider(f.config).resolve(candidate, checkpoint, budget);
      expect(f.calls.length - before).toBeLessThanOrEqual(batch === 0 ? 9 : 8);
      if (result.status === 'complete') {
        expect(result.fact.episodes).toHaveLength(count);
        expect(f.calls.filter((path) => path === '/detail')).toHaveLength(1);
        expect(f.calls).toHaveLength(count + 1);
        return;
      }
      expect(result.status).toBe('progress');
      if (result.status !== 'progress') throw new Error('resolution blocked');
      checkpoint = batch % 2 ? JSON.parse(result.cursor) : result.cursor;
    }
    throw new Error('did not complete');
  });
  it('rejects mutated identity, index, prefix, origin, expiry and protection flags before network access', async () => {
    const f = fixture(10), first = await createS1Provider(f.config).resolve(candidate, undefined, budget);
    if (first.status !== 'progress') throw new Error('expected checkpoint');
    const changes: ((state: DiscoveryResolveState) => void)[] = [
      (s) => { s.candidate.sourceItemId = '11'; }, (s) => { s.fact.id = 'drama_s_11'; },
      (s) => { s.next++; }, (s) => { s.next = -1; }, (s) => { s.vids[1] = s.vids[0]; },
      (s) => { s.fact.episodes[0].sourceEpisodeId = '999'; }, (s) => { s.fact.episodes.reverse(); },
      (s) => { s.fact.episodes[0].lines[0].mediaUrl = 'https://evil.example/a.mp4'; },
      (s) => { s.fact.coverTargetUrl = 'https://evil.example/a.jpg'; },
      (s) => { s.fact.episodes[0].lines[0].providerId = 'provider_m1'; },
      (s) => { s.fact.isPrivate = true as false; }, (s) => { s.fact.enabled = false as true; },
      (s) => { s.fact.shareable = false as true; },
      (s) => { Object.assign(s.fact.episodes[0], { drm: true }); },
      (s) => { Object.assign(s, { origin: 'https://evil.example' }); },
      (s) => { s.expiresAt = Date.now() - 1; }, (s) => { s.expiresAt = Date.now() + 86460000; }
    ];
    const before = f.calls.length;
    for (const change of changes) {
      const state = JSON.parse(first.cursor) as DiscoveryResolveState; change(state);
      expect((await createS1Provider(f.config).resolve(candidate, state, budget)).status).toBe('blocked');
    }
    expect(f.calls).toHaveLength(before);
  });
  it('survives more than sixty seconds and refreshes only expired prefix media within each budget', async () => {
    let now = 1900000000000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const f = fixture(10, (vid) => `?expires=${(now + (Number(vid) < 102 ? 10000 : 3600000)) / 1000}`);
      const first = await createS1Provider(f.config).resolve(candidate, undefined, budget);
      if (first.status !== 'progress') throw new Error('expected checkpoint');
      now += 120000;
      const before = f.calls.length;
      const second = await createS1Provider(f.config).resolve(candidate, first.cursor, { maxRequests: 1, timeoutMs: 1000 });
      expect(second.status).toBe('progress'); expect(f.calls.slice(before)).toEqual(['/player/10/100']);
      if (second.status !== 'progress') throw new Error('expected refresh checkpoint');
      expect(second.state.next).toBe(8); expect(second.state.fact.episodes).toHaveLength(8);
      const final = await createS1Provider(f.config).resolve(candidate, second.state, budget);
      expect(final.status).toBe('complete');
      expect(f.calls.slice(before)).toEqual(['/player/10/100', '/player/10/101', '/player/10/108', '/player/10/109']);
    } finally { vi.restoreAllMocks(); }
  });
  it('preserves a complete prefix when a redirect exhausts the final request slot', async () => {
    const f = fixture(10), fetcher = f.config.fetcher!;
    f.config.fetcher = async (raw, init) => {
      const url = new URL(raw);
      if (url.pathname.startsWith('/player/') && !url.search) {
        f.calls.push(url.pathname);
        return new Response(null, { status: 302, headers: { Location: `${url.pathname}?terminal=1` } });
      }
      return fetcher(raw, init);
    };
    const first = await createS1Provider(f.config).resolve(candidate, undefined, { maxRequests: 8, timeoutMs: 1000 });
    expect(first.status).toBe('progress'); expect(f.calls).toHaveLength(8);
    if (first.status !== 'progress') throw new Error('expected prefix checkpoint');
    expect(first.state.next).toBe(3);
    let state = first.state;
    for (let batch = 0; batch < 3; batch++) {
      const result = await createS1Provider(f.config).resolve(candidate, state, budget);
      if (result.status === 'complete') { expect(result.fact.episodeCount).toBe(10); return; }
      if (result.status !== 'progress') throw new Error('blocked redirect resume');
      state = result.state;
    }
    throw new Error('did not complete redirect resume');
  });
  it('preserves retry evidence across batches and fails closed on repeatedly expired player media', async () => {
    const f = fixture(9, () => '?auth_key=1-signature');
    const first = await createS1Provider(f.config).resolve(candidate, undefined, { maxRequests: 2, timeoutMs: 1000 });
    expect(first.status).toBe('progress');
    if (first.status !== 'progress') throw new Error('expected retry checkpoint');
    expect(first.state.refreshed).toEqual(['100']);
    expect((await createS1Provider(f.config).resolve(candidate, first.cursor, budget)).status).toBe('blocked');
    expect(f.calls).toHaveLength(3);
  });
});
