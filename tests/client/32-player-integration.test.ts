// @vitest-environment jsdom
/**
 * 播放器宿主生命周期（AC-02-6 / AC-15）：起播、断点上报、异常态文案与私密缺失卡。
 * The real ArtPlayer/hls.js path is device-only; everything else in the lifecycle is proven here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/core/api/client';
import type { TitleDetail } from '../../edge/src/types/api';
import { detailOf, settle, setup, STREAM } from './player-harness';

afterEach(() => vi.restoreAllMocks());
describe('起播、异常态与断点上报', () => {
  it('loads the resolved url, resumes at the breakpoint and hands the row to the sink', async () => {
    const h = setup();
    await h.player.load(11, 30); await settle();
    expect(h.state.sources).toEqual([STREAM]);
    expect(h.player.state()).toMatchObject({ phase: 'ready', episodeId: 11, contentId: 'c1', isPrivate: false, durationSeconds: 100, positionSeconds: 30 });
    const [row, context] = h.progress.mock.calls[0] as [Record<string, unknown>, Record<string, unknown>];
    expect(h.progress).toHaveBeenCalledTimes(1);
    expect(row).toMatchObject({ content_id: 'c1', last_episode_id: 11, last_episode_number: 1, position_seconds: 30, duration_seconds: 100, total_episodes: 3 });
    expect(context).toMatchObject({ isPrivate: false, channelId: 'drama', contentId: 'c1', episodeTotal: 3 });
    expect(h.q('.prism-player__state')?.hasAttribute('hidden')).toBe(true);
  });

  it('503 无源 is retryable and retry re-resolves; a refused progress write is surfaced, not swallowed', async () => {
    const h = setup();
    h.api.playback.mockRejectedValueOnce(new ApiError('SERVICE_UNAVAILABLE', 503, '暂无可用源'));
    await h.player.load(11); await settle();
    expect(h.player.state()).toMatchObject({ phase: 'error', errorKind: 'retryable' });
    expect(h.text()).toContain('暂无可用播放源');
    expect(h.q<HTMLElement>('.prism-player__retry')?.hidden).toBe(false);
    h.q<HTMLElement>('.prism-player__retry')?.click(); await settle();
    expect(h.api.playback).toHaveBeenCalledTimes(2);
    expect(h.player.state().phase).toBe('ready');
    const blocked = setup({ onProgress: () => { throw new Error('个人探索内容禁止落盘'); } });
    await blocked.player.load(11); await settle();
    expect(blocked.failures.filter((failure) => failure.kind === 'progress-blocked')).toHaveLength(1);
    expect(blocked.player.state().phase).toBe('ready');
  });

  it('断网 says 需要网络 instead of pretending offline playback works (AC-15)', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const h = setup({ allowBackgroundAudio: true });
    h.api.playback.mockRejectedValueOnce(new ApiError('NETWORK_ERROR', 0, '网络不可用'));
    await h.player.load(11); await settle();
    expect(h.player.state().errorKind).toBe('offline');
    expect(h.text()).toContain('需要网络');
    expect(h.failures.at(-1)).toMatchObject({ kind: 'offline' });
    expect(h.calls.startBackground).toHaveLength(0);
  });

  it('applies the configured 2x rate on open, metadata reset and the next episode', async () => {
    const h = setup({ playbackPreferences: { normalRate: () => 2 } });
    await h.player.load(11); await settle();
    expect(h.state.rate).toBe(2);
    h.state.rate = 1; h.fire('loadedmetadata');
    expect(h.state.rate).toBe(2);
    await h.player.load(12); await settle();
    expect(h.state.rate).toBe(2);
    h.player.destroy();
  });
  it('private and unknown both render the same missing card, leaking nothing (AC-02-6)', async () => {
    const render = async (detail?: TitleDetail) => {
      const h = setup(detail === undefined ? {} : { detail, titleId: detail.item.id });
      h.api.playback.mockRejectedValue(new ApiError('NOT_FOUND', 404, '内容不存在'));
      await h.player.load(11); await settle();
      return h;
    };
    const known = await render();
    const secret = await render(detailOf({ isPrivate: true, channelId: 'private', shareable: false }));
    expect(known.player.state().errorKind).toBe('missing');
    expect(secret.player.state()).toMatchObject({ errorKind: 'missing', isPrivate: true });
    expect(secret.q('.prism-player__state-title')?.textContent).toBe(known.q('.prism-player__state-title')?.textContent);
    expect(secret.q('.prism-player__state-copy')?.textContent).toBe(known.q('.prism-player__state-copy')?.textContent);
    expect(secret.q<HTMLElement>('.prism-player__retry')?.hidden).toBe(true);
  });
});
