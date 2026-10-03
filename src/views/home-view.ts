/**
 * 大视界主视图（SPEC §7 第一行，AC-01 / AC-03 / AC-04；SPEC-APP-REFACTOR A-2 / A-4 / A-5）。
 *
 * 组合根只负责注入依赖：API 客户端、排版偏好读写、打开剧目、续播、历史预览、搜索 Overlay 触发。
 * 本视图不做任何持久化，也不 import 存储/播放/历史/设置视图——跨域能力一律是注入的小接口。
 * 两层导航与搜索入口在 `home-topology.ts`，滚动行为在 `home-scroll.ts`；这里只剩片单与分页。
 *
 * 本波次三条行为变更都有真实机制对应（零假 UI）：**单页 60 部**（`HOME_PAGE_SIZE` 与 Track 2 的 R2 分片
 * 一一对应，60 = 3 个 3.5:3.5:3 混排块 = 20 整行）；**无感加载**（手动【加载更多】按钮已物理拔除，尾部
 * 1px 哨兵 + IntersectionObserver 静默追加）；**分享入口**（海报卡不再有分享按钮，分享收敛播放器内）。
 */

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
import { attachHomeScroll, type HomeScroll } from './home-scroll';
import { createHomeTopology } from './home-topology';

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
  /**
   * 顶栏右侧工具槽（由外壳提供，永不被清空）。四模排版切换器挂在这里，随视图构造一次并常驻复用。
   * 缺省时切换器退回视图内部（单测与旧宿主场景），保证不必依赖外壳也能渲染。
   */
  headerAccessory?: HTMLElement | null;
  posterMode: () => PosterMode;
  onPosterModeChange: (mode: PosterMode) => void;
  onOpenTitle: (contentId: string) => void;
  onResume: (row: WatchHistoryRow) => void;
  historyPreview: () => Promise<WatchHistoryRow[]>;
  /**
   * 每次拓扑落定或用户切换频道后回传当前频道节点，供主宿主挂/摘 FLAG_SECURE（AC-02-4）。
   * 本视图不碰原生层，也不缓存这个值。
   */
  onChannelChange?: (channel: ChannelItem | null) => void;
  pageSize?: number;
  /** 打开全屏搜索 Overlay（A-3：搜索不再是 Tab）。未注入即整条搜索栏不渲染，不做只长样子的控件。 */
  onSearch?: () => void;
}

export interface HomeView {
  mount: () => Promise<void>;
  refresh: () => Promise<void>;
  setPosterMode: (mode: PosterMode) => void;
  /** 触底续载的唯一入口：哨兵与调用方共用同一条路径，不留第二套翻页语义。 */
  loadMore: () => void;
  destroy: () => void;
}

export function createHomeView(deps: HomeViewDeps): HomeView {
  let reload: (() => Promise<void>) | null = null;
  let changeMode: ((mode: PosterMode) => void) | null = null;
  let recheck: (() => void) | null = null;
  let teardown: (() => void) | null = null;

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

    const topology = createHomeTopology({
      channelHost, railHost, onSearch: deps.onSearch,
      onSelectChannel: (channelId) => { if (channelId !== selectedChannelId) selectChannel(channelId); },
      onSelectCategory: (category) => {
        if (category === selectedCategory) return;
        selectedCategory = category;
        void loadCatalog(++token, 1);
      }
    });
    const searchBar = topology.searchEntry();

    // 频道名与一级频道栏 100% 重复，排版器单占一行又把海报流下压 40px，故这一整行区块头已拔除（§1.7.3）。
    // 排版切换器优先住外壳顶栏右侧工具槽；无槽位（单测/旧宿主）时退化为视图内独立一行，功能不因此丢失。
    const rows: HTMLElement[] = [sticky];
    if (searchBar !== null) rows.push(searchBar);
    rows.push(continueHost);
    if (deps.headerAccessory !== null && deps.headerAccessory !== undefined) deps.headerAccessory.replaceChildren(switchHost);
    else rows.push(switchHost);
    rows.push(gridHost, moreHost);
    sticky.append(channelHost, railHost);
    view.append(...rows);
    deps.root.appendChild(view);

    // A-5：海报卡不再有分享入口，网格只留"进详情"这一个动作。
    const grid = createPosterGrid({ root: gridHost, mode: deps.posterMode, onOpenTitle: deps.onOpenTitle });
    const card = createContinueCard({ root: continueHost, onResume: deps.onResume });
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

    // 混排只重排**展示层**（§1.8.4 / AC-28）：输入是累积集合 `items`，page / revision / 游标 语义一字不动。
    // 题材归属由片单注入给画像引擎——`WatchHistoryRow` 没有 category 列，端侧不猜题材，查不到即不计分。
    function paintGrid(): void {
      // 题材查表用 Map：排序里每次比较都要取题材，线性 find 会把 2ms 端侧预算整个吃光。
      const genres = new Map(items.map((entry) => [entry.id, entry.category] as const));
      const genreOf: GenreOf = (contentId) => genres.get(contentId);
      const woven = weave(items, genrePreference(historyRows, Math.floor(Date.now() / 1000), genreOf), { genreOf });
      grid.render(woven.items, woven.badges);
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

      try {
        const response = await deps.api.catalog(query);
        if (nextToken !== token) return;
        // 页码是否真的推进过：边缘若把同一页原样回给我们，继续追加只会重复堆同一批剧目。
        const advanced = targetPage === 1 || response.page > page;
        page = response.page;
        total = response.total;
        pageRevision = response.revision;
        items = targetPage === 1 ? [...response.items] : [...items, ...response.items];
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
          appending = false;
          scroll.setPending(false);
          // 落定之后再复查：60 部铺不满一屏（或断网快照只有几部）时哨兵仍贴在触底带里，而观察器只对
          // "新的一次 crossing"发声，不会替静止的哨兵重试——续载链条必须在这里接上。
          scroll.recheck();
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
      scroll.recheck();
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

    reload = refreshTopology;
    changeMode = setMode;
    teardown = () => {
      topology.destroy(); grid.destroy(); card.destroy(); scroll.destroy();
      clearChildren(deps.root);
      reload = null; changeMode = null; recheck = null; teardown = null;
    };

    modeSwitch.paint();
  }

  async function boot(): Promise<void> {
    if (teardown === null) build();
    await reload?.();
  }

  return {
    mount: boot,
    refresh: boot,
    setPosterMode: (mode) => { if (teardown === null) build(); changeMode?.(mode); },
    loadMore: () => { if (teardown === null) build(); recheck?.(); },
    destroy: () => teardown?.()
  };
}
