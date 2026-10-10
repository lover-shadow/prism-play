import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(() => vi.unstubAllGlobals());
import { asD1, createInMemoryD1 } from '../support/sqlite-d1';
import { saveDiscoveryCard } from '../../edge/src/search/discovery-cards';
import { handleTitles } from '../../edge/src/routes/titles';
import { handleNativePlayback } from '../../edge/src/routes/native-playback';
import type { Env } from '../../edge/src/types/env';

describe('E2E on-demand discovery titles route integration', () => {
  it('serves honest pure-videoId native lines for newly discovered card without placeholder mediaUrl', async () => {
    const sqlite = createInMemoryD1();
    const objects = new Map<string, Uint8Array>();
    const bucket = {
      get: async (key: string) => {
        const bytes = objects.get(key);
        return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } : null;
      },
      put: async (key: string, bytes: Uint8Array) => { objects.set(key, bytes.slice()); return { key }; }
    };
    const sid = '7671966197985856536';
    const workId = `drama_s_${sid}`;
    const vids = ['7000000000000000101', '7000000000000000102', '7000000000000000103'];

    const env = {
      DB: asD1(sqlite),
      DISCOVERY_BUCKET: bucket as unknown as R2Bucket,
      APK_BUCKET: { get: async () => null } as unknown as R2Bucket,
      SEARCH_DISCOVERY_ENABLED: 'true',
      SEARCH_DISCOVERY_CONFIG: JSON.stringify({
        providers: {
          provider_s1: {
            origin: 'https://hongguoduanju.com',
            originAllowlist: ['https://hongguoduanju.com'],
            mediaAllowlist: ['https://v26-hgweb.qznovelvod.com'],
            coverAllowlist: ['https://p3-novel.byteimg.com']
          }
        }
      }),
      KV: {
        get: async (key: string) => {
          if (key === 'catalog:manifest') {
            return JSON.stringify({
              revision: 1,
              pageSize: 60,
              channels: { drama: { chunks: 0, total: 0 } },
              workFacts: { schema: 1, maxBytes: 524288, packs: {} },
              coverOrigins: []
            });
          }
          return null;
        }
      }
    } as unknown as Env;

    const clock = { nowSeconds: () => 1000, nowMillis: () => 1000000 };

    // 1. 模拟搜索时存入该剧目卡片
    const context = {
      bindings: { DB: env.DB, DISCOVERY_BUCKET: env.DISCOVERY_BUCKET },
      nowSeconds: () => 1000,
      authority: async () => ({ authoritative: false as const })
    };
    await saveDiscoveryCard(context, {
      providerId: 'provider_s1', sourceItemId: sid, id: workId,
      title: '持械入宋', channelId: 'drama', episodeCount: 3
    });

    // 2. 模拟上游 fetcher 响应 detail 页面（只在请求详情时调用）
    const fetchMock = async (url: string | URL | Request) => {
      const u = new URL(typeof url === 'string' ? url : url instanceof Request ? url.url : url.href);
      if (u.pathname === '/detail') {
        const html = `<script>window._ROUTER_DATA = ${JSON.stringify({
          loaderData: {
            'detail_page': {
              seriesDetail: {
                series_id_str: sid, series_name: '持械入宋',
                episode_cnt: 3, vid_list: vids
              }
            }
          }
        })};</script>`;
        return new Response(html);
      }
      throw new Error('Unexpected fetch: ' + u.pathname);
    };
    const fetcher = vi.fn(fetchMock);
    vi.stubGlobal('fetch', fetcher);

    // 3. 请求详情接口 GET /api/titles/drama_s_7671966197985856536
    const req = new Request(`https://play.prismos.org/api/titles/${workId}`);
    const res = await handleTitles(req, env, clock);
    expect(res.status).toBe(200);

    const json = await res.json() as { workId: string; episodes: { lines: Record<string, unknown>[] }[] };
    expect(json.workId).toBe(workId);
    expect(json.episodes).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      const line = json.episodes[i].lines[0];
      expect(line.providerId).toBe('provider_s1');
      expect(line.native).toEqual({ kind: 's1-cenc', videoId: vids[i] });
      // 诚实契约核心：绝无占位/虚假的 mediaUrl
      expect(Object.prototype.hasOwnProperty.call(line, 'mediaUrl')).toBe(false);
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
    const cached = await handleTitles(req, env, clock);
    expect(cached.status).toBe(200);
    expect(await cached.json()).toEqual(json);
    const playback = await handleNativePlayback(new Request(
      `https://play.prismos.org/api/titles/${workId}/episodes/2/native-playback?line=0`
    ), env, clock);
    expect(playback.status).toBe(200);
    expect(await playback.json()).toMatchObject({ workId, episodeNumber: 2,
      native: { kind: 's1-cenc', videoId: vids[1] } });
    expect(fetcher).toHaveBeenCalledTimes(1);
    // 有已知card但上游暂不可用：预算失败必须可重试503，而非把作品伪装成未知404。
    sqlite.execute('DELETE FROM discovery_works WHERE work_id = ?', workId);
    vi.stubGlobal('fetch', async () => new Response(null, { status: 503 }));
    expect((await handleTitles(req, env, clock)).status).toBe(503);
  });
});
