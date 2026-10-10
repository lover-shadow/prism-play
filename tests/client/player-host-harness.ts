// 51 与 HP-03 loading 测试共享的播放宿主夹具：假内核 + 假桥 + 可控延迟的详情端点。
// 存在理由与 `player-harness.ts` 同：SPEC §10 单文件 ≤300 行，测试替身只允许一份真相，禁止复制成两份。
import { vi } from 'vitest';
import { createPlayerHost } from '../../src/player-host';
import type { PlayerHostDeps } from '../../src/player-host';
import type { PlayerEngine } from '../../src/player/engine-seam';
import type { CallState, PrismNativeBridge } from '../../src/core/native/bridge';
import type { PlayerApi } from '../../src/player/player-contract';
import type { TitleDetail } from '../../edge/src/types/api';
import type { WatchHistoryRow } from '../../src/core/storage/storage-domains';
import { detailOf } from './player-harness';

export type FakeEngine = PlayerEngine & { sources: string[]; times: number[]; volumes: number[] };

export function fakeEngine(): FakeEngine {
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

export function host(
  over: Partial<PlayerHostDeps> & {
    detail?: TitleDetail; titleError?: unknown;
    /** 详情闸门：pending 期间界面上必须已经有 loading 宿主（HP-03a）。 */
    titleGate?: Promise<void>;
    /** 按剧目分派的详情应答：用来造 A/B 乱序（HP-03b）。 */
    respondTitle?: (contentId: string) => Promise<TitleDetail>;
  } = {}
) {
  const { detail = detailOf(), titleError, titleGate, respondTitle, ...rest } = over;
  const mount = document.createElement('div');
  document.body.replaceChildren(mount);
  const engine = fakeEngine();
  const calls = { playback: [] as number[], progress: [] as unknown[][], privacy: [] as boolean[], closed: 0, blocked: [] as string[], background: [] as string[] };
  const mockTitle = vi.fn(respondTitle ?? (async () => {
    if (titleGate !== undefined) await titleGate;
    if (titleError !== undefined) throw titleError;
    return detail;
  }));
  const mockPlayback = vi.fn(async (id: number) => { calls.playback.push(id); return { episodeId: id, url: 'https://play.prismos.org/proxy/m3u8/h1', mimeType: 'application/vnd.m3u8+playlist', durationSeconds: 100 }; });
  const api = {
    ...over.api,
    title: (over.api?.title as any) ?? mockTitle,
    playback: (over.api?.playback as any) ?? mockPlayback
  } as PlayerApi & { title: typeof mockTitle; playback: typeof mockPlayback };
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

export const row = (over: Partial<WatchHistoryRow> = {}): WatchHistoryRow => ({
  content_id: 'c1', title: '测试剧', cover_url: null, last_episode_id: 12, last_episode_number: 2,
  position_seconds: 42, duration_seconds: 100, total_episodes: 3, updated_at: 10, ...over
});
