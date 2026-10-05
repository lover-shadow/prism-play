// @vitest-environment jsdom
/**
 * A-7.4 / A-7.5 直连起播、线路切换与失败记账（SPEC-APP-REFACTOR A-7）。
 *
 * 钉的是"地址到底给了谁"：清单在场时内核拿到的必须是上游 `mediaUrl`，且**一次代理请求都不发**
 * （AC-A7-2 的"播放期间云端无流媒体转发请求"在单测里的可证形式就是这条断言）；清单缺席才回退。
 * 切换上限、断点跟随、同一故障不重复消耗额度、私密剧目不产生遥测，都在这一组里。
 * 假内核沿用 `player-harness.ts` 那份唯一真相，测试替身不许有第二份。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TitleDetail, TitleManifest } from '../../edge/src/types/api';
import { setup, settle, STREAM } from './player-harness';
import { ApiError } from '../../src/core/api/client';
import { clearLineTelemetry, pendingLineSignals } from '../../src/core/native/telemetry';
import { classifyHlsFailure, classifyMediaError } from '../../src/player/art-engine';

const LINE_URLS = ['https://cdn.invalid/a.m3u8', 'https://cdn.invalid/b.m3u8', 'https://cdn.invalid/c.m3u8', 'https://cdn.invalid/d.m3u8'];

const manifestOf = (over: Partial<TitleManifest> = {}): TitleManifest => ({
  workId: 'c1', title: '测试剧', channelId: 'drama', isPrivate: false, generatedAt: 1_780_000_000,
  episodes: [
    { episodeNumber: 1, durationSeconds: 100, lines: LINE_URLS.map((url, index) => ({ providerId: `provider_s${index + 1}`, mediaUrl: url })) },
    { episodeNumber: 2, durationSeconds: 100, lines: [{ providerId: 'provider_m1', mediaUrl: LINE_URLS[1] }, { providerId: 'provider_m2', mediaUrl: LINE_URLS[2] }] },
    { episodeNumber: 3, durationSeconds: 100, lines: [] }
  ],
  ...over
});

const LEGACY = { item: { id: 'c1', channelId: 'drama', title: '测试剧', category: '都市', isPrivate: false }, episodes: [{ episodeId: 11, episodeNumber: 1 }] } as unknown as TitleDetail;

/** 每例一只干净的播放器：线路缓存与遥测队列都是进程内的，必须逐例复位。 */
function wired(options: { manifest?: TitleManifest | TitleDetail | null; detail?: TitleDetail; titleId?: string } = {}) {
  const manifest = options.manifest === undefined ? manifestOf() : options.manifest;
  const api = {
    title: vi.fn(async () => options.detail ?? { item: { id: 'c1', channelId: 'drama', title: '测试剧', category: '都市', isPrivate: false }, episodes: [{ episodeId: 11, episodeNumber: 1, durationSeconds: 100 }, { episodeId: 12, episodeNumber: 2, durationSeconds: 100 }] } as unknown as TitleDetail),
    playback: vi.fn(async (episodeId: number) => ({ episodeId, url: STREAM, mimeType: 'application/vnd.m3u8+playlist', durationSeconds: 100 })),
    // 故意把旧云端的 `TitleDetail` 从"清单"口喂进来：这正是 Track 2 尚未切换时线上真实会回来的形状。
    ...(manifest === null ? {} : { titleManifest: vi.fn(async () => manifest as TitleManifest) })
  };
  // 唯一 titleId：清单缓存是进程内单例，复用 id 会让上一例的缓存假装成这一例的事实。
  return { ...setup({ api, titleId: options.titleId ?? `t${Math.random().toString(36).slice(2, 8)}`, detail: options.detail }), api };
}

beforeEach(() => { clearLineTelemetry(); });

describe('A-7.2 起播地址：清单优先，代理回退', () => {
  it('AC-A7-1/2 直连上游 mediaUrl 起播，播放期间零代理请求', async () => {
    const h = wired();
    await h.player.load(11);
    await settle();
    expect(h.state.sources).toEqual([LINE_URLS[0]]);
    expect(h.api.playback).not.toHaveBeenCalled();
    expect(h.player.state()).toMatchObject({ phase: 'ready', lineIndex: 0 });
  });

  it('AC-A7-2 调用方没给 titleManifest 时退回代理句柄，界面不白屏', async () => {
    const h = wired({ manifest: null });
    await h.player.load(11);
    await settle();
    expect(h.state.sources).toEqual([STREAM]);
    expect(h.api.playback).toHaveBeenCalledWith(11);
    expect(h.player.state().lineIndex).toBeNull();
  });

  it('AC-A7-2 旧云端仍返回 TitleDetail：整份清单作废，回退链接管', async () => {
    const h = wired({ manifest: LEGACY });
    await h.player.load(11);
    await settle();
    expect(h.state.sources).toEqual([STREAM]);
    expect(h.player.state().lineIndex).toBeNull();
  });

  it('A-7.2 私密与未知共用同一张 404 卡，不泄露任何元信息（AC-02-6）', async () => {
    const h = wired({ manifest: null });
    h.api.playback.mockRejectedValueOnce(new ApiError('NOT_FOUND', 404, '内容不存在'));
    await h.player.load(11);
    await settle();
    expect(h.root.querySelector('.prism-player__state')).not.toBeNull();
    expect(h.text()).toContain('内容不存在或已下架');
  });

  it('A-7.2 该集清单里线路为空（源站巡检中）时按集退回代理句柄，而不是报"无可用源"', async () => {
    const detail = { item: { id: 'c1', channelId: 'drama', title: '测试剧', category: '都市', isPrivate: false }, episodes: [
      { episodeId: 11, episodeNumber: 1, durationSeconds: 100 }, { episodeId: 13, episodeNumber: 3, durationSeconds: 100 }
    ] } as unknown as TitleDetail;
    const h = wired({ detail });
    await h.player.load(13);
    await settle();
    expect(h.state.sources).toEqual([STREAM]);
    expect(h.api.playback).toHaveBeenCalledWith(13);
    expect(h.player.state()).toMatchObject({ phase: 'ready', lineIndex: null });
  });

  it('A-7.2 切集后线路重算：第二集用第二集的线路表', async () => {
    const h = wired();
    await h.player.load(11);
    await settle();
    await h.player.load(12);
    await settle();
    expect(h.state.sources).toEqual([LINE_URLS[0], LINE_URLS[1]]);
    expect(h.player.state().lineIndex).toBe(0);
  });
});

describe('A-7.4 失败切换：lines[0] 之后最多再切两条', () => {
  it('AC-A7-4 依次切到第二条、第三条，第四条起播失败即落诚实错误态', async () => {
    const h = wired();
    await h.player.load(11);
    await settle();
    h.fire('error'); await settle();
    expect(h.state.sources[1]).toBe(LINE_URLS[1]);
    h.clock.advance(2_000);
    h.fire('error'); await settle();
    expect(h.state.sources[2]).toBe(LINE_URLS[2]);
    expect(h.player.state().lineIndex).toBe(2);
    h.clock.advance(2_000);
    h.fire('error'); await settle();
    expect(h.state.sources).toHaveLength(3);
    expect(h.player.state()).toMatchObject({ phase: 'error', errorKind: 'retryable', lineIndex: null });
    expect(h.failures.map((entry) => entry.kind)).toContain('media');
  });

  it('A-7.4 每条失败就地记一条遥测，且只记三条（切换上限即尝试上限）', async () => {
    const h = wired();
    await h.player.load(11);
    await settle();
    for (const wait of [0, 2_000, 2_000, 2_000]) { if (wait > 0) h.clock.advance(wait); h.fire('error'); await settle(); }
    expect(pendingLineSignals().map((entry) => entry.lineIndex)).toEqual([0, 1, 2]);
    expect(pendingLineSignals().map((entry) => entry.providerId)).toEqual(['provider_s1', 'provider_s2', 'provider_s3']);
    expect(pendingLineSignals().every((entry) => entry.failureCode === 'http_error')).toBe(true);
  });

  it('A-7.4 同一次故障的连发事件只消耗一条备用线路', async () => {
    const h = wired();
    await h.player.load(11);
    await settle();
    h.fire('error'); await settle();
    h.fire('error'); await settle();
    h.fire('error'); await settle();
    expect(h.state.sources).toHaveLength(2);
    expect(pendingLineSignals()).toHaveLength(1);
  });

  it('A-7.4 切线必须带着断点走，用户不该为源站故障重看一遍', async () => {
    const h = wired();
    await h.player.load(11);
    await settle();
    h.state.t = 42;
    h.player.notifyLeave();
    h.fire('error'); await settle();
    expect(h.state.sources[1]).toBe(LINE_URLS[1]);
    expect(h.state.t).toBe(42);
  });

  it('A-7.4 线路全灭后重试仍从第一条开始', async () => {
    const h = wired({ manifest: manifestOf({ episodes: [{ episodeNumber: 1, lines: [{ providerId: 'provider_s1', mediaUrl: LINE_URLS[0] }] }] }) });
    await h.player.load(11);
    await settle();
    h.fire('error'); await settle();
    expect(h.player.state().phase).toBe('error');
    h.clock.advance(2_000);
    await h.player.load(11);
    await settle();
    expect(h.state.sources).toEqual([LINE_URLS[0], LINE_URLS[0]]);
    expect(h.player.state().lineIndex).toBe(0);
  });

  it('AC-02 私密剧目的线路失败不进遥测队列，切换照做', async () => {
    const secret = { item: { id: 'c1', channelId: 'private', title: '私密剧', category: '都市', isPrivate: true }, episodes: [{ episodeId: 11, episodeNumber: 1, durationSeconds: 100 }] } as unknown as TitleDetail;
    const h = wired({ detail: secret, manifest: manifestOf({ isPrivate: true, channelId: 'private' }) });
    await h.player.load(11);
    await settle();
    h.fire('error'); await settle();
    expect(h.state.sources[1]).toBe(LINE_URLS[1]);
    expect(pendingLineSignals()).toEqual([]);
    expect(h.player.state().isPrivate).toBe(true);
  });
});

describe('A-8 失败分类：内核能给多少就记多少，给不出就保守', () => {
  it('AC-A8-1 hls 明细翻译成 §C-4 的三个失败码', () => {
    expect(classifyHlsFailure('manifestLoadingTimeOut')).toBe('timeout');
    expect(classifyHlsFailure('levelLoadTimeOut')).toBe('timeout');
    expect(classifyHlsFailure('fragParsingError')).toBe('decode_error');
    expect(classifyHlsFailure('bufferAppendError')).toBe('decode_error');
    expect(classifyHlsFailure('manifestLoadError')).toBe('http_error');
    expect(classifyHlsFailure('levelLoadError')).toBe('http_error');
  });

  it('AC-A8-1 MediaError.code 的四种取值各有归属，未知值不编造', () => {
    expect(classifyMediaError(1)).toBe('timeout');
    expect(classifyMediaError(2)).toBe('http_error');
    expect(classifyMediaError(3)).toBe('decode_error');
    expect(classifyMediaError(4)).toBe('http_error');
    expect(classifyMediaError(undefined)).toBeNull();
  });
});

describe('HP-01 ended and source isolation', () => {
  it('a valid play, seek recovery, and ended sequence advances only one episode', async () => {
    const h = wired(); await h.player.load(11);
    h.player.play(); h.fire('seeked'); h.fire('timeupdate'); h.fire('ended'); await settle();
    expect(h.player.state().episodeId).toBe(12);
    h.fire('playing'); h.fire('ended'); await settle();
    expect(h.player.state().episodeId).toBe(12);
    h.player.destroy();
  });
});
