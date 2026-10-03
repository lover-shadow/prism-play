// @vitest-environment jsdom
/** home-view 续播卡与生命周期：AC-03 断点回传、历史域故障隔离、refresh 保态、A-2 搜索条、A-4 无感加载。拓扑/五态见 22-home-view。 */

import { afterEach, describe, expect, it } from 'vitest';
import { catalog, content, defaultResponder, flush, harness, historyRow, reply, seen, TOPOLOGY, resetHomeFixtures } from './home-view-harness';

afterEach(resetHomeFixtures);

describe('home-view 续播卡与生命周期', () => {
  it('有历史即渲染续播卡，点击回传整行断点（AC-03）', async () => {
    const h = harness(defaultResponder, [historyRow('c-9', { updated_at: 1 }), historyRow('c-1')]);
    await h.view.mount();
    const card = h.root.querySelector('.continue-card') as HTMLButtonElement;
    expect(card.dataset.contentId).toBe('c-1');
    expect(card.textContent ?? '').toContain('第 18 集');
    expect(card.textContent ?? '').toContain('1:42');
    expect(h.root.querySelector('.continue-progress-fill')?.getAttribute('style')).toBe('width: 76%;');

    card.click();
    expect(h.resumed.length).toBe(1);
    expect(h.resumed[0].last_episode_id).toBe(180);
  });

  it('无历史时整卡不渲染，不占首屏', async () => {
    const h = harness();
    await h.view.mount();
    expect(h.root.querySelector('.continue-card')).toBeNull();
    expect(h.root.querySelector('.home-continue-host')?.hasAttribute('hidden')).toBe(true);
  });

  it('历史域失败只让续播卡缺席，片单照常', async () => {
    const h = harness(defaultResponder, 'fail');
    await h.view.mount();
    expect(h.root.querySelector('.continue-card')).toBeNull();
    expect(h.root.querySelectorAll('.poster-card').length).toBe(2);
  });

  it('点海报回调 contentId，refresh 保留用户已选频道与「全部」分类', async () => {
    const h = harness();
    await h.view.mount();
    (h.root.querySelector('.poster-open') as HTMLButtonElement).click();
    expect(h.opened).toEqual(['c-1']);

    (h.root.querySelector('[data-channel-id="movie"]') as HTMLButtonElement).click();
    await flush();
    expect(h.root.querySelector<HTMLElement>('.channel-tab[aria-current="true"]')?.dataset.channelId).toBe('movie');

    await h.view.refresh();
    expect(h.root.querySelector<HTMLElement>('.channel-tab[aria-current="true"]')?.dataset.channelId).toBe('movie');
    expect(h.root.querySelector('.capsule[aria-current="true"]')?.textContent).toBe('全部');
  });

  it('destroy 清空宿主，setPosterMode 在未挂载时先装配', async () => {
    const h = harness();
    await h.view.mount();
    h.view.destroy();
    expect(h.root.childElementCount).toBe(0);

    const idle = harness();
    idle.view.setPosterMode('list-1');
    expect(idle.modes).toEqual(['list-1']);
    expect(idle.root.querySelectorAll('.mode-btn').length).toBe(4);
  });

  it('A-4 无感加载：手动按钮已拔除，续载由尾部哨兵静默发起并带 revision 游标', async () => {
    const h = harness((url) =>
      url.startsWith('/api/channels')
        ? reply({ version: 11, channels: TOPOLOGY })
        : url.includes('page=2')
          ? reply(catalog([content('c-9')], 2, 2, 77))
          : reply(catalog([content('c-1')], 1, 2, 77)));
    await h.view.mount();
    // 旧的那颗【加载更多】按钮不再存在于 DOM；尾部只有一枚 1px 哨兵（+ 一条 aria-live 状态行）。
    expect(h.root.querySelector('.home-more-btn')).toBeNull();
    expect(h.root.querySelector('.home-sentinel')).not.toBeNull();
    // 首屏只落 1 / 2：没有任何点击，第二页就被静默接上了（AC-A4-2）。
    expect(seen.filter((url) => url.includes('page=2'))).toEqual(['/api/catalog?channel=drama&page=2&pageSize=60&revision=77']);
    expect(h.root.querySelectorAll('.poster-card').length).toBe(2);

    // 已到 total 后再调用同一条入口：不放行，也不谎报"还有更多"。
    h.view.loadMore();
    await flush();
    expect(seen.filter((url) => url.includes('page=2'))).toHaveLength(1);
  });

  it('A-2 搜索条：注入 onSearch 才可点（点开即打开 Overlay），未注入则整条缺席', async () => {
    const opened: number[] = [];
    const h = harness(defaultResponder, [], { onSearch: () => opened.push(1) });
    await h.view.mount();
    const bar = h.root.querySelector<HTMLElement>('.home-search-bar');
    expect(bar).not.toBeNull();
    bar?.click();
    expect(opened).toEqual([1]);
    // 键盘可达：Enter 与点击同一条去处。
    bar?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(opened).toEqual([1, 1]);

    const bare = harness();
    await bare.view.mount();
    expect(bare.root.querySelector('.home-search-bar')).toBeNull();
  });
});
