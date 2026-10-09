// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  create: vi.fn(async (_args: { sessionId: string; bounds: unknown }) => {}), setSource: vi.fn(async (_args: { sessionId: string; videoId: string }) => {}), play: vi.fn(async () => {}),
  pause: vi.fn(async () => {}), seek: vi.fn(async () => {}), setVolume: vi.fn(async () => {}),
  setBackgroundAllowed: vi.fn(async () => {}), setRate: vi.fn(async () => {}), setBounds: vi.fn(async () => {}), release: vi.fn(async () => {}),
  remove: vi.fn(async () => {}), callback: undefined as ((event: unknown) => void) | undefined,
  listenerFailure: false, platform: 'android'
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => native.platform, isPluginAvailable: () => true },
  registerPlugin: () => ({ ...native, addListener: async (_name: string, callback: (event: unknown) => void) => {
    if (native.listenerFailure) throw new Error('listener failed');
    native.callback = callback; return { remove: native.remove };
  } })
}));
import { createExoEngine } from '../../src/player/exo-engine';
import { probeStageOrientation } from '../../src/player/aspect';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
beforeEach(() => {
  vi.clearAllMocks(); native.listenerFailure = false; native.platform = 'android'; document.body.innerHTML = '<div id="mount"></div>';
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
const mount = () => document.getElementById('mount') as HTMLDivElement;

describe('native engine adapter', () => {
  it('passes only video identity to the bridge and starts after source preparation', async () => {
    const engine = await createExoEngine({ container: mount(), theme: '', onError: vi.fn(), resolveNative: async (source) => source });
    engine.setSource('https://media.example.test/encrypted.mp4', 'video/mp4', { kind: 's1-cenc', videoId: '12345' });
    await flush();
    expect(native.setSource).toHaveBeenCalledWith({ sessionId: expect.any(String), videoId: '12345' });
    expect(native.play).toHaveBeenCalledOnce();
    engine.setBackgroundAllowed?.(true); await flush();
    expect(native.setBackgroundAllowed).toHaveBeenCalledWith({ sessionId: expect.any(String), allowed: true });
    const keys = Object.keys(native.setSource.mock.calls[0][0]);
    expect(keys).not.toContain('url'); expect(keys).not.toContain('keyHex');
    engine.destroy(); await flush();
  });

  it('isolates events from old sessions and exposes intrinsic video dimensions', async () => {
    const engine = await createExoEngine({ container: mount(), theme: '', onError: vi.fn(), resolveNative: async (source) => source });
    const playing = vi.fn(); engine.on('playing', playing);
    const sessionId = native.create.mock.calls[0][0].sessionId;
    const event = { sessionId, event: 'playing', positionSeconds: 7, durationSeconds: 120,
      playing: true, volume: 0.7, rate: 1.5, width: 1080, height: 1920 };
    native.callback?.({ ...event, sessionId: 'old' }); expect(playing).not.toHaveBeenCalled();
    native.callback?.(event);
    expect(playing).toHaveBeenCalledOnce(); expect(engine.currentTime()).toBe(7);
    expect(engine.playing()).toBe(true); expect(mount().dataset.nativeVideoHeight).toBe('1920');
    expect(probeStageOrientation(mount())).toBe('portrait');
    expect(probeStageOrientation(null)).toBeNull();
    engine.destroy(); await flush();
    expect(document.documentElement.classList.contains('prism-native-active')).toBe(false);
    expect(native.remove).toHaveBeenCalledOnce(); expect(native.release).toHaveBeenCalledOnce();
  });

  it('releases immediately during source resolution and never plays the destroyed session', async () => {
    let finish!: () => void;
    native.setSource.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const engine = await createExoEngine({ container: mount(), theme: '', onError: vi.fn(), resolveNative: async (source) => source });
    engine.setSource('', 'video/mp4', { kind: 's1-cenc', videoId: '12345' });
    await flush();
    engine.destroy(); await flush();
    expect(native.release).toHaveBeenCalledOnce();
    finish(); await flush();
    expect(native.play).not.toHaveBeenCalled();
  });

  it('applies resume seeking after source preparation and before playback', async () => {
    let prepare!: () => void;
    native.setSource.mockImplementationOnce(() => new Promise<void>((resolve) => { prepare = resolve; }));
    const engine = await createExoEngine({ container: mount(), theme: '', onError: vi.fn(), resolveNative: async (source) => source });
    engine.setSource('', 'video/mp4', { kind: 's1-cenc', videoId: '12345' });
    engine.setCurrentTime(42); await flush();
    expect(native.play).not.toHaveBeenCalled();
    prepare(); await flush();
    expect(native.seek).toHaveBeenCalledWith({ sessionId: expect.any(String), seconds: 42 });
    expect(native.seek.mock.invocationCallOrder[0]).toBeLessThan(native.play.mock.invocationCallOrder[0]);
    engine.destroy(); await flush();
  });

  it('delivers background permission immediately even while verification is pending', async () => {
    let finish!: (source: { kind: 's1-cenc'; videoId: string }) => void;
    const engine = await createExoEngine({ container: mount(), theme: '', onError: vi.fn(),
      resolveNative: () => new Promise((resolve) => { finish = resolve; }) });
    engine.setSource('', 'video/mp4', { kind: 's1-cenc', videoId: '12345' }); await flush();
    engine.setBackgroundAllowed?.(false); await flush();
    expect(native.setBackgroundAllowed).toHaveBeenCalledWith({ sessionId: expect.any(String), allowed: false });
    engine.destroy(); finish({ kind: 's1-cenc', videoId: '12345' }); await flush();
  });

  it('updates surface bounds during pending verification without waiting for the network', async () => {
    let finish!: (source: { kind: 's1-cenc'; videoId: string }) => void;
    const engine = await createExoEngine({ container: mount(), theme: '', onError: vi.fn(),
      resolveNative: () => new Promise((resolve) => { finish = resolve; }) });
    engine.setSource('', 'video/mp4', { kind: 's1-cenc', videoId: '12345' }); await flush();
    engine.resize?.(); await flush();
    expect(native.setBounds).toHaveBeenCalledOnce();
    engine.destroy(); finish({ kind: 's1-cenc', videoId: '12345' }); await flush();
  });

  it('keeps resume position while native metadata reports the pre-seek position', async () => {
    let prepare!: () => void;
    native.setSource.mockImplementationOnce(() => new Promise<void>((resolve) => { prepare = resolve; }));
    const engine = await createExoEngine({ container: mount(), theme: '', onError: vi.fn(), resolveNative: async (source) => source });
    engine.setSource('', 'video/mp4', { kind: 's1-cenc', videoId: '12345' }); engine.setCurrentTime(42);
    await flush();
    const sessionId = native.create.mock.calls[0][0].sessionId;
    native.callback?.({ sessionId, event: 'loadedmetadata', positionSeconds: 0, durationSeconds: 100,
      playing: false, volume: 1, rate: 1, width: 1080, height: 1920 });
    expect(engine.currentTime()).toBe(42);
    prepare(); await flush(); engine.destroy(); await flush();
  });

  it('applies preferred rate before first play despite stale preparation events', async () => {
    let prepare!: () => void;
    native.setSource.mockImplementationOnce(() => new Promise<void>((resolve) => { prepare = resolve; }));
    const engine = await createExoEngine({ container: mount(), theme: '', onError: vi.fn(), resolveNative: async (source) => source });
    engine.setSource('', 'video/mp4', { kind: 's1-cenc', videoId: '12345' });
    engine.setPlaybackRate?.(2); await flush();
    const sessionId = native.create.mock.calls[0][0].sessionId;
    native.callback?.({ sessionId, event: 'loadedmetadata', positionSeconds: 0, durationSeconds: 100,
      playing: false, volume: 1, rate: 1, width: 1080, height: 1920 });
    prepare(); await flush();
    expect(engine.playbackRate?.()).toBe(2);
    expect(native.setRate).toHaveBeenCalledWith({ sessionId, rate: 2 });
    expect(native.setRate.mock.invocationCallOrder[0]).toBeLessThan(native.play.mock.invocationCallOrder[0]);
    engine.destroy(); await flush();
  });
  it('honors pause while preparing instead of briefly auto-playing', async () => {
    let prepare!: () => void;
    native.setSource.mockImplementationOnce(() => new Promise<void>((resolve) => { prepare = resolve; }));
    const engine = await createExoEngine({ container: mount(), theme: '', onError: vi.fn(), resolveNative: async (source) => source });
    engine.setSource('', 'video/mp4', { kind: 's1-cenc', videoId: '12345' });
    await flush(); engine.pause(); prepare(); await flush();
    expect(native.play).not.toHaveBeenCalled(); engine.destroy(); await flush();
  });

  it('does not pass a late verification result to a destroyed native session', async () => {
    let finish!: (source: { kind: 's1-cenc'; videoId: string }) => void;
    const engine = await createExoEngine({ container: mount(), theme: '', onError: vi.fn(),
      resolveNative: () => new Promise((resolve) => { finish = resolve; }) });
    engine.setSource('', 'video/mp4', { kind: 's1-cenc', videoId: '12345' });
    await flush(); engine.destroy(); await flush();
    finish({ kind: 's1-cenc', videoId: '12345' }); await flush();
    expect(native.setSource).not.toHaveBeenCalled(); expect(native.play).not.toHaveBeenCalled();
  });

  it('does not start a native source when server verification rejects it', async () => {
    const onError = vi.fn();
    const engine = await createExoEngine({ container: mount(), theme: '', onError,
      resolveNative: async () => { throw new Error('denied'); } });
    engine.setSource('', 'video/mp4', { kind: 's1-cenc', videoId: '12345' });
    await flush();
    expect(native.setSource).not.toHaveBeenCalled(); expect(native.play).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce(); engine.destroy(); await flush();
  });

  it('cleans transparency and listener state if native session creation fails', async () => {
    native.create.mockRejectedValueOnce(new Error('create failed'));
    await expect(createExoEngine({ container: mount(), theme: '', onError: vi.fn() })).rejects.toThrow('create failed');
    expect(document.documentElement.classList.contains('prism-native-active')).toBe(false);
    expect(mount().classList.contains('prism-native-transparent')).toBe(false);
    expect(native.remove).toHaveBeenCalledOnce();
  });

  it('rejects source setup without an authority resolver before passing a video identity', async () => {
    const onError = vi.fn();
    const engine = await createExoEngine({ container: mount(), theme: '', onError });
    engine.setSource('', 'video/mp4', { kind: 's1-cenc', videoId: '12345' }); await flush();
    expect(native.setSource).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledOnce();
    engine.destroy(); await flush();
  });

  it('does not leave transparent ancestors behind when listener registration fails', async () => {
    native.listenerFailure = true;
    await expect(createExoEngine({ container: mount(), theme: '', onError: vi.fn() })).rejects.toThrow('listener failed');
    expect(document.documentElement.classList.contains('prism-native-active')).toBe(false);
    expect(mount().classList.contains('prism-native-transparent')).toBe(false);
    expect(native.create).not.toHaveBeenCalled();
  });

  it('rejects web environment instead of sending encrypted media to a browser engine', async () => {
    native.platform = 'web';
    await expect(createExoEngine({ container: mount(), theme: '', onError: vi.fn(), resolveNative: async (source) => source })).rejects.toThrow('不支持');
    expect(native.create).not.toHaveBeenCalled();
  });
});
