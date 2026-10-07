// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { setup } from './player-harness';
import type { PrismNativeBridge } from '../../src/core/native/bridge';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
describe('background service startup lifetime', () => {
  it('does not silently re-enable background audio after the user disables it', async () => {
    const h = setup({ allowBackgroundAudio: true });
    await h.player.load(11); h.fire('play'); await flush();
    expect(h.calls.startBackground).toHaveLength(1);
    h.player.openDrawer();
    const toggle = h.root.querySelector<HTMLInputElement>('.prism-drawer__checkbox')!;
    toggle.checked = false; toggle.dispatchEvent(new Event('change')); await flush();
    h.fire('pause'); h.fire('play'); await flush();
    expect(h.calls.startBackground).toHaveLength(1);
    await h.player.load(12); h.fire('play'); await flush();
    expect(h.calls.startBackground).toHaveLength(1);
    h.player.destroy();
  });
  it('stops a service whose startup completes after the player was destroyed', async () => {
    const seed = setup(); const bridge = {
      getSystemVolume: async () => ({ volume: 1, supported: false }),
      setSystemVolume: async (volume: number) => ({ volume, supported: false }),
      getBrightness: async () => ({ brightness: 1, supported: false }),
      setBrightness: async (brightness: number) => ({ brightness, supported: false }),
      setKeepScreenOn: async () => {}, onCallState: () => () => {},
      startBackgroundAudio: vi.fn(), stopBackgroundAudio: vi.fn(async () => {})
    };
    seed.player.destroy();
    let complete!: () => void;
    bridge.startBackgroundAudio.mockImplementation(() => new Promise<void>((resolve) => { complete = resolve; }));
    const h = setup({ allowBackgroundAudio: true, bridge: bridge as unknown as PrismNativeBridge });
    await h.player.load(11); h.fire('play'); await flush();
    expect(bridge.startBackgroundAudio).toHaveBeenCalledOnce();
    h.player.destroy(); await flush();
    const stops = bridge.stopBackgroundAudio.mock.calls.length;
    complete(); await flush();
    expect(bridge.stopBackgroundAudio.mock.calls.length).toBe(stops + 1);
  });
});
