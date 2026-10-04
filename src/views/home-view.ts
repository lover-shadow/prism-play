/** 首页组合根：注入目录/同步/历史能力；拓扑、滚动、重复点击各自独立，不直接访问存储。 */

// @ts-ignore Vite 的 CSS 副作用导入没有环境模块声明（tsconfig 未挂 vite/client），构建期由 Vite 处理。
import '../styles/home.css';

import type { CatalogResponse, ChannelId, ChannelItem, ChannelsResponse, ContentItem } from '../../edge/src/types/api';
import type { WatchHistoryRow } from '../core/storage/storage-domains';
import { genrePreference, weave, type GenreOf } from '../core/recommendation';
import { isPosterMode, type PosterMode } from '../core/state/theme';
import { ALL_CATEGORIES_LABEL } from '../components/capsule-rail';
import { DEFAULT_CHANNEL_ID, pickDefaultChannel } from '../components/channel-bar';
import { createContinueCard } from '../components/continue-card';
import { createModeSwitch, createPosterGrid } from '../components/poster-grid';
import { clearChildren, detailForError, element, renderStateView, stateKindForError, type ViewStateKind } from '../components/state-views';
import { attachHomeScroll, resolveScroller, smoothScrollToTop, type HomeScroll } from './home-scroll';
import { createHomeTopology } from './home-topology';
import { createHomeRepeat } from './home-repeat';

/** 单页拉取量：与目录分片契约同值（SPEC-APP-REFACTOR §2.1，`pageSize` 恒为 60）。 */
export const HOME_PAGE_SIZE = 60;

/** 主视图实际消费的两个端点：组合根注入的是"快照优先"门面（AC-01 / AC-18），视图不该看见它拿不到的端点。 */
export interface HomeApi {
  channels(): Promise<ChannelsResponse>;
  catalog(input: { channel: string; category?: string; page?: number; pageSize?: number; revision?: number }): Promise<CatalogResponse>;
  /** 可选的本地快照读取门面：0ms 同步读取已持久化的频道与剧目，供启动立刻展示 */
  cachedSnapshot?(): { channels: ChannelsResponse | null; items(channel: string): ContentItem[] };
}

export interface HomeViewDeps {
  api: HomeApi;
  root: HTMLElement;
  /** 外壳顶栏工具槽，缺省时排版器退回视图内。 */
  headerAccessory?: HTMLElement | null;
  posterMode: () => PosterMode;
  onPosterModeChange: (mode: PosterMode) => void;
  onOpenTitle: (contentId: string) => void;
  onResume: (row: WatchHistoryRow) => void;
  historyPreview: () => Promise<WatchHistoryRow[]>;
  /** 回传当前频道供宿主挂/摘 FLAG_SECURE（AC-02-4）。 */
  onChannelChange?: (channel: ChannelItem | null) => void;
  pageSize?: number;
  /** 打开全屏搜索 Overlay（A-3：搜索不再是 Tab）。未注入即整条搜索栏不渲染，不做只长样子的控件。 */
  onSearch?: () => void;
  /** main 注入真实目录同步；resolve 必须在新快照提交后。未注入则直接重读 api（本地门面可能仅缓存）。 */
  syncCatalog?: () => Promise<void>;
}

export interface HomeView {
  mount: () => Promise<void>;
  refresh: () => Promise<void>;
  setPosterMode: (mode: PosterMode) => void;
  /** 触底续载的唯一入口：哨兵与调用方共用同一条路径，不留第二套翻页语义。 */
  loadMore: () => void;
  /** 宿主离页、打开 Overlay/播放器或其他导航时调用，打断重复序列并废弃在途视图结果。 */
  interruptNavigation: () => void;
  destroy: () => void;
}

export function createHomeView(deps: HomeViewDeps): HomeView {
  let reload: (() => Promise<void>) | null = null, initial: (() => Promise<void>) | null = null;
  let changeMode: ((mode: PosterMode) => void) | null = null;
  let recheck: (() => void) | null = null;
  let teardown: (() => void) | null = null, interrupt: (() => void) | null = null;

  function build(): void {
    const pageSize = deps.pageSize ?? HOME_PAGE_SIZE;
    const view = element('div', 'home-view'), sticky = element('div', 'home-sticky');
    const channelHost = element('div', 'home-channel-host'), railHost = element('div', 'home-capsule-host');
    const continueHost = element('div', 'home-continue-host'), switchHost = element('div', 'home-mode-switch');
    const gridHost = element('div', 'home-grid-host'), moreHost = element('div', 'home-more-host');
    continueHost.hidden = true;

    let channels: ChannelItem[] = [], items: ContentItem[] = [], historyRows: WatchHistoryRow[] = [];
    let selectedChannelId: ChannelId | null = null, selectedCategory = ALL_CATEGORIES_LABEL;
    let page = 1, total = 0, pageRevision: number | undefined, token = 0;
    /** 网格是否处于可续载态：五态（empty / error / offline / disabled）下哨兵一律不放行。 */
    let gridReady = false, appending = false;

    const repeat = createHomeRepeat({
      top: () => smoothScrollToTop(resolveScroller(deps.root)), sync: deps.syncCatalog,
      reload: refreshTopology,
      invalidate: () => { ++token; gridReady = false; appending = false; },
      failed: (error) => presentState(stateKindForError(error), { detail: detailForError(error), actionLabel: '重试', onAction: () => void repeat.refresh() })
    });
    interrupt = repeat.interrupt;
    const topology = createHomeTopology({
      channelHost, railHost, onSearch: deps.onSearch, onNavigate: repeat.interrupt,
      items: () => selectedChannelId ? deps.api.cachedSnapshot?.().items(selectedChannelId) ?? items : [],
      onOpenTitle: deps.onOpenTitle,
      onSelectChannel: (channelId) => {
        if (channelId === selectedChannelId) repeat.click(`channel:${channelId}`); else selectChannel(channelId);
      },
      onSelectCategory: (category) => {
        if (category === selectedCategory) { repeat.click(`category:${selectedChannelId}:${category}`); return; }
        repeat.interrupt(); selectedCategory = category; page = 1; pageRevision = undefined;
        smoothScrollToTop(resolveScroller(deps.root)); void loadCatalog(++token, 1);
      }
    });
    const searchBar = topology.searchEntry();

    const rows: HTMLElement[] = [sticky];
    if (searchBar !== null) rows.push(searchBar);
    rows.push(continueHost);
    if (deps.headerAccessory !== null && deps.headerAccessory !== undefined) deps.headerAccessory.replaceChildren(switchHost);
    else rows.push(switchHost);
    rows.push(gridHost, moreHost);
    sticky.append(channelHost, railHost);
    view.append(...rows);
    deps.root.appendChild(view);

    const grid = createPosterGrid({ root: gridHost, mode: deps.posterMode, onOpenTitle: (id) => { repeat.interrupt(); deps.onOpenTitle(id); } });
    const card = createContinueCard({ root: continueHost, onResume: (row) => { repeat.interrupt(); deps.onResume(row); } });
    const modeSwitch = createModeSwitch({ root: switchHost, mode: deps.posterMode, onChange: setMode });

    // A-4 无感加载：尾部哨兵进入触底带即静默追加下一页；A-2 折叠搜索条同一条滚动订阅消费同一个容器。
    const scroll: HomeScroll = attachHomeScroll({
      root: deps.root,
      searchBar,
      tail: moreHost,
      canLoad: () => gridReady && !appending && items.length > 0 && items.length < total,
      onLoad: () => void loadCatalog(token, page + 1)
    });
    recheck = () => scroll.recheck();

    function paintGrid(): void {
      // 题材查表用 Map：排序里每次比较都要取题材，线性 find 会把 2ms 端侧预算整个吃光。
      const genres = new Map(items.map((entry) => [entry.id, entry.category] as const));
      const genreOf: GenreOf = (contentId) => genres.get(contentId);
      const woven = weave(items, genrePreference(historyRows, Math.floor(Date.now() / 1000), genreOf), { genreOf, preserveAppend: true });
      grid.render(woven.items, woven.badges); topology.refreshRankings();
    }

    function currentChannel(): ChannelItem | null {
      return channels.find((channel) => channel.id === selectedChannelId) ?? null;
    }

    /** 两层导航与 FLAG_SECURE 判定共用这一次落位：切频道、换分类、重同步都只有一条渲染路径。 */
    function paintTopology(): void {
      topology.paint(channels, selectedChannelId, selectedCategory);
      deps.onChannelChange?.(currentChannel());
      modeSwitch.paint();
    }

    function setMode(mode: PosterMode): void {
      if (!isPosterMode(mode)) return;
      // 先交给偏好域持久化，再就地乐观重贴类名：渲染读的是注入的 `posterMode()`，偏好天然穿越重绘。
      deps.onPosterModeChange(mode);
      grid.applyMode(mode);
      modeSwitch.paint(mode);
    }

    function selectChannel(channelId: ChannelId): void {
      repeat.interrupt(); page = 1; pageRevision = undefined;
      smoothScrollToTop(resolveScroller(deps.root));
      selectedChannelId = channelId;
      selectedCategory = ALL_CATEGORIES_LABEL;
      paintTopology();
      void loadCatalog(++token, 1);
    }

    function presentState(kind: ViewStateKind, options: { detail?: string; actionLabel?: string; onAction?: () => void } = {}): void {
      gridReady = false;
      // 哨兵与状态行留在尾部容器（canLoad 已回 false）：清掉它们等于拆了观察器又得原地重建。
      scroll.setPending(false);
      grid.replaceWith(renderStateView(kind, options));
    }

    function emptyOptions(): { detail: string; actionLabel?: string; onAction?: () => void } {
      const fallback = channels.find((channel) => channel.id === DEFAULT_CHANNEL_ID) ?? null;
      if (fallback === null || selectedChannelId === fallback.id)
        return { detail: '该视界尚未上架内容，换个频道或稍后再来。', actionLabel: '重新加载', onAction: () => void loadCatalog(++token, 1) };
      return { detail: '该视界暂无可播放剧目。', actionLabel: `返回${fallback.name}`, onAction: () => selectChannel(fallback.id) };
    }

    async function loadCatalog(nextToken: number, targetPage: number): Promise<void> {
      const channel = selectedChannelId;
      if (channel === null) {
        presentState('disabled', { detail: '没有可展示的视界频道。', actionLabel: '重新加载', onAction: () => void refreshTopology() });
        return;
      }
      if (targetPage === 1 && items.length === 0) grid.showSkeleton();
      appending = targetPage > 1;
      scroll.setPending(appending);
      const query = {
        channel,
        ...(selectedCategory === ALL_CATEGORIES_LABEL ? {} : { category: selectedCategory }),
        page: targetPage,
        pageSize,
        // 翻页才带游标：首页无游标可钉，第二页起把上一页的 revision 交给边缘做快照一致性校验。
        ...(targetPage > 1 && pageRevision !== undefined ? { revision: pageRevision } : {})
      };

      let response: CatalogResponse | undefined;
      try {
        response = await deps.api.catalog(query);
        if (nextToken !== token) return;
        // 页码是否真的推进过：边缘若把同一页原样回给我们，继续追加只会重复堆同一批剧目。
        const advanced = targetPage === 1 || response.page > page;
        page = response.page;
        total = response.total;
        pageRevision = response.revision;
        const before = items.length;
        items = targetPage === 1 ? [...response.items] : [...new Map([...items, ...response.items].map(item => [item.id, item])).values()];
        if (targetPage > 1 && items.length === before) total = items.length;
        if (items.length === 0) {
          presentState('empty', emptyOptions());
          return;
        }
        // 空页或页码未推进就如实收口（把 total 降到已载数）：哨兵从此不再打无意义的请求，也不谎报"还有更多"。
        if (targetPage > 1 && (response.items.length === 0 || !advanced)) total = items.length;
        paintGrid();
        gridReady = true;
      } catch (error) {
        if (nextToken !== token) return;
        presentState(stateKindForError(error), { detail: detailForError(error), actionLabel: '重试', onAction: () => void loadCatalog(++token, 1) });
      } finally {
        if (nextToken === token) {
          appending = false; scroll.setPending(false);
          // 仅当条数不足单页容量（铺不满一屏）时才主动复查续载；满页由用户滚动触发，绝不自动死循环拉取。
          if (response !== undefined && response.items.length < pageSize && items.length < total) scroll.recheck();
        }
      }
    }

    async function loadContinue(nextToken: number): Promise<void> {
      try {
        const rows = await deps.historyPreview();
        // 画像原料与续播卡同源（同一个注入 seam），本视图不开第二条存储路径；取回失败即清空，不留旧画像。
        if (nextToken === token) { historyRows = rows; card.show(rows); }
      } catch {
        if (nextToken === token) { historyRows = []; card.hide(); }
      }
    }

    function hydrateFromLocalCache(): boolean {
      const snapshot = deps.api.cachedSnapshot?.();
      if (!snapshot?.channels?.channels?.length) return false;
      channels = [...snapshot.channels.channels];
      const target = currentChannel() ?? pickDefaultChannel(channels);
      selectedChannelId = target?.id ?? null;
      if (!target?.categories.includes(selectedCategory)) selectedCategory = ALL_CATEGORIES_LABEL;
      paintTopology();
      const local = selectedChannelId ? snapshot.items(selectedChannelId) : [];
      if (local.length === 0) return false;
      items = local.slice(0, pageSize);
      total = local.length;
      paintGrid();
      gridReady = true;
      if (local.length < pageSize) scroll.recheck();
      return true;
    }

    async function refreshTopology(): Promise<void> {
      const nextToken = ++token;
      if (items.length === 0 && !hydrateFromLocalCache()) grid.showSkeleton();
      const continueTask = loadContinue(nextToken);
      try {
        const response = await deps.api.channels();
        if (nextToken !== token) return;
        channels = [...response.channels];
        const target = currentChannel() ?? pickDefaultChannel(channels);
        selectedChannelId = target?.id ?? null;
        if (!target?.categories.some((label) => label === selectedCategory)) selectedCategory = ALL_CATEGORIES_LABEL;
        paintTopology();
        await loadCatalog(nextToken, 1);
      } catch (error) {
        if (nextToken !== token) return;
        presentState(stateKindForError(error), { detail: detailForError(error), actionLabel: '重试', onAction: () => void refreshTopology() });
      } finally {
        await continueTask;
      }
    }

    initial = refreshTopology; reload = repeat.refresh;
    changeMode = setMode;
    teardown = () => {
      repeat.destroy(); interrupt = null;
      topology.destroy(); grid.destroy(); card.destroy(); scroll.destroy();
      clearChildren(deps.root);
      reload = null; changeMode = null; recheck = null; teardown = null;
    };

    modeSwitch.paint();
  }

  async function boot(): Promise<void> {
    if (teardown === null) build();
    await initial?.();
  }

  return {
    mount: boot,
    refresh: async () => { if (teardown === null) build(); await reload?.(); },
    interruptNavigation: () => interrupt?.(),
    setPosterMode: (mode) => { if (teardown === null) build(); changeMode?.(mode); },
    loadMore: () => { if (teardown === null) build(); recheck?.(); },
    destroy: () => teardown?.()
  };
}
