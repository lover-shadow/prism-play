/**
 * HP-05 综合首页配额选择器单测（HOME-PLAYER-REPAIR-SPEC-AND-PLAN §HP-05 / §3.2 / §2.3）。
 *
 * 只证逻辑：纯函数、同步、零 I/O，同输入必同输出。首页的**独占轨配额**与旧 AC-28 的 20 条 7/7/6
 * 块编排是两台互不套用的机器——后者继续服务频道目录，本文件绝不把 20/4/12/6/18 说成频道目录口径。
 */

import { describe, expect, it } from 'vitest';
import type { ChannelId, ContentItem } from '../../edge/src/types/api';
import {
  HOME_PAGE_TARGET, HOME_TRACKS, HOME_TRACK_TARGETS, createHomeRound,
  type HomeRecommendationInput, type HomeTrackAllocation
} from '../../src/core/home-recommendation';

const mk = (id: string, channelId: ChannelId = 'drama', overrides: Partial<ContentItem> = {}): ContentItem =>
  ({ id, channelId, title: `剧目${id}`, category: '都市', isPrivate: false, ...overrides });

const seq = (count: number, prefix: string, channelId: ChannelId, overrides: (index: number) => Partial<ContentItem> = () => ({})): ContentItem[] =>
  Array.from({ length: count }, (_, index) => mk(`${prefix}-${String(index + 1).padStart(2, '0')}`, channelId, overrides(index)));

const qualified = (): { evidence: 'qualified'; basis: string } => ({ evidence: 'qualified', basis: '夹具注入的可信口碑与量纲证据' });
const ids = (entries: readonly ContentItem[]): string[] => entries.map((entry) => entry.id);

/** 供应充足的完整候选池：AI 24、真人 8、电影 14、纪录片 5、动漫 5、其余短剧 20，共 76 部。 */
function richPool(): ContentItem[] {
  return [
    ...seq(24, 'ai', 'drama', () => ({ isAi: true, hitsTotal: 500 })),
    ...seq(8, 'lv', 'drama', (index) => ({ hitsTotal: 900 - index })),
    ...seq(14, 'mv', 'movie', (index) => ({ category: '科幻', hitsTotal: 400 - index })),
    ...seq(5, 'dc', 'documentary', (index) => ({ category: '自然', hitsTotal: 300 - index })),
    ...seq(5, 'an', 'anime', (index) => ({ category: '番剧', hitsTotal: 200 - index })),
    ...seq(20, 'rd', 'drama', (index) => ({ hitsTotal: 100 - index, category: '逆袭' }))
  ];
}

const run = (over: Partial<HomeRecommendationInput> = {}) => createHomeRound({
  candidates: richPool(), revision: 7, round: 1, coverage: 'full', scores: {}, ...over
});
const alloc = (allocation: readonly HomeTrackAllocation[], track: string): HomeTrackAllocation => {
  const found = allocation.find((entry) => entry.track === track);
  expect(found, `配额记录必须包含 ${track} 轨`).toBeDefined();
  return found as HomeTrackAllocation;
};

describe('HP-05 配额常量与作用范围', () => {
  it('目标轨 20/4/12/6/18 合计 60，比例即短剧24:电影12:其他6:偏好18＝4:2:1:3', () => {
    expect(HOME_TRACKS).toHaveLength(5);
    expect(Object.values(HOME_TRACK_TARGETS).reduce((sum, n) => sum + n, 0)).toBe(HOME_PAGE_TARGET);
    expect(HOME_TRACK_TARGETS.ai + HOME_TRACK_TARGETS.live).toBe(24);
    expect(HOME_PAGE_TARGET).toBe(60);
  });

  it('完整页严格 20/4/12/6/18 且零重复；尾页不足 60 也不拿重复作品凑数', () => {
    const round = run({ reputationOf: () => qualified() });
    const first = round.page(0);
    expect(first.items).toHaveLength(60);
    expect(new Set(ids(first.items)).size).toBe(60);
    expect(HOME_TRACKS.map((track) => alloc(round.record.allocation, track).actual)).toEqual([20, 4, 12, 6, 18]);
    expect(first.short).toBe(false);
    const tail = round.page(1);
    expect(tail.items).toHaveLength(16);
    expect(tail.short).toBe(true);
    expect(new Set([...ids(first.items), ...ids(tail.items)]).size).toBe(76);
    expect(round.record.pages).toBe(2);
    expect(round.record.shortPages).toBe(1);
  });

  it('候选池小于 60 时只出一页，条数如实少于目标', () => {
    const small = [...seq(3, 'ai', 'drama', () => ({ isAi: true })), ...seq(2, 'mv', 'movie')];
    const round = run({ candidates: small });
    expect(round.record.pages).toBe(1);
    expect(round.page(0).items).toHaveLength(5);
    expect(round.page(1).items).toHaveLength(0);
  });
});

describe('HP-05 证据闸门：不猜类型、不猜口碑', () => {
  it('AI 轨只认 isAi === true：片名带 AI、字段缺失的候选一律不进 AI 轨', () => {
    const pool = [...seq(20, 'ai', 'drama', () => ({ isAi: true })),
      mk('guess-1', 'drama', { title: 'AI 生成的传说' }), mk('guess-2', 'drama', { isAi: false }), ...seq(20, 'rd', 'drama')];
    const round = run({ candidates: pool });
    const first = ids(round.page(0).items);
    expect(first.filter((id) => id.startsWith('ai-'))).toHaveLength(20);
    expect(round.record.evidence.aiField).toBe('present');
    expect(pool.filter((entry) => entry.isAi === true)).toHaveLength(20);
  });

  it('isAi 字段全缺时如实记 absent，AI 轨一席都不发', () => {
    const pool = [...seq(30, 'rd', 'drama'), ...seq(20, 'mv', 'movie')];
    const round = run({ candidates: pool });
    expect(round.record.evidence.aiField).toBe('absent');
    expect(alloc(round.record.allocation, 'ai').actual).toBe(0);
    expect(alloc(round.record.allocation, 'ai').deviation).toBe(20);
  });

  it('仓库无口碑接缝时真人轨 actual 0、deviation 4，缺额按 §2.3 最小回退补给 AI 轨', () => {
    const round = run();
    const live = alloc(round.record.allocation, 'live');
    expect(round.record.evidence.reputation).toBe('insufficient');
    expect(live.actual).toBe(0);
    expect(live.deviation).toBe(4);
    expect(live.backfilled).toBe(4);
    expect(live.basis).toMatch(/口碑证据不足/);
    const first = round.page(0).items;
    expect(first.filter((entry) => entry.isAi === true)).toHaveLength(24);
  });

  it('注入可信口碑后真人 4 席坐实，部分证据只记 mixed 不假装 4 席全优', () => {
    const all = run({ reputationOf: () => qualified() });
    expect(alloc(all.record.allocation, 'live').actual).toBe(4);
    expect(alloc(all.record.allocation, 'live').deviation).toBe(0);
    expect(all.record.evidence.reputation).toBe('qualified');
    const partial = run({ reputationOf: (item) => (Number(item.hitsTotal) > 897 ? qualified() : { evidence: 'insufficient', basis: '夹具只给三条口碑证据' }) });
    expect(partial.record.evidence.reputation).toBe('mixed');
    expect(alloc(partial.record.allocation, 'live').actual).toBeGreaterThan(0);
    expect(alloc(partial.record.allocation, 'live').actual).toBeLessThan(4);
  });

  it('isHot 与 hitsTotal 不得冒充口碑：只有 isHot/高热度而无口碑接缝时真人轨仍为 0', () => {
    const hot = [...seq(8, 'lv', 'drama', () => ({ isHot: true, hitsTotal: 999_999 })), ...richPool()];
    const round = run({ candidates: hot });
    expect(alloc(round.record.allocation, 'live').actual).toBe(0);
    expect(round.record.evidence.reputation).toBe('insufficient');
  });
});

describe('HP-05 全局去重、撤片与同名异剧', () => {
  it('分配前统一剔除私密、撤片与重复 workId，并逐条计数', () => {
    const pool = [...seq(24, 'ai', 'drama', () => ({ isAi: true })),
      mk('p-1', 'private', { isPrivate: true }), mk('p-2', 'drama', { isPrivate: true }), mk('p-3', 'private'),
      mk('off-1', 'movie', { enabled: false }), mk('dup-1', 'anime'), mk('dup-1', 'anime'), ...seq(20, 'mv', 'movie')];
    const round = run({ candidates: pool });
    expect(round.record.excluded).toEqual({ private: 3, withdrawn: 1, duplicate: 1 });
    const all = [...ids(round.page(0).items), ...ids(round.page(1).items)];
    expect(all).not.toContain('p-1');
    expect(all).not.toContain('off-1');
    expect(all.filter((id) => id === 'dup-1')).toHaveLength(1);
  });

  it('同名不同剧不互相删除：标题相同、workId 不同的两部作品都能入选', () => {
    const pool = [...seq(20, 'ai', 'drama', () => ({ isAi: true, title: '同名不同剧' })),
      ...seq(20, 'mv', 'movie', () => ({ title: '同名不同剧' })), ...seq(30, 'rd', 'drama', () => ({ title: '同名不同剧' }))];
    const round = run({ candidates: pool });
    const shown = ids(round.page(0).items);
    expect(shown.filter((id) => id.startsWith('ai-'))).toHaveLength(20);
    expect(shown.filter((id) => id.startsWith('mv-')).length).toBeGreaterThan(0);
    expect(new Set(shown).size).toBe(60);
  });

  it('跨轨同一作品只占一次，偏好轨只从剩余候选取，绝不压低已预留的 24 席短剧', () => {
    const pool = [...seq(20, 'ai', 'drama', () => ({ isAi: true })), ...seq(4, 'lv', 'drama'),
      ...seq(40, 'mv', 'movie'), ...seq(20, 'rd', 'drama')];
    const round = run({ candidates: pool, reputationOf: () => qualified() });
    const page = round.page(0);
    expect(new Set(ids(page.items)).size).toBe(60);
    expect(alloc(round.record.allocation, 'ai').actual).toBe(20);
    expect(alloc(round.record.allocation, 'live').actual).toBe(4);
    const shortSeats = page.items.filter((entry) => page.trackOf.get(entry.id) === 'ai' || page.trackOf.get(entry.id) === 'live');
    expect(shortSeats).toHaveLength(24);
    expect(shortSeats.every((entry) => entry.channelId === 'drama')).toBe(true);
    const movieSeats = page.items.filter((entry) => page.trackOf.get(entry.id) === 'movie');
    expect(movieSeats).toHaveLength(12);
    expect(movieSeats.some((entry) => entry.channelId === 'drama')).toBe(false);         // 电影轨不越界取短剧供给
    expect(alloc(round.record.allocation, 'other').deviation).toBe(6);                    // 无纪录/动漫供给即如实记缺额
  });
});

describe('HP-05 热度可比性：来源内分位，不比跨源绝对值', () => {
  it('电影轨只按电影频道内部排序取前 12，短剧的绝对高热不越轨抢位', () => {
    const pool = [...seq(20, 'ai', 'drama', () => ({ isAi: true, hitsTotal: 1_000_000 })),
      ...seq(20, 'mv', 'movie', (index) => ({ hitsTotal: 20 - index })), ...seq(30, 'rd', 'drama')];
    const round = run({ candidates: pool });
    const page = round.page(0);
    const movieSeats = page.items.filter((entry) => page.trackOf.get(entry.id) === 'movie');
    expect(ids(movieSeats)).toEqual(seq(20, 'mv', 'movie', (index) => ({ hitsTotal: 20 - index })).slice(0, 12).map((entry) => entry.id));
    expect(round.record.evidence.heat).toBe('within-source');
  });

  it('缺热度与真实 0 分分开对待：真实 0 仍按证据参与，缺字段落到最后', () => {
    const pool = [...seq(20, 'ai', 'drama', () => ({ isAi: true })),
      ...seq(10, 'mv', 'movie', (index) => ({ hitsTotal: 10 - index })),
      mk('zero-1', 'movie', { hitsTotal: 0 }), mk('zero-2', 'movie', { hitsTotal: 0 }),
      ...seq(10, 'none', 'movie'), ...seq(20, 'rd', 'drama')];
    const round = run({ candidates: pool });
    const page = round.page(0);
    const movieIds = ids(page.items.filter((entry) => page.trackOf.get(entry.id) === 'movie'));
    expect(movieIds).toHaveLength(12);
    expect(movieIds.some((id) => id.startsWith('none-'))).toBe(false);
    expect(movieIds.filter((id) => id.startsWith('zero-'))).toHaveLength(2);
  });
});

describe('HP-05 画像、多样性与纪录片/动漫兼顾', () => {
  it('零画像：profile 记 none，且一颗【推荐】角标都不发（不得宣称已懂偏好）', () => {
    const round = run();
    expect(round.record.profile).toBe('none');
    expect([...round.page(0).badges.values()].filter((kind) => kind === 'recommend')).toHaveLength(0);
  });

  it('有效画像：偏好轨把高分题材提到前面，且只在剩余候选里取', () => {
    const pool = [...seq(20, 'ai', 'drama', () => ({ isAi: true })), ...seq(12, 'mv', 'movie'),
      ...seq(6, 'dc', 'documentary'), ...seq(30, 'rd', 'drama', () => ({ category: '科幻' })), ...seq(10, 'zz', 'drama', () => ({ category: '都市' }))];
    const round = run({ candidates: pool, scores: { 科幻: 12 } });
    expect(round.record.profile).toBe('valid');
    const page = round.page(0);
    const preference = page.items.filter((entry) => page.trackOf.get(entry.id) === 'preference');
    expect(preference).toHaveLength(18);
    expect(preference.every((entry) => entry.category === '科幻')).toBe(true);
    expect([...page.badges.values()].filter((kind) => kind === 'recommend').length).toBeGreaterThan(0);
  });

  it('纪录片＋动漫 6 席两频道兼顾，第二页换起始频道，长期不独占', () => {
    const pool = [...seq(20, 'ai', 'drama', () => ({ isAi: true })), ...seq(12, 'mv', 'movie'),
      ...seq(14, 'dc', 'documentary'), ...seq(14, 'an', 'anime'), ...seq(60, 'rd', 'drama')];
    const round = run({ candidates: pool });
    const seats = (index: number): string[] => {
      const page = round.page(index);
      return ids(page.items.filter((entry) => page.trackOf.get(entry.id) === 'other'));
    };
    const first = seats(0);
    expect(first).toHaveLength(6);
    expect(first.filter((id) => id.startsWith('dc-'))).toHaveLength(3);
    expect(first.filter((id) => id.startsWith('an-'))).toHaveLength(3);
    expect(first[0]).toBe('dc-01');
    expect(alloc(round.record.allocation, 'other').basis).toMatch(/兼顾/);
    const second = seats(1);
    expect(second[0]).toMatch(/^an-/);                                   // 起始频道翻页轮换，长期不被单频道独占
    expect(second.filter((id) => id.startsWith('dc-')).length >= 1 && second.filter((id) => id.startsWith('an-')).length >= 1).toBe(true);
  });
});

describe('HP-05 输入记录与同轮冻结', () => {
  it('记录轮次号、内容 revision、覆盖度、证据与画像：推荐轮次与云 revision 分别命名', () => {
    const round = run({ revision: 42, round: 9, coverage: 'partial' });
    expect(round.record).toMatchObject({ round: 9, revision: 42, coverage: 'partial', pageSize: 60, candidates: 76 });
    expect(round.record.evidence).toEqual({ reputation: 'insufficient', aiField: 'present', heat: 'within-source' });
    expect(round.record.round).not.toBe(round.record.revision);
  });

  it('同轮只追加尾块：重复取同一页输入完全一致，前页不受后续页影响', () => {
    const round = run();
    const first = ids(round.page(0).items);
    expect(ids(round.page(0).items)).toEqual(first);
    const second = ids(round.page(1).items);
    expect(second).toHaveLength(16);
    expect(first.every((id) => !second.includes(id))).toBe(true);
    expect(ids(round.page(0).items)).toEqual(first);
  });

  it('空候选池如实返回零页，不编造 60 条', () => {
    const round = run({ candidates: [], coverage: 'empty' });
    expect(round.record.pages).toBe(0);
    expect(round.page(0).items).toHaveLength(0);
    expect(round.record.coverage).toBe('empty');
  });
});
