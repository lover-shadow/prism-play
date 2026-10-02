// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  dispatchBackButtonForTest,
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
});
