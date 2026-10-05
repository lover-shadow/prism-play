// @vitest-environment jsdom
/**
 * HP-05 60 作品配额页在综合首页里的实际行为（HOME-PLAYER-REPAIR-SPEC-AND-PLAN §HP-05 / §3.2 / §2.3）。
 *
 * 与 `69-home-quota.test.ts` 的分工：那份证纯函数配额账，这份证"首页真的按这份账出片、并且如实登记"。
 * 只证行为不证视觉：jsdom 无布局引擎，卡片密度、顺序观感一律待浏览器/真机验证。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { ContentItem } from '../../edge/src/types/api';
import { flush, item, must, pool, row, setup, track } from './home-composite-harness';

afterEach(() => document.body.replaceChildren());

describe('HP-05 配额页、诚实偏差与同轮冻结', () => {
  it('HP-05 无口碑证据时真人轨如实为 0，缺额按 §2.3 最小回退补给 AI 轨，其余轨严守 20/12/6/18', async () => {
    const h = setup();
    await h.view.mount();
    const record = must(h.record());
    expect(h.ids()).toHaveLength(60);
    expect(record.pageSize).toBe(60);
    expect(record.allocation.map((entry) => entry.requested)).toEqual([20, 4, 12, 6, 18]);
    expect(record.evidence.reputation).toBe('insufficient');            // 仓库无口碑字段，绝不宣称口碑合格
    expect(track(record, 'live')?.actual).toBe(0);
    expect(track(record, 'live')?.deviation).toBe(4);
    expect(track(record, 'live')?.backfilled).toBe(4);
    expect(track(record, 'live')?.basis).toMatch(/口碑证据不足/);
    expect(track(record, 'ai')?.actual).toBe(20);
    expect(track(record, 'movie')?.actual).toBe(12);
    expect(track(record, 'other')?.actual).toBe(6);
    expect(track(record, 'preference')?.actual).toBe(18);
    expect(new Set(h.ids()).size).toBe(60);                             // 全局去重，同页零重复
    h.view.destroy();
  });

  it('HP-05 注入可信口碑证据后真人 4 席坐实，偏好轨不反向挤占预留的 24 席短剧', async () => {
    const qualified = (entry: ContentItem) => (entry.channelId === 'drama' && entry.isAi !== true && Number(entry.hitsTotal) > 850
      ? { evidence: 'qualified' as const, basis: '夹具注入的可信口碑接缝' }
      : { evidence: 'insufficient' as const, basis: '夹具未给口碑证据' });
    const h = setup({ reputationOf: qualified });
    await h.view.mount();
    const record = must(h.record());
    expect(track(record, 'live')?.actual).toBe(4);
    expect(track(record, 'live')?.deviation).toBe(0);
    expect(record.evidence.reputation).toBe('qualified');
    expect(h.ids().filter((id) => h.of(id)?.channelId === 'drama').length).toBeGreaterThanOrEqual(24);
    h.view.destroy();
  });

  it('HP-05 纪录片＋动漫 6 席兼顾两个频道，不让单一频道长期独占', async () => {
    const h = setup();
    await h.view.mount();
    const channels = h.ids().map((id) => h.of(id)?.channelId);
    expect(channels.filter((c) => c === 'documentary').length).toBeGreaterThanOrEqual(1);
    expect(channels.filter((c) => c === 'anime').length).toBeGreaterThanOrEqual(1);
    expect(must(h.record()).allocation.find((entry) => entry.track === 'other')?.basis).toContain('兼顾');
    h.view.destroy();
  });

  it('HP-05 零画像：偏好席走来源内热度与多样性探索，状态如实记 profile 无效', async () => {
    const h = setup();
    await h.view.mount();
    expect(must(h.record()).profile).toBe('none');
    expect(h.ids().filter((id) => h.of(id)?.isAi === true)).toHaveLength(24);   // 20 AI ＋真人缺额回补的 4 席
    h.view.destroy();
  });

  it('HP-05 有效画像参与选择并如实登记 valid', async () => {
    const h = setup({ rows: [row('mv-20')] });
    await h.view.mount();
    expect(must(h.record()).profile).toBe('valid');
    expect(h.ids()).toHaveLength(60);
    h.view.destroy();
  });

  it('HP-05 尾页不足 60 时不重复作品凑数', async () => {
    const h = setup({ items: pool().slice(0, 45) });
    await h.view.mount();
    expect(h.ids()).toHaveLength(45);
    expect(new Set(h.ids()).size).toBe(45);
    const record = must(h.record());
    expect(record.candidates).toBe(45);
    expect(record.pages).toBe(1);
    expect(record.shortPages).toBe(1);
    h.view.destroy();
  });

  it('HP-05 同轮冻结：loadMore 只追加尾块，不回排已展示条目、不跨页重复、尾页不再变', async () => {
    const h = setup();
    await h.view.mount();
    const before = h.ids();
    expect(before).toHaveLength(60);
    h.view.loadMore();
    await flush();
    const after = h.ids();
    expect(after.slice(0, 60)).toEqual(before);                          // 前页一字不动
    expect(after).toHaveLength(105);                                      // 候选耗尽即如实收口
    expect(new Set(after).size).toBe(105);
    h.view.loadMore();
    await flush();
    expect(h.ids()).toEqual(after);
    h.view.destroy();
  });

  it('HP-05 背景同步到同 revision 不重排、不把已追加的列表塌陷回首页；HP-06 显式刷新只开新轮次且不洗牌', async () => {
    const h = setup();
    await h.view.mount();
    h.view.loadMore();
    await flush();
    const before = h.ids();
    expect(before).toHaveLength(105);                                     // 首页 + 一个尾块都已追加

    await h.view.syncRecommendation();
    expect(h.ids()).toEqual(before);                                      // 同修订：一个字都不动
    // B5 接线后 main 的后台同步回调走 `syncRecommendation()`（上面那条断言就是它的证据）；
    // `refresh()` 从此只代表用户显式刷新：开**新的推荐轮次**并交出新一轮首页，而不是重画旧列表。
    await h.view.refresh();
    const record = must(h.record());
    expect(record.round).toBe(2);                                          // 轮次确实推进了一轮
    expect(h.ids()).toEqual(before.slice(0, 60));                          // 同候选、同修订、零真实曝光＝同序列：不随机洗牌
    h.view.loadMore();
    await flush();
    expect(h.ids()).toEqual(before);                                       // 新轮次仍能按页把同一个完整序列续上，不跨页重复
    expect(record.revision).toBe(42);
    expect(record.round).not.toBe(record.revision);                        // 推荐轮次 ≠ 云 revision
    h.view.destroy();
  });

  it('HP-05 换代修订不与当前页混代：已展示页保持冻结，新修订只喂下一次显式刷新', async () => {
    const state = { revision: 42, partial: false };
    const h = setup({ state });
    await h.view.mount();
    const before = h.ids();
    expect(must(h.record()).revision).toBe(42);

    state.revision = 43;                                                  // 后台同步把公开目录推进了一代
    await h.view.syncRecommendation();
    expect(h.ids()).toEqual(before);                                      // 本页仍是同一轮的连续页面，绝不混代重排
    expect(must(h.record()).revision).toBe(42);
    expect(must(h.record()).coverage).toBe('full');
    h.view.destroy();
  });

  it('HP-05 本机快照不完整时覆盖度如实记 partial，不夸口成完整候选池', async () => {
    const h = setup({ state: { revision: 42, partial: true } });
    await h.view.mount();
    expect(must(h.record()).coverage).toBe('partial');
    h.view.destroy();
  });

  it('HP-05 无本地快照时如实降级为逐公开频道读候选，覆盖度记 partial', async () => {
    const h = setup({ noSnapshot: true });
    await h.view.mount();
    expect(must(h.record()).coverage).toBe('partial');
    expect(h.ids().length).toBeGreaterThan(0);
    expect(h.requested.length).toBeGreaterThan(1);                        // 跨频道读取，不是单频道第一页
    h.view.destroy();
  });

  it('HP-05 分配前剔除撤片与重复 workId，同名不同剧不互相删除', async () => {
    const dup = [...pool().slice(0, 20), item('dup-1', 'movie', { title: '同名不同剧' }),
      item('dup-2', 'anime', { title: '同名不同剧' }), item('off-1', 'drama', { enabled: false })];
    const h = setup({ items: dup });
    await h.view.mount();
    expect(must(h.record()).excluded.withdrawn).toBe(1);
    expect(h.ids().filter((id) => id === 'dup-1' || id === 'dup-2')).toHaveLength(2);
    expect(h.ids()).not.toContain('off-1');
    h.view.destroy();
  });

  it('HP-05 候选池为空时如实空态，不编造 60 条', async () => {
    const h = setup({ items: [] });
    await h.view.mount();
    expect(h.ids()).toHaveLength(0);
    expect(h.root.querySelector('.state-view--empty')).not.toBeNull();
    h.view.destroy();
  });
});
