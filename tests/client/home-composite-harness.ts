// 68/70 两份综合首页测试共享的夹具：跨四公开频道的确定性候选池、可变快照门面、画像与口碑接缝注入。
import { expect } from 'vitest';
import type { CatalogResponse, ChannelId, ChannelItem, ContentItem } from '../../edge/src/types/api';
import type { WatchHistoryRow } from '../../src/core/storage/storage-domains';
import { createHomeView, type HomeApi, type HomeView } from '../../src/views/home-view';
import type { HomeRoundRecord, ReputationOf } from '../../src/core/home-recommendation';

export const channel = (id: ChannelId, name: string, order: number, categories: string[] = []): ChannelItem =>
  ({ id, name, order, requiresTier: [], categories });
export const item = (id: string, channelId: ChannelId, overrides: Partial<ContentItem> = {}): ContentItem =>
  ({ id, channelId, title: `剧目${id}`, category: '都市', isPrivate: false, coverUrl: `https://cdn.example/${id}.jpg`, ...overrides });
export const row = (contentId: string, overrides: Partial<WatchHistoryRow> = {}): WatchHistoryRow =>
  ({ content_id: contentId, title: '剧目', cover_url: null, last_episode_id: 3, last_episode_number: 3,
    position_seconds: 600, duration_seconds: 1000, total_episodes: 40, updated_at: 1_700_000_000, ...overrides });

export const FOUR: ChannelItem[] = [
  channel('drama', '精彩短剧', 1, ['都市', '战神']), channel('movie', '电影仓库', 2, ['科幻']),
  channel('documentary', '纪录片', 3, ['自然']), channel('anime', '动漫', 4, ['番剧'])
];

/** 确定性跨频道候选池：短剧 30 AI + 40 真人、电影 20、纪录片 8、动漫 7，共 105 部公开作品。 */
export function pool(): ContentItem[] {
  const drama = [
    ...Array.from({ length: 30 }, (_, i) => item(`ai-${String(i + 1).padStart(2, '0')}`, 'drama', { isAi: true, hitsTotal: 500 - i })),
    ...Array.from({ length: 40 }, (_, i) => item(`live-${String(i + 1).padStart(2, '0')}`, 'drama', { hitsTotal: 900 - i, category: '战神' }))
  ];
  const movie = Array.from({ length: 20 }, (_, i) => item(`mv-${String(i + 1).padStart(2, '0')}`, 'movie', { category: '科幻', hitsTotal: 400 - i }));
  const doc = Array.from({ length: 8 }, (_, i) => item(`doc-${String(i + 1).padStart(2, '0')}`, 'documentary', { category: '自然', hitsTotal: 300 - i }));
  const anime = Array.from({ length: 7 }, (_, i) => item(`an-${String(i + 1).padStart(2, '0')}`, 'anime', { category: '番剧', hitsTotal: 200 - i }));
  return [...drama, ...movie, ...doc, ...anime];
}

export interface SnapshotState { revision: number; partial: boolean }

export interface HarnessOptions {
  items?: ContentItem[];
  channels?: ChannelItem[];
  rows?: WatchHistoryRow[];
  /** 可变快照状态：用例就地推进 revision / partial，验 HP-05 的覆盖度与换代混排策略。 */
  state?: SnapshotState;
  reputationOf?: ReputationOf;
  networkCatalog?: (input: { channel: string }) => ContentItem[];
  noSnapshot?: boolean;
}

export function setup(over: HarnessOptions = {}) {
  const items = over.items ?? pool();
  const channels = over.channels ?? FOUR;
  const state = over.state ?? { revision: 42, partial: false };
  const network = over.networkCatalog ?? ((input: { channel: string }) => items.filter((entry) => entry.channelId === input.channel));
  const requested: string[] = [];
  const api: HomeApi = {
    channels: async () => ({ version: 3, channels }),
    catalog: async (input) => {
      requested.push(`catalog:${input.channel}:${input.page ?? 1}`);
      const source = network(input);
      const page = input.page ?? 1, size = input.pageSize ?? 60;
      return { items: source.slice((page - 1) * size, page * size), page, pageSize: size, total: source.length, revision: 42 } as CatalogResponse;
    },
    ...(over.noSnapshot === true ? {} : {
      cachedSnapshot: () => ({
        channels: { version: 3, channels },
        items: (channelId: string) => channelId === 'private' ? [] : items.filter((entry) => entry.channelId === channelId),
        state: () => ({ revision: state.revision, items: items.length, channels: channels.length, partial: state.partial })
      })
    })
  };
  const root = document.createElement('div');
  document.body.appendChild(root);
  const view: HomeView = createHomeView({
    api, root, posterMode: () => 'compact-3', onPosterModeChange: () => undefined,
    onOpenTitle: () => undefined, onResume: () => undefined,
    historyPreview: async () => over.rows ?? [],
    nowSeconds: () => 1_700_000_000,
    ...(over.reputationOf === undefined ? {} : { reputationOf: over.reputationOf })
  });
  const ids = (): string[] => Array.from(root.querySelectorAll<HTMLElement>('.poster-card')).map((node) => node.dataset.contentId ?? '');
  const of = (id: string): ContentItem | undefined => items.find((entry) => entry.id === id);
  return { root, view, ids, of, state, requested, record: () => view.recommendationRecord() };
}

export const flush = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)); };
export const tabIds = (root: HTMLElement): string[] =>
  Array.from(root.querySelectorAll<HTMLElement>('.channel-tab')).map((tab) => tab.dataset.navId ?? '');
export const capsules = (root: HTMLElement): (string | null)[] =>
  Array.from(root.querySelectorAll<HTMLElement>('.capsule[data-category]')).map((pill) => pill.textContent);
/** 断言"记录必须存在"后再解引用：红灯是断言失败，而不是空指针崩溃。 */
export const must = (record: HomeRoundRecord | null): HomeRoundRecord => {
  expect(record, '综合首页必须登记本轮推荐输入（轮次/revision/覆盖/证据/配额）').not.toBeNull();
  return record as HomeRoundRecord;
};
export const track = (record: HomeRoundRecord, name: string) => record.allocation.find((entry) => entry.track === name);
