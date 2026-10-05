// @vitest-environment jsdom
/**
 * 真机缺陷组 1、2 的回归：媒体子树层叠隔离 + 工具栏定位（AC-19），选集面板三态与返回级联（AC-21 / R26-05）。
 * 断言口径见 `player-sheet-harness.ts` 顶部说明：DOM/ARIA/内联量走真断言，视觉规则钉样式正本声明文本。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createArtEngine } from '../../src/player/art-engine';
import { dispatchBackButtonForTest } from '../../src/core/native/back-button';
import { settle, setup } from './player-harness';
import { episodeSheetMode } from '../../src/player/episode-sheet';
import { applyMediaFrame, containedRect } from '../../src/player/media-frame';
import { hostCss, openHost, playerCss, rule } from './player-sheet-harness';

/** 画面矩形变量必须留在播放器根上：工具栏与 HUD 都以它为基准定位。 */
const MEDIA_VARS = ['--prism-media-top', '--prism-media-left', '--prism-media-width', '--prism-media-height'];

describe('缺陷组 1：媒体子树层叠隔离与工具栏定位（AC-19）', () => {
  it('舞台自成 stacking context：artplayer 内部的 z10/20 出不来', () => {
    const stage = rule(playerCss, '.prism-player__stage');
    expect(stage).toMatch(/isolation:\s*isolate/);
    expect(stage).toMatch(/contain:\s*[^;}]*layout[^;}]*paint[^;}]*;/);
    expect(stage).toMatch(/z-index:\s*var\(--prism-z-media\)/);
  });

  it('宿主 chrome 的层叠令牌真的高于媒体与手势面', () => {
    const tokens = Object.fromEntries([...playerCss.matchAll(/--prism-z-([a-z]+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]));
    expect(tokens.media).toBeGreaterThan(0);
    expect(tokens.chrome).toBeGreaterThan(tokens.media);
    expect(tokens.gesture).toBeGreaterThan(tokens.media);
    expect(tokens.state).toBeGreaterThan(tokens.chrome);
    expect(tokens.rate).toBeGreaterThan(tokens.chrome);
    expect(Number(rule(hostCss, '.prism-player-host').match(/--prism-z-drawer:\s*(\d+)/)?.[1])).toBeGreaterThan(tokens.rate);
    for (const [name, selector] of [['media', '.prism-player__stage'], ['gesture', '.prism-player__body'], ['chrome', '.prism-player__chrome'], ['state', '.prism-player__state'], ['rate', '.prism-rate-sheet'], ['drawer', '.prism-drawer']] as const) {
      expect(rule(playerCss, selector)).toContain(`z-index: var(--prism-z-${name}${name === 'drawer' ? ', 240' : ''})`);
    }
  });

  it('360w 舞台的顶部控制带独立于约 114w 竖屏内容，五按钮不被内容矩形约束', () => {
    const chrome = rule(playerCss, '.prism-player__chrome');
    expect(containedRect({ width: 390, height: 390 * 9 / 16 }, { width: 1080, height: 1920 }).width).toBeCloseTo(123.4, 1);
    expect(chrome).toMatch(/top:\s*0/);
    expect(chrome).toMatch(/inset-inline:\s*0/);
    expect(chrome).toMatch(/width:\s*auto/);
    expect(chrome).not.toMatch(/var\(--prism-media-/);
    expect(chrome).toMatch(/box-sizing:\s*border-box/);
    expect(rule(playerCss, '.prism-player__chrome > button')).toMatch(/min-width:\s*44px/);
    expect(rule(playerCss, '.prism-player__chrome > button')).toMatch(/flex:\s*0 0 44px/);
    expect(chrome).toMatch(/safe-area-inset-top/);
    expect(chrome).toMatch(/safe-area-inset-left/);
    expect(chrome).toMatch(/safe-area-inset-right/);
    expect(chrome).not.toMatch(/top:\s*50%/);
    // 未量到画面时的降级基线：整块舞台，与旧行为等价，绝不出现"工具栏消失"。
    for (const name of MEDIA_VARS) expect(playerCss).toMatch(new RegExp(`${name}:\\s*\\S+`));
  });

  it('宿主实际装配五个顶部按钮；360w 预算容纳 44px 触点与标题', async () => {
    const h = openHost(); await h.host.open('c1'); await settle();
    const chrome = h.q<HTMLElement>('.prism-player__chrome')!;
    expect(chrome.querySelectorAll(':scope > button')).toHaveLength(5);
    expect(360 - 2 * 12 - 5 * 8 - 5 * 44).toBeGreaterThan(0);
    expect(rule(playerCss, '.prism-player__chrome-title')).toMatch(/min-width:\s*0/);
    h.host.close();
  });

  it('contain 等比适配的画面矩形：竖屏短剧在 16:9 详情舞台里就是居中窄列', () => {
    expect(containedRect({ width: 640, height: 360 }, { width: 1080, height: 1920 })).toEqual({ top: 0, left: 218.75, width: 202.5, height: 360 });
    // 全屏竖屏放横屏电影：画面居中，工具栏跟着画面的上边缘走。
    expect(containedRect({ width: 1080, height: 2400 }, { width: 1920, height: 1080 })).toEqual({ top: 896.25, left: 0, width: 1080, height: 607.5 });
    // 画幅未知（元数据未到）时铺满容器，不做任何猜测性偏移。
    expect(containedRect({ width: 640, height: 360 }, null)).toEqual({ top: 0, left: 0, width: 640, height: 360 });
  });

  it('实测矩形以 px 内联写到播放器根上，供 chrome/HUD 定位', () => {
    const el = document.createElement('div');
    applyMediaFrame(el, containedRect({ width: 640, height: 360 }, { width: 1080, height: 1920 }));
    expect(el.style.getPropertyValue('--prism-media-left')).toBe('218.75px');
    expect(el.style.getPropertyValue('--prism-media-width')).toBe('202.5px');
    expect(el.style.getPropertyValue('--prism-media-top')).toBe('0px');
    expect(el.style.getPropertyValue('--prism-media-height')).toBe('360px');
  });

  it('内核报出画幅后写入矩形，工具栏基准随画面而不是整块舞台', async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    const h = openHost({ engine: async (options) => {
      vi.spyOn(options.container, 'getBoundingClientRect').mockReturnValue({
        width: 640, height: 360, top: 0, left: 0, right: 640, bottom: 360, x: 0, y: 0, toJSON: () => ({})
      } as DOMRect);
      const engine = await createArtEngine(options);
      const video = options.container.querySelector('video') as HTMLVideoElement;
      Object.defineProperties(video, { videoWidth: { value: 1080, configurable: true }, videoHeight: { value: 1920, configurable: true } });
      return engine;
    } });
    try {
      await h.host.open('c1'); await settle();
      const player = h.mount.querySelector<HTMLElement>('.prism-player')!;
      expect(player.style.getPropertyValue('--prism-media-width')).toBe('202.5px');
      expect(player.style.getPropertyValue('--prism-media-left')).toBe('218.75px');
    } finally {
      h.host.close();
      play.mockRestore(); pause.mockRestore(); load.mockRestore();
    }
  });

  it('选集面板保留 data-prism-ui 钩子：面板内的点击不会被当成播放手势', async () => {
    const h = setup();
    await h.player.load(11); await settle();
    h.player.openDrawer();
    const drawer = h.root.querySelector<HTMLElement>('[data-prism-ui="drawer"]');
    expect(drawer).not.toBeNull();
    expect(drawer!.querySelector('.prism-drawer__item')!.closest('[data-prism-ui]')).toBe(drawer);
    h.player.destroy();
  });
});

describe('缺陷组 2：选集面板三态、互斥与返回级联（AC-21 / R26-05）', () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it('模式判据：非全屏一律 inline，全屏按视口分 side/sheet', () => {
    expect(episodeSheetMode({ fullscreen: false, viewportWidth: 1024, viewportHeight: 768 })).toBe('inline');
    expect(episodeSheetMode({ fullscreen: false, viewportWidth: 420, viewportHeight: 900 })).toBe('inline');
    expect(episodeSheetMode({ fullscreen: true, viewportWidth: 2400, viewportHeight: 1080 })).toBe('side');
    expect(episodeSheetMode({ fullscreen: true, viewportWidth: 1080, viewportHeight: 2400 })).toBe('sheet');
  });

  it('非全屏：选集在视频下方 inline 展开，独立滚动且不进视频盒', async () => {
    const h = openHost();
    await h.host.open('c1'); await settle();
    h.mount.querySelector<HTMLButtonElement>('[data-action="list"]')!.click();
    const drawer = h.mount.querySelector<HTMLElement>('.prism-drawer')!;
    expect([drawer.hidden, drawer.dataset['mode'], drawer.getAttribute('aria-modal')]).toEqual([false, 'inline', 'false']);
    expect(drawer.parentElement?.className).toBe('prism-player-host__sheet');
    expect(h.mount.querySelector('.prism-player-host__stage .prism-drawer')).toBeNull();
    expect(h.mount.querySelector('.prism-player-host__body .prism-drawer')).toBeNull();
    expect(rule(hostCss, '.prism-player-host__sheet')).toMatch(/flex:\s*none/);
    expect(rule(playerCss, '.prism-drawer')).toMatch(/position:\s*relative/);
    expect(rule(playerCss, '.prism-drawer__list')).toMatch(/overflow-y:\s*auto/);
  });

  it('全屏横屏：右侧抽屉并让视频区缩窄；全屏竖屏：底部限高抽屉', () => {
    const side = rule(playerCss, '.prism-drawer--side');
    expect(side).toMatch(/position:\s*fixed/);
    expect(side).toMatch(/inset-block:\s*0/);
    expect(side).toMatch(/right:\s*0/);
    expect(side).toMatch(/left:\s*auto/);
    const sheet = rule(playerCss, '.prism-drawer--sheet');
    expect(sheet).toMatch(/position:\s*fixed/);
    expect(sheet).toMatch(/bottom:\s*0/);
    expect(sheet).toMatch(/top:\s*auto/);
    expect(sheet).toMatch(/max-height:\s*\d+dvh/);
    // 视频让位：抽屉真的开着才缩窄，关掉就复原。
    const narrow = hostCss.match(/\.prism-player-host--fullscreen[^{]*:has\(\.prism-drawer--side:not\(\[hidden]\)\)[^{]*\{[^}]*\}/);
    expect(narrow, '横屏全屏缺少"视频区让位"规则').not.toBeNull();
    expect(narrow![0]).toMatch(/right:\s*var\(--prism-sheet-side\)/);
    expect(narrow![0]).toMatch(/width:\s*auto/);
    expect(rule(hostCss, '.prism-player-host--fullscreen .art-video-player')).toMatch(/width:\s*100%/);
    // 遮罩只属于浮动态，inline 态不得有遮罩。
    expect(playerCss).toMatch(/\.prism-drawer--(?:sheet|side)::before\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0/);
    expect(playerCss).not.toMatch(/\.prism-drawer--inline::before/);
  });

  it('抽屉 open/close 均重测，setMode 不递归通知；重复 close 不重测', async () => {
    const h = openHost();
    await h.host.open('c1'); await settle();
    const resize = vi.fn(); h.engine.resize = resize;
    const stage = h.q<HTMLElement>('.prism-player__stage')!;
    const measure = vi.spyOn(stage, 'getBoundingClientRect');
    h.fullscreenButton().click(); resize.mockClear(); measure.mockClear();
    h.q<HTMLButtonElement>('[data-action="list"]')!.click();
    expect(resize).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenCalledTimes(1);
    h.q<HTMLButtonElement>('.prism-drawer__close')!.click();
    expect(resize).toHaveBeenCalledTimes(2);
    expect(measure).toHaveBeenCalledTimes(2);
    h.q<HTMLButtonElement>('.prism-drawer__close')!.click();
    expect(resize).toHaveBeenCalledTimes(2);
    h.host.close();
  });

  it('兄弟槽位从共同宿主继承 drawer 层级，standalone 有合法 fallback', async () => {
    const h = openHost(); await h.host.open('c1'); await settle();
    const drawer = h.q<HTMLElement>('.prism-drawer')!;
    const host = drawer.closest('.prism-player-host')!;
    expect(h.q('.prism-player')!.parentElement).toBe(host);
    expect(drawer.parentElement?.parentElement).toBe(host);
    expect(rule(hostCss, '.prism-player-host')).toMatch(/--prism-z-drawer:\s*240/);
    expect(rule(playerCss, '.prism-player')).not.toMatch(/--prism-z-drawer:/);
    expect(rule(playerCss, '.prism-drawer')).toMatch(/z-index:\s*var\(--prism-z-drawer,\s*240\)/);
    h.host.close();
  });

  it('全屏态标记随模式落到抽屉上，遮罩点击即收起', async () => {
    const h = openHost();
    await h.host.open('c1'); await settle();
    h.fullscreenButton().click();
    const drawer = h.mount.querySelector<HTMLElement>('.prism-drawer')!;
    h.mount.querySelector<HTMLButtonElement>('[data-action="list"]')!.click();
    expect(drawer.dataset['mode']).toBe('side');
    expect(drawer.getAttribute('aria-modal')).toBe('true');
    drawer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(drawer.hidden).toBe(true);
  });

  it('选集与倍速、投屏互斥：开一个必收其余', async () => {
    const h = openHost();
    await h.host.open('c1'); await settle();
    const drawer = h.mount.querySelector<HTMLElement>('.prism-drawer')!;
    const cast = () => h.mount.querySelector<HTMLElement>('.prism-cast')!;
    const list = () => h.mount.querySelector<HTMLButtonElement>('[data-action="list"]')!.click();
    h.island('投屏').click(); await settle();
    expect(cast().hidden).toBe(false);
    list();
    expect(cast().hidden).toBe(true);
    expect(drawer.hidden).toBe(false);
    h.island('投屏').click(); await settle();
    expect(drawer.hidden).toBe(true);
    h.q<HTMLButtonElement>('[data-action="rate"]')!.click();
    expect(cast().hidden).toBe(true);
    h.host.close();
  });

  it('AC-21：返回键先收起集浮层（inline 也算浮层），再退全屏，再关播放器', async () => {
    const h = openHost();
    await h.host.open('c1'); await settle();
    h.mount.querySelector<HTMLButtonElement>('[data-action="list"]')!.click();
    expect(await dispatchBackButtonForTest()).toBe(true);
    expect(h.mount.querySelector<HTMLElement>('.prism-drawer')!.hidden).toBe(true);
    expect(h.host.isOpen()).toBe(true);
    h.fullscreenButton().click();
    h.mount.querySelector<HTMLButtonElement>('[data-action="list"]')!.click();
    expect(await dispatchBackButtonForTest()).toBe(true);
    expect(h.mount.querySelector<HTMLElement>('.prism-drawer')!.hidden).toBe(true);
    expect(h.fullscreenOn()).toBe(true);
    expect(await dispatchBackButtonForTest()).toBe(true);
    expect(h.fullscreenOn()).toBe(false);
    expect(await dispatchBackButtonForTest()).toBe(true);
    expect(h.host.isOpen()).toBe(false);
    expect(h.calls.closed).toBe(1);
  });
});
