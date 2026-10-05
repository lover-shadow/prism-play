// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setup, detailOf } from './player-harness';
import type { EngineContext, PlayerEngine, MediaEvent } from '../../src/player/engine-seam';
import type { TitleManifest } from '../../edge/src/types/api';

const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function media(context: EngineContext) {
  const video = document.createElement('video'); context.container.append(video);
  const queued = new Map<MediaEvent, (() => void)[]>();
  let position = 0, volume = 1, rate = 1, playing = false;
  const live: PlayerEngine = {
    play: () => { playing = true; video.dispatchEvent(new Event('play')); },
    pause: () => { playing = false; video.dispatchEvent(new Event('pause')); },
    playing: () => playing, currentTime: () => position, duration: () => 100,
    setCurrentTime: (v) => { position = v; }, volume: () => volume, setVolume: (v) => { volume = v; },
    playbackRate: () => rate, setPlaybackRate: (v) => { rate = v; },
    setSource: vi.fn(), toggleControls: vi.fn(),
    destroy: vi.fn(() => { video.remove(); }),
    on: (event, handler) => {
      queued.set(event, [...(queued.get(event) ?? []), handler]);
      video.addEventListener(event, handler);
      return () => video.removeEventListener(event, handler);
    }
  };
  return { live, video, fatal: () => context.onError('late fatal'),
    late: (event: MediaEvent) => { video.dispatchEvent(new Event(event)); for (const handler of queued.get(event) ?? []) handler(); } };
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function isolated(delayed = false, direct = false) {
  const instances: ReturnType<typeof media>[] = [];
  const pending: ReturnType<typeof deferred<PlayerEngine>>[] = [];
  const factory = vi.fn((context: EngineContext) => {
    const instance = media(context); instances.push(instance);
    if (!delayed) return instance.live;
    const task = deferred<PlayerEngine>(); pending.push(task); return task.promise;
  });
  const manifest: TitleManifest = {
    workId: 'c1', title: '测试剧', channelId: 'drama', isPrivate: false, generatedAt: 1,
    episodes: [1, 2, 3].map((episodeNumber) => ({ episodeNumber, lines: [0, 1, 2].map((n) => ({ providerId: `provider_s${n}`, mediaUrl: `https://cdn.invalid/${episodeNumber}/${n}.m3u8` })) }))
  };
  const boundary = vi.fn(), change = vi.fn();
  const h = setup({ detail: detailOf(), engine: factory, allowBackgroundAudio: true, onNaturalBoundary: boundary, onEpisodeChange: change,
    ...(direct ? { api: { title: vi.fn(async () => detailOf()), playback: vi.fn(), titleManifest: vi.fn(async () => manifest) } } : {}) });
  cleanups.push(() => h.player.destroy());
  return { ...h, instances, pending, factory, boundary, change };
}

describe('player source instance isolation', () => {
  it('destroys the outgoing video and ignores its queued playing/ended/error/timeupdate/fatal', async () => {
    const h = isolated(); await h.player.load(11);
    const old = h.instances[0]; old.live.play(); old.live.setCurrentTime(48);
    await h.player.load(12);
    expect(h.instances).toHaveLength(2);
    expect(old.live.destroy).toHaveBeenCalledOnce(); expect(old.video.isConnected).toBe(false);
    expect(h.progress.mock.calls.some(([value]) => value.last_episode_id === 11 && value.position_seconds === 48)).toBe(true);
    const reports = h.progress.mock.calls.length, errors = h.failures.length;
    h.clock.advance(6_000);
    for (const event of ['playing', 'ended', 'error', 'timeupdate'] as const) old.late(event);
    old.fatal(); await flush();
    expect(h.player.state()).toMatchObject({ episodeId: 12, phase: 'ready', positionSeconds: 0 });
    expect(h.progress).toHaveBeenCalledTimes(reports); expect(h.failures).toHaveLength(errors);
    expect(h.boundary).not.toHaveBeenCalled();
    h.instances[1].late('ended'); await flush(); expect(h.player.state().episodeId).toBe(12);
    h.instances[1].live.play(); h.instances[1].late('ended'); await flush(); expect(h.player.state().episodeId).toBe(13);
    expect(h.change.mock.calls.map(([ep]) => ep.episodeId)).toEqual([11, 12, 13]);
  });

  it.each(['A-first', 'B-first'])('discards asynchronous creations resolved %s', async (order) => {
    const h = isolated(true); const a = h.player.load(11); await flush();
    const b = h.player.load(12); await flush(); expect(h.pending).toHaveLength(2);
    const sequence = order === 'A-first' ? [0, 1] : [1, 0];
    for (const n of sequence) { h.pending[n].resolve(h.instances[n].live); await flush(); }
    await Promise.all([a, b]);
    expect(h.instances[0].live.destroy).toHaveBeenCalledOnce();
    expect(h.instances[0].live.setSource).not.toHaveBeenCalled();
    expect(h.instances[1].live.setSource).toHaveBeenCalledOnce();
    h.instances[0].fatal(); h.instances[0].late('error');
    expect(h.failures).toEqual([]); expect(h.player.state()).toMatchObject({ episodeId: 12, phase: 'ready' });
  });

  it('rebuilds on fallback with old position, volume/rate and sleep/background state intact', async () => {
    const h = isolated(false, true); await h.player.load(11);
    const old = h.instances[0]; old.live.play(); old.live.setCurrentTime(42); old.live.setVolume(0.35);
    h.player.setPlaybackRate(1.75); h.player.scheduleSleep('episode-end');
    old.fatal(); await flush();
    expect(h.instances).toHaveLength(2); expect(old.live.destroy).toHaveBeenCalledOnce();
    const next = h.instances[1];
    expect(next.live.setSource).toHaveBeenCalledWith('https://cdn.invalid/1/1.m3u8', 'application/vnd.m3u8+playlist');
    expect(h.player.state()).toMatchObject({ phase: 'ready', lineIndex: 1, positionSeconds: 42, volume: 0.35, sleepMode: 'episode-end' });
    expect(next.live.playbackRate?.()).toBe(1.75); expect(h.calls.stopBackground).toBe(0);
    const errors = h.failures.length; h.clock.advance(2_000); old.fatal(); old.late('error'); await flush();
    expect(h.instances).toHaveLength(2); expect(h.failures).toHaveLength(errors);
    await h.player.load(12);
    expect(h.instances[2].live.volume()).toBe(0.35); expect(h.instances[2].live.playbackRate?.()).toBe(1.75);
    expect(h.calls.stopBackground).toBe(0); expect(h.player.state().sleepMode).toBe('episode-end');
  });

  it('abandons a pending fallback when another episode starts loading', async () => {
    const h = isolated(true, true); const first = h.player.load(11); await flush();
    h.pending[0].resolve(h.instances[0].live); await first;
    h.instances[0].live.setCurrentTime(39); h.instances[0].fatal(); await flush();
    expect(h.instances).toHaveLength(2);
    const load = h.player.load(12); await flush();
    h.pending[2].resolve(h.instances[2].live); await load;
    const errors = h.failures.length;
    h.pending[1].resolve(h.instances[1].live); await flush();
    expect(h.instances[1].live.destroy).toHaveBeenCalledOnce();
    expect(h.instances[1].live.setSource).not.toHaveBeenCalled();
    h.instances[1].fatal(); expect(h.failures).toHaveLength(errors);
    expect(h.player.state()).toMatchObject({ episodeId: 12, phase: 'ready', lineIndex: 0, positionSeconds: 0 });
  });

  it('destroys a pending instance after destroy without applying a source', async () => {
    const h = isolated(true); const loading = h.player.load(11); await flush();
    h.player.destroy(); h.pending[0].resolve(h.instances[0].live); await loading;
    expect(h.instances[0].live.destroy).toHaveBeenCalledOnce();
    expect(h.instances[0].live.setSource).not.toHaveBeenCalled();
    h.instances[0].fatal(); expect(h.failures).toEqual([]);
  });
});
