/**
 * AC-06/07：手势要落到真实被改变的那个量上。
 *
 * 从 `prism-player.ts` 拆出来不是整理癖：平台支持位与「Web 只能动元素增益」这条诚实边界是一个决策面，
 * 复制成第二处就会出现网页构建宣称自己调了系统音量这种事。这里持有唯一的真相，播放器只负责接线。
 */
import type { PrismNativeBridge } from '../core/native/bridge';
import type { GestureHud } from './hud';
import type { ValueChannel } from './gestures';
import type { PlayerEngine } from './engine-seam';

export interface ValueChannels {
  apply(channel: ValueChannel, value: number): Promise<void>;
  /** Read the platform once per engine: the flags decide whether the HUD may claim a system change. */
  sync(): Promise<void>;
  read(): { systemVolumeSupported: boolean; brightnessSupported: boolean };
}

export function createValueChannels(deps: {
  bridge: PrismNativeBridge;
  hud: GestureHud;
  engine(): PlayerEngine | null;
  seed(channel: ValueChannel, value: number): void;
}): ValueChannels {
  let systemVolumeSupported = false, brightnessSupported = false;

  async function applyBrightness(value: number): Promise<void> {
    const applied = await deps.bridge.setBrightness(value);
    brightnessSupported = applied.supported;
    deps.hud.show({ kind: 'brightness', value: applied.brightness, supported: applied.supported });
  }

  async function applyVolume(value: number): Promise<void> {
    // Web 端只有元素增益可动，HUD 就这么写，不冒充系统音量（AC-07 的诚实边界）。
    if (!systemVolumeSupported) { deps.engine()?.setVolume(value); deps.hud.show({ kind: 'volume', value, supported: false }); return; }
    const applied = await deps.bridge.setSystemVolume(value);
    systemVolumeSupported = applied.supported;
    if (!applied.supported) deps.engine()?.setVolume(value);
    deps.hud.show({ kind: 'volume', value: applied.volume, supported: applied.supported });
  }

  return {
    apply: (channel, value) => (channel === 'brightness' ? applyBrightness(value) : applyVolume(value)),
    async sync() {
      const [volume, brightness] = await Promise.all([deps.bridge.getSystemVolume(), deps.bridge.getBrightness()]);
      systemVolumeSupported = volume.supported; brightnessSupported = brightness.supported;
      deps.seed('volume', volume.supported ? volume.volume : (deps.engine()?.volume() ?? 1));
      deps.seed('brightness', brightness.brightness);
    },
    read: () => ({ systemVolumeSupported, brightnessSupported })
  };
}
