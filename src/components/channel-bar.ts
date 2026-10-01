/**
 * 第一层：云端动态大视界频道栏（SPEC §7、AC-01，UIUX §5.1）。
 *
 * 渲染口径只有一条：**服务端下发了什么就渲染什么**，按 `order` 升序、用返回的 `name` 原文，
 * 客户端不内置频道清单、不补占位、不给「个人探索」渲染锁定或置灰的空壳。AC-02-3 的双层隐形
 * 依赖的正是「缺席即契约」：未双重准入时 `/api/channels` 不含 private 节点，这里就物理不存在它。
 */

import type { ChannelId, ChannelItem } from '../../edge/src/types/api';
import { clearChildren, element } from './state-views';

/** AC-01 默认高亮项；仅在它真的出现在响应里时才生效，否则退化为 `order` 最小项。 */
export const DEFAULT_CHANNEL_ID: ChannelId = 'drama';

export function sortChannels(channels: readonly ChannelItem[]): ChannelItem[] {
  return [...channels].sort((left, right) => left.order - right.order);
}

export function pickDefaultChannel(channels: readonly ChannelItem[]): ChannelItem | null {
  const sorted = sortChannels(channels);
  return sorted.find((channel) => channel.id === DEFAULT_CHANNEL_ID) ?? sorted[0] ?? null;
}

export interface ChannelBarDeps {
  root: HTMLElement;
  onSelect: (channelId: ChannelId) => void;
}

export interface ChannelBar {
  /** 幂等重绘：`channels` 为云端原样返回的数组，本组件不做任何补全。 */
  render(channels: readonly ChannelItem[], selectedId: ChannelId | null): void;
  /** 只改选中态，不重新拉数据（保留胶囊与海报的既有滚动位置）。 */
  select(channelId: ChannelId | null): void;
  destroy(): void;
}

export function createChannelBar(deps: ChannelBarDeps): ChannelBar {
  let tabs: HTMLButtonElement[] = [];

  function paintSelected(selectedId: ChannelId | null): void {
    for (const tab of tabs) {
      if (tab.dataset.channelId === selectedId) {
        tab.classList.add('is-active');
        tab.setAttribute('aria-current', 'true');
      } else {
        tab.classList.remove('is-active');
        tab.removeAttribute('aria-current');
      }
    }
  }

  function render(channels: readonly ChannelItem[], selectedId: ChannelId | null): void {
    clearChildren(deps.root);
    tabs = [];
    const sorted = sortChannels(channels);
    if (sorted.length === 0) return;

    const nav = element('nav', 'channel-bar');
    nav.setAttribute('aria-label', '大视界频道');
    const list = element('div', 'channel-bar-list');
    const signal = new AbortController();

    for (const channel of sorted) {
      const tab = element('button', 'channel-tab touch-target', channel.name);
      tab.type = 'button';
      tab.dataset.channelId = channel.id;
      tab.title = channel.name;
      tab.addEventListener('click', () => deps.onSelect(channel.id), { signal: signal.signal });
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

  return {
    render,
    select: paintSelected,
    destroy: () => {
      tabs = [];
      clearChildren(deps.root);
    }
  };
}
