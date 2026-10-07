import { describe, expect, it, vi } from 'vitest';
import { asD1, createInMemoryD1 } from '../support/sqlite-d1';
import { saveDiscoveryCard, resolveCardDetail } from '../../edge/src/search/discovery-cards';
import type { DiscoveryContext } from '../../edge/src/search/discovery-store';
import type { DiscoveryConfig } from '../../edge/src/search/discovery-provider';

function fixture() {
  const sqlite = createInMemoryD1();
  const objects = new Map<string, Uint8Array>();
  const bucket = {
    get: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } : null;
    }),
    put: vi.fn(async (key: string, bytes: Uint8Array) => { objects.set(key, bytes.slice()); return { key }; })
  };
  const context: DiscoveryContext = {
    bindings: { DB: asD1(sqlite), DISCOVERY_BUCKET: bucket as unknown as R2Bucket },
    nowSeconds: () => 100,
    authority: async () => ({ authoritative: false })
  };
  return { sqlite, context, objects };
}

describe('on-demand pure-videoId detail resolution (honest contract)', () => {
  it('resolves s1 card into manifest containing pure videoId native lines without placeholder mediaUrl', async () => {
    const f = fixture();
    const sid = '7671966197985856536';
    const candidate = {
      providerId: 'provider_s1' as const, sourceItemId: sid, id: `drama_s_${sid}`,
      title: '持械入宋', channelId: 'drama' as const, episodeCount: 100
    };
    await saveDiscoveryCard(f.context, candidate);

    const vids = Array.from({ length: 100 }, (_, i) => String(7000000000000000000n + BigInt(i)));
    let detailFetched = false;
    const config: DiscoveryConfig = {
      origin: 'https://hongguoduanju.com',
      originAllowlist: new Set(['https://hongguoduanju.com']),
      mediaAllowlist: new Set(['https://v26-hgweb.qznovelvod.com']),
      coverAllowlist: new Set(['https://p3-novel.byteimg.com']),
      fetcher: async (url) => {
        const u = new URL(url);
        if (u.pathname === '/detail') {
          detailFetched = true;
          const html = `<script>window._ROUTER_DATA = ${JSON.stringify({
            loaderData: {
              'detail_page': {
                seriesDetail: {
                  series_id_str: sid, series_name: '持械入宋',
                  episode_cnt: 100, vid_list: vids
                }
              }
            }
          })};</script>`;
          return new Response(html);
        }
        throw new Error('Unexpected fetch: ' + u.pathname);
      }
    };

    const fetcher = vi.fn(config.fetcher!);
    config.fetcher = fetcher;
    const asset = await resolveCardDetail(f.context, candidate.id, { provider_s1: config });
    expect(detailFetched).toBe(true);
    expect(asset).not.toBeNull();
    expect(asset?.episodes).toHaveLength(100);
    // 关键契约：严禁任何假 mediaUrl 占位符，native 线路无 mediaUrl 属性
    for (const ep of asset!.episodes) {
      expect(ep.lines).toHaveLength(1);
      const line = ep.lines[0];
      expect(line.providerId).toBe('provider_s1');
      expect(line.native).toBeDefined();
      expect(line.native?.kind).toBe('s1-cenc');
      expect(line.native?.videoId).toMatch(/^\d+$/);
      expect(Object.prototype.hasOwnProperty.call(line, 'mediaUrl')).toBe(false);
    }
    expect(await resolveCardDetail(f.context, candidate.id, { provider_s1: config })).toEqual(asset);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
