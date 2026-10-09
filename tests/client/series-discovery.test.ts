import { describe, expect, it, vi } from 'vitest';
import { createSeriesDiscovery } from '../../src/core/series-discovery';
import type { ContentItem, SearchResponse } from '../../edge/src/types/api';

const item = (id: string, title: string, channelId: ContentItem['channelId'] = 'drama'): ContentItem => ({
  id, title, channelId, category: '都市', isPrivate: false, enabled: true, shareable: true
});

describe('后台按系列补卡（AC-R05 / AC-R06）', () => {
  it.each(['discoveryPending', 'discoveryFailed'] as const)('does not cache %s responses', async (flag) => {
    const search = vi.fn(async (): Promise<SearchResponse> => ({ items: [], page: 1, hasMore: false, [flag]: true }));
    const d = createSeriesDiscovery({ search, onDiscovered: async () => {} });
    await d.discover(item('s7', '故事第七季')); await d.discover(item('s7', '故事第七季'));
    expect(search).toHaveBeenCalledTimes(2);
  });
  it('retains successful first page when second page fails and allows retry', async () => {
    const first = item('s1', '故事');
    const search = vi.fn(async ({ page }: { page?: number }): Promise<SearchResponse> => {
      if (page === 2) throw new Error('timeout');
      return { items: [{ item: first, matchType: 'exact' }], page: 1, hasMore: true };
    });
    const onDiscovered = vi.fn(async () => {}), d = createSeriesDiscovery({ search, onDiscovered });
    expect(await d.discover(item('s7', '故事第七季'))).toEqual([first]);
    expect(onDiscovered).toHaveBeenCalledWith([first]);
    await d.discover(item('s7', '故事第七季')); expect(search).toHaveBeenCalledTimes(4);
  });
  it('does not cache before persistence succeeds', async () => {
    const search = vi.fn(async (): Promise<SearchResponse> => ({ items: [{ item: item('s1', '故事'), matchType: 'exact' }], page: 1, hasMore: false }));
    const onDiscovered = vi.fn(async () => { throw new Error('disk'); }), d = createSeriesDiscovery({ search, onDiscovered });
    expect(await d.discover(item('s7', '故事第七季'))).toEqual([]);
    expect(await d.discover(item('s7', '故事第七季'))).toEqual([]);
    expect(search).toHaveBeenCalledTimes(2); expect(onDiscovered).toHaveBeenCalledTimes(2);
  });
  it('bounds pagination and excludes private and other channel hits', async () => {
    const secret = { ...item('secret', '故事第二季'), isPrivate: true };
    const search = vi.fn(async (): Promise<SearchResponse> => ({ items: [secret, item('movie', '故事第三季', 'movie'), item('s1', '故事')].map(item => ({ item, matchType: 'exact' })), page: 1, hasMore: true }));
    const d = createSeriesDiscovery({ search, onDiscovered: async () => {} });
    expect((await d.discover(item('s7', '故事第七季'))).map(i => i.id)).toEqual(['s1']);
    expect(search).toHaveBeenCalledTimes(2);
    expect(await d.discover(secret)).toEqual([]); expect(search).toHaveBeenCalledTimes(2);
  });
  it('打开高季时按基底名搜索并补充缺季，过滤无关模糊命中', async () => {
    const s7 = item('drama_s7', '别逼我修炼第七季');
    const mockHits: ContentItem[] = [
      item('drama_s1', '别逼我修炼'),
      item('drama_s2', '别逼我修炼第二季'),
      item('drama_other', '别逼我修仙第一季'), // 无关作品应被过滤
      item('drama_s3', '别逼我修炼第三季')
    ];

    const searchFn = vi.fn(async (input: { q: string; page?: number }): Promise<SearchResponse> => ({
      items: (input.page === 1 ? mockHits : []).map((i) => ({ item: i, matchType: 'exact' })),
      page: input.page ?? 1,
      hasMore: false
    }));

    const found: ContentItem[][] = [];
    const discovery = createSeriesDiscovery({
      search: searchFn,
      onDiscovered: async (items) => { found.push(items); }
    });

    const result = await discovery.discover(s7);
    expect(searchFn).toHaveBeenCalledWith(expect.objectContaining({ q: '别逼我修炼', channel: 'drama', page: 1 }));
    expect(result.map((i) => i.id)).toEqual(['drama_s1', 'drama_s2', 'drama_s3']);
    expect(found[0].map((i) => i.id)).toEqual(['drama_s1', 'drama_s2', 'drama_s3']);
  });

  it('同进程对同系列多次打开请求只执行一次搜索（single-flight 与已查缓存）', async () => {
    const s7 = item('drama_s7', '别逼我修炼第七季');
    const s6 = item('drama_s6', '别逼我修炼第六季');

    const searchFn = vi.fn(async (): Promise<SearchResponse> => ({
      items: [{ item: item('drama_s1', '别逼我修炼'), matchType: 'exact' }],
      page: 1,
      hasMore: false
    }));

    const discovery = createSeriesDiscovery({
      search: searchFn,
      onDiscovered: async () => {}
    });

    const [res1, res2] = await Promise.all([discovery.discover(s7), discovery.discover(s6)]);
    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(res1.map((i) => i.id)).toEqual(['drama_s1']);
    expect(res2.map((i) => i.id)).toEqual(['drama_s1']);

    // 再次调用已完成系列
    const res3 = await discovery.discover(s7);
    expect(searchFn).toHaveBeenCalledTimes(1);
    expect(res3.map((i) => i.id)).toEqual(['drama_s1']);
  });

  it('搜索失败时不抛错，优雅返回空数组不中断调用方', async () => {
    const s7 = item('drama_s7', '别逼我修炼第七季');
    const searchFn = vi.fn(async () => { throw new Error('network timeout'); });

    const discovery = createSeriesDiscovery({
      search: searchFn,
      onDiscovered: async () => {}
    });

    const res = await discovery.discover(s7);
    expect(res).toEqual([]);
  });
});
