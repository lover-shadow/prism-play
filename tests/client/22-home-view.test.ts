// @vitest-environment jsdom
/** 大视界主视图装配测试：AC-01 拓扑驱动默认高亮、AC-02-3 私密缺席、AC-04 排版持久化、AC-15/AC-18 离线诚实边界、SPEC §7 五态。 */

import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelId, ChannelItem, CatalogResponse, ContentItem } from '../../edge/src/types/api';
import type { WatchHistoryRow } from '../../src/core/storage/storage-domains';
import type { PosterMode } from '../../src/core/state/theme';
import { PrismApiClient } from '../../src/core/api/client';
import { createHomeView } from '../../src/views/home-view';

const reply = (body: unknown, status = 200): Response =>
  ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response);
const channel = (id: ChannelId, name: string, order: number, categories: string[] = []): ChannelItem =>
  ({ id, name, order, requiresTier: [], categories });
const content = (id: string, overrides: Partial<ContentItem> = {}): ContentItem => ({
  id, channelId: 'drama', title: `剧目${id}`, category: '都市', isPrivate: false,
  coverUrl: `https://cdn.example/${id}.jpg`, episodeCount: 40, shareable: true, ...overrides
});
const catalog = (items: ContentItem[], page = 1, total = items.length, revision = 99): CatalogResponse =>
  ({ items, page, pageSize: 24, total, revision });
const historyRow = (contentId: string, overrides: Partial<WatchHistoryRow> = {}): WatchHistoryRow => ({
  content_id: contentId, title: '战神之龙王归来', cover_url: 'https://cdn.example/cover-1.jpg', last_episode_id: 180,
  last_episode_number: 18, position_seconds: 102, duration_seconds: 135, total_episodes: 80,
  updated_at: 1_700_000_000, ...overrides
});
const TOPOLOGY: ChannelItem[] = [
  channel('drama', '短剧精选', 1, ['都市', '战神', '逆袭']), channel('movie', '院线电影', 2, ['科幻']),
  channel('anime', '热血动漫', 3), channel('documentary', '人文纪录', 4)
];

type Responder = (url: string) => Response;
const seen: string[] = [];
const defaultResponder: Responder = (url) =>
  url.startsWith('/api/channels') ? reply({ version: 11, channels: TOPOLOGY }) : reply(catalog(url.includes('channel=movie') ? [] : [content('c-1'), content('c-2')]));
/** 宏任务冲刷：点击链路含多层 await，微任务冲刷一层不够。 */
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};
const gridClass = (root: HTMLElement): string => (root.querySelector('.home-poster-grid') as HTMLElement | null)?.className ?? '';

function harness(responder: Responder = defaultResponder, rows: WatchHistoryRow[] | 'fail' = []) {
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
    historyPreview: rows === 'fail' ? async () => { throw new Error('SQLite 未就绪'); } : async () => rows
  });
  return { root, view, opened, resumed, modes, currentMode: () => mode };
}

afterEach(() => {
  document.body.replaceChildren();
  seen.length = 0;
});

describe('home-view 挂载与默认高亮（AC-01）', () => {
  it('首屏拉云端拓扑，四公开频道齐备且默认高亮短剧精选', async () => {
    const h = harness();
    await h.view.mount();

    expect(seen[0]).toBe('/api/channels');
    expect(Array.from(h.root.querySelectorAll('.channel-tab')).map((tab) => tab.textContent))
      .toEqual(['短剧精选', '院线电影', '热血动漫', '人文纪录']);
    expect(h.root.querySelectorAll('.channel-tab[aria-current="true"]').length).toBe(1);
    expect(h.root.querySelector<HTMLElement>('.channel-tab[aria-current="true"]')?.dataset.channelId).toBe('drama');
    // AC-25：区块头被物理拔除——频道名与一级频道栏 100% 重复，那一行还白吃 40px 高度。
    expect(h.root.querySelector('.home-section-header')).toBeNull();
    expect(h.root.querySelector('.home-section-title')).toBeNull();
  });

  it('云端未下发短剧精选时高亮 order 最小项，绝不造假频道', async () => {
    const h = harness((url) =>
      url.startsWith('/api/channels')
        ? reply({ version: 1, channels: [channel('anime', '热血动漫', 3), channel('movie', '院线电影', 2)] })
        : reply(catalog([content('a-1')])));
    await h.view.mount();
    expect(h.root.querySelector<HTMLElement>('.channel-tab[aria-current="true"]')?.dataset.channelId).toBe('movie');
  });

  it('未下发 private 时整棵 DOM 物理隐形：零节点、零字样、零二级分类', async () => {
    const h = harness();
    await h.view.mount();

    expect(h.root.querySelectorAll('[data-channel-id="private"]').length).toBe(0);
    expect(h.root.innerHTML.toLowerCase()).not.toContain('private');
    expect(h.root.textContent ?? '').not.toContain('个人探索');
    expect(Array.from(h.root.querySelectorAll('.capsule')).map((pill) => pill.textContent)).toEqual(['全部', '都市', '战神', '逆袭']);
  });

  it('云端下发 private 时才渲染它；私密条目自身也不带分享按钮', async () => {
    const h = harness((url) =>
      url.startsWith('/api/channels')
        ? reply({ version: 2, channels: [...TOPOLOGY, channel('private', '个人探索', 9, ['今日更新'])] })
        : reply(catalog([content('p-1', { channelId: 'private', isPrivate: true, shareable: false })])));
    await h.view.mount();

    expect(h.root.querySelectorAll('[data-channel-id="private"]').length).toBe(1);
    expect(h.root.querySelector('[data-channel-id="private"]')?.textContent).toBe('个人探索');
    expect(h.root.querySelectorAll('.poster-share').length).toBe(0);
  });

  it('海报请求带上所选频道与分页，切频道后重新拉取且空片单退场网格', async () => {
    const h = harness();
    await h.view.mount();
    expect(seen).toContain('/api/catalog?channel=drama&page=1&pageSize=24');

    (h.root.querySelector('[data-channel-id="movie"]') as HTMLButtonElement).click();
    await flush();
    expect(seen).toContain('/api/catalog?channel=movie&page=1&pageSize=24');
    expect(h.root.querySelector('.state-view--empty')).not.toBeNull();
    expect(h.root.querySelector('.home-poster-grid')).toBeNull();
  });

  it('选中的二级分类才作为 category 下发，「全部」不带参数', async () => {
    const h = harness();
    await h.view.mount();
    const pill = Array.from(h.root.querySelectorAll<HTMLButtonElement>('.capsule')).find((entry) => entry.textContent === '战神');
    (pill as HTMLButtonElement).click();
    await flush();
    expect(seen).toContain('/api/catalog?channel=drama&category=%E6%88%98%E7%A5%9E&page=1&pageSize=24');
  });
});

describe('home-view 排版模式（AC-04）', () => {
  it('setPosterMode 回调持久化并重贴类名，重绘后仍是同一模式', async () => {
    const h = harness();
    await h.view.mount();
    expect(gridClass(h.root)).toBe('home-poster-grid grid-posters-compact-3');

    h.view.setPosterMode('bookshelf-4');
    expect(h.modes).toEqual(['bookshelf-4']);
    expect(h.currentMode()).toBe('bookshelf-4');
    expect(gridClass(h.root)).toContain('grid-posters-bookshelf-4');

    await h.view.refresh();
    expect(gridClass(h.root)).toContain('grid-posters-bookshelf-4');
    // 模式归属的唯一可见证据是切换器自身的 `aria-pressed`；旧的【四列书架】文字标签随区块头一起拔除，
    // 重绘后仍要点亮同一颗，否则说明偏好态被重建冲掉了。
    expect(h.root.querySelector('.home-mode-tag')).toBeNull();
    const pressed = Array.from(h.root.querySelectorAll<HTMLButtonElement>('.mode-btn'))
      .filter((button) => button.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0]?.dataset.mode).toBe('bookshelf-4');
  });

  it('点击切换器即回传模式，aria-pressed 乐观点亮', async () => {
    const h = harness();
    await h.view.mount();
    const buttons = Array.from(h.root.querySelectorAll<HTMLButtonElement>('.mode-btn'));
    expect(buttons.map((button) => button.dataset.mode)).toEqual(['compact-3', 'comfort-2', 'bookshelf-4', 'list-1']);

    buttons[1].click();
    expect(h.modes).toEqual(['comfort-2']);
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
    expect(gridClass(h.root)).toContain('grid-posters-comfort-2');
  });
});

describe('home-view 五态（SPEC §7）', () => {
  it('加载中先铺骨架屏，不留空白首屏', async () => {
    const h = harness();
    const pending = h.view.mount();
    expect(h.root.querySelectorAll('.poster-card--skeleton').length).toBeGreaterThan(0);
    expect(h.root.querySelector<HTMLElement>('.home-poster-grid')?.dataset.state).toBe('loading');
    await pending;
    expect(h.root.querySelectorAll('.poster-card--skeleton').length).toBe(0);
  });

  it('断网走 offline 态：文案声明点播需要网络，绝不承诺可离线播放', async () => {
    const h = harness(() => { throw new TypeError('fetch failed'); });
    await h.view.mount();
    const box = h.root.querySelector('.state-view--offline') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.getAttribute('role')).toBe('alert');
    const copy = box.textContent ?? '';
    expect(copy).toContain('网络');
    expect(copy).toContain('点播');
    expect(copy).not.toMatch(/离线播放|无需联网|可以离线看/);
    expect(h.root.querySelectorAll('.state-view--error').length).toBe(0);
  });

  it('服务端 503 走 error 态并带重试按钮，点击重新拉取', async () => {
    const h = harness(() => reply({ success: false, code: 'SERVICE_UNAVAILABLE', message: '边缘节点拥挤' }, 503));
    await h.view.mount();
    const box = h.root.querySelector('.state-view--error') as HTMLElement;
    expect(box.textContent ?? '').toContain('边缘节点拥挤');

    const before = seen.length;
    (box.querySelector('.state-view-action') as HTMLButtonElement).click();
    await flush();
    expect(seen.length).toBeGreaterThan(before);
  });

  it('私密凭据失效走 disabled 态而非 error 态', async () => {
    const h = harness(() => reply({ success: false, code: 'PRIVATE_SESSION_REQUIRED', message: '当次会话已结束' }, 403));
    await h.view.mount();
    expect(h.root.querySelector('.state-view--disabled')).not.toBeNull();
    expect(h.root.querySelector('.state-view--error')).toBeNull();
  });

  it('空片单走 empty 态并提供返回短剧精选', async () => {
    const h = harness((url) => (url.startsWith('/api/channels') ? reply({ version: 11, channels: TOPOLOGY }) : reply(catalog([]))));
    await h.view.mount();
    (h.root.querySelector('[data-channel-id="anime"]') as HTMLButtonElement).click();
    await flush();

    const box = h.root.querySelector('.state-view--empty') as HTMLElement;
    expect(box.textContent ?? '').toContain('暂无可播放剧目');
    expect(box.querySelector('.state-view-action')?.textContent).toBe('返回短剧精选');
  });
});

describe('home-view 续播卡与生命周期', () => {
  it('有历史即渲染续播卡，点击回传整行断点（AC-03）', async () => {
    const h = harness(defaultResponder, [historyRow('c-9', { updated_at: 1 }), historyRow('c-1')]);
    await h.view.mount();
    const card = h.root.querySelector('.continue-card') as HTMLButtonElement;
    expect(card.dataset.contentId).toBe('c-1');
    expect(card.textContent ?? '').toContain('第 18 集');
    expect(card.textContent ?? '').toContain('1:42');
    expect(h.root.querySelector('.continue-progress-fill')?.getAttribute('style')).toBe('width: 76%;');

    card.click();
    expect(h.resumed.length).toBe(1);
    expect(h.resumed[0].last_episode_id).toBe(180);
  });

  it('无历史时整卡不渲染，不占首屏', async () => {
    const h = harness();
    await h.view.mount();
    expect(h.root.querySelector('.continue-card')).toBeNull();
    expect(h.root.querySelector('.home-continue-host')?.hasAttribute('hidden')).toBe(true);
  });

  it('历史域失败只让续播卡缺席，片单照常', async () => {
    const h = harness(defaultResponder, 'fail');
    await h.view.mount();
    expect(h.root.querySelector('.continue-card')).toBeNull();
    expect(h.root.querySelectorAll('.poster-card').length).toBe(2);
  });

  it('点海报回调 contentId，refresh 保留用户已选频道与「全部」分类', async () => {
    const h = harness();
    await h.view.mount();
    (h.root.querySelector('.poster-open') as HTMLButtonElement).click();
    expect(h.opened).toEqual(['c-1']);

    (h.root.querySelector('[data-channel-id="movie"]') as HTMLButtonElement).click();
    await flush();
    expect(h.root.querySelector<HTMLElement>('.channel-tab[aria-current="true"]')?.dataset.channelId).toBe('movie');

    await h.view.refresh();
    expect(h.root.querySelector<HTMLElement>('.channel-tab[aria-current="true"]')?.dataset.channelId).toBe('movie');
    expect(h.root.querySelector('.capsule[aria-current="true"]')?.textContent).toBe('全部');
  });

  it('destroy 清空宿主，setPosterMode 在未挂载时先装配', async () => {
    const h = harness();
    await h.view.mount();
    h.view.destroy();
    expect(h.root.childElementCount).toBe(0);

    const idle = harness();
    idle.view.setPosterMode('list-1');
    expect(idle.modes).toEqual(['list-1']);
    expect(idle.root.querySelectorAll('.mode-btn').length).toBe(4);
  });

  it('总条数大于已载条数时给出加载更多，翻页带上 revision 游标', async () => {
    const h = harness((url) =>
      url.startsWith('/api/channels')
        ? reply({ version: 11, channels: TOPOLOGY })
        : url.includes('page=2')
          ? reply(catalog([content('c-9')], 2))
          : reply(catalog([content('c-1')], 1, 30, 77)));
    await h.view.mount();
    const more = h.root.querySelector('.home-more-btn') as HTMLButtonElement;
    expect(more.textContent ?? '').toContain('已载 1 / 30');

    more.click();
    await flush();
    expect(seen).toContain('/api/catalog?channel=drama&page=2&pageSize=24&revision=77');
    expect(h.root.querySelectorAll('.poster-card').length).toBe(2);
  });
});
