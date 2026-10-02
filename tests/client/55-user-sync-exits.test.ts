// @vitest-environment jsdom
/**
 * WP7 两个离场触发与【追剧】拉取口的接线测试（AC-30）。
 *
 * `54-user-sync.test.ts` 钉的是中枢自身的契约形状；本文件钉"接线"：播放器销毁是否真的把刚结束的断点
 * 交给中枢（播放期间仍须零请求）、私密剧目关闭播放器是否做到零网络、进入【追剧】Tab 是否静默拉取一次
 * 并把合并结果重绘到【正在追】。历史存储与网络替身沿用 `user-sync-harness.ts` 那份唯一真相。
 */
import { describe, expect, it, vi } from 'vitest';
import { createPlayerHost } from '../../src/player-host';
import type { PlayerEngine } from '../../src/player/engine-seam';
import type { PrismNativeBridge } from '../../src/core/native/bridge';
import type { CallState } from '../../src/core/native/bridge';
import { createHistoryView, type CacheUsage, type CredentialWriter, type HistoryApi, type HistoryReader } from '../../src/views/history-view';
import type { MergeReport } from '../../src/core/user-sync';
import type { WatchHistoryRow } from '../../src/core/storage/storage-domains';
import type { RelatedResponse } from '../../edge/src/types/api';
import { detailOf } from './player-harness';
import { fakeHistory, harness, posted, row, settle as flushMicrotasks, TOKEN } from './user-sync-harness';

const engineStub = (): PlayerEngine => {
  const handlers = new Map<string, Array<() => void>>();
  const state = { playing: false, t: 33, source: '' };
  return {
    play: () => { state.playing = true; },
    pause: () => { state.playing = false; },
    playing: () => state.playing,
    currentTime: () => state.t,
    duration: () => 300,
    volume: () => 1,
    setCurrentTime: (value: number) => { state.t = value; },
    setVolume: () => undefined,
    setSource: (url: string) => { state.source = url; },
    toggleControls: () => undefined,
    destroy: () => undefined,
    on: (event: string, handler: () => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((item) => item !== handler));
    }
  } as unknown as PlayerEngine;
};

const bridgeStub = (): PrismNativeBridge => ({
  getSystemVolume: async () => ({ volume: 1, supported: false }),
  getBrightness: async () => ({ brightness: 1, supported: false }),
  setSystemVolume: async () => ({ volume: 1, supported: false }),
  setBrightness: async () => ({ brightness: 1, supported: false }),
  setKeepScreenOn: async () => undefined,
  startBackgroundAudio: async () => undefined,
  stopBackgroundAudio: async () => undefined,
  setSecureScreen: async () => false,
  onCallState: (_listener: (state: CallState) => void) => () => undefined
} as unknown as PrismNativeBridge);

/** 把真中枢接到真播放器宿主上：这里证的是"触发点存在且只在离场时触发"，不是中枢内部逻辑。 */
function wired(detail = detailOf()) {
  const pipe = harness([row()]);
  const mount = document.createElement('div');
  document.body.replaceChildren(mount);
  const api = {
    title: async () => detail,
    playback: async (episodeId: number) => ({ episodeId, url: 'https://play.prismos.org/proxy/m3u8/h1', mimeType: 'application/vnd.m3u8+playlist', durationSeconds: 300 })
  };
  const host = createPlayerHost({
    mount, bridge: bridgeStub(), api, engine: async () => engineStub(),
    onProgress: pipe.sync.onProgress,
    onExit: (report) => void pipe.sync.reportExit(report),
    allowBackgroundAudio: () => false,
    onPrivacyChange: () => undefined
  });
  return { host, pipe, mount };
}

describe('AC-30 离场触发一：播放器销毁上报刚结束的断点', () => {
  it('AC-30 节点 ①：关闭播放器才产生一次 keepalive 上报，播放期间零请求', async () => {
    const { host, pipe } = wired();
    expect(await host.open('c1')).toBe(true);
    for (let index = 0; index < 30; index += 1) {
      pipe.sync.onProgress(row({ position_seconds: 40 + index }), { contentId: 'c1', channelId: 'drama' });
    }
    await flushMicrotasks();
    expect(pipe.calls).toHaveLength(0);
    host.close();
    await flushMicrotasks();
    expect(posted(pipe.calls)).toHaveLength(1);
    expect(pipe.calls[0].keepalive).toBe(true);
    expect(JSON.parse(pipe.calls[0].body ?? '{}').history).toMatchObject({ contentId: 'c1', episodeNumber: 1 });
  });

  it('AC-30 节点 ①：退出按钮与系统返回同径——销毁钩子只报一次，重复 close 不重报', async () => {
    const { host, pipe, mount } = wired();
    await host.open('c1');
    await flushMicrotasks();
    mount.querySelector<HTMLButtonElement>('.prism-player-host__exit')?.click();
    await flushMicrotasks();
    host.close();
    host.close();
    await flushMicrotasks();
    expect(posted(pipe.calls)).toHaveLength(1);
  });

  it('AC-30 节点 ①：关闭私密剧目播放器零网络、零落盘，并如实出声', async () => {
    const { host, pipe } = wired(detailOf({ isPrivate: true, channelId: 'private' }));
    await host.open('c1');
    await flushMicrotasks();
    pipe.calls.length = 0;
    pipe.notices.length = 0;
    host.close();
    await flushMicrotasks();
    expect(pipe.calls).toHaveLength(0);
    expect(pipe.ops).toEqual([]);
    expect(pipe.notices.join('|')).toContain('个人探索的断点不会离开本机');
  });

  it('AC-30 节点 ①：未开播就关闭不产生任何上报（open 内部的先关后开同理）', async () => {
    const { host, pipe } = wired();
    host.close();
    expect(pipe.calls).toHaveLength(0);
    expect(await host.open('c1')).toBe(true);
    pipe.calls.length = 0;
    // `open()` 先关后开：这一条关闭同样是一个离场触发，且只报一次，绝不因换集重入而重复上报。
    expect(await host.open('c1')).toBe(true);
    await flushMicrotasks();
    expect(posted(pipe.calls)).toHaveLength(1);
    host.close();
    await flushMicrotasks();
    expect(posted(pipe.calls)).toHaveLength(2);
  });
});

describe('AC-30 离场触发二与拉取口：挂起上报与【追剧】静默合并', () => {
  it('AC-30 节点 ②：Web 宿主下挂起监听退化为 no-op，绝不在播放期发出心跳', async () => {
    const pipe = harness([row()]);
    const undo = await pipe.sync.observeBackground(() => void pipe.sync.reportExit(pipe.sync.lastBreakpoint()));
    pipe.sync.onProgress(row({ position_seconds: 88 }), { contentId: 'c1', channelId: 'drama' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pipe.calls).toHaveLength(0);
    expect(await pipe.sync.reportExit(pipe.sync.lastBreakpoint())).toBe(true);
    expect(posted(pipe.calls)).toHaveLength(1);
    expect(JSON.parse(posted(pipe.calls)[0].body ?? '{}').history).toMatchObject({ positionSeconds: 88 });
    undo();
  });

  it('AC-30 节点 ②：私密播放中切后台，内存里没有该断点，上报载荷的 history 为空', async () => {
    const pipe = harness([row()]);
    pipe.sync.onProgress(row({ content_id: 'pv', title: '私密剧' }), { contentId: 'pv', isPrivate: true });
    expect(pipe.sync.lastBreakpoint()).toBeNull();
    await pipe.sync.reportExit(null);
    expect(JSON.parse(posted(pipe.calls)[0].body ?? '{}').history).toBeNull();
    expect(pipe.calls[0].url).not.toContain('pv');
  });

  function historySetup(report: MergeReport | null, mode: { unavailable?: boolean; fail?: boolean } = {}) {
    const local = row({ content_id: 'd1', title: '本机剧', last_episode_number: 4, position_seconds: 60, duration_seconds: 300, updated_at: 1000 });
    const rows = mode.unavailable ? [] : [local];
    const history: HistoryReader = {
      available: async () => mode.unavailable !== true && true,
      list: async () => rows,
      clear: async () => undefined
    };
    const cache: CacheUsage = { measure: async () => ({ usedBytes: 1, limitBytes: 2 }), clearPublicCache: async () => ({ clearedBytes: 0, domains: ['public-cache'] }) };
    const credentials: CredentialWriter = { readGrant: async () => null, clearGrant: async () => undefined };
    const api = { related: async (): Promise<RelatedResponse> => ({ items: [] }) } as unknown as HistoryApi;
    let stateWhenPulled: string | undefined;
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const pullRemote = vi.fn(async () => {
      stateWhenPulled = root.querySelector<HTMLElement>('[data-el="band-resume"]')?.dataset.state;
      if (mode.fail === true) throw new Error('offline');
      return report;
    });
    const view = createHistoryView({ api, history, cache, credentials, root, onOpenTitle: () => undefined, onResume: () => undefined, now: () => 2000, pullRemote });
    return { view, root, pullRemote, local, stateWhenPulled: () => stateWhenPulled };
  }

  const mergedReport = (rows: WatchHistoryRow[]): MergeReport => ({ merged: 1, unresolved: [], rows });

  it('AC-30 进入【追剧】Tab 静默拉取一次，并按合并结果重绘【正在追】', async () => {
    const cloudRow = row({ last_episode_number: 18, position_seconds: 610, duration_seconds: 700, updated_at: 1900 });
    const { view, root, pullRemote } = historySetup(mergedReport([cloudRow]));
    await view.mount();
    expect(pullRemote).toHaveBeenCalledTimes(1);
    await flushMicrotasks();
    expect(root.querySelector<HTMLElement>('[data-el="band-resume"]')?.dataset.state).toBe('ready');
    expect(root.textContent).toContain('第 18 集');
    expect(root.textContent).not.toContain('第 4 集');
  });

  it('AC-30 拉取是静默的：本机断点先照常渲染完毕，网络回来才重绘，不新增阻塞式 loading 带', async () => {
    const { view, root, stateWhenPulled } = historySetup(mergedReport([row({ position_seconds: 12 })]));
    await view.mount();
    expect(stateWhenPulled()).toBe('ready');
    await flushMicrotasks();
    expect(root.querySelector<HTMLElement>('[data-el="band-resume"]')?.dataset.state).toBe('ready');
  });

  it('AC-30 拉取失败不影响本机视图：断点原样呈现，不谎报已同步', async () => {
    const { view, root } = historySetup(null, { fail: true });
    await view.mount();
    await flushMicrotasks();
    expect(root.querySelector<HTMLElement>('[data-el="band-resume"]')?.dataset.state).toBe('ready');
    expect(root.textContent).toContain('第 4 集');
    expect(root.textContent).not.toContain('已同步');
  });

  it('AC-30 历史库不可用时不拉取云端：disabled 路径零网络、零合并', async () => {
    const { view, root, pullRemote } = historySetup(mergedReport([row()]), { unavailable: true });
    await view.mount();
    expect(pullRemote).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLElement>('[data-el="band-resume"]')?.dataset.state).toBe('disabled');
  });

  it('AC-30 云端较新值经真闸门写入本机历史，本机较新时原样保留', async () => {
    const history = fakeHistory([row({ updated_at: 1000, position_seconds: 10 })]);
    const pipe = harness([], { success: true, history: [{ contentId: 'c1', episodeNumber: 12, positionSeconds: 500, durationSeconds: 600, updatedAt: 2000 }], preferences: null }, { history, token: TOKEN });
    const merged = await pipe.sync.pull();
    expect(merged?.merged).toBe(1);
    expect(history.rows.get('c1')).toMatchObject({ position_seconds: 500, updated_at: 2000 });
    const newer = fakeHistory([row({ updated_at: 9999, position_seconds: 22 })]);
    const kept = harness([], { success: true, history: [{ contentId: 'c1', episodeNumber: 12, positionSeconds: 500, durationSeconds: 600, updatedAt: 2000 }], preferences: null }, { history: newer });
    expect((await kept.sync.pull())?.merged).toBe(0);
    expect(newer.rows.get('c1')?.position_seconds).toBe(22);
  });
});
