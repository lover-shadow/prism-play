/**
 * HP-05 综合首页 60 作品候选页选择器（HOME-PLAYER-REPAIR-SPEC-AND-PLAN §HP-05 / §3.2 / §2.3）。
 *
 * 三条施工纪律：
 * 1. **纯函数、同步、零 I/O**：候选池、画像分与口碑证据都由调用方注入，同输入必同输出，因此"同轮冻结"
 *    与"尾页不重复"能在单测里逐条定量断言；排序与供给取用机制在配套模块 `home-feed-order.ts`；
 * 2. **零虚构**：AI 轨唯一判据 `isAi === true`；真人轨唯一资格是注入的口碑证据接缝——仓库当前**没有**口碑
 *    字段，默认接缝一律回 `insufficient`，缺额按 §2.3 最小回退补给 AI 轨并如实记偏差；`isHot`/`hitsTotal`
 *    只作热度线索，永不当作口碑；
 * 3. **只作用于综合首页**：20/4/12/6/18 是首页独占轨配额；频道目录继续走 `recommendation.ts` 的 20 条
 *    7/7/6 块编排（AC-28 历史口径），两台机器互不套常量。
 *
 * 【待证工程参数 · 不是 Master 批准的数字】跨源热度可比性尚未核验，故只做"来源内分位"后公平合并；席位散布
 * 与四相位补位优先级（先预留、再补位、偏好殿后、尾页收口）是按真实可得供给排定的工程选择，需在真实候选分布
 * 上复核；观感、密度与顺序"看起来对不对"一律待浏览器验证，本文件不作视觉承诺。
 */

import type { ContentItem, PublicChannelId } from '../../edge/src/types/api';
import { isPrivateSubject } from './storage/storage-domains';
import type { BadgeKind, GenreScores } from './recommendation';
import { heatOf, makeCompare, makeSupply, pageSlotPattern, percentilesBySource, takeFrom, type Supply } from './home-feed-order';

/** 一个完整推荐页的目标条数：展示单位是**作品**，不是集，也不是云分片传输分页。 */
export const HOME_PAGE_TARGET = 60;
export const HOME_TRACKS = ['ai', 'live', 'movie', 'other', 'preference'] as const;
export type HomeTrack = (typeof HOME_TRACKS)[number];

export const HOME_TRACK_TARGETS: Readonly<Record<HomeTrack, number>> = Object.freeze({
  ai: 20, live: 4, movie: 12, other: 6, preference: 18
});
/**
 * 各轨供给范围。**顺序即偏好轨的轮转顺序**：`documentary` 排在 `anime` 之前，两频道的 6 席才谈得上兼顾。
 * 这是首页配额层的顺序，与云端频道展示 `order` 无关，也不进入任何请求参数。
 */
const FEED_SCOPE_ORDER: readonly PublicChannelId[] = Object.freeze(['drama', 'movie', 'documentary', 'anime']);
export const HOME_TRACK_SCOPE: Readonly<Record<HomeTrack, readonly PublicChannelId[]>> = Object.freeze({
  ai: ['drama'], live: ['drama'], movie: ['movie'], other: ['documentary', 'anime'], preference: FEED_SCOPE_ORDER
});
/**
 * 缺额补位优先级（§3.2「其他补位优先级需按真实可用供给集中定义并登记」）：真人缺额优先回补 AI 轨
 * （§2.3 已获认可的最小回退），其余轨缺额依次借用相邻轨的剩余量。集中定义不等于自动动态调比——
 * 任何一轨的目标配额都不会因为别人补齐而变大。
 */
const SUPPLY_CHAIN: Readonly<Record<HomeTrack, readonly HomeTrack[]>> = Object.freeze({
  ai: ['ai', 'live', 'movie', 'other', 'preference'],
  live: ['live', 'ai', 'movie', 'other', 'preference'],
  movie: ['movie', 'other', 'ai', 'live', 'preference'],
  other: ['other', 'movie', 'ai', 'live', 'preference'],
  preference: ['preference', 'movie', 'other', 'ai', 'live']
});
/** 相位一～二期间偏好轨不参与别人的补位，确保 18 席不会被反向挤占，也不会反吃预留的 24 席。 */
const RESERVE_ORDER: readonly HomeTrack[] = Object.freeze(['ai', 'live', 'movie', 'other']);

export type ReputationEvidence = 'qualified' | 'insufficient';
export interface ReputationProbe { evidence: ReputationEvidence; basis: string }
export type ReputationOf = (item: ContentItem) => ReputationProbe;
/** 默认口碑接缝：契约无口碑/评分字段即一律证据不足，端侧不发明公网 rating 接口去凑 4 席。 */
export const NO_REPUTATION_EVIDENCE: ReputationOf = () => ({ evidence: 'insufficient', basis: '公开契约无口碑字段，口碑证据不足' });
export type HomeCoverage = 'full' | 'partial' | 'empty';

export interface HomeTrackAllocation {
  track: HomeTrack;
  /** 本页为该轨保留的席位数（目标配额）。 */
  requested: number;
  /** 真正由本轨合格供给坐实的席位数；`requested - actual` 即缺额，靠 `basis` 区分成因。 */
  actual: number;
  deviation: number;
  /** 本轨席位里由其他供给补齐的数量（不计入 `actual`，用于如实说明回退规模）。 */
  backfilled: number;
  basis: string;
}

export interface HomeRoundRecord {
  /** 推荐轮次号：与云 `revision`、播放器打开代次是三件不同的事，各自命名。 */
  round: number;
  revision: number;
  coverage: HomeCoverage;
  pageSize: number;
  candidates: number;
  pages: number;
  shortPages: number;
  profile: 'valid' | 'none';
  excluded: { private: number; withdrawn: number; duplicate: number };
  evidence: { reputation: ReputationEvidence | 'mixed'; aiField: 'present' | 'absent'; heat: 'within-source' | 'unknown' };
  /** 首页首末页（完整页）的配额账；后续页各自的账在 `page(i).allocation`。 */
  allocation: readonly HomeTrackAllocation[];
}

export interface HomeRoundPage {
  items: ContentItem[];
  badges: ReadonlyMap<string, BadgeKind>;
  /** 席位归属（哪一条独占轨的槽位）：供界面与单测按轨核对，不靠渲染角标倒算配额。 */
  trackOf: ReadonlyMap<string, HomeTrack>;
  allocation: readonly HomeTrackAllocation[];
  short: boolean;
}

export interface HomeRecommendationInput {
  candidates: readonly ContentItem[];
  revision: number;
  round: number;
  coverage: HomeCoverage;
  scores: GenreScores;
  reputationOf?: ReputationOf;
  pageSize?: number;
}

export interface HomeRound {
  readonly record: HomeRoundRecord;
  page(index: number): HomeRoundPage;
}

/** 池内一条真人候选都没有时，偏差文案仍要说清依据：拿默认接缝的措辞，而不是编造一条作品的口碑。 */
const PROBE_FALLBACK: ContentItem = { id: '', channelId: 'drama', title: '', category: '', isPrivate: false };
const inScope = (track: HomeTrack, item: ContentItem): boolean =>
  (HOME_TRACK_SCOPE[track] as readonly string[]).includes(item.channelId);

export function createHomeRound(input: HomeRecommendationInput): HomeRound {
  const pageSize = input.pageSize ?? HOME_PAGE_TARGET;
  const reputationOf = input.reputationOf ?? NO_REPUTATION_EVIDENCE;

  // 分配前统一剔除：私密与任何公开频道之外的身份（fail-closed）→ 撤片 → 重复 workId。同名不同剧各留其位。
  const unique = new Map<string, ContentItem>();
  const excluded = { private: 0, withdrawn: 0, duplicate: 0 };
  for (const item of input.candidates) {
    if (isPrivateSubject(item) || !inScope('preference', item)) { excluded.private += 1; continue; }
    if (item.enabled === false) { excluded.withdrawn += 1; continue; }
    if (unique.has(item.id)) { excluded.duplicate += 1; continue; }
    unique.set(item.id, item);
  }
  const pool = [...unique.values()];
  const compare = makeCompare(input.scores, percentilesBySource(pool));
  const profileValid = Object.keys(input.scores).length > 0;
  const sorted = (keep: (item: ContentItem) => boolean): ContentItem[] => pool.filter(keep).sort(compare);
  const pools: Record<HomeTrack, Supply> = {
    ai: makeSupply([sorted((entry) => inScope('ai', entry) && entry.isAi === true)],
      'AI 轨只认有依据的 isAi === true，不用片名/海报/缺字段猜测'),
    live: makeSupply([sorted((entry) => inScope('live', entry) && entry.isAi !== true && reputationOf(entry).evidence === 'qualified')],
      '真人席位只认可信口碑证据；无口碑字段即证据不足，不强凑普通作品'),
    movie: makeSupply([sorted((entry) => inScope('movie', entry))], '电影仓库真实频道候选，来源内分位排序'),
    other: makeSupply([sorted((entry) => entry.channelId === 'documentary'), sorted((entry) => entry.channelId === 'anime')],
      '纪录片＋动漫 6 席两频道兼顾，按页轮换起始频道，长期不被单频道独占'),
    preference: makeSupply(FEED_SCOPE_ORDER.filter((channelId) => pool.some((entry) => entry.channelId === channelId))
      .map((channelId) => sorted((entry) => entry.channelId === channelId)), profileValid
      ? '跨公开频道按本地画像与来源内热度取尚未选中的候选，频道轮流供给'
      : '零画像：跨公开频道轮流走有依据的来源内热度与多样性探索，不宣称已懂你的偏好')
  };

  const taken = new Set<string>();
  const slots = pageSlotPattern(HOME_TRACKS, HOME_TRACK_TARGETS, pageSize);
  const requested: Record<HomeTrack, number> = { ai: 0, live: 0, movie: 0, other: 0, preference: 0 };
  for (const slot of slots) requested[slot] += 1;
  const basisOf = reputationOf(pool.find((entry) => inScope('live', entry) && entry.isAi !== true) ?? PROBE_FALLBACK).basis;
  const pages: HomeRoundPage[] = [];

  for (let index = 0; index * pageSize < pool.length; index += 1) {
    pools.other.rotation = index % 2;                                              // 换页轮换起始频道
    pools.preference.rotation = index % pools.preference.queues.length;
    const seats = slots.map((track) => ({ track, item: undefined as ContentItem | undefined, supply: undefined as HomeTrack | undefined }));
    const claim = (at: number, chain: readonly HomeTrack[]): void => {
      for (const key of chain) {
        const candidate = takeFrom(pools[key], taken);
        if (candidate === undefined) continue;
        seats[at].item = candidate; seats[at].supply = key; taken.add(candidate.id); return;
      }
    };
    const emptyOf = (track: HomeTrack): number[] => seats.reduce((list, seat, at) =>
      (seat.track === track && seat.item === undefined ? [...list, at] : list), [] as number[]);
    // 相位一：先为供应足够的轨预留额度（AI/真人/电影/其他依次预留）。
    for (const track of RESERVE_ORDER) for (const at of emptyOf(track)) claim(at, [track]);
    // 相位二：真人缺额按 §2.3 最小回退补给 AI 轨，其余轨缺额用相邻轨剩余量补齐（偏好轨此时不动）。
    for (const track of RESERVE_ORDER) for (const at of emptyOf(track)) claim(at, SUPPLY_CHAIN[track].filter((key) => key !== 'preference'));
    // 相位三：偏好 18 席只从尚未选中的公开候选里取。
    for (const at of emptyOf('preference')) claim(at, ['preference']);
    // 相位四：候选仍有剩余而席位仍空（尾页未满）时按补位优先级收口，仍不足即如实留空，不重复作品凑数。
    for (const track of HOME_TRACKS) for (const at of emptyOf(track)) claim(at, SUPPLY_CHAIN[track]);

    const items: ContentItem[] = [];
    const trackOf = new Map<string, HomeTrack>();
    const badges = new Map<string, BadgeKind>();
    const own: Record<HomeTrack, number> = { ai: 0, live: 0, movie: 0, other: 0, preference: 0 };
    const backfilled: Record<HomeTrack, number> = { ai: 0, live: 0, movie: 0, other: 0, preference: 0 };
    for (const seat of seats) {
      const picked = seat.item;
      const supply = seat.supply;
      if (picked === undefined || supply === null) continue;                       // 供给耗尽：席位留空，尾页如实不足
      items.push(picked);
      trackOf.set(picked.id, seat.track);
      if (supply === seat.track) own[seat.track] += 1; else backfilled[seat.track] += 1;
      const badge: BadgeKind | undefined = picked.isAi === true ? 'ai'
        : supply === 'preference' && profileValid ? 'recommend'
          : supply === 'live' && picked.isHot === true ? 'hot' : undefined;
      if (badge !== undefined) badges.set(picked.id, badge);
    }
    const allocation: HomeTrackAllocation[] = HOME_TRACKS.map((track) => {
      const deficit = requested[track] - own[track];
      return {
        track, requested: requested[track], actual: own[track], deviation: deficit, backfilled: backfilled[track],
        basis: track === 'live' && deficit > 0
          ? `口碑证据不足（${basisOf}）；缺额 ${deficit} 席按 §2.3 最小回退补给 AI 轨`
          : pools[track].basis
      };
    });
    pages.push({ items, badges, trackOf, allocation, short: items.length < pageSize });
  }

  const qualified = pools.live.queues[0].length;
  const record: HomeRoundRecord = {
    round: input.round, revision: input.revision, coverage: input.coverage, pageSize,
    candidates: pool.length, pages: pages.length, shortPages: pages.filter((entry) => entry.short).length,
    profile: profileValid ? 'valid' : 'none', excluded,
    evidence: {
      reputation: qualified === 0 ? 'insufficient' : qualified >= HOME_TRACK_TARGETS.live ? 'qualified' : 'mixed',
      aiField: pool.some((entry) => entry.isAi === true) ? 'present' : 'absent',
      heat: pool.some((entry) => heatOf(entry) !== null) ? 'within-source' : 'unknown'
    },
    allocation: pages.length > 0 ? pages[0].allocation : HOME_TRACKS.map((track) => ({
      track, requested: HOME_TRACK_TARGETS[track], actual: 0, deviation: HOME_TRACK_TARGETS[track], backfilled: 0, basis: pools[track].basis
    }))
  };
  return { record, page: (index: number) => pages[index] ?? { items: [], badges: new Map(), trackOf: new Map(), allocation: record.allocation, short: true } };
}
