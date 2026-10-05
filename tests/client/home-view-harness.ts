// 22/27 两份 home-view 测试共享的夹具：网络假件、拓扑、harness 装配与请求台账。
import type { ChannelId, ChannelItem, CatalogResponse, ContentItem } from '../../edge/src/types/api';
import type { WatchHistoryRow } from '../../src/core/storage/storage-domains';
import type { PosterMode } from '../../src/core/state/theme';
import { PrismApiClient } from '../../src/core/api/client';
import { createHomeView } from '../../src/views/home-view';

export const reply = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response);
export const channel = (id: ChannelId, name: string, order: number, categories: string[] = []): ChannelItem =>
  ({ id, name, order, requiresTier: [], categories });
export const content = (id: string, overrides: Partial<ContentItem> = {}): ContentItem => ({
  id, channelId: 'drama', title: `剧目${id}`, category: '都市', isPrivate: false,
  coverUrl: `https://cdn.example/${id}.jpg`, episodeCount: 40, shareable: true, ...overrides
});
export const catalog = (items: ContentItem[], page = 1, total = items.length, revision = 99): CatalogResponse =>
  ({ items, page, pageSize: 24, total, revision });
export const historyRow = (contentId: string, overrides: Partial<WatchHistoryRow> = {}): WatchHistoryRow => ({
  content_id: contentId, title: '战神之龙王归来', cover_url: 'https://cdn.example/cover-1.jpg', last_episode_id: 180,
  last_episode_number: 18, position_seconds: 102, duration_seconds: 135, total_episodes: 80,
  updated_at: 1_700_000_000, ...overrides
});
export const TOPOLOGY: ChannelItem[] = [
  channel('drama', '短剧精选', 1, ['都市', '战神', '逆袭']), channel('movie', '院线电影', 2, ['科幻']),
  channel('anime', '热血动漫', 3), channel('documentary', '人文纪录', 4)
];

export type Responder = (url: string) => Response;
export const seen: string[] = [];
export const defaultResponder: Responder = (url) =>
  url.startsWith('/api/channels') ? reply({ version: 11, channels: TOPOLOGY }) : reply(catalog(url.includes('channel=movie') ? [] : [content('c-1'), content('c-2')]));
/** 宏任务冲刷：点击链路含多层 await，微任务冲刷一层不够。 */
export const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};
export const gridClass = (root: HTMLElement): string => (root.querySelector('.home-poster-grid') as HTMLElement | null)?.className ?? '';
/** HP-04：启动默认停在综合首页，要看频道目录语义就得先点进真实频道（这一步不发任何伪频道请求）。 */
export const enterChannel = async (root: HTMLElement, id: ChannelId): Promise<void> => {
  (root.querySelector(`[data-channel-id="${id}"]`) as HTMLButtonElement).click();
  await flush();
};
export const navIds = (root: HTMLElement): string[] =>
  Array.from(root.querySelectorAll<HTMLElement>('.channel-tab')).map((tab) => tab.dataset.navId ?? '');
export const currentNav = (root: HTMLElement): string | undefined =>
  root.querySelector<HTMLElement>('.channel-tab[aria-current="true"]')?.dataset.navId;
export const resetHomeFixtures = (): void => {
  document.body.replaceChildren();
  seen.length = 0;
};

export function harness(responder: Responder = defaultResponder, rows: WatchHistoryRow[] | 'fail' = [], over: { onSearch?: () => void } = {}) {
  let mode: PosterMode = 'compact-3';
  const root = document.createElement('div');
  document.body.appendChild(root);
  const opened: string[] = [];
  const resumed: WatchHistoryRow[] = [];
  const modes: PosterMode[] = [];
  const view = createHomeView({
    api: new PrismApiClient({ baseUrl: '', fetchImpl: async (input: string) => { seen.push(input); return responder(input); } }),
    root,
    posterMode: () => mode,
    onPosterModeChange: (next) => { modes.push(next); mode = next; },
    onOpenTitle: (id) => opened.push(id),
    onResume: (entry) => resumed.push(entry),
    historyPreview: rows === 'fail' ? async () => { throw new Error('SQLite 未就绪'); } : async () => rows,
    ...(over.onSearch !== undefined ? { onSearch: over.onSearch } : {})
  });
  return { root, view, opened, resumed, modes, currentMode: () => mode };
}
