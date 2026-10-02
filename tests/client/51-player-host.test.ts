// @vitest-environment jsdom
/**
 * 播放宿主（`src/player-host.ts`）的装配面测试：退出控件、断点选集、私密性回调、通知栏动作回程。
 * 手势与定时策略在 `30/31/33` 已各自验过，这里只证"宿主这一层有没有把它接错"。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPlayerHost } from '../../src/player-host';
import type { PlayerHostDeps } from '../../src/player-host';
import type { PlayerEngine } from '../../src/player/engine-seam';
import type { CallState, PrismNativeBridge } from '../../src/core/native/bridge';
import type { TitleDetail } from '../../edge/src/types/api';
import type { WatchHistoryRow } from '../../src/core/storage/storage-domains';
import { dispatchBackButtonForTest } from '../../src/core/native/back-button';
import { detailOf, settle } from './player-harness';

type FakeEngine = PlayerEngine & { sources: string[]; times: number[]; volumes: number[] };

function fakeEngine(): FakeEngine {
  const handlers = new Map<string, Array<() => void>>();
  const flags = { isPlaying: false, t: 0, vol: 1, sources: [] as string[], times: [] as number[], volumes: [] as number[] };
  const emit = (event: string): void => (handlers.get(event) ?? []).forEach((handler) => handler());
  const engine = {
    play: () => { flags.isPlaying = true; emit('play'); },
    pause: () => { flags.isPlaying = false; emit('pause'); },
    playing: () => flags.isPlaying,
    currentTime: () => flags.t,
    duration: () => 100,
    volume: () => flags.vol,
    setCurrentTime: (seconds: number) => { flags.t = seconds; flags.times.push(seconds); },
    setVolume: (value: number) => { flags.vol = value; flags.volumes.push(value); },
    setSource: (url: string) => { flags.sources.push(url); },
    toggleControls: () => undefined,
    destroy: () => undefined,
    on: (event: string, handler: () => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((item) => item !== handler));
    }
  };
  return Object.assign(flags, engine) as unknown as FakeEngine;
}

function host(over: Partial<PlayerHostDeps> & { detail?: TitleDetail; titleError?: unknown } = {}) {
  const { detail = detailOf(), titleError, ...rest } = over;
  const mount = document.createElement('div');
  document.body.replaceChildren(mount);
  const engine = fakeEngine();
  const calls = { playback: [] as number[], progress: [] as unknown[][], privacy: [] as boolean[], closed: 0, blocked: [] as string[], background: [] as string[] };
  const api = {
    title: vi.fn(async () => { if (titleError !== undefined) throw titleError; return detail; }),
    playback: vi.fn(async (id: number) => { calls.playback.push(id); return { episodeId: id, url: 'https://play.prismos.org/proxy/m3u8/h1', mimeType: 'application/vnd.m3u8+playlist', durationSeconds: 100 }; })
  };
  const bridge = {
    getSystemVolume: async () => ({ volume: 1, supported: false }),
    getBrightness: async () => ({ brightness: 1, supported: false }),
    setSystemVolume: async () => ({ volume: 1, supported: false }),
    setBrightness: async () => ({ brightness: 1, supported: false }),
    setKeepScreenOn: async () => undefined,
    startBackgroundAudio: async (title: string) => { calls.background.push(title); },
    stopBackgroundAudio: async () => undefined,
    setSecureScreen: async () => false,
    onCallState: (_listener: (state: CallState) => void) => () => undefined
  } as unknown as PrismNativeBridge;
  const player = createPlayerHost({
    mount,
    bridge,
    api,
    onProgress: (row, context) => { calls.progress.push([row, context]); },
    allowBackgroundAudio: () => false,
    onPrivacyChange: (isPrivate) => { calls.privacy.push(isPrivate); },
    onClose: () => { calls.closed += 1; },
    onBlocked: (message) => { calls.blocked.push(message); },
    engine: async () => engine,
    ...rest
  });
  return { player, mount, engine, calls, api };
}

const row = (over: Partial<WatchHistoryRow> = {}): WatchHistoryRow => ({
  content_id: 'c1', title: '测试剧', cover_url: null, last_episode_id: 12, last_episode_number: 2,
  position_seconds: 42, duration_seconds: 100, total_episodes: 3, updated_at: 10, ...over
});

describe('player-host 装配', () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it('open 挂出全屏浮层与退出控件，并把剧目交给详情端点', async () => {
    const h = host();
    expect(await h.player.open('c1')).toBe(true);
    const layer = h.mount.querySelector('.prism-player-host');
    expect(layer?.getAttribute('role')).toBe('dialog');
    expect(layer?.getAttribute('aria-modal')).toBe('true');
    expect(layer?.querySelector('.prism-player-host__exit')).not.toBeNull();
    expect(h.api.title).toHaveBeenCalledWith('c1');
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

  it('详情取不到（404/私密未准入）时不挂浮层，也不留残骸', async () => {
    const h = host({ titleError: new Error('missing') });
    expect(await h.player.open('nope')).toBe(false);
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
