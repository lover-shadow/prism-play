/**
 * HP-04 首页导航模型（HOME-PLAYER-REPAIR-SPEC-AND-PLAN §HP-04 / §3.2 末条，PRD §3.1.1，UIUX §5.1）。
 *
 * 综合首页是**纯客户端视图**，因此它的身份只存在于导航层：
 * 1. `COMPOSITE_HOME_ID` 不是 `ChannelId`，不写进任何请求参数，也不参与缓存键；一旦有代码把它交给
 *    `/api/catalog` 的 `channel` 或拼成 URL，就是 HP-04 的硬违反（`home-view` 的目录请求路径只认真实频道）。
 * 2. 顺序由数据驱动：首页恒在最前，其后按云端 `ChannelItem.order` 升序排列，展示名逐字取云端 `name`；
 *    本模块不内置任何中文频道名，云端改名即端侧改名（`20-channel-bar` 的「不夹带本地词表」口径继续成立）。
 * 3. 云端若真下发 `private` 节点，导航照渲染（隐形由服务端裁决）；但**候选池只读公开频道**——
 *    私密内容不进综合首页、公开榜、推荐、标签与曝光，这一条在 `publicFeedChannels()` 上收口。
 */

import type { ChannelId, ChannelItem, ContentItem } from '../../edge/src/types/api';
import { PUBLIC_CHANNEL_IDS } from '../../edge/src/types/api';
import { sortChannels } from '../components/channel-bar';

/** 综合首页的本地身份：只在导航与视图内部存在，绝不出站。 */
export const COMPOSITE_HOME_ID = 'local-home';
/** 综合首页的展示名：这是唯一的本地文案，因为它不对应任何 ChannelItem，云端无处下发。 */
export const COMPOSITE_HOME_LABEL = '首页';
export type HomeNavId = typeof COMPOSITE_HOME_ID | ChannelId;

export interface HomeNavEntry {
  id: HomeNavId;
  name: string;
  /** 综合首页无频道身份：目录、榜单与 FLAG_SECURE 判定都据此分路。 */
  composite: boolean;
  categories: readonly string[];
}

export function isCompositeHomeNav(id: HomeNavId | null): boolean {
  return id === COMPOSITE_HOME_ID;
}

/** 首页在最前，其后完全由云端 `order` 决定；`categories` 仍是各真实频道自己的真实分类。 */
export function buildHomeNav(channels: readonly ChannelItem[]): HomeNavEntry[] {
  const head: HomeNavEntry = { id: COMPOSITE_HOME_ID, name: COMPOSITE_HOME_LABEL, composite: true, categories: [] };
  return [head, ...sortChannels(channels).map((channel) => ({
    id: channel.id as HomeNavId, name: channel.name, composite: false, categories: channel.categories
  }))];
}

/** 综合首页候选池允许读取的公开频道：`private` 与任何未知频道一律不在集合内（fail-closed）。 */
export function publicFeedChannels(channels: readonly ChannelItem[]): ChannelItem[] {
  return sortChannels(channels.filter((channel) => (PUBLIC_CHANNEL_IDS as readonly string[]).includes(channel.id)));
}

/** 空态文案同样数据驱动：回退目标取云端 order 最小的公开频道，没有公开频道就如实说没有。 */
export interface EmptyCatalogCopy {
  detail: string;
  actionLabel: string;
  /** `reload` 重试本范围；`back` 回到回退频道。视图只认这两个去处，不猜第三个。 */
  action: 'reload' | 'back';
  fallbackId: ChannelId | null;
}

export function describeEmptyOverview(partial: boolean): EmptyCatalogCopy {
  return {
    detail: partial ? '本机公开目录尚不完整，先补齐候选后再来综合首页。' : '本机尚无公开目录快照，综合首页不编造片单。',
    actionLabel: '重新加载', action: 'reload', fallbackId: null
  };
}

export function describeEmptyCatalog(channels: readonly ChannelItem[], selected: HomeNavId | null): EmptyCatalogCopy {
  const fallback = publicFeedChannels(channels)[0] ?? null;
  if (fallback === null || selected === fallback.id) {
    return { detail: '该视界尚未上架内容，换个频道或稍后再来。', actionLabel: '重新加载', action: 'reload', fallbackId: fallback?.id ?? null };
  }
  return { detail: '该视界暂无可播放剧目。', actionLabel: `返回${fallback.name}`, action: 'back', fallbackId: fallback.id };
}

/** 私密闸门之外的第二道防线：候选池里连"看起来公开但挂在私密频道"的条目都不该出现。 */
export function keepPublicCandidate(item: ContentItem): boolean {
  return (PUBLIC_CHANNEL_IDS as readonly string[]).includes(item.channelId);
}
