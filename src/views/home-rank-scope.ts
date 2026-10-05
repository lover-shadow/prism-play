/**
 * HP-07 频道＋二级分类热门榜的排名口径（HOME-PLAYER-REPAIR-SPEC-AND-PLAN §HP-07 / §3.2 公平热度条 / §5.1 HP-07a·HP-07b）。
 *
 * 顺序只有这一种写法：**先从完整可见候选里筛范围 → 再公平排序 → 最后截 20**。
 * 任何"先截总榜前 20 再按分类过滤"的实现都会把整个分类凭空抹掉（HP-07a 的直接反例），本模块把三步
 * 钉成三个函数，界面只能按这个次序调用。
 *
 * 【待证工程参数 · 已在代码注释与交付报告登记】`hitsTotal` 的单位、统计窗口、更新时间、累计/周值口径
 * 跨源尚未核验，因此这里**绝不比跨源绝对值**：只在同一 `channelId` 内取分位再公平合并；真实同分不分裂
 * 分位，一律以 workId 收口。`isHot` 只作行尾标签，永远不参与排序；个人偏好分不进公共榜（HP-07b）。
 * 缺热度与真实 0 分是两件事：缺失者不入榜并在覆盖说明里计数，0 分照常上榜并如实标出。
 */

import type { ContentItem } from '../../edge/src/types/api';
import { ALL_CATEGORIES_LABEL } from '../components/capsule-rail';
import { isPrivateSubject } from '../core/storage/storage-domains';
import { byId, heatOf, percentilesBySource } from '../core/home-feed-order';
import { keepPublicCandidate } from './home-nav';

/** 榜单种类的唯一表：`hot` 热度榜、`fresh` 上架时间榜、`ai` 只认有依据的 `isAi === true`。 */
export const RANK_KINDS = ['hot', 'fresh', 'ai'] as const;
export type RankKind = (typeof RANK_KINDS)[number];
export type RankBasis = 'heat' | 'published';
/** 排序口径：热度榜与 AI 榜读公共热度，新剧榜读上架时间；两者都不读画像。 */
export const basisOf = (kind: RankKind): RankBasis => (kind === 'fresh' ? 'published' : 'heat');
/** 【AI先锋榜】只认 `isAi === true`：缺省或 false 都不入榜，不在这里猜"是不是 AI 做的"。 */
export function kindCandidates(items: readonly ContentItem[], kind: RankKind): ContentItem[] {
  return kind === 'ai' ? items.filter((item) => item.isAi === true) : [...items];
}

export interface RankScope {
  /** `null` 表示不限频道（搜索 Overlay 的三榜读面）。 */
  channel: string | null;
  /** `全部` 即频道总榜；其余分类就是该频道该分类榜（HP-07）。 */
  category: string;
}

export interface RankCoverage {
  /** 本范围内的完整候选数（先筛后的池子，与截断后的名次条数是两件事）。 */
  considered: number;
  /** 热度字段缺失的候选数：与"真实 0"分开计，绝不合并成"低热度"。 */
  missingHeat: number;
  realZero: number;
  /** 本范围涉及的来源（频道）数：跨源不可比这条事实的直接证据。 */
  sources: number;
  withdrawn: number;
  excluded: number;
}

export const rankScope = (channel: string | null | undefined, category?: string): RankScope =>
  ({ channel: channel ?? null, category: category ?? ALL_CATEGORIES_LABEL });

/** 范围筛选：私密/未知身份/撤片先出局，再按频道与二级分类收口（§3.2「先统一去 private/撤片/重复 workId」）。 */
export function scopeCandidates(items: readonly ContentItem[], scope: RankScope): ContentItem[] {
  const unique = new Map<string, ContentItem>();
  for (const item of items) {
    if (isPrivateSubject(item) || !keepPublicCandidate(item) || item.enabled === false) continue;
    if (scope.channel !== null && item.channelId !== scope.channel) continue;
    if (scope.category !== ALL_CATEGORIES_LABEL && item.category !== scope.category) continue;
    if (!unique.has(item.id)) unique.set(item.id, item);
  }
  return [...unique.values()];
}

const publishedOf = (item: ContentItem): number | null =>
  typeof item.firstPublishedAt === 'number' && Number.isFinite(item.firstPublishedAt) ? item.firstPublishedAt : null;

/**
 * 公平排序：只读公共热度/上架时间，不读画像。
 * 热度走"来源内分位后公平合并"（同分不分叉，workId 收口）；缺失者不入榜，由覆盖说明如实计数。
 */
export function fairRank(items: readonly ContentItem[], kind: RankKind): ContentItem[] {
  const basis = basisOf(kind);
  if (basis === 'published') {
    return items
      .filter((item) => publishedOf(item) !== null)
      .sort((left, right) => (publishedOf(right) ?? 0) - (publishedOf(left) ?? 0) || byId(left, right));
  }
  const pool = items.filter((item) => heatOf(item) !== null);
  const percentiles = percentilesBySource(pool);
  const rank = (item: ContentItem): number => percentiles.get(item.id) ?? -1;
  return [...pool].sort((left, right) => rank(right) - rank(left) || byId(left, right));
}

/** 完整范围 → 公平排序 → 截断：三步的唯一次序，界面不提供第二种拼法。 */
export function rankWindow(
  items: readonly ContentItem[],
  kind: RankKind,
  limit: number,
  scope: RankScope
): ContentItem[] {
  return fairRank(scopeCandidates(kindCandidates(items, kind), scope), kind).slice(0, Math.max(0, limit));
}

export function coverageOf(items: readonly ContentItem[], scope: RankScope, kind: RankKind = 'hot'): RankCoverage {
  const candidates = scopeCandidates(kindCandidates(items, kind), scope);
  return {
    considered: candidates.length,
    missingHeat: candidates.filter((item) => heatOf(item) === null).length,
    realZero: candidates.filter((item) => heatOf(item) === 0).length,
    sources: new Set(candidates.map((item) => item.channelId)).size,
    withdrawn: items.filter((item) => item.enabled === false
      && (scope.channel === null || item.channelId === scope.channel)).length,
    excluded: items.filter((item) => isPrivateSubject(item) || !keepPublicCandidate(item)).length
  };
}

/**
 * 覆盖说明：只报"读到了多少、缺了多少、来自几个来源"，不承诺实时，也不给缺失字段编一个名次。
 * 文案里保留"本机快照"与"非24小时或全网实时榜"两条既有口径，与 HP-07b 的诚实边界逐字一致。
 */
export function coverageNote(scope: RankScope, coverage: RankCoverage): string {
  const scopeCopy = scope.channel === null
    ? '本机全部公开候选'
    : `本机公开候选 ${coverage.considered} 部 · 来源 ${coverage.sources} 个 · ${scope.category === ALL_CATEGORIES_LABEL ? '频道总榜' : `「${scope.category}」分类榜`}`;
  const heatCopy = `热度缺失 ${coverage.missingHeat} 部（不计入排名），真实 0 分 ${coverage.realZero} 部（照常上榜）。`;
  return `${scopeCopy}；${heatCopy}排名仅覆盖本机快照，非24小时或全网实时榜。`;
}
