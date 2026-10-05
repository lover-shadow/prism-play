/**
 * 首页视界拓扑选择器（SPEC §7 两层导航 + SPEC-APP-REFACTOR A-2 搜索入口）。
 *
 * 从 `home-view.ts` 拆出是为 §10 的 300 行红线让路，也正好顺着语义边界切：这一件只管"选哪个视界 /
 * 哪个分类 / 打开搜索 / 展开热门榜"，片单与分页全部留在主视图。四条渲染口径沿用原实现，一条都没放松：
 * 1. 频道与分类 100% 来自 `/api/channels`，客户端不补位、不造假（AC-02-3 的双层隐形依赖"缺席即契约"）；
 * 2. 搜索条只在注入 `onSearch` 时存在——没有真实 Overlay 可打开的搜索框就是虚假 UI，宁可整条缺席；
 * 3. 折叠动效不在这里：本模块只交出搜索条节点，滚动差量状态机归 `home-scroll.ts`；
 * 4. HP-02：榜单是"就地展开区"而不是独立页面，所以它不进历史记录，只在既有返回总线占**一条** layer
 *    handler（关榜、切频道、离页、销毁都必须注销）。搜索 Overlay 与播放器由同层 LIFO 天然压在我们上面，
 *    本批不重排 `BACK_LAYER_ORDER`，也不另造第二套返回系统。
 */
import type { ChannelId, ChannelItem, ContentItem } from '../../edge/src/types/api';
import { createRankingsRail } from './rankings-rail';
import { createCapsuleRail, ALL_CATEGORIES_LABEL } from '../components/capsule-rail';
import { createChannelBar } from '../components/channel-bar';
import { buildHomeNav, isCompositeHomeNav, type HomeNavId } from './home-nav';
import { icon } from '../components/icons';
import { element } from '../components/state-views';
import { registerBackHandler } from '../core/native/back-button';

/** 首页搜索条：一颗 role=button 的整行热区（键盘 Enter / Space 与指针同一条去处）。 */
export function createSearchBar(onClick: () => void): HTMLElement {
  const bar = element('div', 'home-search-bar');
  const lead = element('span', 'home-search-lead');
  bar.setAttribute('role', 'button');
  bar.setAttribute('tabindex', '0');
  bar.setAttribute('aria-label', '搜索全网剧目');
  lead.innerHTML = `${icon('search', { size: 16 })}<span>搜索剧名 / 题材</span>`;
  bar.append(lead);
  bar.addEventListener('click', onClick);
  bar.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick();
    }
  });
  return bar;
}

export interface HomeTopologyDeps {
  channelHost: HTMLElement;
  railHost: HTMLElement;
  keyScope: HTMLElement;
  /** 打开全屏搜索 Overlay（A-3）；未注入即不渲染搜索条。 */
  onSearch?: () => void;
  onSelectChannel(channelId: ChannelId): void;
  /** HP-04：综合首页那条导航项的去处（纯客户端视图，不发任何频道请求）。 */
  onSelectHome(): void;
  onSelectCategory(category: string): void;
  items?: () => readonly ContentItem[];
  onOpenTitle?: (id: string) => void;
  onNavigate?: () => void;
}

export interface HomeTopology {
  /** 一次画齐两层：频道条高亮 + 该频道的二级胶囊（「全部」由胶囊组件自己兜底补齐）。 */
  paint(channels: readonly ChannelItem[], selected: HomeNavId | null, category: string): void;
  /** 交给主视图决定它在视图里的落位，同时供折叠滚动消费。 */
  searchEntry(): HTMLElement | null;
  refreshRankings(): void;
  /** HP-06a：榜单展开区开着时，下拉手势让位，不与展开区抢同一段滚动。 */
  rankingsOpen(): boolean;
  destroy(): void;
}

export function createHomeTopology(deps: HomeTopologyDeps): HomeTopology {
  const bar = createChannelBar({ root: deps.channelHost, onSelect: deps.onSelectChannel, onSelectHome: deps.onSelectHome });
  const rail = createCapsuleRail({
    root: deps.railHost,
    // 乐观回显选中的胶囊再上报：胶囊自身的高亮不该等片单回来才亮（与旧主视图同一口径）。
    onSelect: (category) => {
      rail.select(category);
      deps.onSelectCategory(category);
    }
  });
  const entry = deps.onSearch === undefined ? null : createSearchBar(() => { deps.onNavigate?.(); deps.onSearch?.(); });
  let painted: readonly ChannelItem[] | null = null, selectedId: HomeNavId | null = null;
  let currentCategory: string = ALL_CATEGORIES_LABEL;
  const hot = element('button', 'capsule touch-target');
  hot.type = 'button'; hot.dataset.el = 'channel-hot-entry';
  hot.innerHTML = `${icon('list', { size: 16 })}<span class="capsule-pill">热门榜</span>`;
  hot.setAttribute('aria-expanded', 'false');
  const rankingsHost = element('div'); rankingsHost.hidden = true; rankingsHost.dataset.el = 'rankings-host';
  // HP-02a：展开区自己是键盘焦点所在（`tabindex="-1"` 的 disclosure 容器）。开着搜索/播放器时
  // 焦点在那一层里，Escape 由那一层先消费；只有榜单确实是当前最上层时，这条监听才收得到键。
  rankingsHost.tabIndex = -1;
  const rankings = deps.items && deps.onOpenTitle ? createRankingsRail({
    root: rankingsHost,
    items: deps.items,
    // HP-07a：范围＝当前频道＋当前二级分类，读面始终是 feed 交出的**完整**候选，不在这里先截断。
    channel: () => selectedId,
    category: () => currentCategory,
    channelName: () => painted?.find((entry) => entry.id === selectedId)?.name ?? null,
    onOpenTitle: (id) => { deps.onNavigate?.(); deps.onOpenTitle?.(id); }
  }) : null;
  /** HP-02：展开区只在返回栈上留**一条** handler；计数能不能回到基线，全看 `closeRankings` 的几条来路。 */
  let rankingsOpen = false, releaseBack: (() => void) | null = null;
  /**
   * 面板是否真的挂在当前可见页面上：外壳切 Tab 走的是 `.app-view` 容器的 `hidden`（A-1 只隐藏不销毁），
   * 所以"离页"没有回调可等。看不见就别抢返回——就地收榜、注销，并把事件如实交还给 Page 级。
   */
  const shownOnPage = (): boolean => {
    for (let node: HTMLElement | null = rankingsHost; node !== null; node = node.parentElement) if (node.hidden) return false;
    return true;
  };
  function closeRankings(focusTrigger: boolean): void {
    rankingsOpen = false;
    rankingsHost.hidden = true;
    hot.setAttribute('aria-expanded', 'false');
    if (releaseBack !== null) releaseBack();
    releaseBack = null;
    // 谁开的榜就把焦点还给谁：关完榜单焦点不该掉回 body，键盘用户要能立刻再按开。
    if (focusTrigger) hot.focus();
  }
  function toggleRankings(): void {
    if (rankingsOpen) { closeRankings(true); return; }
    rankingsOpen = true;
    rankingsHost.hidden = false;
    hot.setAttribute('aria-expanded', 'true');
    rankings?.refresh();
    // HP-02a：焦点落进展开区本身。键盘出口因此只属于当前最上层——搜索 Overlay 或播放器开着时
    // 焦点已离开这里，Escape 归那一层消费，首页不替上层做主（既有返回栈顺序）。
    rankingsHost.focus();
    // 已注册就不再叠加：重复开榜只有一条 handler（HP-02a）。
    if (releaseBack === null) {
      releaseBack = registerBackHandler(() => {
        if (!shownOnPage()) { closeRankings(false); return false; }
        closeRankings(true);
        return true;
      }, 'layer');
    }
  }
  hot.addEventListener('click', () => { deps.onNavigate?.(); toggleRankings(); });
  // 首页子树包含分类栏但不包含播放器／搜索层，切分类后仍可收键且不抢上层 Escape。
  const onEscape = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !rankingsOpen) return;
    if (!shownOnPage()) return;
    event.preventDefault();
    closeRankings(true);
  };
  deps.keyScope.addEventListener('keydown', onEscape);

  return {
    paint(channels, selected, category) {
      // 换频道即收起：连同注销一起做，别让上一层的返回 handler 漂在新页面上。
      if (selectedId !== selected) closeRankings(false);
      selectedId = selected;
      // HP-07a：切分类保留开榜状态，只把范围/标题/排名就地换掉（不关榜也不重新注册返回层）。
      const categoryChanged = currentCategory !== category;
      currentCategory = category;
      const nav = buildHomeNav(channels);
      // 同一份数组只重绘一次整栏，换频道走 `select`：保住横向滚动位置，也省掉频道按钮的重建。
      if (channels !== painted) {
        bar.renderNav(nav, selected);
        painted = channels;
      } else {
        bar.select(selected);
      }
      // HP-04：综合首页不虚构二级来源分类，只有「全部」；四个真实频道仍各用自己的云端 categories。
      const scope = isCompositeHomeNav(selected) ? [] : channels.find((channel) => channel.id === selected)?.categories ?? [];
      rail.render(scope, category);
      const publicChannel = !isCompositeHomeNav(selected) && selected !== null && selected !== 'private';
      if (rankings !== null && publicChannel) {
        deps.railHost.querySelector('.capsule-rail')?.prepend(hot);
        deps.railHost.append(rankingsHost); rankings.refresh();
        if (rankingsOpen && categoryChanged) rankingsHost.focus();
      } else { closeRankings(false); hot.remove(); rankingsHost.remove(); }
    },
    refreshRankings: () => rankings?.refresh(),
    rankingsOpen: () => rankingsOpen,
    searchEntry: () => entry,
    destroy() {
      deps.keyScope.removeEventListener('keydown', onEscape);
      closeRankings(false);
      rankings?.destroy();
      bar.destroy();
      rail.destroy();
    }
  };
}
