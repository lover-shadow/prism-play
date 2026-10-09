// @vitest-environment jsdom
/**
 * 播放宿主（`src/player-host.ts`）的装配面测试：退出控件、断点选集、私密性回调、通知栏动作回程。
 * 手势与定时策略在 `30/31/33` 已各自验过，这里只证"宿主这一层有没有把它接错"。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WatchHistoryRow } from '../../src/core/storage/storage-domains';
import { dispatchBackButtonForTest } from '../../src/core/native/back-button';
import { detailOf, settle } from './player-harness';
import { host, row } from './player-host-harness';
import Artplayer from 'artplayer';
import { createArtEngine } from '../../src/player/art-engine';
import playerCss from '../../src/player/player.css?raw';
import hostCss from '../../src/player/player-host.css?raw';

describe('player-host 装配', () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it('open 挂出全屏浮层与退出控件，并把剧目交给详情端点', async () => {
    const h = host();
    expect(await h.player.open('c1')).toBe(true);
    const layer = h.mount.querySelector('.prism-player-host');
    expect(layer?.getAttribute('role')).toBe('dialog');
    expect(layer?.getAttribute('aria-modal')).toBe('true');
    expect(layer?.querySelector('.prism-player-host__exit')).not.toBeNull();
    expect(h.api.title).toHaveBeenCalledWith('c1', expect.any(AbortSignal));
    expect(h.player.isOpen()).toBe(true);
  });

  it('历史断点回到那一集那一秒；断点属于别的剧目时从首集起播', async () => {
    const resumed = host();
    await resumed.player.open('c1', row()); await settle();
    expect(resumed.calls.playback).toEqual([12]);
    expect(resumed.engine.times).toContain(42);

    const foreign = host();
    await foreign.player.open('c1', row({ content_id: 'other', position_seconds: 88 })); await settle();
    expect(foreign.calls.playback).toEqual([11]);
    expect(foreign.engine.times).not.toContain(88);
  });

  // HP-03 迁移：旧的"详情失败即静默、open 返回时就该空"改为"失败停在层内、给出可返回与可重试出口"。
  // 原断言的含义（不留残骸、不谎报打开）完整保留，只是挪到"用户从层内退出之后"这一时点来证。
  it('详情取不到（404/私密未准入）时不谎报打开，退出层后不留残骸', async () => {
    const h = host({ titleError: new Error('missing') });
    expect(await h.player.open('nope')).toBe(false);
    expect(h.player.state()).toBeNull();
    expect(h.calls.closed).toBe(0); // 从未起播的失败层不该被记成一次播放退出
    expect(h.player.isOpen()).toBe(true); // 层还在，且必须带出口（HP-03b 的细则在 67-host-loading）
    h.player.close();
    expect(h.mount.querySelector('.prism-player-host')).toBeNull();
    expect(h.player.isOpen()).toBe(false);
  });

  it('私密剧目：分享入口物理缺席，隐私回调如实上报', async () => {
    const secret = host({ detail: detailOf({ isPrivate: true, channelId: 'private', shareable: false }), onShare: () => undefined });
    await secret.player.open('c1'); await settle();
    expect(secret.calls.privacy).toEqual([true]);
    secret.player.state();
    expect(secret.mount.querySelector('.prism-drawer__action')).toBeNull();

    const open = host({ onShare: () => undefined });
    await open.player.open('c1'); await settle();
    open.player.state();
    expect(open.calls.privacy).toEqual([false]);
  });

  it('close 拆掉浮层、解除私密状态并通知宿主', async () => {
    const h = host();
    await h.player.open('c1', row()); await settle();
    h.player.close();
    expect(h.mount.querySelector('.prism-player-host')).toBeNull();
    expect(h.calls.privacy).toEqual([false, false]);
    expect(h.calls.closed).toBe(1);
    expect(h.player.isOpen()).toBe(false);
    h.player.close();
    expect(h.calls.closed).toBe(1);
  });

  it('Escape 与退出按钮等价，未打开时按键不产生任何副作用', async () => {
    const h = host();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(h.calls.closed).toBe(0);
    await h.player.open('c1'); await settle();
    (h.mount.querySelector('.prism-player-host__exit') as HTMLButtonElement).click();
    expect(h.mount.querySelector('.prism-player-host')).toBeNull();
    await h.player.open('c1'); await settle();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(h.player.isOpen()).toBe(false);

    // 验证原生系统 Back 键 / 全面屏侧滑手势自动拦截并关闭播放器
    await h.player.open('c1'); await settle();
    expect(h.player.isOpen()).toBe(true);
    const handled = await dispatchBackButtonForTest();
    expect(handled).toBe(true);
    expect(h.player.isOpen()).toBe(false);
  });

  it('全屏模式切换与返回拦截：全屏下返回优先退出全屏，非全屏返回才关闭播放器', async () => {
    const h = host();
    await h.player.open('c1'); await settle();
    const hostEl = h.mount.querySelector('.prism-player-host') as HTMLElement;
    expect(hostEl.classList.contains('prism-player-host--fullscreen')).toBe(false);

    const cinemaBtn = Array.from(h.mount.querySelectorAll<HTMLButtonElement>('.action-island-item')).find(
      (b) => b.textContent?.includes('沉浸全屏')
    );
    cinemaBtn?.click();
    expect(hostEl.classList.contains('prism-player-host--fullscreen')).toBe(true);

    // 全屏态下触发系统 Back 键：优先退出全屏，播放器保持打开
    const back1 = await dispatchBackButtonForTest();
    expect(back1).toBe(true);
    expect(hostEl.classList.contains('prism-player-host--fullscreen')).toBe(false);
    expect(h.player.isOpen()).toBe(true);

    // 非全屏态下触发系统 Back 键：关闭播放器
    const back2 = await dispatchBackButtonForTest();
    expect(back2).toBe(true);
    expect(h.player.isOpen()).toBe(false);
  });

  it('真实 ArtPlayer 全屏/退出重排只通知 resize，不按 9:16 媒体比例缩小舞台容器', async () => {
    // jsdom 不做像素布局：仅提供舞台几何，验证真实厂商代码的 inline style 与事件。
    const css = document.createElement('style');
    css.textContent = `${playerCss}\n${hostCss}`;
    document.head.append(css);
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    let art!: Artplayer;
    const h = host({ engine: async (options) => {
      vi.spyOn(options.container, 'getBoundingClientRect').mockImplementation(() => {
        const fullscreen = !!options.container.closest('.prism-player-host--fullscreen');
        return { width: 360, height: fullscreen ? 800 : 202.5, top: 0, left: 0, right: 360,
          bottom: fullscreen ? 800 : 202.5, x: 0, y: 0, toJSON: () => ({}) };
      });
      const engine = await createArtEngine(options);
      art = Artplayer.instances.at(-1)!;
      Object.defineProperties(art.video, { videoWidth: { value: 540 }, videoHeight: { value: 960 } });
      return engine;
    } });
    try {
      await h.player.open('c1'); await settle();
      const hostEl = h.mount.querySelector('.prism-player-host') as HTMLElement;
      const playerEl = art.template.$player;
      const autoSize = vi.fn();
      art.on('autoSize', autoSize);
      const resized = vi.fn();
      art.on('resize', resized);
      const cinemaBtn = Array.from(h.mount.querySelectorAll<HTMLButtonElement>('.action-island-item'))
        .find((button) => button.textContent?.includes('沉浸全屏'))!;
      const expectStageFill = () => {
        expect(playerEl.style.height).toBe('');
        expect(playerEl.style.width).toBe('');
        expect(getComputedStyle(playerEl).width).toBe('100%');
        expect(getComputedStyle(playerEl).height).toBe('100%');
        expect(getComputedStyle(art.video).objectFit).toBe('contain');
      };
      expect(art.option.autoSize).toBe(false);
      expectStageFill();
      for (let cycle = 0; cycle < 2; cycle += 1) {
        cinemaBtn.click();
        expect(hostEl.classList.contains('prism-player-host--fullscreen')).toBe(true);
        expectStageFill();
        expect(await dispatchBackButtonForTest()).toBe(true);
        expect(hostEl.classList.contains('prism-player-host--fullscreen')).toBe(false);
        expect(h.player.isOpen()).toBe(true);
        expectStageFill();
      }
      expect(autoSize).not.toHaveBeenCalled();
      expect(resized).toHaveBeenCalledTimes(4);
    } finally {
      h.player.close();
      css.remove();
      play.mockRestore(); pause.mockRestore(); load.mockRestore();
    }
  });

  it('通知栏动作映射到当前实例：切换播放、上下集、焦点回程', async () => {
    const h = host();
    await h.player.open('c1'); await settle();
    h.player.onNotification('toggle');
    expect(h.engine.playing()).toBe(true);
    h.player.onNotification('next'); await settle();
    expect(h.calls.playback.at(-1)).toBe(12);
    h.player.onNotification('previous'); await settle();
    expect(h.calls.playback.at(-1)).toBe(11);
    h.player.onNotification('focus-lost');
    h.player.onNotification('focus-regained');
    expect(h.player.state()?.phase).toBe('ready');
  });

  it('进度转交宿主持久化：行与上下文成对送达，宿主未开启后台播放就不拉前台服务', async () => {
    const h = host();
    await h.player.open('c1', row()); await settle();
    expect(h.calls.progress.length).toBeGreaterThan(0);
    const [written, context] = h.calls.progress[0] as [WatchHistoryRow, { isPrivate: boolean; channelId: string }];
    expect(written.content_id).toBe('c1');
    expect(context.channelId).toBe('drama');
    expect(context.isPrivate).toBe(false);
    h.player.onNotification('toggle'); await settle();
    expect(h.calls.background).toEqual([]);
  });
});
