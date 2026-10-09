// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { createHomeView, type HomeApi } from '../../src/views/home-view';
import type { ChannelsResponse, ContentItem } from '../../edge/src/types/api';

const MOCK_CHANNELS: ChannelsResponse = {
  version: 1,
  channels: [
    { id: 'drama', name: '短剧', order: 1, requiresTier: ['0'], categories: ['都市', '逆袭'] }
  ]
};

const MOCK_ITEMS: ContentItem[] = [
  { id: 'drama_1', channelId: 'drama', title: '战神归来', category: '逆袭', enabled: true, shareable: true, isPrivate: false },
  { id: 'drama_2', channelId: 'drama', title: '龙王殿', category: '都市', enabled: true, shareable: true, isPrivate: false }
];

describe('首页本地快照启动先显（AC-OPT-01）', () => {
  it('存在本地快照时，在 channels 网络请求挂起时立即呈现首屏卡片，无需骨架屏等待', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);

    let channelsResolve!: (res: ChannelsResponse) => void;
    const channelsPromise = new Promise<ChannelsResponse>((resolve) => {
      channelsResolve = resolve;
    });

    const homeApi: HomeApi = {
      channels: () => channelsPromise,
      catalog: async () => ({ items: MOCK_ITEMS, page: 1, pageSize: 60, total: 2, revision: 1 }),
      cachedSnapshot: () => ({
        channels: MOCK_CHANNELS,
        state: () => ({ revision: 1, items: 2, channels: 1, partial: false }),
        items: (_ch: string) => MOCK_ITEMS
      })
    };

    const view = createHomeView({
      api: homeApi,
      root,
      nowSeconds: () => 1700000000,
      posterMode: () => 'compact-3',
      onPosterModeChange: () => {},
      onOpenTitle: () => {},
      onResume: () => {},
      historyPreview: async () => [],
      onSearch: () => {}
    });

    // 启动挂载
    const mounted = view.mount();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // 在 channels 尚未 resolve 时，本地卡片必须已经上屏
    const cards = root.querySelectorAll('article.poster-card');
    expect(cards.length).toBeGreaterThan(0);
    expect(root.querySelector('.poster-card--skeleton')).toBeNull();

    // 随后让网络 channels 请求正常完成
    channelsResolve(MOCK_CHANNELS);
    await mounted;

    // 卡片依然正常存在
    const afterCards = root.querySelectorAll('article.poster-card');
    expect(afterCards.length).toBeGreaterThan(0);

    view.destroy();
    root.remove();
  });
});
