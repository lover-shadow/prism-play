// @vitest-environment jsdom
/**
 * A-7.5 投屏直连：电视拿到的应该是手机上正在播的那条上游地址。
 *
 * 电视自己取流，既没有 WebView 的 CORS 问题，也不占 Workers 的转发配额；因此这里钉三件事：
 *   • 清单在场 → 推的是 `mediaUrl`，一次 `api.playback()` 都不发；
 *   • 清单缺席 / 该集没有线路 / 线路是 http（原生 `LanAddressPolicy` 与 `requireCastableStreamUrl`
 *     都只放过公网 https）→ **退回代理句柄**，这是能力缺席而不是失败，投屏照常成立；
 *   • 投屏面板够不到 `PrismApiClient`，只能复用播放器装好的那一份清单缓存——两处必须同源，
 *     否则"手机在播第三条线、电视被推到第一条线"这种错位又会长出第二个权威。
 * 面板本身的状态机用例在 `35-cast-panel.test.ts`，本文件不重复那一套假桥。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TitleDetail, TitleManifest } from '../../edge/src/types/api';
import { createLineAwareCastStreamSource, defaultCastStreamSource } from '../../src/player/cast-ports';
import { activeTitleManifestStore, createTitleManifestStore, installTitleManifestStore } from '../../src/player/title-manifest';
import { setup, settle, STREAM } from './player-harness';

const PROXY = 'https://play.prismos.org/proxy/m3u8/h1';
const DIRECT = ['https://cdn.invalid/a.m3u8', 'https://cdn.invalid/b.m3u8'];

const episodes = [{ episodeId: 11, episodeNumber: 1, durationSeconds: 100 }, { episodeId: 12, episodeNumber: 2, durationSeconds: 100 }];

/** 一只只装清单的假缓存盘：本文件测的是取流口，不测落盘。 */
const storeOf = (manifest: TitleManifest | null) => {
  const api = manifest === null ? {} : { titleManifest: async () => manifest };
  return installTitleManifestStore(createTitleManifestStore({ api, disk: null }));
};

const manifestOf = (lines: Record<number, Array<{ providerId: string; mediaUrl: string }>>): TitleManifest => ({
  workId: 'c1', title: '测试剧', channelId: 'drama', isPrivate: false, generatedAt: 1_780_000_000,
  episodes: Object.entries(lines).map(([number, entry]) => ({ episodeNumber: Number(number), lines: entry }))
});

beforeEach(() => { storeOf(null); });

describe('A-7.5 大屏取流口：直连优先，代理兜底', () => {
  it('AC-A7-5 清单在场时推上游地址，并按后缀给出 MIME', async () => {
    const store = storeOf(manifestOf({ 1: [{ providerId: 'provider_s1', mediaUrl: DIRECT[0] }], 2: [{ providerId: 'provider_s2', mediaUrl: DIRECT[1] }] }));
    const source = createLineAwareCastStreamSource({ workId: () => 'c1', episodes, store: () => store, fallback: async () => ({ url: PROXY }) });
    expect(await source(11)).toMatchObject({ url: DIRECT[0], mimeType: 'application/vnd.m3u8+playlist' });
    expect((await source(12)).url).toBe(DIRECT[1]);
  });

  it('AC-A7-5 清单缺席（旧云端 / 断网）退回代理句柄，投屏不许因为直连改造而变瞎', async () => {
    const fallback = vi.fn(async () => ({ url: PROXY, mimeType: 'application/vnd.apple.mpegurl' }));
    const source = createLineAwareCastStreamSource({ workId: () => 'c1', episodes, store: () => storeOf(null), fallback });
    expect(await source(11)).toMatchObject({ url: PROXY });
    expect(fallback).toHaveBeenCalledWith(11);
  });

  it('AC-A7-5 http 切片推给电视会被原生与 TS 两道闸门拒掉，因此直接选下一条公网 https 线路', async () => {
    const store = storeOf(manifestOf({ 1: [
      { providerId: 'provider_s1', mediaUrl: 'http://cdn.invalid/a.m3u8' },
      { providerId: 'provider_s2', mediaUrl: DIRECT[1] },
      { providerId: 'provider_s3', mediaUrl: 'https://192.168.31.9/x.m3u8' }
    ] }));
    const source = createLineAwareCastStreamSource({ workId: () => 'c1', episodes, store: () => store, fallback: async () => ({ url: PROXY }) });
    expect((await source(11)).url).toBe(DIRECT[1]);
  });

  it('AC-A7-5 全是 http / 全是局域网时退回代理句柄，而不是推一条注定被拒的地址', async () => {
    const store = storeOf(manifestOf({ 1: [{ providerId: 'provider_s1', mediaUrl: 'http://cdn.invalid/a.m3u8' }] }));
    const fallback = vi.fn(async () => ({ url: PROXY }));
    const source = createLineAwareCastStreamSource({ workId: () => 'c1', episodes, store: () => store, fallback });
    expect((await source(11)).url).toBe(PROXY);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('AC-A7-5 该集不在线路表里（更新中的剧）按清单缺席处理，未知集数也不抛错', async () => {
    const store = storeOf(manifestOf({ 1: [{ providerId: 'provider_s1', mediaUrl: DIRECT[0] }] }));
    const fallback = vi.fn(async () => ({ url: PROXY }));
    const source = createLineAwareCastStreamSource({ workId: () => 'c1', episodes, store: () => store, fallback });
    expect((await source(99)).url).toBe(PROXY);
    expect((await source(12)).url).toBe(PROXY);
  });

  it('A-7.5 缺省回退仍是那条代理句柄接口：`defaultCastStreamSource` 没被改成第二套地址来源', async () => {
    const source = defaultCastStreamSource();
    expect(typeof source).toBe('function');
    const store = storeOf(manifestOf({ 1: [{ providerId: 'provider_s1', mediaUrl: DIRECT[0] }] }));
    const aware = createLineAwareCastStreamSource({ workId: () => 'c1', episodes, store: () => store });
    expect((await aware(11)).url).toBe(DIRECT[0]);
  });

  it('AC-A7-5 大屏与手机同源：播放器装好的那份清单就是投屏读的那一份', async () => {
    const detail = { item: { id: 'c1', channelId: 'drama', title: '测试剧', category: '都市', isPrivate: false }, episodes } as unknown as TitleDetail;
    const api = {
      title: async () => detail,
      playback: vi.fn(async (episodeId: number) => ({ episodeId, url: STREAM, mimeType: 'application/vnd.m3u8+playlist', durationSeconds: 100 })),
      titleManifest: async () => manifestOf({ 1: [{ providerId: 'provider_s1', mediaUrl: DIRECT[0] }] })
    };
    const h = setup({ api, detail, titleId: 'c1' });
    await h.player.load(11);
    await settle();
    expect(h.state.sources).toEqual([DIRECT[0]]);
    expect(activeTitleManifestStore()).not.toBeNull();
    const source = createLineAwareCastStreamSource({ workId: () => 'c1', episodes });
    expect((await source(11)).url).toBe(DIRECT[0]);
  });
});
