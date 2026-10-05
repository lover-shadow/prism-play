/**
 * 详情台状态文案的判据（R26-05）：集数、分类、是否合集是**三件不同的事**，各自只在有字段支撑时成话。
 *
 * 旧实现把这三件事糊成一句由集数反推出来的"全集已上线 / 连载中"——`episodes.length > 0` 既证明不了
 * 上游已经把全部剧集放出，也证明不了这部剧还在更新；它只证明本机拿到过这些集。同理，分类缺失时写死
 * "精选"、简介缺失时编一句"暂无详细剧目简介，敬请沉浸观赏精彩剧情"，都是 AGENTS.md 明令禁止的假 UI 文案。
 *
 * 本模块刻意不碰 DOM：判据可以在 Node 侧逐值钉死，渲染留在 `player-detail.ts`，两处不各持一套口径。
 */

import type { ContentItem, TitleDetail } from '../../edge/src/types/api';

/** 超过这个长度才有折叠的必要；短于此一律全文显示，不给用户一个点了没变化的控件。 */
export const SYNOPSIS_CLAMP_CHARS = 60;

/**
 * 集数事实的唯一口径：`episodes.length` 是**本机可播**，`item.episodeCount` 是**源声明的总数**，
 * 两者不一致时必须同时说出来，谁也不许冒充谁——这正是"只截取两集/90 集只上线一集"那类现场反馈的照妖镜。
 */
export function episodeCountLabel(info: TitleDetail): string {
  const available = info.episodes.length;
  const declared = info.item.episodeCount;
  if (available === 0) return declared === undefined ? '' : `源 ${declared} 集`;
  return declared !== undefined && declared !== available
    ? `目录 ${available} 集 / 源 ${declared} 集`
    : `共 ${available} 集`;
}

/** 当前集指示：只报集号，时长与剧名不上这一行（按钮栅格归 `episode-sheet.ts` 管）。 */
export function episodeTagOf(info: TitleDetail, id: number): string {
  return `第 ${(info.episodes.find((item) => item.episodeId === id) ?? info.episodes[0])?.episodeNumber ?? 1} 集`;
}

/**
 * "合集"只在数据显式声明时出现：契约目前没有这个字段，判据就是"有且只为真"。
 * 单集长片、`episodeCount === 1` 都不构成证据——R26 的现场口径是合集需核验而非虚拟拆集，
 * 反过来把没声明的剧目说成合集同样是谎。
 */
export function isMarkedCollection(item: ContentItem): boolean {
  return (item as { isCollection?: boolean }).isCollection === true;
}

/** 状态胶囊的文本清单：分类缺失即整枚缺席，绝不补一个"精选"上去。 */
export function statusPillLabels(info: TitleDetail): string[] {
  const count = episodeCountLabel(info);
  const category = info.item.category;
  return [
    ...(count === '' ? [] : [count]),
    ...(category === undefined || category === '' ? [] : [category]),
    ...(isMarkedCollection(info.item) ? ['合集'] : [])
  ];
}

/** 简介文本：`undefined` 与空串同等对待，返回 null 让调用方整块不渲染。 */
export function synopsisOf(info: TitleDetail): string | null {
  const text = info.item.synopsis;
  return text === undefined || text === '' ? null : text;
}
