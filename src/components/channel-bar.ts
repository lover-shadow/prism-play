/**
 * 第一层：云端动态大视界频道栏（SPEC §7、AC-01，UIUX §5.1，HP-04）。
 *
 * 渲染口径只有两条：
 * 1. **服务端下发了什么就渲染什么**：`render()` 按 `order` 升序、逐字采用返回的 `name`，客户端不内置
 *    频道清单、不补占位、不给「个人探索」渲染锁定或置灰的空壳（AC-02-3 的双层隐形依赖"缺席即契约"）；
 * 2. **顺序由数据驱动**（HP-04）：`renderNav()` 接收调用方排好的导航条目，本组件不再二次排序，
 *    综合首页那条只以 `composite` 身份存在——它的 `id` 是本地身份，**只落在 `data-nav-id` 上**，
 *    绝不写成 `data-channel-id`，也绝不进了任何请求参数。
 */

import type { ChannelId, ChannelItem } from '../../edge/src/types/api';
import { clearChildren, element } from './state-views';

/** AC-01 历史默认高亮项；HP-04 后它只是频道目录的默认落位候选，不再是启动默认页。 */
export const DEFAULT_CHANNEL_ID: ChannelId = 'drama';

export function sortChannels(channels: readonly ChannelItem[]): ChannelItem[] {
  return [...channels].sort((left, right) => left.order - right.order);
}

export function pickDefaultChannel(channels: readonly ChannelItem[]): ChannelItem | null {
  const sorted = sortChannels(channels);
  return sorted.find((channel) => channel.id === DEFAULT_CHANNEL_ID) ?? sorted[0] ?? null;
}

/** 一颗导航项：`composite === true` 即综合首页（本地视图），其余条目对应真实 ChannelItem。 */
export interface ChannelTabEntry {
  id: string;
  name: string;
  composite: boolean;
}

export interface ChannelBarDeps {
  root: HTMLElement;
  onSelect: (channelId: ChannelId) => void;
  /** 综合首页那条导航项的去处；未注入即不渲染它——没有真实视图可打开的按钮就是虚假 UI。 */
  onSelectHome?: () => void;
}

export interface ChannelBar {
  /** 幂等重绘：`channels` 为云端原样返回的数组，本组件不做任何补全。 */
  render(channels: readonly ChannelItem[], selectedId: ChannelId | null): void;
  /** HP-04：按调用方给定的顺序渲染（综合首页在最前），顺序即数据，本组件不再排。 */
  renderNav(entries: readonly ChannelTabEntry[], selectedId: string | null): void;
  /** 只改选中态，不重新拉数据（保留胶囊与海报的既有滚动位置）。 */
  select(id: string | null): void;
  destroy(): void;
}

export function createChannelBar(deps: ChannelBarDeps): ChannelBar {
  let tabs: HTMLButtonElement[] = [];

  function paintSelected(selectedId: string | null): void {
    for (const tab of tabs) {
      if (tab.dataset.navId === selectedId) {
        tab.classList.add('is-active');
        tab.setAttribute('aria-current', 'true');
      } else {
        tab.classList.remove('is-active');
        tab.removeAttribute('aria-current');
      }
    }
  }

  function paint(entries: readonly ChannelTabEntry[], selectedId: string | null): void {
    clearChildren(deps.root);
    tabs = [];
    if (entries.length === 0) return;

    const nav = element('nav', 'channel-bar');
    nav.setAttribute('aria-label', '大视界频道');
    const list = element('div', 'channel-bar-list');
    const signal = new AbortController();

    for (const entry of entries) {
      const tab = element('button', 'channel-tab touch-target', entry.name);
      tab.type = 'button';
      tab.dataset.navId = entry.id;
      // 综合首页没有频道身份：`data-channel-id` 只属于真实 ChannelItem，测试与宿主都按这条区分。
      if (!entry.composite) tab.dataset.channelId = entry.id;
      else tab.dataset.el = 'home-nav';
      tab.title = entry.name;
      const isHome = entry.composite;
      tab.addEventListener('click', () => {
        if (isHome) { deps.onSelectHome?.(); return; }
        deps.onSelect(entry.id as ChannelId);
      }, { signal: signal.signal });
      list.appendChild(tab);
      tabs.push(tab);
    }

    nav.addEventListener(
      'keydown',
      (event) => {
        const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
        const delta = keys[event.key];
        if (delta === undefined) return;
        event.preventDefault();
        const at = tabs.findIndex((tab) => tab === document.activeElement);
        const next = tabs[(at + delta + tabs.length) % tabs.length] ?? tabs[0];
        next.focus();
      },
      { signal: signal.signal }
    );

    nav.appendChild(list);
    deps.root.appendChild(nav);
    paintSelected(selectedId);
  }

  const tabsOf = (channels: readonly ChannelItem[]): ChannelTabEntry[] =>
    sortChannels(channels).map((channel) => ({ id: channel.id, name: channel.name, composite: false }));

  return {
    render: (channels, selectedId) => paint(tabsOf(channels), selectedId),
    renderNav: (entries, selectedId) => paint(entries, selectedId),
    select: paintSelected,
    destroy: () => {
      tabs = [];
      clearChildren(deps.root);
    }
  };
}
