/**
 * 首页视界拓扑选择器（SPEC §7 两层导航 + SPEC-APP-REFACTOR A-2 搜索入口）。
 *
 * 从 `home-view.ts` 拆出是为 §10 的 300 行红线让路，也正好顺着语义边界切：这一件只管"选哪个视界 /
 * 哪个分类 / 打开搜索"，片单与分页全部留在主视图。三条渲染口径沿用原实现，一条都没放松：
 * 1. 频道与分类 100% 来自 `/api/channels`，客户端不补位、不造假（AC-02-3 的双层隐形依赖"缺席即契约"）；
 * 2. 搜索条只在注入 `onSearch` 时存在——没有真实 Overlay 可打开的搜索框就是虚假 UI，宁可整条缺席；
 * 3. 折叠动效不在这里：本模块只交出搜索条节点，滚动差量状态机归 `home-scroll.ts`。
 */
import type { ChannelId, ChannelItem, ContentItem } from '../../edge/src/types/api';
import { createRankingsRail } from './rankings-rail';
import { createCapsuleRail } from '../components/capsule-rail';
import { createChannelBar } from '../components/channel-bar';
import { icon } from '../components/icons';
import { element } from '../components/state-views';

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
  /** 打开全屏搜索 Overlay（A-3）；未注入即不渲染搜索条。 */
  onSearch?: () => void;
  onSelectChannel(channelId: ChannelId): void;
  onSelectCategory(category: string): void;
  items?: () => readonly ContentItem[];
  onOpenTitle?: (id: string) => void;
  onNavigate?: () => void;
}

export interface HomeTopology {
  /** 一次画齐两层：频道条高亮 + 该频道的二级胶囊（「全部」由胶囊组件自己兜底补齐）。 */
  paint(channels: readonly ChannelItem[], selected: ChannelId | null, category: string): void;
  /** 交给主视图决定它在视图里的落位，同时供折叠滚动消费。 */
  searchEntry(): HTMLElement | null;
  refreshRankings(): void;
  destroy(): void;
}

export function createHomeTopology(deps: HomeTopologyDeps): HomeTopology {
  const bar = createChannelBar({ root: deps.channelHost, onSelect: deps.onSelectChannel });
  const rail = createCapsuleRail({
    root: deps.railHost,
    // 乐观回显选中的胶囊再上报：胶囊自身的高亮不该等片单回来才亮（与旧主视图同一口径）。
    onSelect: (category) => {
      rail.select(category);
      deps.onSelectCategory(category);
    }
  });
  const entry = deps.onSearch === undefined ? null : createSearchBar(() => { deps.onNavigate?.(); deps.onSearch?.(); });
  let painted: readonly ChannelItem[] | null = null, selectedId: ChannelId | null = null;
  const hot = element('button', 'capsule touch-target');
  hot.type = 'button'; hot.dataset.el = 'channel-hot-entry';
  hot.innerHTML = `${icon('list', { size: 16 })}<span class="capsule-pill">热门榜</span>`;
  hot.setAttribute('aria-expanded', 'false');
  const rankingsHost = element('div'); rankingsHost.hidden = true;
  const rankings = deps.items && deps.onOpenTitle ? createRankingsRail({
    root: rankingsHost, items: deps.items, channel: () => selectedId,
    onOpenTitle: (id) => { deps.onNavigate?.(); deps.onOpenTitle?.(id); }
  }) : null;
  hot.addEventListener('click', () => {
    deps.onNavigate?.(); rankingsHost.hidden = !rankingsHost.hidden;
    hot.setAttribute('aria-expanded', String(!rankingsHost.hidden)); rankings?.refresh();
  });

  return {
    paint(channels, selected, category) {
      if (selectedId !== selected) { rankingsHost.hidden = true; hot.setAttribute('aria-expanded', 'false'); }
      selectedId = selected;
      // 同一份数组只重绘一次整栏，换频道走 `select`：保住横向滚动位置，也省掉四颗按钮的重建。
      if (channels !== painted) {
        bar.render(channels, selected);
        painted = channels;
      } else {
        bar.select(selected);
      }
      rail.render(channels.find((channel) => channel.id === selected)?.categories ?? [], category);
      if (rankings !== null && selected !== null && selected !== 'private') {
        deps.railHost.querySelector('.capsule-rail')?.prepend(hot);
        deps.railHost.append(rankingsHost); rankings.refresh();
      } else { hot.remove(); rankingsHost.remove(); }
    },
    refreshRankings: () => rankings?.refresh(),
    searchEntry: () => entry,
    destroy() {
      rankings?.destroy();
      bar.destroy();
      rail.destroy();
    }
  };
}
