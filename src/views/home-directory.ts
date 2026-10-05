/**
 * 频道目录 feed（HP-04 分路之一）：真实频道身份 + 真实 categories + 60 条传输分页。
 *
 * 分页语义一字未改地从 `home-view.ts` 搬出：`page / revision 游标 / total 收口 / 本地先显 / 确定性混排`
 * 全部保持原实现，因为 AC-01 / AC-18 / AC-28 的历史口径仍按这条路径验收。综合首页**不套**这里的
 * 20 条 7/7/6 块编排，频道目录也**不套**首页的 20/4/12/6/18 配额（HP-05 明示"普通频道目录不套首页配额"）。
 */

import type { ChannelId, ChannelItem, CatalogResponse, ContentItem } from '../../edge/src/types/api';
import type { WatchHistoryRow } from '../core/storage/storage-domains';
import type { HomeApi } from './home-view';
import { genrePreference, weave } from '../core/recommendation';
import { ALL_CATEGORIES_LABEL } from '../components/capsule-rail';
import { changedSequence, discoveryPool } from './home-discovery';
import { describeEmptyCatalog } from './home-nav';
import type { DiscoveryReport, HomeFeed, FeedContext } from './home-feeds';

export interface DirectoryDeps extends FeedContext {
  api: HomeApi;
  pageSize: number;
  /** 当前真实频道身份与二级分类：`channel` 只会是云端下发的 `ChannelItem.id`，永远不是首页本地身份。 */
  scope: () => { channel: ChannelId | null; category: string };
  channels: () => readonly ChannelItem[];
  historyRows: () => readonly WatchHistoryRow[];
  nowSeconds: () => number;
  /** 空态「返回某视界」的去处：由视图决定切频道，feed 不自己改导航状态。 */
  goFallback: (channelId: ChannelId | null) => void;
  /** 重试本范围首屏（视图负责 ++token），与「重新装配拓扑」是两个不同去处。 */
  retryScope: () => void;
  retryTopology: () => void;
}

export function createDirectoryFeed(deps: DirectoryDeps): HomeFeed & { items(): ContentItem[]; hydrateLocal(): boolean } {
  let items: ContentItem[] = [], page = 1, total = 0, revision: number | undefined;
  let ready = false, appending = false;

  /** 题材查表用 Map：排序里每次比较都要取题材，线性 find 会把 2ms 端侧预算整个吃光。 */
  function paintGrid(): void {
    const genres = new Map(items.map((entry) => [entry.id, entry.category] as const));
    const genreOf = (contentId: string): string | undefined => genres.get(contentId);
    const woven = weave(items, genrePreference([...deps.historyRows()], deps.nowSeconds(), genreOf), { genreOf, preserveAppend: true });
    deps.paint(woven.items, woven.badges);
  }

  /** 本地先显（AC-01）：有同频道快照就立刻铺满首屏，网络只负责替换与追加。 */
  function hydrateLocal(): boolean {
    const snapshot = deps.api.cachedSnapshot?.();
    const scope = deps.scope();
    if (scope.channel === null || snapshot === undefined) return false;
    const local = snapshot.items(scope.channel);
    if (local.length === 0) return false;
    items = scope.category === ALL_CATEGORIES_LABEL ? local.slice(0, deps.pageSize)
      : local.filter((entry) => entry.category === scope.category).slice(0, deps.pageSize);
    total = scope.category === ALL_CATEGORIES_LABEL ? local.length : items.length;
    paintGrid();
    ready = true;
    if (local.length < deps.pageSize) deps.recheck();
    return true;
  }

  async function load(token: number, append: boolean): Promise<void> {
    const targetPage = append ? page + 1 : 1;
    const scope = deps.scope();
    if (scope.channel === null) {
      deps.state('disabled', { detail: '没有可展示的视界频道。', actionLabel: '重新加载', onAction: () => deps.retryTopology() });
      return;
    }
    if (targetPage === 1 && items.length === 0) deps.skeleton();
    appending = targetPage > 1;
    deps.pending(appending);
    const query = {
      channel: scope.channel,
      ...(scope.category === ALL_CATEGORIES_LABEL ? {} : { category: scope.category }),
      page: targetPage,
      pageSize: deps.pageSize,
      // 翻页才带游标：首页无游标可钉，第二页起把上一页的 revision 交给边缘做快照一致性校验。
      ...(targetPage > 1 && revision !== undefined ? { revision } : {})
    };

    let response: CatalogResponse | undefined;
    try {
      response = await deps.api.catalog(query);
      if (!deps.isCurrent(token)) return;
      // 页码是否真的推进过：边缘若把同一页原样回给我们，继续追加只会重复堆同一批剧目。
      const advanced = targetPage === 1 || response.page > page;
      page = response.page;
      total = response.total;
      revision = response.revision;
      const before = items.length;
      items = targetPage === 1 ? [...response.items] : [...new Map([...items, ...response.items].map((entry) => [entry.id, entry])).values()];
      if (targetPage > 1 && items.length === before) total = items.length;
      if (items.length === 0) {
        const copy = describeEmptyCatalog(deps.channels(), scope.channel);
        deps.state('empty', {
          detail: copy.detail, actionLabel: copy.actionLabel,
          onAction: () => { if (copy.action === 'reload') deps.retryScope(); else deps.goFallback(copy.fallbackId); }
        });
        return;
      }
      // 空页或页码未推进就如实收口（把 total 降到已载数）：哨兵从此不再打无意义的请求，也不谎报"还有更多"。
      if (targetPage > 1 && (response.items.length === 0 || !advanced)) total = items.length;
      paintGrid();
      ready = true;
    } catch (error) {
      if (!deps.isCurrent(token)) return;
      deps.fail(error, () => deps.retryScope());
    } finally {
      if (deps.isCurrent(token)) {
        appending = false; deps.pending(false);
        // 仅当条数不足单页容量（铺不满一屏）时才主动复查续载；满页由用户滚动触发，绝不自动死循环拉取。
        if (response !== undefined && response.items.length < deps.pageSize && items.length < total) deps.recheck();
      }
    }
  }

  /** 本范围内的完整候选：网络首屏 ＋ 本机快照，再按当前二级分类收口（先筛，绝不先截）。 */
  function unionOf(scope: { channel: ChannelId; category: string }, head: ContentItem[]): ContentItem[] {
    const local = deps.api.cachedSnapshot?.().items(scope.channel) ?? [];
    const merged = [...head, ...local];
    return scope.category === ALL_CATEGORIES_LABEL ? merged : merged.filter((entry) => entry.category === scope.category);
  }

  return {
    /**
     * HP-06：本频道／本二级分类的刷新＝**这一范围候选的发现 feed 重选**（画像＋真实曝光一起进池），
     * 不是把公共热门榜随机洗牌，也不是只把修订号同步一遍。网络读失败时本机快照照常重排，
     * 但把网络故障单独带进回执（`error`），由上层与"本地重排成功"分开陈述；范围内一个候选都没有
     * 就落五态并抛错——空缓存不许假装成功。
     */
    async restart(token: number): Promise<DiscoveryReport> {
      const scope = deps.scope();
      if (scope.channel === null) {
        deps.state('disabled', { detail: '没有可展示的视界频道。', actionLabel: '重新加载', onAction: () => deps.retryTopology() });
        return { changed: false, candidates: 0, delivered: 0, exhausted: true };
      }
      const before = items.map((entry) => entry.id);
      let networkError: unknown = null;
      let head: ContentItem[] = [];
      try {
        const response = await deps.api.catalog({
          channel: scope.channel,
          ...(scope.category === ALL_CATEGORIES_LABEL ? {} : { category: scope.category }),
          page: 1,
          pageSize: deps.pageSize
        });
        if (!deps.isCurrent(token)) return { changed: false, candidates: 0, delivered: 0, exhausted: true };
        head = response.items;
        page = response.page;
        total = response.total;
        revision = response.revision;
      } catch (error) {
        networkError = error;
      }
      const union = unionOf({ channel: scope.channel, category: scope.category }, head);
      if (union.length === 0) {
        ready = false;
        const copy = describeEmptyCatalog(deps.channels(), scope.channel);
        deps.state('empty', {
          detail: copy.detail, actionLabel: copy.actionLabel,
          onAction: () => { if (copy.action === 'reload') deps.retryScope(); else deps.goFallback(copy.fallbackId); }
        });
        throw networkError ?? new Error('本机没有该范围内的候选快照。');
      }
      const picked = discoveryPool(union, deps.exposed(), deps.pageSize);
      items = picked.items.slice(0, deps.pageSize);
      if (networkError !== null) total = picked.items.length;                          // 断网：只在本地池内收口
      paintGrid();
      ready = true;
      const report: DiscoveryReport = {
        changed: changedSequence(before, items.map((entry) => entry.id)),
        candidates: picked.items.length,
        delivered: items.length,
        exhausted: picked.exhausted
      };
      if (networkError !== null) return { ...report, error: networkError };
      return report;
    },
    load,
    canLoadMore: () => ready && !appending && items.length > 0 && items.length < total,
    rankingsItems: () => {
      const scope = deps.scope();
      if (scope.channel === null) return [];
      return deps.api.cachedSnapshot?.().items(scope.channel) ?? items;
    },
    items: () => items,
    hasContent: () => items.length > 0,
    hydrateLocal,
    suspend() { ready = false; appending = false; },
    reset() { items = []; page = 1; total = 0; revision = undefined; ready = false; appending = false; }
  };
}
