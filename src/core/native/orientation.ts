/**
 * 屏幕方向端口（SPEC §1.2.1 / AC-20）。
 *
 * 为什么单列一个端口而不是塞进 `PrismNativeBridge`：方向锁由官方 `@capacitor/screen-orientation`
 * 提供，不属于自研 `PrismNative` 插件的能力面；塞进去会让 Android 侧凭空多出一组必须逐字对齐的
 * 方法名，而真实实现根本不在那里。
 *
 * 为什么返回 `boolean` 而不是 `void`：Web 端与部分设备根本不允许脚本锁方向（`screen.orientation.lock`
 * 需要全屏且常被拒）。端口必须如实告诉调用方"有没有真的锁上"，调用方才能既不假装成功、
 * 也不因为锁失败就放弃全屏（全屏本身仍由 CSS 权威成立）。
 */
import { Capacitor } from '@capacitor/core';
import type { PrismNativeBridge } from './bridge';

/** Serialize entry/exit so a late lock can never outlive its queued restoration. */
export function createFullscreenPolicy(orientation: OrientationPort, bridge: PrismNativeBridge) {
  let desiredFullscreen = false, desiredLock = false, locked = false;
  let queue = Promise.resolve();
  return (fullscreen: boolean, lockLandscape = false): Promise<void> => {
    if (desiredFullscreen === fullscreen && desiredLock === lockLandscape) return queue;
    desiredFullscreen = fullscreen;
    desiredLock = lockLandscape;
    queue = queue.then(async () => {
      try {
        if (fullscreen) {
          await bridge.setImmersiveMode?.(true);
          if (lockLandscape && !locked) {
            locked = await orientation.lock('landscape');
          } else if (!lockLandscape && locked) {
            locked = false;
            await orientation.unlock();
          }
        } else {
          if (locked) { locked = false; await orientation.unlock(); }
          await bridge.setImmersiveMode?.(false);
        }
      } catch {
        locked = false;
        await orientation.unlock().catch(() => false);
        await bridge.setImmersiveMode?.(false).catch(() => false);
      }
    });
    return queue;
  };
}

export type OrientationLock = 'landscape' | 'portrait';

export interface OrientationPort {
  /** `true` 表示方向确实被宿主锁住；`false` 表示平台拒绝，界面必须自己撑满。 */
  lock(to: OrientationLock): Promise<boolean>;
  unlock(): Promise<boolean>;
}

interface ScreenOrientationLike {
  lock(config: { orientation: OrientationLock }): Promise<void>;
  unlock(): Promise<void>;
}

type OrientationModule = { ScreenOrientation: ScreenOrientationLike };

/** 懒取插件：Web 构建与 jsdom 单测都不该因为一个原生插件而无法加载本模块。 */
async function loadPlugin(): Promise<OrientationModule | null> {
  try {
    return await import('@capacitor/screen-orientation');
  } catch {
    return null;
  }
}

async function lockDomScreen(to: OrientationLock): Promise<boolean> {
  const orientation = window.screen?.orientation as { lock?: (value: string) => Promise<void> } | undefined;
  if (typeof orientation?.lock !== 'function') return false;
  try {
    await orientation.lock(to);
    return true;
  } catch {
    // 浏览器策略拒绝（最常见是没有真全屏）：方向保持自然态，全屏照样由 CSS 状态机成立。
    return false;
  }
}

export function createOrientationPort(isNative: () => boolean = () => Capacitor.isNativePlatform()): OrientationPort {
  async function lock(to: OrientationLock): Promise<boolean> {
    if (!isNative()) return lockDomScreen(to);
    const plugin = await loadPlugin();
    if (plugin === null) return false;
    try {
      await plugin.ScreenOrientation.lock({ orientation: to });
      return true;
    } catch {
      return false;
    }
  }

  async function unlock(): Promise<boolean> {
    if (!isNative()) {
      const orientation = window.screen?.orientation as { unlock?: () => void } | undefined;
      orientation?.unlock?.();
      return typeof orientation?.unlock === 'function';
    }
    const plugin = await loadPlugin();
    if (plugin === null) return false;
    try {
      await plugin.ScreenOrientation.unlock();
      return true;
    } catch {
      return false;
    }
  }

  return { lock, unlock };
}
