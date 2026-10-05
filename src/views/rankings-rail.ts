/**
 * 榜单专区（SPEC-APP-REFACTOR A-3 ＋ HP-07 频道/二级分类榜）。
 *
 * 三条榜**全部端侧本地计算**，本模块一次网络请求都不发：数据源是注入的 `items()`（本机公开快照读面），
 * 排序键是目录分片携带的可选字段 `hitsTotal` / `firstPublishedAt` 与 `isAi` 标记（SPEC §2.1）。
 * 因此断网、飞行模式下榜单照样出得来，代价是"榜"只覆盖本机已缓存的这部分片单——这一点必须说给用户听，
 * 不能把局部缓存装扮成全量榜单，所以空态文案如实回报覆盖范围。
 *
 * HP-07 的次序只有一条：`home-rank-scope.ts` 里"完整范围筛选 → 公平排序 → 截断"。
 * 「全部＋热门榜」＝频道总榜，「逆袭＋热门榜」＝该频道该分类榜；切分类保留开榜状态、标题与范围同步。
 * 跨源热度不可比时不比绝对值，`isHot` 只作标签，个人偏好不进公共榜（§3.2 公平热度条）。
 *
 * 合规：只渲染公开条目（`isPrivateSubject` 再挡一道），私密内容连标题都不进 DOM（AC-02-3）。
 * 行尾标签与名次高亮全部走 tokens，本模块零裸色值（P0-3）。
 */
import type { ContentItem } from '../../edge/src/types/api';
import { ALL_CATEGORIES_LABEL } from '../components/capsule-rail';
import { make, type Band } from './history-view';
import {
  coverageNote, coverageOf, kindCandidates, RANK_KINDS, rankScope, rankWindow, type RankKind, type RankScope
} from './home-rank-scope';

/** 榜种表在 `home-rank-scope.ts` 唯一定义，本模块只做展示与渲染，不再复制第二套。 */
export const RANKING_KINDS = RANK_KINDS;
export type RankingKind = RankKind;

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
/** 单榜展示上限：Overlay 不是目录页，20 条足够决策，也把 DOM 体积钉住。截断永远在筛选与排序之后。 */
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

/**
 * 纯函数排名（单测直接喂数据断言，不经过 DOM）：先范围筛选 → 来源内分位公平排序 → workId 同分收口
 * → 最后截断。`channel` 省略时不限频道（搜索三榜读面），与 HP-07 的分类榜共用同一条次序。
 */
export function rankItems(
  items: readonly ContentItem[],
  kind: RankingKind,
  limit: number = RANKING_LIMIT,
  channel?: string
): ContentItem[] {
  return rankWindow(items, kind, limit, rankScope(channel));
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
  /** HP-07a：二级分类范围（「全部」＝频道总榜）。省略即搜索三榜，不渲染分类榜头。 */
  category?: () => string;
  /** 榜头里的频道展示名：逐字来自云端拓扑，本模块不内置任何中文频道名。 */
  channelName?: () => string | null;
  /** 榜单标题注入点（首页展开区之外的宿主可自定义）。 */
  kind?: RankingKind;
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
  return { wrap, body, head: make('div') };
}

export function createRankingsRail(deps: RankingsRailDeps): RankingsRail {
  const limit = deps.limit ?? RANKING_LIMIT;
  let current: RankingKind = deps.kind ?? 'hot';
  let disposed = false;

  const host = make('section', 'srch-rankings');
  host.dataset.el = 'rankings';
  const tabs = make('div', 'rank-tabs');
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', '端侧榜单');
  const title = make('h3', 'rank-title-line');
  title.dataset.el = 'rankings-title';
  const list = bareBand('srch-rank-list', 'rankings-list');
  const note = make('p', 'pv-hint', '按累计热度或上架时间排序，仅覆盖本机快照已缓存的公开目录；非24小时或全网实时榜。');

  const scopeOf = (): RankScope => rankScope(deps.channel?.(), deps.category?.() ?? ALL_CATEGORIES_LABEL);

  const itemsOf = (): ContentItem[] => {
    if (disposed) return [];
    try {
      return [...deps.items()];
    } catch {
      return [];
    }
  };
  /** 【AI先锋榜】的候选范围与排名走同一处筛选，覆盖说明与名次因此永远对得上。 */
  const candidatesOf = (): ContentItem[] => kindCandidates(itemsOf(), current);

  function paintTitle(): void {
    const scope = scopeOf();
    const parts = [deps.channelName?.() ?? null, scope.category === ALL_CATEGORIES_LABEL ? '全部' : scope.category, RANKING_LABEL[current]]
      .filter((part): part is string => typeof part === 'string' && part !== '');
    title.textContent = parts.join(' · ');
  }

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

  function emptyCopy(scope: RankScope): string {
    if (current === 'fresh') return '本机快照上架时间数据不足。';
    if (scope.channel === null) return '热度数据不足：本机快照暂无可核验的累计热度。';
    const category = scope.category === ALL_CATEGORIES_LABEL ? '该视界' : `「${scope.category}」分类`;
    return `热度数据不足：${category}在本机快照内暂无可核验的累计热度，不编造名次。`;
  }

  function paint(): void {
    if (disposed) return;
    paintTitle();
    const scope = scopeOf();
    const candidates = candidatesOf();
    const coverage = coverageOf(candidates, scope, current);
    const ranked = rankWindow(candidates, current, limit, scope);
    const coverageLine = make('p', 'pv-hint rank-coverage');
    coverageLine.dataset.el = 'rankings-coverage';
    coverageLine.textContent = coverageNote(scope, coverage);
    if (ranked.length === 0) {
      list.wrap.dataset.state = 'empty';
      list.body.replaceChildren(make('p', 'pv-state pv-state-empty', emptyCopy(scope)), coverageLine, note);
      return;
    }
    const rows = make('div', 'rank-list');
    rows.append(...ranked.map((item, index) => row(item, index + 1)));
    list.wrap.dataset.state = 'ready';
    list.wrap.dataset.rankKind = current;
    list.body.replaceChildren(rows, coverageLine, note);
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
  if (deps.category !== undefined) host.append(title);
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
