/**
 * 大视界主视图（SPEC §7 第一行，AC-01 / AC-03 / AC-04）。
 *
 * 组合根只负责注入依赖：API 客户端、排版偏好读写、打开剧目、续播、历史预览。本视图不做任何持久化，
 * 也不 import 存储/播放/历史/设置视图——跨域能力一律是注入的小接口，并行施工的兄弟 Agent 可各自替换
 * 实现而 shell 的测试面不变。
 */

// @ts-ignore Vite 的 CSS 副作用导入没有环境模块声明（tsconfig 未挂 vite/client），构建期由 Vite 处理。
import '../styles/home.css';

import type { CatalogResponse, ChannelId, ChannelItem, ChannelsResponse, ContentItem } from '../../edge/src/types/api';
import type { WatchHistoryRow } from '../core/storage/storage-domains';
import { POSTER_MODE_LABEL, isPosterMode, type PosterMode } from '../core/state/theme';
import { ALL_CATEGORIES_LABEL, createCapsuleRail } from '../components/capsule-rail';
import { createChannelBar, DEFAULT_CHANNEL_ID, pickDefaultChannel } from '../components/channel-bar';
import { createContinueCard } from '../components/continue-card';
import { icon } from '../components/icons';
import { createModeSwitch, createPosterGrid } from '../components/poster-grid';
import {
  clearChildren,
  element,
  detailForError,
  renderStateView,
  stateKindForError,
  type ViewStateKind
} from '../components/state-views';

const DEFAULT_PAGE_SIZE = 24;

/** 主视图实际消费的两个端点：组合根注入的是"快照优先"门面（AC-01 / AC-18），视图不该看见它拿不到的端点。 */
export interface HomeApi {
  channels(): Promise<ChannelsResponse>;
  catalog(input: { channel: string; category?: string; page?: number; pageSize?: number; revision?: number }): Promise<CatalogResponse>;
}

export interface HomeViewDeps {
  api: HomeApi;
  root: HTMLElement;
  posterMode: () => PosterMode;
  onPosterModeChange: (mode: PosterMode) => void;
  onOpenTitle: (contentId: string) => void;
  onResume: (row: WatchHistoryRow) => void;
  historyPreview: () => Promise<WatchHistoryRow[]>;
  /** 分享落点（复制链接 / 原生分享面板）。缺省时海报上的分享按钮打开边缘 `/s/:id`。 */
  onShare?: (item: ContentItem) => void;
  /**
   * 每次拓扑落定或用户切换频道后回传当前频道节点，供主宿主挂/摘 FLAG_SECURE（AC-02-4）。
   * 本视图不碰原生层，也不缓存这个值。
   */
  onChannelChange?: (channel: ChannelItem | null) => void;
  pageSize?: number;
  onSearch?: () => void;
}

export interface HomeView {
  mount: () => Promise<void>;
  refresh: () => Promise<void>;
  setPosterMode: (mode: PosterMode) => void;
  destroy: () => void;
}

export function createHomeView(deps: HomeViewDeps): HomeView {
  let reload: (() => Promise<void>) | null = null;
  let changeMode: ((mode: PosterMode) => void) | null = null;
  let teardown: (() => void) | null = null;

  function build(): void {
    const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
    const view = element('div', 'home-view');
    const sticky = element('div', 'home-sticky');
    const channelHost = element('div', 'home-channel-host');
    const railHost = element('div', 'home-capsule-host');
    const searchBar = element('div', 'home-search-bar');
    searchBar.setAttribute('role', 'button');
    searchBar.setAttribute('tabindex', '0');
    searchBar.setAttribute('aria-label', '搜索全网剧目');
    searchBar.innerHTML = `<span class="home-search-lead">${icon('search', { size: 16 })}<span>搜索剧名 / 题材</span></span>`;
    searchBar.addEventListener('click', () => {
      if (deps.onSearch) deps.onSearch();
      else {
        const btn = document.querySelector<HTMLButtonElement>('.app-tab[data-tab="search"]');
        btn?.click();
      }
    });
    searchBar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        searchBar.click();
      }
    });

    const continueHost = element('div', 'home-continue-host');
    const heading = element('h2', 'home-section-header');
    const titleGroup = element('div', 'home-section-lead');
    const channelName = element('span', 'home-section-title');
    const modeTag = element('span', 'home-mode-tag');
    titleGroup.appendChild(channelName);
    titleGroup.appendChild(modeTag);

    const switchHost = element('div', 'home-mode-switch');
    const gridHost = element('div', 'home-grid-host');
    const moreHost = element('div', 'home-more-host');
    continueHost.hidden = true;

    sticky.appendChild(channelHost);
    sticky.appendChild(railHost);
    heading.appendChild(titleGroup);
    heading.appendChild(switchHost);

    view.appendChild(sticky);
    view.appendChild(searchBar);
    view.appendChild(continueHost);
    view.appendChild(heading);
    view.appendChild(gridHost);
    view.appendChild(moreHost);
    view.appendChild(gridHost);
    view.appendChild(moreHost);
    deps.root.appendChild(view);

    let channels: ChannelItem[] = [];
    let items: ContentItem[] = [];
    let selectedChannelId: ChannelId | null = null;
    let selectedCategory = ALL_CATEGORIES_LABEL;
    let page = 1;
    let total = 0;
    let pageRevision: number | undefined;
    let token = 0;

    const bar = createChannelBar({ root: channelHost, onSelect: (channelId) => { if (channelId !== selectedChannelId) selectChannel(channelId); } });
    const rail = createCapsuleRail({
      root: railHost,
      onSelect: (category) => {
        if (category === selectedCategory) return;
        selectedCategory = category;
        rail.select(category);
        void loadCatalog(++token, 1);
      }
    });
    const grid = createPosterGrid({
      root: gridHost,
      mode: deps.posterMode,
      onOpenTitle: deps.onOpenTitle,
      onShare: deps.onShare
    });
    const card = createContinueCard({ root: continueHost, onResume: deps.onResume });
    const modeSwitch = createModeSwitch({ root: switchHost, mode: deps.posterMode, onChange: setMode });

    function currentChannel(): ChannelItem | null {
      return channels.find((channel) => channel.id === selectedChannelId) ?? null;
    }

    function paintHeading(active?: PosterMode): void {
      channelName.textContent = currentChannel()?.name ?? '大视界';
      modeTag.textContent = `【${POSTER_MODE_LABEL[active ?? deps.posterMode()]}】`;
    }

    function setMode(mode: PosterMode): void {
      if (!isPosterMode(mode)) return;
      // 先交给偏好域持久化，再就地乐观重贴类名：渲染读的是注入的 `posterMode()`，偏好天然穿越重绘。
      deps.onPosterModeChange(mode);
      grid.applyMode(mode);
      paintHeading(mode);
      modeSwitch.paint(mode);
    }

    function selectChannel(channelId: ChannelId): void {
      selectedChannelId = channelId;
      selectedCategory = ALL_CATEGORIES_LABEL;
      bar.select(channelId);
      rail.render(currentChannel()?.categories ?? [], selectedCategory);
      paintHeading();
      deps.onChannelChange?.(currentChannel());
      void loadCatalog(++token, 1);
    }

    function presentState(
      kind: ViewStateKind,
      options: { detail?: string; actionLabel?: string; onAction?: () => void } = {}
    ): void {
      grid.replaceWith(renderStateView(kind, options));
      clearChildren(moreHost);
    }

    function renderMore(): void {
      clearChildren(moreHost);
      if (items.length === 0 || items.length >= total) return;
      const button = element('button', 'home-more-btn touch-target', `加载更多（已载 ${items.length} / ${total}）`);
      button.type = 'button';
      button.addEventListener('click', () => void loadCatalog(token, page + 1));
      moreHost.appendChild(button);
    }

    function emptyOptions(): { detail: string; actionLabel?: string; onAction?: () => void } {
      const fallback = channels.find((channel) => channel.id === DEFAULT_CHANNEL_ID) ?? null;
      if (fallback === null || selectedChannelId === fallback.id) {
        // 没有可退回的默认视界时也要给一条出路：五态里每一态都得是可操作的（SPEC §10）。
        return { detail: '该视界尚未上架内容，换个频道或稍后再来。', actionLabel: '重新加载', onAction: () => void loadCatalog(++token, 1) };
      }
      return {
        detail: '该视界暂无可播放剧目。',
        actionLabel: `返回${fallback.name}`,
        onAction: () => selectChannel(fallback.id)
      };
    }

    async function loadCatalog(nextToken: number, targetPage: number): Promise<void> {
      const channel = selectedChannelId;
      if (channel === null) {
        presentState('disabled', {
          detail: '没有可展示的视界频道。',
          actionLabel: '重新加载',
          onAction: () => void refreshTopology()
        });
        return;
      }
      if (targetPage === 1) {
        items = [];
        grid.showSkeleton();
      }
      const query = {
        channel,
        ...(selectedCategory === ALL_CATEGORIES_LABEL ? {} : { category: selectedCategory }),
        page: targetPage,
        pageSize,
        // 翻页才带游标：首页无游标可钉，第二页起把上一页的 revision 交给边缘做快照一致性校验。
        ...(targetPage > 1 && pageRevision !== undefined ? { revision: pageRevision } : {})
      };

      try {
        const response = await deps.api.catalog(query);
        if (nextToken !== token) return;
        page = response.page;
        total = response.total;
        pageRevision = response.revision;
        items = targetPage === 1 ? [...response.items] : [...items, ...response.items];
        if (items.length === 0) {
          presentState('empty', emptyOptions());
          return;
        }
        grid.render(items);
        renderMore();
      } catch (error) {
        if (nextToken !== token) return;
        presentState(stateKindForError(error), {
          detail: detailForError(error),
          actionLabel: '重试',
          onAction: () => void loadCatalog(++token, 1)
        });
      }
    }

    async function loadContinue(nextToken: number): Promise<void> {
      try {
        const rows = await deps.historyPreview();
        if (nextToken === token) card.show(rows);
      } catch {
        // 历史域由并行施工的兄弟模块持有：它的失败只让续播卡缺席，绝不拖垮片单。
        if (nextToken === token) card.hide();
      }
    }

    async function refreshTopology(): Promise<void> {
      const nextToken = ++token;
      grid.showSkeleton();
      // 续播卡与拓扑并行拉取；`mount()` resolve 时两者都已落定，测试与组合根都不必再等空转的微任务。
      const continueTask = loadContinue(nextToken);
      try {
        const response = await deps.api.channels();
        if (nextToken !== token) return;
        channels = [...response.channels];
        // AC-01 默认高亮短剧精选；refresh 时用户已选频道若仍在响应里就尊重它。
        const keep = currentChannel();
        const target = keep ?? pickDefaultChannel(channels);
        selectedChannelId = target?.id ?? null;
        const known = target?.categories.some((label) => label === selectedCategory) ?? false;
        if (!known) selectedCategory = ALL_CATEGORIES_LABEL;
        bar.render(channels, selectedChannelId);
        rail.render(target?.categories ?? [], selectedCategory);
        paintHeading();
        deps.onChannelChange?.(target);
        modeSwitch.paint();
        await loadCatalog(nextToken, 1);
      } catch (error) {
        if (nextToken !== token) return;
        presentState(stateKindForError(error), {
          detail: detailForError(error),
          actionLabel: '重试',
          onAction: () => void refreshTopology()
        });
      } finally {
        await continueTask;
      }
    }

    reload = refreshTopology;
    changeMode = setMode;
    teardown = () => {
      bar.destroy();
      rail.destroy();
      grid.destroy();
      card.destroy();
      clearChildren(deps.root);
      reload = null;
      changeMode = null;
      teardown = null;
    };

    paintHeading();
    modeSwitch.paint();
  }

  async function boot(): Promise<void> {
    if (teardown === null) build();
    await reload?.();
  }

  return {
    mount: boot,
    refresh: boot,
    setPosterMode: (mode) => {
      if (teardown === null) build();
      changeMode?.(mode);
    },
    destroy: () => teardown?.()
  };
}
