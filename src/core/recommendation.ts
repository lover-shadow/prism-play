/**
 * 端侧 3.5:3.5:3 自适应推荐混排（PLAYER-FULLSCREEN-SIGNING-UPDATE-SPEC v2.5 §1.8 机制七，验收 AC-28）。
 *
 * 三条施工纪律：
 * 1. **纯函数、同步、零 I/O**：本文件不读网络、不读磁盘、不自行取时钟（`nowSeconds` 由调用方注入），
 *    因此同输入必同输出，块结构与角标判定都能在单测里逐条定量断言；
 * 2. **零虚构**：A 轨唯一判据 `isAi === true`、B 轨唯一判据 `isHot === true`；字段缺失即按 §1.8.1
 *    降级排队并**不贴对应角标**。`tags` 兜底路径按 §1.8.1 明确废弃——`ContentItem` 不下发 tags，
 *    写进来就是永远走不到的死分支；
 * 3. **只重排展示层**：`page / revision / 游标 / 加载更多` 语义一律不变，编织发生在**累积集合**上，
 *    凑满的块内容固化、永不再变（§1.8.4）。
 *
 * 【契约缺口登记 · 端侧不以伪造字段填坑】规格书 §1.8.1 的 B 轨降级写的是「回退为 `first_published_at`
 * 倒序」，§1.8.3 又给 C 轨配了 `firstPublishedAt` 次级键。经仓库核验（`edge/src/types/api.ts`、
 * `edge/src/http/serialize.ts`、`src/**` 全量检索），该字段在线上契约中**不存在**；`hotScore` 同样只
 * 活在 D1 内部、不下发。端侧不发明数据：B 轨降级回退为 id 稳定序，C 轨次级键同样取 id 稳定序——
 * 二者都是真实可得的信号，而排序键绝不能依赖收不到的字段。规格书需据此修订（见交付报告）。
 */

import type { ContentItem } from '../../edge/src/types/api';
import { isPrivateSubject, type WatchHistoryRow } from './storage/storage-domains';

/** 历史推荐块按7/7/6混排；综合首页配额由HP-05的60作品候选页替代。 */
export const WEAVE_BLOCK_SIZE = 20;
export const AI_QUOTA = 7;
export const HOT_QUOTA = 7;
export const EXPLORE_QUOTA = 6;
/** 画像半衰期 7 天（§1.8.2）。 */
export const PREFERENCE_HALF_LIFE_SECONDS = 7 * 24 * 60 * 60;
/** 快速划走惩罚阈值：进度 <20% 记 1 分惩罚（§1.8.2）。 */
export const SKIP_RATIO_THRESHOLD = 0.2;

/** 块内槽位轨道：A = AI 精品、H = 全网热门（规格书里的 B 轨）、E = 口碑破圈探索（C 轨）。 */
export type Slot = 'A' | 'H' | 'E';
/** 供给来源：三条轨，或 §1.8.1 的 A 轨降级池（D = degraded，无任何定性依据）。 */
export type Supply = Slot | 'D';
export type BadgeKind = 'ai' | 'hot' | 'recommend';
export type GenreScores = Readonly<Record<string, number>>;
/** 题材归属查找由调用方注入：`WatchHistoryRow` 没有 category 列，端侧不猜。 */
export type GenreOf = (contentId: string) => string | undefined;

/** 块内固定序列 `[A,H,E]×6 + [A,H]`，共 20 槽、恰好 7A / 7H / 6E（§1.8.4）。 */
export const BLOCK_PATTERN: readonly Slot[] = Object.freeze(
  Array.from({ length: AI_QUOTA }, (_, index): Slot[] => (index < EXPLORE_QUOTA ? ['A', 'H', 'E'] : ['A', 'H'])).flat()
);

/**
 * 7 天半衰期本地画像（§1.8.2）：`Score(题材) += 0.5^(Δt/7d) × (集数×2 + 分钟×0.5 − 划走惩罚)`。
 *
 * 诚实边界：查不到题材的历史行**整条不计**（不是补一个默认题材，也不是记 0 分后继续参与排序），
 * 因为「未知」与「看过但无偏好」是两件事。惩罚项可为负分——这是规格书公式的原样，不做美化截断。
 */
export function genrePreference(rows: readonly WatchHistoryRow[], nowSeconds: number, genreOf: GenreOf): GenreScores {
  const acc = new Map<string, number>();
  for (const row of rows) {
    const genre = genreOf(row.content_id);
    if (typeof genre !== 'string' || genre === '') continue;
    const elapsed = Math.max(0, nowSeconds - row.updated_at);
    const decay = Math.pow(0.5, elapsed / PREFERENCE_HALF_LIFE_SECONDS);
    const episodes = Number.isFinite(row.last_episode_number) && row.last_episode_number > 0 ? row.last_episode_number : 0;
    const minutes = Number.isFinite(row.position_seconds) && row.position_seconds > 0 ? row.position_seconds / 60 : 0;
    // duration_seconds ≤ 0 属「无法判定进度」，一律不记惩罚：除零与脏数据不得凭空变成负分。
    const skipped =
      row.duration_seconds > 0 && row.position_seconds / row.duration_seconds < SKIP_RATIO_THRESHOLD;
    const raw = episodes * 2 + minutes * 0.5 - (skipped ? 1 : 0);
    acc.set(genre, (acc.get(genre) ?? 0) + decay * raw);
  }
  return Object.fromEntries(acc);
}

export interface WeaveOptions {
  genreOf?: GenreOf;
  /** 分页累积列表按到达次序划块，避免后来较小 ID 插入已完成的块。 */
  preserveAppend?: boolean;
}

export interface WeaveResult {
  /** 展示顺序：输入（去私密、去重、id 稳定序后）的一个**排列**，条数一一对应、零蒸发。 */
  items: ContentItem[];
  /** contentId → 角标判定；不在表内即「留白不贴标」。 */
  badges: ReadonlyMap<string, BadgeKind>;
  blocks: number;
  /** 显式计数的缺额补偿次数（§1.8.4「禁止静默少渲染」），含 §1.8.1 的 A 轨降级取用。 */
  backfill: number;
  /** 被私密闸门摘除的条数：私密内容绝不进入展示层，也不参与任何一块。 */
  hidden: number;
}

const byId = (a: ContentItem, b: ContentItem): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** 题材归属缺失或分数非有限值时按 0 计——0 是「无信号」，不是猜出来的偏好。 */
function scoreOf(scores: GenreScores, genreOf: GenreOf | undefined, item: ContentItem): number {
  if (genreOf === undefined) return 0;
  const genre = genreOf(item.id);
  if (typeof genre !== 'string' || !Object.prototype.hasOwnProperty.call(scores, genre)) return 0;
  const value = scores[genre];
  return Number.isFinite(value) ? value : 0;
}

const byPreferenceDesc = (scores: GenreScores, genreOf?: GenreOf) =>
  (a: ContentItem, b: ContentItem): number => scoreOf(scores, genreOf, b) - scoreOf(scores, genreOf, a) || byId(a, b);

/**
 * B 轨优先使用真实非负 hitsTotal 降序，真实同分仅 ID 收口。
 * 缺热度时沿用旧供给标记降级，不将该降级冒充频道热度榜。
 */
const heat = (item: ContentItem): number =>
  typeof item.hitsTotal === 'number' && Number.isFinite(item.hitsTotal) && item.hitsTotal >= 0 ? item.hitsTotal : -1;
const byHotFirst = () =>
  (a: ContentItem, b: ContentItem): number => heat(b) - heat(a)
    || (heat(a) < 0 ? Number(b.isHot === true) - Number(a.isHot === true) : 0) || byId(a, b);

/**
 * C 轨排序键：主键「非热门优先」（热门是 B 轨的存货，探索轨不得把它们提前吃掉，否则 7:7:6 配额在
 * 同一块里对不齐——这是 §1.8.4「整数整除零余数」能否成立的前提），次键本地偏好分**升序**（低频题材优先，
 * 反信息茧房），末级键 id 稳定序。
 */
const byExploreOrder = (scores: GenreScores, genreOf?: GenreOf) =>
  (a: ContentItem, b: ContentItem): number =>
    Number(a.isHot === true) - Number(b.isHot === true)
    || scoreOf(scores, genreOf, a) - scoreOf(scores, genreOf, b)
    || byId(a, b);

/**
 * 角标判定（AC-29 的唯一贴标口径）：
 * - A 轨供给：仅当 `isAi === true` 才贴【AI精品】；§1.8.1 的降级供给（`D`）一律不贴；
 * - B 轨供给：仅当 `isHot === true` 才贴【热门】，B 轨的「稳定序尾巴」不贴；
 * - C 轨供给：【推荐】的依据是「确实由探索轨供给」**且本地画像非空**——新装设备画像全空时，
 *   探索次序会退化成 id 序，此时宣称「为你破圈」没有事实支撑，宁可不贴（零虚假 UI）。
 */
function badgeFor(from: Supply, item: ContentItem, hasProfile: boolean): BadgeKind | undefined {
  if (from === 'A') return item.isAi === true ? 'ai' : undefined;
  if (from === 'H') return item.isHot === true ? 'hot' : undefined;
  if (from === 'E') return hasProfile ? 'recommend' : undefined;
  return undefined;
}

/**
 * 三轨互斥编织（§1.8.3 + §1.8.4）。
 *
 * 块切分口径：先对**累积集合**按 id 稳定序得到 `S`，块 c 消费 `S[20c, 20c+20)`。于是
 * 默认保留纯函数 ID 基线；首页传 preserveAppend 按到达次序划块，新页较小 ID 也不扰动已满块；
 * **不足 20 条的尾块**按 `A H E` 循环尽力填充、允许比例偏离，并明确接受它会随下一页数据到达而重排
 * （重排范围严格限于尾块 ≤19 条，不波及已固化块）。
 */
export function weave(items: readonly ContentItem[], scores: GenreScores, options: WeaveOptions = {}): WeaveResult {
  const { genreOf } = options;
  const unique = new Map<string, ContentItem>();
  let hidden = 0;
  for (const item of items) {
    // 私密内容物理隐形：复用存储域的唯一判定咽喉，不在本文件另立第二套谓词。
    if (isPrivateSubject(item)) { hidden += 1; continue; }
    if (!unique.has(item.id)) unique.set(item.id, item);
  }
  const baseline = [...unique.values()];
  if (!options.preserveAppend) baseline.sort(byId);
  const hasProfile = Object.keys(scores).length > 0;
  /**
   * §1.8.1 行 1/行 4 的降级开关：`isAi` 在整个集合里**一个都没有**（字段缺失或全 false）时，A 轨槽位
   * 不再有空池可取，回退为「剩余条目里本地画像得分最高的题材」（画像为空即得分全 0，等价于 id 稳定序取前 N）。
   * 反之只要字段在线上有信号，A 轨缺额就按 §1.8.4 由探索轨（C 轨）优先补齐。两种路径都**不贴【AI精品】标**。
   * B 轨的降级（§1.8.1 行 2）不需要开关：`byHotFirst` 在无人 `isHot === true` 时自然落到 id 稳定序。
   */
  const aiSignalAbsent = !baseline.some((item) => item.isAi === true);

  const out: ContentItem[] = [];
  const badges = new Map<string, BadgeKind>();
  let blocks = 0;
  let backfill = 0;

  for (let start = 0; start < baseline.length; start += WEAVE_BLOCK_SIZE) {
    const block = baseline.slice(start, start + WEAVE_BLOCK_SIZE);
    const taken = new Set<string>();
    const pools: Record<Slot, ContentItem[]> = {
      A: block.filter((x) => x.isAi === true).sort(byPreferenceDesc(scores, genreOf)),
      H: block.filter((x) => x.isAi !== true).sort(byHotFirst()),
      E: block.filter((x) => x.isAi !== true).sort(byExploreOrder(scores, genreOf))
    };
    const heads: Record<Slot, number> = { A: 0, H: 0, E: 0 };

    const takeFrom = (slot: Slot): ContentItem | undefined => {
      const pool = pools[slot];
      while (heads[slot] < pool.length) {
        const candidate = pool[heads[slot]];
        heads[slot] += 1;
        if (!taken.has(candidate.id)) return candidate;
      }
      return undefined;
    };
    /** §1.8.1 行 1/行 4：A 轨没有 `isAi === true` 候选时，回退为「剩余条目中本地画像得分最高的题材」。 */
    const takeDegraded = (): ContentItem | undefined =>
      block.filter((x) => !taken.has(x.id)).sort(byPreferenceDesc(scores, genreOf))[0];

    const chains: Record<Slot, readonly { from: Supply; pick: () => ContentItem | undefined }[]> = {
      A: aiSignalAbsent
        ? [{ from: 'A', pick: () => takeFrom('A') }, { from: 'D', pick: takeDegraded },
          { from: 'H', pick: () => takeFrom('H') }, { from: 'E', pick: () => takeFrom('E') }]
        : [{ from: 'A', pick: () => takeFrom('A') }, { from: 'E', pick: () => takeFrom('E') },
          { from: 'H', pick: () => takeFrom('H') }],
      H: [{ from: 'H', pick: () => takeFrom('H') }, { from: 'E', pick: () => takeFrom('E') },
        { from: 'A', pick: () => takeFrom('A') }],
      E: [{ from: 'E', pick: () => takeFrom('E') }, { from: 'H', pick: () => takeFrom('H') },
        { from: 'A', pick: () => takeFrom('A') }]
    };

    for (const slot of BLOCK_PATTERN) {
      let picked: ContentItem | undefined;
      let from: Supply = slot;
      for (const supply of chains[slot]) {
        const candidate = supply.pick();
        if (candidate !== undefined) { picked = candidate; from = supply.from; break; }
      }
      if (picked === undefined) continue; // 尾块候选耗尽：尽力填充，比例偏离已在 §1.8.4 明确接受
      taken.add(picked.id);
      out.push(picked);
      if (from !== slot) backfill += 1;
      const badge = badgeFor(from, picked, hasProfile);
      if (badge !== undefined) badges.set(picked.id, badge);
    }

    // 零丢失硬保底：三条轨的并集覆盖块内全部条目，理论上不会剩下；真剩下也显式补位并计数，
    // 绝不让某条剧目在展示层凭空蒸发（§1.8.4「禁止静默少渲染」的直接对应）。
    for (const leftover of block) {
      if (taken.has(leftover.id)) continue;
      taken.add(leftover.id);
      out.push(leftover);
      backfill += 1;
    }
    blocks += 1;
  }

  return { items: out, badges, blocks, backfill, hidden };
}
