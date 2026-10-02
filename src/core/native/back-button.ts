/**
 * 系统 Back 键与全面屏侧滑手势全局拦截总线。
 *
 * 在 Android 全面屏模式下，边缘侧滑会向宿主 Activity 派发系统 Back 事件（KeyEvent.KEYCODE_BACK）。
 * Capacitor 通过 @capacitor/app 将其广播为 `backButton` 事件。
 *
 * 本模块维护一个后入先出（LIFO）的 BackHandler 栈：
 * 当浮层（如全屏播放器、选集抽屉、弹窗等）打开时，注册专属的 handler；
 * 用户侧滑或按下返回键时，栈顶 handler 优先消费该事件（返回 true 代表已处理并阻止冒泡），
 * 彻底杜绝“进入播放页无法返回只能强退”的卡脖子体验。
 */

import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

export type BackHandler = () => boolean | Promise<boolean>;

const handlers: BackHandler[] = [];
let listenerInitialized = false;

function initBackListener(): void {
  if (listenerInitialized) return;
  listenerInitialized = true;

  if (Capacitor.isNativePlatform()) {
    void App.addListener('backButton', async ({ canGoBack }) => {
      // 从栈顶开始寻找能够处理该事件的 handler
      for (let i = handlers.length - 1; i >= 0; i--) {
        const handler = handlers[i];
        try {
          const handled = await handler();
          if (handled) {
            return; // 消费成功，停止冒泡
          }
        } catch {
          // 容错继续
        }
      }

      // 没有 handler 消费该事件时的默认兜底
      if (canGoBack) {
        window.history.back();
      } else {
        void App.exitApp();
      }
    });
  }

  // 浏览器 / Web 宿主 popstate 兼容
  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', async () => {
      for (let i = handlers.length - 1; i >= 0; i--) {
        const handler = handlers[i];
        try {
          const handled = await handler();
          if (handled) return;
        } catch {
          // ignore
        }
      }
    });
  }
}

/**
 * 注册一个后退处理器。当系统 Back 键或侧滑手势触发时，后注册的优先执行（LIFO）。
 * @returns 销毁注销函数
 */
export function registerBackHandler(handler: BackHandler): () => void {
  initBackListener();
  handlers.push(handler);
  return () => {
    const index = handlers.lastIndexOf(handler);
    if (index >= 0) {
      handlers.splice(index, 1);
    }
  };
}

/**
 * 获取当前注册的 handler 数量（供状态检测或测试断言）
 */
export function getRegisteredBackHandlerCount(): number {
  return handlers.length;
}

/**
 * 模拟派发一次系统返回键事件（供自动化测试）
 */
export async function dispatchBackButtonForTest(): Promise<boolean> {
  for (let i = handlers.length - 1; i >= 0; i--) {
    const handler = handlers[i];
    try {
      const handled = await handler();
      if (handled) return true;
    } catch {
      // ignore
    }
  }
  return false;
}
