import { describe, expect, it, vi } from 'vitest';
import { asD1, createInMemoryD1 } from '../support/sqlite-d1';
import { saveDiscoveryCard, resolveCardDetail } from '../../edge/src/search/discovery-cards';
import type { DiscoveryContext } from '../../edge/src/search/discovery-store';
import type { DiscoveryConfig } from '../../edge/src/search/discovery-provider';

function context(): DiscoveryContext {
  const objects = new Map<string, Uint8Array>();
  return { bindings: { DB: asD1(createInMemoryD1()), DISCOVERY_BUCKET: {
    get: async (key: string) => { const data = objects.get(key); return data ? { size: data.length, arrayBuffer: async () => data.slice().buffer } : null; },
    put: async (key: string, data: Uint8Array) => { objects.set(key, data.slice()); return { key }; }
  } as unknown as R2Bucket }, nowSeconds: () => 100, authority: async () => ({ authoritative: false }) };
}

describe('W3 on-demand front budget', () => {
  it.each(['provider_s1', 'provider_m1'] as const)('redirects consume the same two-request front budget for %s', async providerId => {
    const ctx = context(), sid = '10', id = `drama_${providerId === 'provider_s1' ? 's' : 'm'}_10`;
    await saveDiscoveryCard(ctx, { providerId, sourceItemId: sid, id, title: '故事', channelId: 'drama' });
    let calls = 0;
    const cfg: DiscoveryConfig = { origin: 'https://api.example', originAllowlist: new Set(['https://api.example']),
      mediaAllowlist: new Set(['https://media.example']), coverAllowlist: new Set(['https://cover.example']),
      fetcher: async () => { calls++; if (calls < 3) return new Response(null, { status: 302, headers: { Location: '/next' } });
        return new Response(JSON.stringify(providerId === 'provider_s1'
          ? { loaderData: { detail_page: { seriesDetail: { series_id_str: sid, series_title: '故事', episode_cnt: 1, vid_list: ['100'] } } } }
          : { code: 1, list: [{ vod_id: 10, type_id: 38, vod_name: '故事', vod_total: 1, vod_play_url: '第1集$https://media.example/one.mp4' }] })); }
    };
    await expect(resolveCardDetail(ctx, id, { [providerId]: cfg })).rejects.toThrow('temporarily unavailable');
    expect(calls).toBe(2);
  });
  it('front timeout bounds slow fetch even if injected fetcher ignores AbortSignal', async () => {
    vi.useFakeTimers();
    try {
      const ctx = context(), id = 'drama_s_10';
      await saveDiscoveryCard(ctx, { providerId: 'provider_s1', sourceItemId: '10', id, title: '故事', channelId: 'drama' });
      const fetcher = vi.fn(async () => new Promise<Response>(() => undefined));
      const cfg: DiscoveryConfig = { origin: 'https://api.example', originAllowlist: new Set(['https://api.example']),
        mediaAllowlist: new Set(), coverAllowlist: new Set(), fetcher };
      const pending = resolveCardDetail(ctx, id, { provider_s1: cfg }).catch(error => error);
      for (let i = 0; i < 50 && !fetcher.mock.calls.length; i++) await Promise.resolve();
      let settled = false; void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(3001);
      expect(settled).toBe(true);
      expect(await pending).toBeInstanceOf(Error);
      expect((await pending).message).toContain('temporarily unavailable');
    } finally { vi.useRealTimers(); }
  });
});
