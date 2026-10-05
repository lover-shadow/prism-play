/** 首页组合根：拓扑、滚动、重复点击与两条 feed（综合首页 / 频道目录）各自独立，视图不直接访问存储。 */

// @ts-ignore Vite 的 CSS 副作用导入没有环境模块声明（tsconfig 未挂 vite/client），构建期由 Vite 处理。
import '../styles/home.css';

import type { ChannelId, ChannelItem, ContentItem } from '../../edge/src/types/api';
import type { WatchHistoryRow } from '../core/storage/storage-domains';
import type { HomeRoundRecord } from '../core/home-recommendation';
import { isPosterMode, type PosterMode } from '../core/state/theme';
import { ALL_CATEGORIES_LABEL } from '../components/capsule-rail';
import { pickDefaultChannel } from '../components/channel-bar';
import { createContinueCard } from '../components/continue-card';
import { createModeSwitch, createPosterGrid } from '../components/poster-grid';
import { clearChildren, detailForError, renderStateView, stateKindForError, type ViewStateKind } from '../components/state-views';
import type { BadgeKind } from '../core/recommendation';
import { attachHomeScroll, resolveScroller, smoothScrollToTop, type HomeScroll } from './home-scroll';
import { createHomeTopology } from './home-topology';
import { createHomeController } from './home-refresh';
import type { RefreshFeedback } from './home-repeat';
import { createHomeFeed } from './home-composite';
import type { DiscoveryReport } from './home-feeds';
// 视图契约在 `home-contract.ts` 单处定义（§10 红线让路），导入面保持从本文件取。
import type { HomeView, HomeViewDeps } from './home-contract';
export type { HomeApi, HomeSnapshot, HomeView, HomeViewDeps } from './home-contract';
import { createDirectoryFeed } from './home-directory';
import { createHomeHosts, mountHomeLayout } from './home-layout';
import { COMPOSITE_HOME_ID } from './home-nav';

/** 单页拉取量：与目录分片契约同值（SPEC-APP-REFACTOR §2.1，`pageSize` 恒为 60），也是首页一个推荐页的展示单位。 */
export const HOME_PAGE_SIZE = 60;

export function createHomeView(deps: HomeViewDeps): HomeView {
  let reload: (() => Promise<void>) | null = null, initial: (() => Promise<void>) | null = null;
  let changeMode: ((mode: PosterMode) => void) | null = null;
  let recheck: (() => void) | null = null;
  let showRecord: (() => HomeRoundRecord | null) | null = null;
  let syncFeed: (() => Promise<void>) | null = null;
  let teardown: (() => void) | null = null, interrupt: (() => void) | null = null;

  function build(): void {
    const pageSize = deps.pageSize ?? HOME_PAGE_SIZE;
    const nowSeconds = deps.nowSeconds ?? ((): number => Math.floor(Date.now() / 1000));
    const hosts = createHomeHosts();

    let channels: ChannelItem[] = [], historyRows: WatchHistoryRow[] = [];
    let selectedChannelId: ChannelId | null = null, selectedCategory = ALL_CATEGORIES_LABEL;
    /** HP-04：启动默认停在综合首页；它是纯客户端视图，因此这里只记状态，绝不把它写进任何请求参数。 */
    let onHome = true, token = 0;

    const context = {
      paint: (items: readonly ContentItem[], badges: ReadonlyMap<string, BadgeKind>) => {
        grid.render(items, badges);
        topology.refreshRankings();
        controller.observePaint(items);                                   // HP-06c：只有此刻挂上去的公开卡片才可能被记为曝光
      },
      state: presentState,
      fail: (error: unknown, retry: () => void): void => presentState(stateKindForError(error), { detail: detailForError(error), actionLabel: '重试', onAction: retry }),
      skeleton: () => grid.showSkeleton(),
      pending: (pending: boolean) => scroll.setPending(pending),
      recheck: () => scroll.recheck(),
      isCurrent: (at: number) => at === token,
      exposed: () => controller.exposed()
    };
    const retryScope = (): void => { void loadScope(++token, false); };
    const retryTopology = (): void => { void refreshTopology(); };
    const directory = createDirectoryFeed({
      ...context, api: deps.api, pageSize, scope: () => ({ channel: onHome ? null : selectedChannelId, category: selectedCategory }),
      channels: () => channels, historyRows: () => historyRows, nowSeconds, goFallback: (id) => { if (id !== null) selectChannel(id); },
      retryScope, retryTopology
    });
    const feed = createHomeFeed({
      ...context, api: deps.api, pageSize, channels: () => channels, historyRows: () => historyRows, nowSeconds,
      retryScope, retryTopology, token: () => token,
      ...(deps.reputationOf === undefined ? {} : { reputationOf: deps.reputationOf })
    });
    const active = () => (onHome ? feed : directory);
    function loadScope(at: number, append: boolean): Promise<void> { return active().load(at, append); }

    /**
     * HP-06：显式刷新的发现入口＝**先检查可获得的内容更新（云端拓扑＋画像原料），再对本范围候选重选**。
     * 拓扑读失败只影响"内容更新"这一条：本机快照照常重排（§3.2「更新失败保留上一可用快照」）；
     * 候选读失败原样抛出——空缓存不许被说成"已更新"。代次变了就直接交出空回执，不回写任何画面。
     */
    async function discover(): Promise<DiscoveryReport> {
      const none: DiscoveryReport = { changed: false, candidates: 0, delivered: 0, exhausted: true };
      const at = token;
      try {
        const response = await deps.api.channels();
        if (at !== token) return none;
        channels = [...response.channels];
        anchorSelection();
        paintTopology();
      } catch {
        if (at !== token) return none;                                       // 拓扑读不到：沿用上一份可用快照
      }
      await loadContinue(at);
      if (at !== token) return none;
      return active().restart(at);
    }

    /** HP-06a/b：两条来路都汇到同一条刷新入口；状态条负责文案，视图只在本地也排不出来时补五态。 */
    function reportFeedback(state: RefreshFeedback): void {
      controller.feedback(state);
      deps.onFeedback?.(state);
      if (state.phase !== 'failed' || active().hasContent()) return;
      const cause = state.error ?? state.syncError;
      presentState(cause === undefined ? 'error' : stateKindForError(cause), {
        detail: detailForError(cause), actionLabel: '重试', onAction: () => { void controller.refresh(); }
      });
    }

    interrupt = () => controller.interrupt();
    const topology = createHomeTopology({
      channelHost: hosts.channelHost, railHost: hosts.railHost, keyScope: deps.root, onSearch: deps.onSearch, onNavigate: () => controller.interrupt(),
      items: () => directory.rankingsItems(), onOpenTitle: deps.onOpenTitle,
      onSelectHome: () => { if (onHome) controller.click('home'); else selectHome(); },
      onSelectChannel: (channelId) => {
        if (channelId === selectedChannelId && !onHome) controller.click(`channel:${channelId}`); else selectChannel(channelId);
      },
      onSelectCategory: (category) => {
        if (category === selectedCategory) { controller.click(`category:${selectedChannelId}:${category}`); return; }
        // HP-07a：切分类是**新范围加载**，重复点击判定序列随之重置；榜头标题/范围就地同步，开榜状态不清。
        controller.interrupt(); selectedCategory = category; paintTopology();
        smoothScrollToTop(resolveScroller(deps.root)); void loadScope(++token, false);
      }
    });
    const searchBar = topology.searchEntry();
    mountHomeLayout(hosts, searchBar, deps.headerAccessory);
    deps.root.appendChild(hosts.view);
    const controller = createHomeController({
      root: deps.root, slot: hosts.view, insertBefore: hosts.gridHost,
      top: () => smoothScrollToTop(resolveScroller(deps.root)),
      scroller: () => resolveScroller(deps.root),
      discover,
      invalidate: () => { ++token; active().suspend(); },
      feedback: reportFeedback,
      ...(deps.syncCatalog === undefined ? {} : { sync: deps.syncCatalog }),
      nowMillis: deps.nowMillis ?? ((): number => Date.now()),
      blocked: () => topology.rankingsOpen(),
      ...(deps.exposure === undefined ? {} : { exposure: deps.exposure })
    });

    const grid = createPosterGrid({ root: hosts.gridHost, mode: deps.posterMode, onOpenTitle: (id) => { controller.interrupt(); deps.onOpenTitle(id); } });
    const card = createContinueCard({ root: hosts.continueHost, onResume: (row) => { controller.interrupt(); deps.onResume(row); } });
    const modeSwitch = createModeSwitch({ root: hosts.switchHost, mode: deps.posterMode, onChange: setMode });

    // A-4 无感加载：尾部哨兵进入触底带即静默追加下一页；A-2 折叠搜索条同一条滚动订阅消费同一个容器。
    const scroll: HomeScroll = attachHomeScroll({
      root: deps.root, searchBar, tail: hosts.moreHost,
      canLoad: () => active().canLoadMore(),
      onLoad: () => void loadScope(token, true)
    });
    recheck = () => scroll.recheck();

    /** 两层导航与 FLAG_SECURE 判定共用这一次落位：切频道、换分类、重同步都只有一条渲染路径。 */
    function paintTopology(): void {
      topology.paint(channels, onHome ? COMPOSITE_HOME_ID : selectedChannelId, selectedCategory);
      deps.onChannelChange?.(currentChannel());
      modeSwitch.paint();
    }

    function currentChannel(): ChannelItem | null {
      return onHome ? null : channels.find((channel) => channel.id === selectedChannelId) ?? null;
    }

    /** HP-04 默认落位：综合首页恒为启动页；已选真实频道时钉住它，云端没下发该频道才回退。 */
    function anchorSelection(): void {
      if (onHome) { selectedChannelId = null; selectedCategory = ALL_CATEGORIES_LABEL; return; }
      const target = channels.find((channel) => channel.id === selectedChannelId) ?? pickDefaultChannel(channels);
      selectedChannelId = target?.id ?? null;
      if (!target?.categories.some((label) => label === selectedCategory)) selectedCategory = ALL_CATEGORIES_LABEL;
    }

    function presentState(kind: ViewStateKind, options: { detail?: string; actionLabel?: string; onAction?: () => void } = {}): void {
      active().suspend();
      // 哨兵与状态行留在尾部容器（canLoad 已回 false）：清掉它们等于拆了观察器又得原地重建。
      scroll.setPending(false);
      controller.observePaint([]);   // 落五态即摘除观察：不在画面里的东西永远不该被记成曝光
      grid.replaceWith(renderStateView(kind, options));
    }

    function setMode(mode: PosterMode): void {
      if (!isPosterMode(mode)) return;
      // 先交给偏好域持久化，再就地乐观重贴类名：渲染读的是注入的 `posterMode()`，偏好天然穿越重绘。
      deps.onPosterModeChange(mode);
      grid.applyMode(mode);
      modeSwitch.paint(mode);
    }

    function selectChannel(channelId: ChannelId): void {
      onHome = false; selectedChannelId = channelId; selectedCategory = ALL_CATEGORIES_LABEL;
      feed.reset();
      controller.interrupt();
      smoothScrollToTop(resolveScroller(deps.root));
      paintTopology();
      void loadScope(++token, false);
    }

    function selectHome(): void {
      onHome = true; selectedChannelId = null; selectedCategory = ALL_CATEGORIES_LABEL;
      directory.reset();
      controller.interrupt();
      smoothScrollToTop(resolveScroller(deps.root));
      paintTopology();
      void loadScope(++token, false);
    }

    /** 本地先显（AC-01）：频道目录读同频道快照；综合首页的候选池由 feed 在同一条读面上取。 */
    function hydrateFromLocalCache(): boolean {
      const snapshot = deps.api.cachedSnapshot?.();
      if (!snapshot?.channels?.channels?.length) return false;
      channels = [...snapshot.channels.channels];
      anchorSelection();
      paintTopology();
      return !onHome && directory.hydrateLocal();
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

    async function refreshTopology(): Promise<void> {
      const nextToken = ++token;
      if (!active().hasContent() && !hydrateFromLocalCache()) grid.showSkeleton();
      const continueTask = loadContinue(nextToken);
      try {
        const response = await deps.api.channels();
        if (nextToken !== token) return;
        channels = [...response.channels];
        anchorSelection();
        paintTopology();
        await loadScope(nextToken, false);
      } catch (error) {
        if (nextToken !== token) return;
        // §3.2「更新失败保留上一可用快照」：拓扑这一条读面失败只关掉"内容更新"，不该把已经躺在
        // 本机快照里的片单盖成整页错误。只剩空手（连频道都没有）才落五态。
        if (channels.length === 0) {
          presentState(stateKindForError(error), { detail: detailForError(error), actionLabel: '重试', onAction: retryTopology });
          return;
        }
        await loadScope(nextToken, false);
        if (active().hasContent()) reportFeedback({ phase: 'offline', syncError: error });
      } finally {
        await continueTask;
      }
    }

    initial = refreshTopology; reload = () => controller.refresh();
    changeMode = setMode;
    showRecord = () => (onHome ? feed.record() : null);
    syncFeed = () => (onHome ? feed.sync() : Promise.resolve());   // 频道目录范围内背景同步不越权重画首页
    teardown = () => {
      controller.destroy(); interrupt = null;
      topology.destroy(); grid.destroy(); card.destroy(); scroll.destroy();
      directory.reset(); feed.reset();
      clearChildren(deps.root);
      reload = null; changeMode = null; recheck = null; teardown = null;
      showRecord = null; syncFeed = null;
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
    recommendationRecord: () => { if (teardown === null) build(); return showRecord?.() ?? null; },
    syncRecommendation: async () => { if (teardown === null) build(); await syncFeed?.(); },
    destroy: () => teardown?.()
  };
}
