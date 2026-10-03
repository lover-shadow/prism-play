/**
 * 系统 Back 键与全面屏侧滑手势全局拦截总线（SPEC-APP-REFACTOR A-1）。
 *
 * 在 Android 全面屏模式下，边缘侧滑会向宿主 Activity 派发系统 Back 事件（KeyEvent.KEYCODE_BACK）。
 * Capacitor 通过 @capacitor/app 将其广播为 `backButton` 事件。
 *
 * 本模块维护**三级**后入先出（LIFO）的 BackHandler 栈，消费顺序固定为：
 *   Layer（选集抽屉 / 清晰度面板 / 搜索 Overlay）→ Dialog（模态卡）→ Page（Tab 页面级返回）。
 * 同层内后注册的优先执行；某层无人消费才下沉到下一层，全部无人消费才走兜底。
 * 彻底杜绝"进入播放页/搜索页无法返回只能强退"的卡脖子体验。
 *
 * 退栈的两种来源必须区分清楚，否则会双重消费：
 * - 原生返回键 / 侧滑：事件到达本总线，由 handler 消费；handler 若要顺带清掉自己 push 的历史条目，
 *   用 `unwindHistory()` 登记，popstate 就不会再被当成一次用户返回重放一遍；
 * - 浏览器物理后退：已经消耗了历史条目，popstate 到达时若无登记才派发给 handler。
 */

import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

export type BackHandler = () => boolean | Promise<boolean>;
/** 返回栈层级：数值小的先消费（Layer > Dialog > Page）。 */
export type BackLayer = 'layer' | 'dialog' | 'page';

/** 消费顺序的唯一真相源：调整数组顺序即调整优先级，别处不得自行判定。 */
export const BACK_LAYER_ORDER: readonly BackLayer[] = ['layer', 'dialog', 'page'];

const stacks: Readonly<Record<BackLayer, BackHandler[]>> = {
  layer: [],
  dialog: [],
  page: []
};
let listenerInitialized = false;
/** UI 主动 `history.back()`（点关闭按钮 / 返回上一 Tab）时登记的待吞 popstate 条数。 */
let pendingPops = 0;
/** 最近一次派发的来源（默认 `manual`：测试或调用方自己驱动的退栈）。 */
let lastSource: BackSource = 'manual';

/** 消费一次返回事件的来源：Overlay / Tab 退栈时要据此判断历史条目是否已被消耗。 */
export type BackSource = 'native' | 'popstate' | 'manual';

/** UI 主动关层（点关闭按钮 / 原生返回键）需要自己弹历史条目；而浏览器物理后退已经弹掉了一条，
 *  handler 再弹就会多退一层——这条信息必须由总线交出。 */
export function getBackDispatchSource(): BackSource {
  return lastSource;
}

function dispatchBack(source: BackSource): Promise<boolean> {
  lastSource = source;
  return walkStacks();
}

async function walkStacks(): Promise<boolean> {
  for (const level of BACK_LAYER_ORDER) {
    const stack = stacks[level];
    for (let index = stack.length - 1; index >= 0; index -= 1) {
      try {
        if (await stack[index]()) return true;
      } catch {
        // 容错继续：一个 handler 崩了不该让后面的层级失去消费机会。
      }
    }
  }
  return false;
}

function initBackListener(): void {
  if (listenerInitialized) return;
  listenerInitialized = true;

  if (Capacitor.isNativePlatform()) {
    App.addListener('backButton', async ({ canGoBack }) => {
      if (await dispatchBack('native')) return;
      // 三级栈都没消费时的唯一兜底：能回退就回退，否则交还宿主退出。
      if (canGoBack) window.history.back();
      else exitApplication();
    }).catch(() => undefined);
  }

  // 浏览器 / Web 宿主 popstate 兼容
  if (typeof window !== 'undefined') {
    window.addEventListener('popstate', () => {
      if (pendingPops > 0) {
        pendingPops -= 1;
        return; // 这条历史条目是 UI 自己弹掉的，DOM 已就地拆完，不再重放 handler。
      }
      void dispatchBack('popstate');
    });
  }
}

/**
 * 注册一个后退处理器。当系统 Back 键或侧滑手势触发时，同层内后注册的优先执行（LIFO）。
 * @returns 销毁注销函数
 */
export function registerBackHandler(handler: BackHandler, layer: BackLayer = 'layer'): () => void {
  initBackListener();
  stacks[layer].push(handler);
  return () => {
    const index = stacks[layer].lastIndexOf(handler);
    if (index >= 0) stacks[layer].splice(index, 1);
  };
}

/** 获取当前注册的 handler 数量（三层合计，供状态检测或测试断言）。 */
export function getRegisteredBackHandlerCount(): number {
  return stacks.layer.length + stacks.dialog.length + stacks.page.length;
}

/** 某一层的当前 handler 数量（测试钉死"层内 LIFO + 层间优先"用）。 */
export function getBackHandlerCountOf(layer: BackLayer): number {
  return stacks[layer].length;
}

/**
 * 由 UI 主动弹掉一条历史记录（关闭 Overlay / 回退上一个 Tab），并保证这次 popstate 不再回放 handler。
 * 宿主不具备 History API 时退化为纯 no-op：调用方的 DOM 收尾已经完成。
 */
export function unwindHistory(steps = 1): void {
  if (typeof window === 'undefined') return;
  pendingPops += Math.max(1, steps);
  try {
    window.history.go(steps >= 1 ? -steps : -1);
  } catch {
    pendingPops = 0;
  }
}

/**
 * 请求宿主退出应用。只有原生宿主存在"退出 App"这个动作：Web 宿主没有"应用"可退，
 * 因此如实什么都不做（调用方的提示文案已经把话说清楚了），绝不伪造"已退出"、也不偷偷改浏览器历史。
 */
export function exitApplication(): void {
  if (Capacitor.isNativePlatform()) void App.exitApp().catch(() => undefined);
}

/**
 * 模拟派发一次系统返回键事件（供自动化测试）。
 * 来源记为 `manual`：与原生返回键同一条"条目未被消耗"的路径，handler 会自行弹历史。
 */
export async function dispatchBackButtonForTest(): Promise<boolean> {
  return dispatchBack('manual');
}
