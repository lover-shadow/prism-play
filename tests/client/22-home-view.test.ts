// @vitest-environment jsdom
/** 大视界主视图装配测试：AC-01 拓扑驱动（默认定位口径已由 HP-04 综合首页取代）、AC-02-3 私密缺席、AC-04 排版持久化、SPEC §7 五态。续播卡与 A-2/A-4 生命周期见 27-home-lifecycle。 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  catalog, channel, content, enterChannel, flush, gridClass, harness, reply, seen, TOPOLOGY, resetHomeFixtures
} from './home-view-harness';
import { COMPOSITE_HOME_ID } from '../../src/views/home-nav';

afterEach(resetHomeFixtures);

describe('home-view 挂载与拓扑驱动（AC-01 / HP-04）', () => {
  it('HP-04 首屏拉云端拓扑：首页在最前，四公开频道按 order 齐备且名称逐字采用云端', async () => {
    const h = harness();
    await h.view.mount();

    expect(seen[0]).toBe('/api/channels');
    expect(Array.from(h.root.querySelectorAll<HTMLElement>('.channel-tab')).map((tab) => tab.textContent))
      .toEqual(['首页', '短剧精选', '院线电影', '热血动漫', '人文纪录']);
    expect(Array.from(h.root.querySelectorAll<HTMLElement>('.channel-tab')).map((tab) => tab.dataset.navId))
      .toEqual([COMPOSITE_HOME_ID, 'drama', 'movie', 'anime', 'documentary']);
    // AC-01 的"默认高亮短剧精选"已被 HP-04 迁移为"默认停在综合首页"；频道目录仍可按真实身份高亮。
    expect(h.root.querySelector<HTMLElement>('.channel-tab[aria-current="true"]')?.dataset.navId).toBe(COMPOSITE_HOME_ID);
    await enterChannel(h.root, 'drama');
    expect(h.root.querySelector<HTMLElement>('.channel-tab[aria-current="true"]')?.dataset.channelId).toBe('drama');
    // AC-25：区块头被物理拔除——频道名与一级频道栏 100% 重复，那一行还白吃 40px 高度。
    expect(h.root.querySelector('.home-section-header')).toBeNull();
    expect(h.root.querySelector('.home-section-title')).toBeNull();
  });

  it('HP-04 云端未下发短剧精选时不造假频道节点，频道目录落位退化为 order 最小项', async () => {
    const h = harness((url) =>
      url.startsWith('/api/channels')
        ? reply({ version: 1, channels: [channel('anime', '热血动漫', 3), channel('movie', '院线电影', 2)] })
        : reply(catalog([content('a-1')])));
    await h.view.mount();
    expect(Array.from(h.root.querySelectorAll<HTMLElement>('.channel-tab[data-channel-id]')).map((tab) => tab.dataset.channelId))
      .toEqual(['movie', 'anime']);
    expect(h.root.querySelectorAll('.channel-tab[data-channel-id="drama"]')).toHaveLength(0);
    await enterChannel(h.root, 'movie');
    expect(h.root.querySelector<HTMLElement>('.channel-tab[aria-current="true"]')?.dataset.channelId).toBe('movie');
  });

  it('未下发 private 时整棵 DOM 物理隐形：零节点、零字样、零二级分类', async () => {
    const h = harness();
    await h.view.mount();
    await enterChannel(h.root, 'drama');

    expect(h.root.querySelectorAll('[data-channel-id="private"]').length).toBe(0);
    expect(h.root.innerHTML.toLowerCase()).not.toContain('private');
    expect(h.root.textContent ?? '').not.toContain('个人探索');
    expect(Array.from(h.root.querySelectorAll('.capsule[data-category]')).map((pill) => pill.textContent)).toEqual(['全部', '都市', '战神', '逆袭']);
  });

  it('云端下发 private 时才渲染它；私密条目自身也不带分享按钮', async () => {
    const h = harness((url) =>
      url.startsWith('/api/channels')
        ? reply({ version: 2, channels: [...TOPOLOGY, channel('private', '个人探索', 9, ['今日更新'])] })
        : reply(catalog([content('p-1', { channelId: 'private', isPrivate: true, shareable: false })])));
    await h.view.mount();

    expect(h.root.querySelectorAll('[data-channel-id="private"]').length).toBe(1);
    expect(h.root.querySelector('[data-channel-id="private"]')?.textContent).toBe('个人探索');
    expect(h.root.querySelectorAll('.poster-share').length).toBe(0);
  });

  it('海报请求带上所选频道与分页，切频道后重新拉取且空片单退场网格', async () => {
    const h = harness();
    await h.view.mount();
    expect(seen).toContain('/api/catalog?channel=drama&page=1&pageSize=60');

    (h.root.querySelector('[data-channel-id="movie"]') as HTMLButtonElement).click();
    await flush();
    expect(seen).toContain('/api/catalog?channel=movie&page=1&pageSize=60');
    expect(h.root.querySelector('.state-view--empty')).not.toBeNull();
    expect(h.root.querySelector('.home-poster-grid')).toBeNull();
  });

  it('选中的二级分类才作为 category 下发，「全部」不带参数', async () => {
    const h = harness();
    await h.view.mount();
    await enterChannel(h.root, 'drama');
    const pill = Array.from(h.root.querySelectorAll<HTMLButtonElement>('.capsule')).find((entry) => entry.textContent === '战神');
    (pill as HTMLButtonElement).click();
    await flush();
    expect(seen).toContain('/api/catalog?channel=drama&category=%E6%88%98%E7%A5%9E&page=1&pageSize=60');
  });
});

describe('home-view 排版模式（AC-04）', () => {
  it('setPosterMode 回调持久化并重贴类名，重绘后仍是同一模式', async () => {
    const h = harness();
    await h.view.mount();
    expect(gridClass(h.root)).toBe('home-poster-grid grid-posters-compact-3');

    h.view.setPosterMode('bookshelf-4');
    expect(h.modes).toEqual(['bookshelf-4']);
    expect(h.currentMode()).toBe('bookshelf-4');
    expect(gridClass(h.root)).toContain('grid-posters-bookshelf-4');

    await h.view.refresh();
    expect(gridClass(h.root)).toContain('grid-posters-bookshelf-4');
    // 模式归属的唯一可见证据是切换器自身的 `aria-pressed`；旧的【四列书架】文字标签随区块头一起拔除，
    // 重绘后仍要点亮同一颗，否则说明偏好态被重建冲掉了。
    expect(h.root.querySelector('.home-mode-tag')).toBeNull();
    const pressed = Array.from(h.root.querySelectorAll<HTMLButtonElement>('.mode-btn'))
      .filter((button) => button.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0]?.dataset.mode).toBe('bookshelf-4');
  });

  it('点击切换器即回传模式，aria-pressed 乐观点亮', async () => {
    const h = harness();
    await h.view.mount();
    const buttons = Array.from(h.root.querySelectorAll<HTMLButtonElement>('.mode-btn'));
    expect(buttons.map((button) => button.dataset.mode)).toEqual(['compact-3', 'comfort-2', 'bookshelf-4', 'list-1']);

    buttons[1].click();
    expect(h.modes).toEqual(['comfort-2']);
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
    expect(gridClass(h.root)).toContain('grid-posters-comfort-2');
  });
});

describe('home-view 五态（SPEC §7）', () => {
  it('加载中先铺骨架屏，不留空白首屏', async () => {
    const h = harness();
    const pending = h.view.mount();
    expect(h.root.querySelectorAll('.poster-card--skeleton').length).toBeGreaterThan(0);
    expect(h.root.querySelector<HTMLElement>('.home-poster-grid')?.dataset.state).toBe('loading');
    await pending;
    expect(h.root.querySelectorAll('.poster-card--skeleton').length).toBe(0);
  });

  it('断网走 offline 态：文案声明点播需要网络，绝不承诺可离线播放', async () => {
    const h = harness(() => { throw new TypeError('fetch failed'); });
    await h.view.mount();
    const box = h.root.querySelector('.state-view--offline') as HTMLElement;
    expect(box).not.toBeNull();
    expect(box.getAttribute('role')).toBe('alert');
    const copy = box.textContent ?? '';
    expect(copy).toContain('网络');
    expect(copy).toContain('点播');
    expect(copy).not.toMatch(/离线播放|无需联网|可以离线看/);
    expect(h.root.querySelectorAll('.state-view--error').length).toBe(0);
  });

  it('服务端 503 走 error 态并带重试按钮，点击重新拉取', async () => {
    const h = harness(() => reply({ success: false, code: 'SERVICE_UNAVAILABLE', message: '边缘节点拥挤' }, 503));
    await h.view.mount();
    const box = h.root.querySelector('.state-view--error') as HTMLElement;
    expect(box.textContent ?? '').toContain('边缘节点拥挤');

    const before = seen.length;
    (box.querySelector('.state-view-action') as HTMLButtonElement).click();
    await flush();
    expect(seen.length).toBeGreaterThan(before);
  });

  it('私密凭据失效走 disabled 态而非 error 态', async () => {
    const h = harness(() => reply({ success: false, code: 'PRIVATE_SESSION_REQUIRED', message: '当次会话已结束' }, 403));
    await h.view.mount();
    expect(h.root.querySelector('.state-view--disabled')).not.toBeNull();
    expect(h.root.querySelector('.state-view--error')).toBeNull();
  });

  it('空片单走 empty 态并提供返回短剧精选', async () => {
    const h = harness((url) => (url.startsWith('/api/channels') ? reply({ version: 11, channels: TOPOLOGY }) : reply(catalog([]))));
    await h.view.mount();
    (h.root.querySelector('[data-channel-id="anime"]') as HTMLButtonElement).click();
    await flush();

    const box = h.root.querySelector('.state-view--empty') as HTMLElement;
    expect(box.textContent ?? '').toContain('暂无可播放剧目');
    expect(box.querySelector('.state-view-action')?.textContent).toBe('返回短剧精选');
  });
});
