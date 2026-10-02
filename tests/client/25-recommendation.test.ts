/**
 * 端侧 3.5:3.5:3 混排引擎单测（SPEC v2.5 §1.8 / 验收 AC-28）。
 *
 * 口径：本文件只证**逻辑与块结构**（纯函数、同步、可定量）。2ms 是端侧预算，真机档位实测由监理在
 * Gate 复测——这里的 performance.now() 只做「远低于预算」的量级哨兵，不得转写为真机指标。
 */

import { describe, expect, it } from 'vitest';
import type { ContentItem } from '../../edge/src/types/api';
import type { WatchHistoryRow } from '../../src/core/storage/storage-domains';
import {
  AI_QUOTA,
  BLOCK_PATTERN,
  EXPLORE_QUOTA,
  HOT_QUOTA,
  PREFERENCE_HALF_LIFE_SECONDS,
  WEAVE_BLOCK_SIZE,
  genrePreference,
  weave,
  type BadgeKind,
  type GenreOf
} from '../../src/core/recommendation';

const item = (id: string, overrides: Partial<ContentItem> = {}): ContentItem => ({
  id, channelId: 'drama', title: `剧目${id}`, category: '都市', isPrivate: false, ...overrides
});
const ids = (entries: readonly ContentItem[]): string[] => entries.map((entry) => entry.id);
const kindsOf = (badges: ReadonlyMap<string, BadgeKind>): BadgeKind[] => [...badges.values()];
const everyGenre = (): string | undefined => '战神';
const noGenre = (): string | undefined => undefined;
const sequence = (count: number, prefix: string): string[] =>
  Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(2, '0')}`);

/** 造一条历史行：默认「3 集 / 600 秒 / 片长 1000 秒」→ 原始分 3×2 + 10×0.5 = 11，无划走惩罚。 */
function row(overrides: Partial<WatchHistoryRow> = {}): WatchHistoryRow {
  return {
    content_id: 'c-1', title: '剧目', cover_url: null, last_episode_id: 3, last_episode_number: 3,
    position_seconds: 600, duration_seconds: 1000, total_episodes: 40, updated_at: 1_000_000_000, ...overrides
  };
}

/** 一整块 20 条：c-01…c-07 AI、c-08…c-14 热门、c-15…c-20 普通（题材一致，故轨道只由布尔位决定）。 */
function fullBlock(): ContentItem[] {
  return sequence(WEAVE_BLOCK_SIZE, 'c').map((id, index) => item(id, {
    isAi: index < AI_QUOTA ? true : undefined,
    isHot: index >= AI_QUOTA && index < AI_QUOTA + HOT_QUOTA ? true : undefined
  }));
}

describe('AC-28 本地兴趣画像：7 天半衰期打分（§1.8.2）', () => {
  it('同一张历史行在 Δt=0 / 7 天 / 14 天上的得分严格为原值、半值、四分之一', () => {
    const base = 1_000_000_000;
    const fresh = genrePreference([row()], base, everyGenre);
    const half = genrePreference([row()], base + PREFERENCE_HALF_LIFE_SECONDS, everyGenre);
    const quarter = genrePreference([row()], base + 2 * PREFERENCE_HALF_LIFE_SECONDS, everyGenre);

    expect(PREFERENCE_HALF_LIFE_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(fresh['战神']).toBeCloseTo(11, 10);
    expect(half['战神']).toBeCloseTo(5.5, 10);
    expect(quarter['战神']).toBeCloseTo(2.75, 10);
    expect(half['战神'] / fresh['战神']).toBeCloseTo(0.5, 10);
  });

  it('多行按题材分别累加；查不到题材的行整条不计，绝不拿默认题材凑分', () => {
    const genreOf: GenreOf = (contentId) => (contentId === 'c-1' ? '战神' : contentId === 'c-2' ? '科幻' : undefined);
    const scores = genrePreference([row({ content_id: 'c-1' }), row({ content_id: 'c-2' }), row({ content_id: 'c-9' })], 1_000_000_000, genreOf);

    expect(Object.keys(scores).sort()).toEqual(['战神', '科幻']);
    expect(scores['战神']).toBeCloseTo(11, 10);
    expect(genrePreference([row()], 1_000_000_000, noGenre)).toEqual({});
  });

  it('划走惩罚只在进度 <20% 时计 1 分；duration_seconds ≤ 0 视为无法判定，既不惩罚也不除零', () => {
    const penalised = genrePreference([row({ position_seconds: 100, duration_seconds: 1000, last_episode_number: 1 })], 1_000_000_000, everyGenre);
    const spared = genrePreference([row({ position_seconds: 0, duration_seconds: 0 })], 1_000_000_000, everyGenre);

    expect(penalised['战神']).toBeCloseTo(1 * 2 + (100 / 60) * 0.5 - 1, 10);
    expect(spared['战神']).toBeCloseTo(3 * 2, 10);
    expect(Number.isFinite(spared['战神'])).toBe(true);
  });

  it('时钟往前漂移（updated_at 晚于 now）不把权重放大，Δt 夹到 0', () => {
    const scores = genrePreference([row({ updated_at: 2_000_000_000 })], 1_000_000_000, everyGenre);
    expect(scores['战神']).toBeCloseTo(11, 10);
  });
});

describe('AC-28 三轨互斥编织与 20 条块结构（§1.8.3 / §1.8.4）', () => {
  it('块内序列就是 [A,H,E]×6 + [A,H]，且三轨配额常量合计 20', () => {
    expect(BLOCK_PATTERN).toHaveLength(WEAVE_BLOCK_SIZE);
    expect(BLOCK_PATTERN.filter((slot) => slot === 'A')).toHaveLength(7);
    expect(BLOCK_PATTERN.filter((slot) => slot === 'H')).toHaveLength(7);
    expect(BLOCK_PATTERN.filter((slot) => slot === 'E')).toHaveLength(6);
    expect(AI_QUOTA + HOT_QUOTA + EXPLORE_QUOTA).toBe(WEAVE_BLOCK_SIZE);
  });

  it('满块严格 7 AI / 7 热门 / 6 探索：逐槽布尔位与槽位轨道一致，零条蒸发', () => {
    const block = fullBlock();
    const result = weave(block, {}, { genreOf: everyGenre });

    expect(result.items).toHaveLength(WEAVE_BLOCK_SIZE);
    expect(result.blocks).toBe(1);
    expect(result.backfill).toBe(0);
    expect(new Set(ids(result.items)).size).toBe(WEAVE_BLOCK_SIZE);
    expect(ids(result.items).sort()).toEqual(ids(block).sort());
    BLOCK_PATTERN.forEach((slot, index) => {
      const entry = result.items[index];
      if (slot === 'A') expect(entry.isAi).toBe(true);
      if (slot === 'H') expect(entry.isHot).toBe(true);
      if (slot === 'E') { expect(entry.isAi).not.toBe(true); expect(entry.isHot).not.toBe(true); }
    });
    expect(kindsOf(result.badges).filter((kind) => kind === 'ai')).toHaveLength(7);
    expect(kindsOf(result.badges).filter((kind) => kind === 'hot')).toHaveLength(7);
  });

  it('三轨严格互斥：同一条目不重复出现，身兼双标也只被一条轨取走一次', () => {
    const both = sequence(20, 'c').map((id) => item(id, { isAi: true, isHot: true }));
    const result = weave(both, {}, { genreOf: everyGenre });
    const overlap = weave([...fullBlock(), item('c-01'), item('c-02')], {}, { genreOf: everyGenre });

    expect(result.items).toHaveLength(20);
    expect(new Set(ids(result.items)).size).toBe(20);
    // 入参自带重复 id（翻页游标重叠）时同样去重：展示层绝不出现两张一样的海报。
    expect(overlap.items).toHaveLength(20);
    expect(new Set(ids(overlap.items)).size).toBe(20);
    expect(overlap.hidden).toBe(0);
  });

  it('A 轨候选不足时由探索轨补齐并显式计数，满块仍恒为 20 条（禁止静默少渲染）', () => {
    const scarce = sequence(20, 'c').map((id, index) => item(id, {
      isAi: index < 2 ? true : undefined,
      isHot: index >= 14 && index < 17 ? true : undefined
    }));
    const result = weave(scarce, { 战神: 3 }, { genreOf: everyGenre });
    const kinds = kindsOf(result.badges);

    expect(result.items).toHaveLength(WEAVE_BLOCK_SIZE);
    expect(new Set(ids(result.items)).size).toBe(WEAVE_BLOCK_SIZE);
    expect(result.backfill).toBe(AI_QUOTA - 2);
    expect(result.items.filter((entry) => entry.isAi === true)).toHaveLength(2);
    expect(kinds.filter((kind) => kind === 'ai')).toHaveLength(2);
    expect(kinds.filter((kind) => kind === 'hot')).toHaveLength(3);
  });

  it('私密内容一律不进展示层：isPrivate 与 channelId=private 都走同一个存储域闸门', () => {
    const mixed = [...fullBlock().slice(0, 18), item('z-1', { isPrivate: true }), item('z-2', { channelId: 'private', isPrivate: false })];
    const result = weave(mixed, {}, { genreOf: everyGenre });

    expect(result.hidden).toBe(2);
    expect(result.blocks).toBe(1);
    expect(result.items).toHaveLength(18);
    expect(ids(result.items)).not.toContain('z-1');
    expect(ids(result.items)).not.toContain('z-2');
  });

  it('稳定序基线：网络返回顺序被打乱后，编织结果与乱序输入完全一致（§1.8.3 步骤 0）', () => {
    const ordered = weave(fullBlock(), {}, { genreOf: everyGenre });
    const shuffled = weave([...fullBlock()].reverse(), {}, { genreOf: everyGenre });
    expect(ids(shuffled.items)).toEqual(ids(ordered.items));
  });

  it('A 轨按偏好分降序、C 轨按偏好分升序（反信息茧房），末级键为 id 稳定序', () => {
    const genres: Record<string, string> = { 'c-01': '战神', 'c-02': '战神', 'c-15': '科幻', 'c-16': '科幻' };
    const pool = sequence(20, 'c').map((id, index) => item(id, {
      category: genres[id] ?? '都市',
      isAi: index < AI_QUOTA ? true : undefined,
      isHot: index >= AI_QUOTA && index < AI_QUOTA + HOT_QUOTA ? true : undefined
    }));
    const result = weave(pool, { 战神: 9, 都市: 5, 科幻: 1 }, { genreOf: (id) => genres[id] ?? '都市' });
    const aiOrder = result.items.filter((entry) => entry.isAi === true).map((entry) => entry.category);
    const exploreOrder = BLOCK_PATTERN
      .map((slot, index) => (slot === 'E' ? result.items[index].category : undefined))
      .filter((category): category is string => category !== undefined);

    expect(aiOrder.slice(0, 2)).toEqual(['战神', '战神']);
    expect(exploreOrder.slice(0, 2)).toEqual(['科幻', '科幻']);
    expect(exploreOrder).toHaveLength(EXPLORE_QUOTA);
  });
});

describe('AC-28 固化块零重排 / 尾块可重排（§1.8.4 累积集合切块）', () => {
  it('加载更多只追加：新数据到达后第 0 块逐条不变，块数随 20 的边界递增', () => {
    const first = [...fullBlock(), ...sequence(5, 'd').map((id) => item(id))];
    const before = weave(first, {}, { genreOf: everyGenre });
    const after = weave([...first, ...sequence(10, 'd').slice(5).map((id) => item(id))], {}, { genreOf: everyGenre });
    const grown = weave([...first, ...sequence(25, 'd').slice(5).map((id) => item(id))], {}, { genreOf: everyGenre });

    expect(before.blocks).toBe(2);
    expect(before.items).toHaveLength(25);
    expect(after.blocks).toBe(2);
    expect(after.items).toHaveLength(30);
    expect(grown.blocks).toBe(3);
    expect(grown.items).toHaveLength(45);
    expect(ids(after.items).slice(0, 20)).toEqual(ids(before.items).slice(0, 20));
    // 只有「凑满 20 条」的块才固化：第 1 块在 25/30 条时仍是尾块（会重排），故这里只硬比对第 0 块。
    expect(ids(grown.items).slice(0, 20)).toEqual(ids(before.items).slice(0, 20));
    expect(new Set(ids(grown.items)).size).toBe(45);
  });

  it('尾块允许重排：新到的 AI 精品抢到尾部块首槽，但不波及已固化块', () => {
    const tail = [...fullBlock(), item('d-1')];
    const before = weave(tail, {}, { genreOf: everyGenre });
    const after = weave([...tail, item('d-2', { isAi: true })], {}, { genreOf: everyGenre });

    expect(ids(before.items).slice(20)).toEqual(['d-1']);
    expect(ids(after.items).slice(20)).toEqual(['d-2', 'd-1']);
    expect(ids(after.items).slice(0, 20)).toEqual(ids(before.items).slice(0, 20));
  });
});

describe('AC-28 字段缺失降级（§1.8.1）与端侧耗时量级', () => {
  it('isAi / isHot 全缺且无本地画像：20 条节奏不变，且一个角标都不贴', () => {
    const plain = sequence(45, 'c').map((id) => item(id));
    const result = weave(plain, {}, { genreOf: everyGenre });

    expect(result.blocks).toBe(3);
    expect(result.items).toHaveLength(45);
    expect(ids(result.items).slice(0, 20)).toEqual(ids(result.items).slice(0, 20).sort());
    expect(result.badges.size).toBe(0);
    // 两个满块的 7 个 A 槽 + 尾块的 2 个 A 槽全部走 §1.8.1 降级供给，缺口被显式计数而非静默少渲染。
    expect(result.backfill).toBe(16);
  });

  it('字段缺失但有本地画像：只可能出现【推荐】，绝不出现【AI精品】/【热门】', () => {
    const badges = weave(sequence(20, 'c').map((id) => item(id)), { 战神: 4 }, { genreOf: everyGenre }).badges;
    const kinds = kindsOf(badges);

    expect(kinds).toHaveLength(EXPLORE_QUOTA);
    expect(kinds.every((kind) => kind === 'recommend')).toBe(true);
  });

  it('20 条块的编织远低于 2ms 预算（端侧量级哨兵，不是真机指标）', () => {
    const block = fullBlock();
    weave(block, {}, { genreOf: everyGenre }); // 预热，排除首次调用的编译噪声
    let best = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const started = performance.now();
      weave(block, { 战神: 4 }, { genreOf: everyGenre });
      best = Math.min(best, performance.now() - started);
    }

    expect(best).toBeLessThan(2);
  });
});
