/**
 * 榜单专区（SPEC-APP-REFACTOR A-3）：搜索 Overlay 里的【总热播榜】/【实时新剧榜】/【AI先锋榜】。
 *
 * 三条榜**全部端侧本地计算**，本模块一次网络请求都不发：数据源是注入的 `items()`（本机公开快照读面），
 * 排序键是目录分片携带的可选字段 `hitsTotal` / `firstPublishedAt` 与 `isAi` 标记（SPEC §2.1）。
 * 因此断网、飞行模式下榜单照样出得来，代价是"榜"只覆盖本机已缓存的这部分片单——这一点必须说给用户听，
 * 不能把局部缓存装扮成全量榜单，所以空态文案如实回报覆盖范围。
 *
 * 合规：只渲染公开条目（`isPrivateSubject` 再挡一道），私密内容连标题都不进 DOM（AC-02-3）。
 * 行尾标签与名次高亮全部走 tokens，本模块零裸色值（P0-3）。
 */
import type { ContentItem } from '../../edge/src/types/api';
import { isPrivateSubject } from '../core/storage/storage-domains';
import { make, type Band } from './history-view';

export const RANKING_KINDS = ['hot', 'fresh', 'ai'] as const;
export type RankingKind = (typeof RANKING_KINDS)[number];

/** 榜名：口径与 SPEC A-3 定案逐字一致。 */
export const RANKING_LABEL: Readonly<Record<RankingKind, string>> = {
  hot: '总热播榜',
  fresh: '实时新剧榜',
  ai: 'AI先锋榜'
};
/** 榜名 → 排序依据的可见说明：每条榜都说清自己按什么排，不做只长样子的排行榜。 */
export const RANKING_BASIS: Readonly<Record<RankingKind, string>> = {
  hot: '按累计热度降序',
  fresh: '按上架时间降序',
  ai: 'AI 加工剧目按累计热度降序'
};
/** 单榜展示上限：Overlay 不是目录页，20 条足够决策，也把 DOM 体积钉住。 */
export const RANKING_LIMIT = 20;

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** 热度读数：万为单位收敛，避免 8 位数字把行挤爆；没有读数就不编一个出来。 */
export function formatHits(hits: number): string {
  if (hits >= 10_000) return `${(hits / 10_000).toFixed(1)} 万`;
  return String(Math.round(hits));
}

/** 上架日期：`firstPublishedAt` 按目录契约是 epoch 秒，取 UTC 日期段，跨时区渲染结果恒定。 */
export function formatPublishedAt(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

const sortKey = (item: ContentItem, kind: RankingKind): number =>
  kind === 'fresh'
    ? (finiteNumber(item.firstPublishedAt) ? item.firstPublishedAt : -1)
    : (finiteNumber(item.hitsTotal) ? item.hitsTotal : -1);

/**
 * 纯函数排序（单测直接喂数据断言，不经过 DOM）：降序 + 以 id 收口同分，保证同输入同输出。
 * 【AI先锋榜】只认 `isAi === true`，缺省或 false 都不入榜——不在这里猜"是不是 AI 做的"。
 */
export function rankItems(items: readonly ContentItem[], kind: RankingKind, limit: number = RANKING_LIMIT, channel?: string): ContentItem[] {
  const pool = items.filter((item) => !isPrivateSubject(item) && (channel === undefined || item.channelId === channel)
    && (kind !== 'ai' || item.isAi === true) && sortKey(item, kind) >= 0);
  return [...pool]
    .sort((left, right) => sortKey(right, kind) - sortKey(left, kind) || left.id.localeCompare(right.id))
    .slice(0, limit);
}

/** 行尾标签：新剧榜优先给上架日期，其余给累计热度；两者都没有就留白，不拿占位文案凑数。 */
export function rankBadge(item: ContentItem, kind: RankingKind): string | null {
  const published = kind === 'fresh' && finiteNumber(item.firstPublishedAt)
    ? formatPublishedAt(item.firstPublishedAt)
    : null;
  return published ?? (finiteNumber(item.hitsTotal) ? `热度 ${formatHits(item.hitsTotal)}` : null);
}

function metaOf(item: ContentItem): string {
  const parts = [item.category];
  if (typeof item.episodeCount === 'number' && item.episodeCount > 0) parts.push(`共 ${item.episodeCount} 集`);
  return parts.filter((part) => typeof part === 'string' && part !== '').join(' · ');
}

export interface RankingsRailDeps {
  root: HTMLElement;
  /** 本机公开快照的剧目集合：由组合根注入，本模块不碰存储域、不发网络。 */
  items: () => readonly ContentItem[];
  onOpenTitle(contentId: string): void;
  limit?: number;
  /** 首页仅展示当前公开频道热门榜；省略时保留搜索三榜。 */
  channel?: () => string | null;
}

export interface RankingsRail {
  /** 快照同步完成后重算当前榜即可，不必重建实例。 */
  refresh(): void;
  kind(): RankingKind;
  /** 供 Overlay 在切榜后把焦点交还输入框。 */
  select(kind: RankingKind): void;
  destroy(): void;
}

/** `readyBand` / `stateBand` 只消费 wrap.dataset.state 与 body，所以榜单区不必套 pv-band 卡片壳。 */
function bareBand(className: string, dataEl: string): Band {
  const wrap = make('div', className);
  wrap.dataset.el = dataEl;
  const body = make('div', 'pv-band-body');
  wrap.append(body);
  return { wrap, head: make('div'), body };
}

export function createRankingsRail(deps: RankingsRailDeps): RankingsRail {
  const limit = deps.limit ?? RANKING_LIMIT;
  let current: RankingKind = 'hot';
  let disposed = false;

  const host = make('section', 'srch-rankings');
  host.dataset.el = 'rankings';
  const tabs = make('div', 'rank-tabs');
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', '端侧榜单');
  const list = bareBand('srch-rank-list', 'rankings-list');
  const note = make('p', 'pv-hint', '按累计热度或上架时间排序，仅覆盖本机快照已缓存的公开目录；非24小时或全网实时榜。');

  const itemsOf = (): ContentItem[] => {
    if (disposed) return [];
    try {
      return [...deps.items()];
    } catch {
      return [];
    }
  };

  function row(item: ContentItem, position: number): HTMLButtonElement {
    const line = make('button', `rank-row${position <= 3 ? ' rank-row--top' : ''}`);
    line.type = 'button';
    line.dataset.el = 'rank-row';
    line.dataset.contentId = item.id;
    line.dataset.rankKind = current;
    line.dataset.rank = String(position);
    line.setAttribute('aria-label', `${RANKING_LABEL[current]}第 ${position} 名：${item.title}`);
    line.append(
      make('span', 'rank-index', String(position)),
      make('span', 'rank-title', item.title),
      make('span', 'rank-meta', metaOf(item))
    );
    const badge = rankBadge(item, current);
    if (badge !== null) line.append(make('span', 'rank-heat', badge));
    line.addEventListener('click', () => deps.onOpenTitle(item.id));
    return line;
  }

  function paint(): void {
    if (disposed) return;
    const channel = deps.channel?.();
    const ranked = channel === null || channel === 'private' ? [] : rankItems(itemsOf(), current, limit, channel);
    if (ranked.length === 0) {
      list.wrap.dataset.state = 'empty';
      list.body.replaceChildren(make('p', 'pv-state pv-state-empty', current === 'fresh'
        ? '本机快照上架时间数据不足。'
        : '热度数据不足：本机快照暂无可核验的累计热度。'), note);
      return;
    }
    const rows = make('div', 'rank-list');
    rows.append(...ranked.map((item, index) => row(item, index + 1)));
    list.wrap.dataset.state = 'ready';
    list.wrap.dataset.rankKind = current;
    list.body.replaceChildren(rows, note);
  }

  function select(kind: RankingKind): void {
    current = kind;
    for (const tab of Array.from(tabs.querySelectorAll<HTMLButtonElement>('.rank-tab'))) {
      tab.setAttribute('aria-pressed', String(tab.dataset.rankKind === kind));
    }
    paint();
  }

  for (const kind of RANKING_KINDS) {
    const tab = make('button', 'rank-tab touch-target');
    tab.type = 'button';
    tab.dataset.el = 'rank-tab';
    tab.dataset.rankKind = kind;
    tab.title = RANKING_BASIS[kind];
    tab.textContent = RANKING_LABEL[kind];
    tab.addEventListener('click', () => select(kind));
    tabs.append(tab);
  }
  if (deps.channel === undefined) host.append(tabs);
  host.append(list.wrap);
  deps.root.appendChild(host);
  select(current);

  return {
    kind: () => current,
    refresh: paint,
    select,
    destroy() {
      disposed = true;
      host.remove();
    }
  };
}
