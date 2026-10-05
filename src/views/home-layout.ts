/**
 * 首页 DOM 骨架装配（SPEC §7 两层导航 + AC-25 + UIUX §5.1）。
 *
 * 只管"节点长在哪"，不管数据：`home-view.ts` 到 300 行红线时把这段纯装配抽出来最安全，
 * 因为它没有任何状态与副作用，搬动不改变一条渲染口径。三条既有语义原样保留：
 * 1. AC-25：首页**没有**区块标题行——频道名与一级频道栏 100% 重复，那一行还白吃 40px 高度；
 * 2. 排版切换器优先挂外壳顶栏工具槽（跨 Tab 复用实例），拿不到才退回视图内；
 * 3. 搜索条存在与否由注入决定（没有真实 Overlay 可打开的搜索框就是虚假 UI），骨架不替它补位。
 */

import { element } from '../components/state-views';

export interface HomeHosts {
  view: HTMLElement;
  sticky: HTMLElement;
  channelHost: HTMLElement;
  railHost: HTMLElement;
  continueHost: HTMLElement;
  switchHost: HTMLElement;
  gridHost: HTMLElement;
  moreHost: HTMLElement;
}

export function createHomeHosts(): HomeHosts {
  const view = element('div', 'home-view'), sticky = element('div', 'home-sticky');
  const channelHost = element('div', 'home-channel-host'), railHost = element('div', 'home-capsule-host');
  const continueHost = element('div', 'home-continue-host'), switchHost = element('div', 'home-mode-switch');
  const gridHost = element('div', 'home-grid-host'), moreHost = element('div', 'home-more-host');
  continueHost.hidden = true;
  return { view, sticky, channelHost, railHost, continueHost, switchHost, gridHost, moreHost };
}

/** 落位顺序即视觉顺序；`searchBar` 为 null 时整条搜索行不存在（A-2 的注入决定）。 */
export function mountHomeLayout(hosts: HomeHosts, searchBar: HTMLElement | null, headerAccessory?: HTMLElement | null): void {
  const rows: HTMLElement[] = [hosts.sticky];
  if (searchBar !== null) rows.push(searchBar);
  rows.push(hosts.continueHost);
  if (headerAccessory !== null && headerAccessory !== undefined) headerAccessory.replaceChildren(hosts.switchHost);
  else rows.push(hosts.switchHost);
  rows.push(hosts.gridHost, hosts.moreHost);
  hosts.sticky.append(hosts.channelHost, hosts.railHost);
  hosts.view.append(...rows);
}
