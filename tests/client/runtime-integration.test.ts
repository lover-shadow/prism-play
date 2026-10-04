// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createPlayerHost } from '../../src/player-host';
import { createRuntimeServices } from '../../src/core/runtime-services';
import { detailOf, setup, settle } from './player-harness';
import type { PrismNativeBridge } from '../../src/core/native/bridge';
import type { GrantStatus } from '../../src/core/identity/offline-grant';

function preferences() {
  const data = new Map<string, string>();
  return { data, get: vi.fn(async (key: string) => data.get(key) ?? null), set: vi.fn(async (key: string, value: string) => { data.set(key, value); }) };
}
async function harness(privateContent = false) {
  const h = setup(); h.player.destroy();
  const mount = document.createElement('div'); document.body.replaceChildren(mount);
  const video = document.createElement('video');
  Object.defineProperties(video, { readyState: { value: 2 }, videoWidth: { value: 1280 }, videoHeight: { value: 720 } });
  const prefs = preferences(); let now = 0;
  const runtime = await createRuntimeServices({ prefs, grant: { read: async () => ({ ok: false, reason: 'absent' }), recordOnlineCheck: async () => undefined }, monetization: async () => ({ activeTiers: [{ tier: 'A', name: '支持', priceYuan: 1, durationDays: 1 }], nudgePolicy: { freeTrialSeconds: 1, stage1UntilSeconds: 100, stage2UntilSeconds: 200, stage1IntervalSeconds: 1, stage2IntervalSeconds: 1, stage3IntervalSeconds: 1, dialogTitle: '支持创作', dialogBody: '感谢支持' } }), clock: () => now });
  const following = { init: vi.fn(async () => undefined), list: vi.fn(async () => [{ content_id: 'c1', title: '测试剧', cover_url: null, created_at: 1 }]), toggle: vi.fn(async () => false), remove: vi.fn(async () => undefined) };
  const host = createPlayerHost({ mount, bridge: { getSystemVolume: async () => ({ supported: false, volume: 1 }), getBrightness: async () => ({ supported: false, brightness: 1 }), setKeepScreenOn: async () => undefined, onCallState: () => () => undefined } as unknown as PrismNativeBridge,
    api: { ...h.api, title: async () => detailOf({ isPrivate: privateContent }) }, following, runtime,
    engine: async ({ container }) => { container.append(video); return { ...hEngine(), on: hEngineOn }; },
    onProgress: () => undefined, allowBackgroundAudio: () => false, onPrivacyChange: () => undefined, orientation: { lock: async () => true, unlock: async () => true } });
  const handlers = new Map<string, () => void>();
  function hEngineOn(event: string, fn: () => void) { handlers.set(event, fn); return () => handlers.delete(event); }
  function hEngine() { return { play: () => undefined, pause: () => undefined, playing: () => true, currentTime: () => 999, duration: () => 1000, volume: () => 1, setVolume: () => undefined, setCurrentTime: () => undefined, setSource: () => undefined, destroy: () => undefined, toggleControls: () => undefined, playbackRate: () => 1, setPlaybackRate: () => undefined }; }
  await host.open('c1'); await settle();
  return { host, mount, following, runtime, video, advance: (ms: number) => { now += ms; }, emit: (event: string) => { video.dispatchEvent(new Event(event)); }, ended: () => handlers.get('ended')?.() };
}

describe('real host runtime integration', () => {
  it('hydrates following and changes UI only after a committed toggle', async () => {
    const h = await harness(); const button = h.mount.querySelector<HTMLButtonElement>('[data-action="following"]')!;
    expect(button.textContent).toContain('已追剧');
    h.following.toggle.mockRejectedValueOnce(new Error('disk'));
    button.click(); await settle(); expect(button.textContent).toContain('已追剧');
    button.click(); await settle(); expect(button.textContent).toBe('追剧');
    expect(h.following.toggle).toHaveBeenCalledWith(expect.objectContaining({ contentId: 'c1', isPrivate: false }));
    h.host.close(); await h.runtime.destroy();
  });
  it('counts playing with frame evidence, excludes waits/seeks/resume gaps and settles close', async () => {
    const h = await harness(); h.emit('play'); h.advance(5000); expect(h.runtime.watch?.state().totalSeconds).toBe(0);
    h.emit('playing'); h.emit('loadeddata'); h.advance(2000); h.emit('waiting');
    h.advance(5000); h.emit('playing'); h.emit('loadeddata'); h.advance(3000); h.emit('seeking');
    h.advance(5000); h.emit('seeked'); h.advance(1000); h.emit('playing'); h.emit('loadeddata'); h.advance(1000);
    h.host.close(); await h.runtime.watch?.flush(); expect(h.runtime.watch?.state().totalSeconds).toBe(6);
    await h.runtime.destroy();
  });
  it('shows dismissible nudge on natural auto-next only and never stores private time or following', async () => {
    const h = await harness(); h.emit('playing'); h.emit('loadeddata'); h.advance(2000); h.emit('ended'); h.ended(); await settle();
    expect(h.mount.querySelector('.sponsor-nudge')).not.toBeNull();
    h.mount.querySelector<HTMLButtonElement>('[aria-label="关闭提醒"]')!.click(); await settle();
    expect(h.runtime.watch?.state().lastNudgeSeconds).toBe(2); h.host.close(); await h.runtime.destroy();
    const p = await harness(true); p.emit('playing'); p.emit('loadeddata'); p.advance(9000); p.host.close();
    await p.runtime.watch?.flush(); expect(p.runtime.watch?.state().totalSeconds).toBe(0); expect(p.following.list).not.toHaveBeenCalled(); expect(p.following.toggle).not.toHaveBeenCalled(); await p.runtime.destroy();
  });
  it('requires a decoded frame callback and rejects stale callbacks after seeking', async () => {
    const h = await harness(); const frames: VideoFrameRequestCallback[] = [];
    h.video.requestVideoFrameCallback = vi.fn(callback => { frames.push(callback); return frames.length; });
    h.video.cancelVideoFrameCallback = vi.fn();
    h.emit('playing'); h.advance(5000); h.emit('seeking');
    frames[0](0, {} as VideoFrameCallbackMetadata); h.advance(5000);
    expect(h.runtime.watch?.state().totalSeconds).toBe(0);
    h.emit('playing'); h.advance(3000); frames[1](0, {} as VideoFrameCallbackMetadata);
    h.advance(2000); h.emit('error'); await h.runtime.watch?.flush();
    expect(h.runtime.watch?.state().totalSeconds).toBe(2); h.host.close(); await h.runtime.destroy();
  });
  it('suspension requires fresh playing evidence and manual switching does not offer a nudge', async () => {
    const h = await harness(); h.emit('playing'); h.advance(2000); h.host.suspend();
    h.advance(10000); h.emit('loadeddata'); h.advance(1000);
    expect(h.runtime.watch?.state().totalSeconds).toBe(2);
    h.emit('playing'); h.advance(1000);
    h.mount.querySelector<HTMLButtonElement>('.ep-rail-btn:not(.active)')!.click(); await settle();
    expect(h.mount.querySelector('.sponsor-nudge')).toBeNull();
    h.host.close(); await h.runtime.watch?.flush(); expect(h.runtime.watch?.state().totalSeconds).toBe(3); await h.runtime.destroy();
  });
  it('uses verified grant results and fails closed on unavailable cloud policy', async () => {
    const prefs = preferences(); let status: GrantStatus = { ok: false, reason: 'unsigned' };
    const config = { activeTiers: [{ tier: 'A', name: '支持', priceYuan: 1, durationDays: 1 }], nudgePolicy: { freeTrialSeconds: 1, stage1UntilSeconds: 100, stage2UntilSeconds: 200, stage1IntervalSeconds: 1, stage2IntervalSeconds: 1, stage3IntervalSeconds: 1, dialogTitle: '支持创作', dialogBody: '感谢支持' } };
    let now = 0;
    const runtime = await createRuntimeServices({ prefs, grant: { read: async () => status, recordOnlineCheck: async () => undefined }, monetization: async () => config, clock: () => now });
    await settle(); await runtime.watch!.setScope('public'); runtime.watch!.playing(true); now = 2000; await runtime.watch!.suspend('ended');
    status = { ok: true, grant: { tier: 'A', deviceId: 'GY-12345678', expiresAt: 9999, issuedAt: 1, kid: 'p2026' }, verifiedAt: 1 };
    expect(await runtime.naturalBoundary()).toBeNull();
    runtime.watch!.playing(true); now = 3000; await runtime.watch!.suspend('ended'); status = { ok: false, reason: 'expired' };
    expect(await runtime.naturalBoundary()).toEqual(config); await runtime.destroy();
    const failed = await createRuntimeServices({ prefs, grant: { read: async () => status, recordOnlineCheck: async () => undefined }, monetization: async () => { throw new Error('network'); }, clock: () => now });
    await failed.watch!.setScope('public'); failed.watch!.playing(true); now += 2000; await failed.watch!.suspend('ended');
    expect(await failed.naturalBoundary()).toBeNull(); await failed.destroy();
  });
  it('refreshes persisted rates and never updates cached preference on write failure', async () => {
    const prefs = preferences(); const runtime = await createRuntimeServices({ prefs, grant: { read: async () => ({ ok: false, reason: 'absent' }), recordOnlineCheck: async () => undefined }, monetization: async () => null });
    prefs.data.set('prism.playback.normalRate', '1.5'); prefs.data.set('prism.playback.holdRate', '3'); await runtime.refresh();
    expect(runtime.playbackPreferences.normalRate!()).toBe(1.5); expect(runtime.playbackPreferences.holdRate!()).toBe(3);
    prefs.set.mockRejectedValueOnce(new Error('disk')); runtime.playbackPreferences.onNormalRate!(2); await settle(); expect(runtime.playbackPreferences.normalRate!()).toBe(1.5);
    runtime.playbackPreferences.onNormalRate!(2); await runtime.refresh(); expect(runtime.playbackPreferences.normalRate!()).toBe(2); await runtime.destroy();
  });
});
