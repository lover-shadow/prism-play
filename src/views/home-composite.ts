/**
 * HP-04 / HP-05 综合首页 feed：跨四个公开频道读取**完整候选池**，按首页独占轨配额出页。
 *
 * 四条硬口径：
 * 1. **纯客户端综合视图**：候选只从真实公开频道读（本机快照优先，无快照才逐频道取首页），
 *    永不发 `/api/channels/home`、永不把首页本地身份拼进 `channel` 参数，也不新增云端点；
 * 2. **私密零进入**：候选范围先由 `publicFeedChannels()` 收口，再由选择器的 fail-closed 闸门挡第二道，
 *    私密内容不进首页、公开榜、推荐、标签与画像（AC-02-3 的端侧兜底）；
 * 3. **同轮冻结与一致性策略**：轮次一旦确定，页面序列即固化，`load` 追加尾块不回算前页、不跨页重复。
 *    背景同步（`sync()`）只在"还没有轮次"时建轮次；已有轮次一律不动已展示条目——同修订不重排，
 *    换代修订也只把新候选留给下一次显式刷新（HP-06 归 B5 接线），一个推荐页绝不混两代；
 * 4. **输入如实记账**：轮次号、内容 revision、候选覆盖（完整/部分/空）、类型与口碑证据、画像是否有效
 *    与逐轨 requested/actual/deviation 都留在记录里，供界面或诊断如实呈现（HP-05）。
 *
 * 推荐轮次 ≠ 云 revision ≠ 播放器打开代次：三者来源与命名都不同，本模块不互相顶替。
 */

import type { ChannelItem, ContentItem } from '../../edge/src/types/api';
import type { WatchHistoryRow } from '../core/storage/storage-domains';
import type { HomeApi } from './home-view';
import { genrePreference, type BadgeKind, type GenreOf } from '../core/recommendation';
import { createHomeRound, type HomeCoverage, type HomeRound, type HomeRoundRecord, type ReputationOf } from '../core/home-recommendation';
import { describeEmptyOverview, publicFeedChannels } from './home-nav';
import { changedSequence, discoveryPool } from './home-discovery';
import type { DiscoveryReport, FeedContext, HomeFeed } from './home-feeds';

export interface CompositeDeps extends FeedContext {
  api: HomeApi;
  pageSize: number;
  /** 云端拓扑（真实身份已下发）：候选范围只取其中的公开频道，展示名不参与任何筛选 key。 */
  channels: () => readonly ChannelItem[];
  historyRows: () => readonly WatchHistoryRow[];
  nowSeconds: () => number;
  /** 口碑证据接缝：缺省即"仓库无口碑字段"的诚实证据状态，端侧不发明公网 rating 接口去凑 4 席。 */
  reputationOf?: ReputationOf;
  retryScope: () => void;
  retryTopology: () => void;
  /** 当代导航代次：背景同步与显式刷新都按它核对迟到结果。 */
  token: () => number;
}

export interface CompositeFeed extends HomeFeed {
  record(): HomeRoundRecord | null;
  /** 背景同步的唯一入口：同修订不重排，换代也只喂下一次显式刷新。 */
  sync(): Promise<void>;
}

export function createHomeFeed(deps: CompositeDeps): CompositeFeed {
  let round: HomeRound | null = null;
  let pool: ContentItem[] = [];
  /** 已交给渲染的累积条目：尾块只追加，前页不回算。 */
  let shown: ContentItem[] = [];
  let badges = new Map<string, BadgeKind>();
  let delivered = 0, revision = 0, coverage: HomeCoverage = 'empty', roundIndex = 0;
  let appending = false;

  /** 候选读取：本机快照优先（完整池）；快照缺席才逐公开频道各取一页，覆盖度如实降级为 partial。 */
  async function readCandidates(token: number): Promise<ContentItem[] | null> {
    const targets = publicFeedChannels(deps.channels());
    if (targets.length === 0) {
      deps.state('disabled', { detail: '没有可展示的视界频道。', actionLabel: '重新加载', onAction: () => deps.retryTopology() });
      return null;
    }
    const snapshot = deps.api.cachedSnapshot?.();
    const cached: ContentItem[] = [];
    for (const channel of targets) cached.push(...(snapshot?.items(channel.id) ?? []));
    if (cached.length > 0) {
      const state = snapshot?.state?.() ?? null;
      coverage = state !== null && !state.partial ? 'full' : 'partial';
      revision = state?.revision ?? 0;
      return cached;
    }
    const responses = await Promise.all(targets.map((channel) => deps.api.catalog({ channel: channel.id, page: 1, pageSize: deps.pageSize })));
    if (!deps.isCurrent(token)) return null;
    revision = responses.reduce((max, response) => Math.max(max, response.revision), 0);
    coverage = 'partial';
    return responses.reduce((list: ContentItem[], response) => list.concat(response.items), []);
  }

  /** 新轮次：轮次号自增（与云 revision 无关），选择器输入全部如实登记。 */
  function newRound(candidates: ContentItem[]): void {
    const genres = new Map(candidates.map((entry) => [entry.id, entry.category] as const));
    const genreOf: GenreOf = (contentId: string): string | undefined => genres.get(contentId);
    pool = candidates;
    roundIndex += 1;
    round = createHomeRound({
      candidates, revision, round: roundIndex, coverage,
      scores: genrePreference([...deps.historyRows()], deps.nowSeconds(), genreOf),
      pageSize: deps.pageSize,
      ...(deps.reputationOf === undefined ? {} : { reputationOf: deps.reputationOf })
    });
    delivered = 0; shown = []; badges = new Map();
  }

  function deliver(index: number): boolean {
    if (round === null) return false;
    const page = round.page(index);
    if (page.items.length === 0) return false;
    const merged = new Map([...shown, ...page.items].map((entry) => [entry.id, entry] as const));
    shown = [...merged.values()];
    badges = new Map([...badges, ...page.badges]);
    delivered = index + 1;
    deps.paint(shown, badges);
    return true;
  }

  const emptyCopy = () => {
    const copy = describeEmptyOverview(coverage === 'partial');
    return { detail: copy.detail, actionLabel: copy.actionLabel, onAction: () => deps.retryScope() };
  };

  const sameIds = (candidates: ContentItem[]): boolean =>
    candidates.length === pool.length && candidates.every((entry, index) => pool[index]?.id === entry.id);

  /**
   * 已有轮次时的背景刷新（HP-05 同轮冻结）：同修订同候选一个字都不动——不重排已展示条目、不把
   * 已追加到第 2 页的列表塌陷回第 1 页；换代修订也只把新候选存起来喂下一次显式刷新，绝不与本页混代。
   */
  async function holdRound(token: number): Promise<void> {
    const candidates = await readCandidates(token);
    if (candidates === null || !deps.isCurrent(token) || candidates.length === 0 || round === null) return;
    if (round.record.revision === revision && sameIds(candidates)) return;
    pool = candidates;
  }

  return {
    async load(token: number, append: boolean): Promise<void> {
      if (append) {
        if (round === null || delivered >= round.record.pages) return;
        appending = true;
        deps.pending(true);
        try {
          deliver(delivered);
        } finally {
          appending = false;
          if (deps.isCurrent(token)) deps.pending(false);
        }
        return;
      }
      if (round !== null && shown.length > 0) {
        await holdRound(token);
        if (deps.isCurrent(token)) deps.pending(false);
        return;
      }
      deps.pending(false);
      deps.skeleton();
      try {
        const candidates = await readCandidates(token);
        if (candidates === null || !deps.isCurrent(token)) return;
        if (candidates.length === 0) {
          round = null; coverage = 'empty'; pool = []; shown = [];
          deps.state('empty', emptyCopy());
          return;
        }
        newRound(candidates);
        if (!deliver(0)) {
          round = null;
          deps.state('empty', emptyCopy());
          return;
        }
        // 尾页本来就不足 60：哨兵立刻复查一次，让"还能不能继续追加"由同一条入口回答，不留第二套翻页语义。
        if (shown.length < deps.pageSize) deps.recheck();
      } catch (error) {
        if (deps.isCurrent(token)) deps.fail(error, () => deps.retryScope());
      } finally {
        if (deps.isCurrent(token)) deps.pending(false);
      }
    },
    canLoadMore: () => round !== null && !appending && shown.length > 0 && delivered < round.record.pages,
    rankingsItems: () => pool,
    hasContent: () => shown.length > 0,
    record: () => round?.record ?? null,
    async sync(): Promise<void> {
      const token = deps.token();
      if (round !== null && shown.length > 0) { await holdRound(token); return; }
      const candidates = await readCandidates(token);
      if (candidates === null || !deps.isCurrent(token) || candidates.length === 0) return;
      newRound(candidates);
      deliver(0);
    },
    /**
     * HP-06：显式刷新＝**新的推荐轮次**。同修订也重开一轮（`roundIndex` 自增、云 revision 不变），
     * 并按真实曝光把"已经看见过"的公开候选整体移出本轮池；未看过的不足以铺满一页时如实回
     * `exhausted`，不随机洗牌、也不把看过的塞回前排冒充新意。空缓存直接抛错，由上层诚实报失败。
     */
    async restart(token: number): Promise<DiscoveryReport> {
      const before = shown.map((entry) => entry.id);
      const candidates = await readCandidates(token);
      if (candidates === null || !deps.isCurrent(token)) {
        return { changed: false, candidates: 0, delivered: shown.length, exhausted: true };
      }
      if (candidates.length === 0) {
        round = null; pool = []; shown = []; coverage = 'empty';
        deps.state('empty', emptyCopy());
        throw new Error('本机没有可用的公开候选快照。');
      }
      const picked = discoveryPool(candidates, deps.exposed(), deps.pageSize);
      newRound(picked.items);
      deliver(0);
      return {
        changed: changedSequence(before, shown.map((entry) => entry.id)),
        candidates: picked.items.length,
        delivered: shown.length,
        exhausted: picked.exhausted
      };
    },
    reset(): void {
      round = null; pool = []; shown = []; badges = new Map();
      delivered = 0; coverage = 'empty'; appending = false;
    },
    suspend(): void { appending = false; }
  };
}
