// @vitest-environment jsdom
/**
 * HP-04 综合首页导航与候选覆盖（HOME-PLAYER-REPAIR-SPEC-AND-PLAN §HP-04 / §3.2 末条，PRD §3.1.1，UIUX §5.1）。
 *
 * 只证**行为**，不证视觉：jsdom 没有布局引擎，任何"看起来对不对"的结论一律标待浏览器/真机验证。
 * 配额、偏差与尾页稳定性由 `70-home-quota-page.test.ts` 接手，引擎级定量断言在 `69-home-quota.test.ts`。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { COMPOSITE_HOME_ID } from '../../src/views/home-nav';
import { capsules, flush, item, must, pool, row, setup, tabIds } from './home-composite-harness';

afterEach(() => document.body.replaceChildren());

describe('HP-04 综合首页导航与候选覆盖', () => {
  it('HP-04 启动默认停在综合首页，顶部公开顺序为首页＋云端 order 驱动的四个真实频道', async () => {
    const h = setup();
    await h.view.mount();
    expect(tabIds(h.root)).toEqual([COMPOSITE_HOME_ID, 'drama', 'movie', 'documentary', 'anime']);
    expect(h.root.querySelector<HTMLElement>('.channel-tab[aria-current="true"]')?.dataset.navId).toBe(COMPOSITE_HOME_ID);
    expect(h.root.querySelectorAll('.channel-tab[aria-current="true"]')).toHaveLength(1);
    expect(h.root.querySelector('.home-section-header')).toBeNull();   // AC-25：区块头不得借首页复活
    h.view.destroy();
  });

  it('HP-04 频道顺序由数据驱动：云端换 order、改名与追加频道时端侧不夹带本地词表', async () => {
    const h = setup({
      channels: [
        { id: 'anime', name: '番剧视界', order: 1, requiresTier: [], categories: [] },
        { id: 'documentary', name: '纪录视界', order: 2, requiresTier: [], categories: [] },
        { id: 'movie', name: '电影视界', order: 3, requiresTier: [], categories: [] },
        { id: 'drama', name: '短剧视界', order: 4, requiresTier: [], categories: [] }
      ]
    });
    await h.view.mount();
    expect(tabIds(h.root)).toEqual([COMPOSITE_HOME_ID, 'anime', 'documentary', 'movie', 'drama']);
    expect(Array.from(h.root.querySelectorAll('.channel-tab')).map((tab) => tab.textContent))
      .toEqual(['首页', '番剧视界', '纪录视界', '电影视界', '短剧视界']);
    h.view.destroy();
  });

  it('HP-04 综合首页不发任何伪频道请求：无 home/mix channelId、无 /api/channels/home', async () => {
    const h = setup({ noSnapshot: true });
    await h.view.mount();
    expect(h.requested.filter((entry) => /home|mix|composite/.test(entry))).toEqual([]);
    expect(h.root.innerHTML).not.toContain('/api/channels/home');
    h.view.destroy();
  });

  it('HP-04 首页候选跨四个公开频道读取完整候选池，而不是当前频道第一页', async () => {
    const h = setup();
    await h.view.mount();
    expect(h.ids()).toHaveLength(60);
    expect([...new Set(h.ids().map((id) => h.of(id)?.channelId))].sort()).toEqual(['anime', 'documentary', 'drama', 'movie']);
    h.view.destroy();
  });

  it('HP-04 私密内容 100% 不进首页、公开推荐与画像', async () => {
    const leaked = [...pool(), item('p-1', 'private', { isPrivate: true, title: '不应出现', category: '私密题材' }),
      item('p-2', 'drama', { isPrivate: true }), item('p-3', 'private', { isPrivate: false })];
    const h = setup({ items: leaked, rows: [row('p-1')] });
    await h.view.mount();
    expect(h.ids().some((id) => id.startsWith('p-'))).toBe(false);
    expect(h.root.textContent).not.toContain('不应出现');
    expect(h.requested.filter((entry) => entry.includes('private'))).toEqual([]);   // 候选范围连读都不读私密频道
    const record = must(h.record());
    expect(record.excluded.private).toBe(1);                            // 挂在公开频道里的 isPrivate 仍被闸门摘除
    expect(record.profile).toBe('none');                                // 私密历史一条都不算画像
    h.view.destroy();
  });

  it('HP-04 切到真实频道仍走真实身份与真实 categories，首页配额不套频道目录', async () => {
    const h = setup();
    await h.view.mount();
    (h.root.querySelector('[data-nav-id="drama"]') as HTMLButtonElement).click();
    await flush();
    expect(h.requested).toContain('catalog:drama:1');
    expect(capsules(h.root)).toEqual(['全部', '都市', '战神']);
    expect(h.record()).toBeNull();                                      // 配额只作用于综合首页
    expect(h.ids().length).toBeGreaterThan(0);
    h.view.destroy();
  });

  it('HP-04 首页二级导航不虚构来源分类，只有「全部」', async () => {
    const h = setup();
    await h.view.mount();
    expect(capsules(h.root)).toEqual(['全部']);
    h.view.destroy();
  });

  it('HP-04 首页与频道目录往返不残留：回来时仍是首页身份，切走时配额记录归零', async () => {
    const h = setup();
    await h.view.mount();
    const first = h.ids();
    (h.root.querySelector('[data-nav-id="movie"]') as HTMLButtonElement).click();
    await flush();
    expect(h.record()).toBeNull();
    (h.root.querySelector(`[data-nav-id="${COMPOSITE_HOME_ID}"]`) as HTMLButtonElement).click();
    await flush();
    expect(h.root.querySelector<HTMLElement>('.channel-tab[aria-current="true"]')?.dataset.navId).toBe(COMPOSITE_HOME_ID);
    expect(h.ids()).toEqual(first);                                     // 同修订同候选：回来看见的还是同一轮
    h.view.destroy();
  });
});
