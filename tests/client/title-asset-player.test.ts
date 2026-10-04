// @vitest-environment jsdom
// The real edge response builder also declares an R2 reader; import only its bucket type, not Worker DOM globals.
declare global { type R2Bucket = import('@cloudflare/workers-types').R2Bucket; }
import { describe, expect, it, vi } from 'vitest';
import { titleAssetResponse, type TitleAsset } from '../../edge/src/library/title-asset';
import { PrismApiClient } from '../../src/core/api/client';
import { createHistoryStore, type SqliteStatement } from '../../src/core/storage/history-store';
import type { WatchHistoryRow } from '../../src/core/storage/storage-domains';
import { setup, settle, detailOf } from './player-harness';

function clientFor(episodes: TitleAsset['episodes']) {
  const payload = titleAssetResponse({
    workId: 'asset-regression', title: '边界回归剧', channelId: 'drama', isPrivate: false,
    category: '都市', hasCover: false, generatedAt: 1_800_000_000, episodes
  });
  const fetchImpl = vi.fn(async (_url: string) => new Response(JSON.stringify(payload)));
  return { api: new PrismApiClient({ fetchImpl }), fetchImpl, payload };
}
const episodes: TitleAsset['episodes'] = [2, 1].map((episodeNumber) => ({
  episodeNumber, title: `分集${episodeNumber}`, durationSeconds: 100,
  lines: [{ providerId: 'provider_s1', mediaUrl: `https://cdn.invalid/${episodeNumber}.m3u8` }]
}));

describe('真实 R2 响应 → client → player → history 边界', () => {
  it.each([0, Number.MAX_SAFE_INTEGER + 1, 2])('拒绝非法/重复本地集号 %s，不生成 hash ID', async (episodeNumber) => {
    const { api } = clientFor([{ episodeNumber: 2, lines: [] }, { episodeNumber, lines: [] }]);
    await expect(api.title('asset-regression')).rejects.toMatchObject({ code: 'UNEXPECTED_RESPONSE' });
  });

  it('保留旧 TitleDetail 的 D1 numeric IDs 与代理兜底', async () => {
    const legacy = detailOf();
    const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.includes('/episodes/') ? { episodeId: 12, url: 'https://cdn.invalid/legacy.mp4' } : legacy
    )));
    const api = new PrismApiClient({ fetchImpl });
    expect(await api.title('c1')).toEqual(legacy);
    const h = setup({ api });
    await h.player.load(12);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toContain('/api/episodes/12/playback');
    h.player.destroy();
  });

  it('第二集按钮有限 ID、暂停/离场进入 SQLite 边界，读取断点续播仍选第二集', async () => {
    const { api, fetchImpl, payload } = clientFor(episodes);
    const detail = await api.title(payload.workId);
    expect(detail.episodes.map((episode) => episode.episodeId)).toEqual([1, 2]);
    expect(await api.titleManifest(payload.workId)).toEqual(payload);
    const writes: SqliteStatement[] = [];
    let saved: WatchHistoryRow | null = null;
    const history = createHistoryStore({ sqlite: {
      isConnected: async () => true, open: async () => {}, close: async () => {},
      executeSet: async (_db, statements) => { writes.push(...statements); },
      queryResult: async <T extends Record<string, unknown>>() => saved === null ? [] : [saved as unknown as T]
    } });
    const pending: Promise<WatchHistoryRow>[] = [];
    const h = setup({ api, titleId: payload.workId, detail, onProgress: (row, context) => {
      pending.push(history.upsertWatch({
        ...context, contentId: row.content_id, title: row.title, coverUrl: row.cover_url,
        lastEpisodeId: row.last_episode_id, lastEpisodeNumber: row.last_episode_number,
        positionSeconds: row.position_seconds, durationSeconds: row.duration_seconds,
        totalEpisodes: row.total_episodes, updatedAt: row.updated_at
      }).then((result) => { saved = result; return result; }));
    } });
    await h.player.load(1);
    h.player.openDrawer();
    const buttons = [...h.root.querySelectorAll<HTMLButtonElement>('.prism-drawer__item')];
    expect(buttons.map((button) => button.dataset['episodeId'])).toEqual(['1', '2']);
    buttons[1].click();
    await vi.waitFor(() => expect(h.player.state()).toMatchObject({ phase: 'ready', episodeId: 2 }));
    expect(h.state.sources.at(-1)).toBe('https://cdn.invalid/2.m3u8');
    h.state.t = 37; h.fire('pause');
    h.state.t = 42; h.player.notifyLeave();
    await Promise.all(pending);
    const resume = await history.getWatch(payload.workId);
    expect(resume).toMatchObject({ last_episode_id: 2, last_episode_number: 2, position_seconds: 42 });
    const values = writes.filter((write) => write.statement.startsWith('INSERT')).map((write) => write.values);
    expect(values.slice(-2).map((value) => [value[3], value[4], value[5]])).toEqual([[2, 2, 37], [2, 2, 42]]);
    expect(values.every((value) => Number.isFinite(value[3]))).toBe(true);
    h.player.destroy();
    const resumed = setup({ api, titleId: payload.workId, detail: await api.title(payload.workId) });
    await resumed.player.load(resume!.last_episode_id, history.resumePosition(resume!));
    expect(resumed.state.sources).toEqual(['https://cdn.invalid/2.m3u8']);
    expect(resumed.state.t).toBe(42);
    expect(fetchImpl.mock.calls.every(([url]) => !url.includes('/api/episodes/'))).toBe(true);
    expect(h.failures.filter((failure) => failure.kind === 'progress-blocked')).toEqual([]);
    resumed.player.destroy();
  });

  it('播放器自行拉详情也携带 local 身份，第二集不会匹配第一集', async () => {
    const { api, fetchImpl, payload } = clientFor(episodes);
    const h = setup({ api, titleId: payload.workId });
    await h.player.load(2, 17);
    expect(h.state.sources).toEqual(['https://cdn.invalid/2.m3u8']);
    expect(h.state.t).toBe(17);
    expect(h.progress.mock.calls[0][0]).toMatchObject({ last_episode_id: 2, last_episode_number: 2 });
    expect(fetchImpl.mock.calls.every(([url]) => !url.includes('/api/episodes/'))).toBe(true);
    h.player.destroy();
  });

  it.each(['empty', 'missing', 'offline', 'no-method'] as const)('local ID 不进入 D1 playback：%s', async (mode) => {
    const { api, fetchImpl, payload } = clientFor([{ episodeNumber: 2, lines: [] }]);
    const detail = await api.title(payload.workId);
    if (mode === 'missing') api.titleManifest = async () => ({ ...payload, episodes: [] });
    if (mode === 'offline') api.titleManifest = async () => { throw new Error('offline'); };
    const playerApi = mode === 'no-method'
      ? { title: api.title.bind(api), playback: api.playback.bind(api) } : api;
    const h = setup({ api: playerApi, titleId: payload.workId, detail });
    await h.player.load(2); await settle();
    expect(h.player.state().phase).toBe('error');
    expect(h.state.sources).toEqual([]);
    expect(fetchImpl.mock.calls.every(([url]) => !url.includes('/api/episodes/'))).toBe(true);
    h.player.destroy();
  });
});
