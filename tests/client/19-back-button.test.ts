// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  dispatchBackButtonForTest,
  getBackHandlerCountOf,
  getRegisteredBackHandlerCount,
  registerBackHandler
} from '../../src/core/native/back-button';

describe('back-button — 系统返回与全面屏手势拦截总线', () => {
  it('支持注册与注销 handler，严格遵循 LIFO 后入先出顺序', async () => {
    const log: string[] = [];

    const unreg1 = registerBackHandler(() => {
      log.push('handler1');
      return true;
    });

    expect(getRegisteredBackHandlerCount()).toBe(1);

    const unreg2 = registerBackHandler(() => {
      log.push('handler2');
      return true; // 顶层处理后直接拦截
    });

    expect(getRegisteredBackHandlerCount()).toBe(2);

    // 第一次触发：handler2 优先消费
    const handled = await dispatchBackButtonForTest();
    expect(handled).toBe(true);
    expect(log).toEqual(['handler2']);

    // 注销 handler2
    unreg2();
    expect(getRegisteredBackHandlerCount()).toBe(1);

    // 第二次触发：handler1 消费
    const handledAgain = await dispatchBackButtonForTest();
    expect(handledAgain).toBe(true);
    expect(log).toEqual(['handler2', 'handler1']);

    // 注销 handler1
    unreg1();
    expect(getRegisteredBackHandlerCount()).toBe(0);

    const handledNone = await dispatchBackButtonForTest();
    expect(handledNone).toBe(false);
  });

  it('如果栈顶 handler 返回 false，则向下冒泡给下一个 handler 消费', async () => {
    const unreg1 = registerBackHandler(() => true);
    const unreg2 = registerBackHandler(() => false); // 不消费，放行

    const handled = await dispatchBackButtonForTest();
    expect(handled).toBe(true);

    unreg1();
    unreg2();
  });

  // HP-02：热门榜这类"就地展开区"的层复用同一条总线，计数与消费语义必须先钉死，视图侧接线见 home-repair。
  it('HP-02 layer 计数只由持有者注销决定：消费一次返回不会偷偷摘掉 handler', async () => {
    const base = getBackHandlerCountOf('layer');
    let closes = 0;
    const release = registerBackHandler(() => { closes += 1; return true; }, 'layer');

    expect(getBackHandlerCountOf('layer')).toBe(base + 1);
    expect(await dispatchBackButtonForTest()).toBe(true);
    expect(closes).toBe(1);
    // 榜单仍展开时计数不该掉：谁负责关层，谁才有权注销
    expect(getBackHandlerCountOf('layer')).toBe(base + 1);

    release();
    expect(getBackHandlerCountOf('layer')).toBe(base);
    expect(getRegisteredBackHandlerCount()).toBe(0);
  });

  it('HP-02 没占过历史条目的层不得自行弹历史：返回消费不改写会话历史', async () => {
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => undefined);
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const before = window.history.length;
    const release = registerBackHandler(() => true, 'layer');

    expect(await dispatchBackButtonForTest()).toBe(true);
    expect(window.history.length).toBe(before);

    release();
    expect(go).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    go.mockRestore();
    back.mockRestore();
  });
});
