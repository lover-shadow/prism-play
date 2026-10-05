// @vitest-environment jsdom
/**
 * HP-03 点击立即进入（§3.1 宿主状态机 closed → loading → ready → error/retry）。
 * 只证"第一个 await 之前有没有层"与"每个 await 之后代次有没有核对"；播放内核事件归 B1，不在此列。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlayerHostDeps } from '../../src/player-host';
import type { TitleDetail } from '../../edge/src/types/api';
import { ApiError } from '../../src/core/api/client';
import { dispatchBackButtonForTest, getBackHandlerCountOf } from '../../src/core/native/back-button';
import { detailOf, settle } from './player-harness';
import { host } from './player-host-harness';

/** `detailOf()` 的默认剧名：身份核验通过之前它是"受保护元信息"，一个字节都不许进 DOM。 */
const PROTECTED = '测试剧';
const shellOf = (root: HTMLElement): HTMLElement | null => root.querySelector<HTMLElement>('.prism-player-host');
const hostState = (layer: HTMLElement): HTMLElement | null => layer.querySelector<HTMLElement>(':scope > .prism-player__state');
const stateText = (layer: HTMLElement): string => hostState(layer)?.textContent ?? '';

function deferred<T = void>(): { promise: Promise<T>; release: (value: T) => void } {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, release };
}
/** runtime 接缝的最小替身：只把 `refresh`（或 `setScope`）挂住，其余按"未授权/未计时"如实缺席。 */
const gatedRuntime = (gate: Promise<unknown>, where: 'refresh' | 'setScope' = 'refresh'): PlayerHostDeps['runtime'] => ({
  refresh: async () => { if (where === 'refresh') await gate; },
  watch: { setScope: async () => { if (where === 'setScope') await gate; } },
  naturalBoundary: async () => null,
  playbackPreferences: undefined,
  destroy: async () => undefined
}) as unknown as PlayerHostDeps['runtime'];

describe('HP-03 点击立即进入', () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it('HP-03a runtime 刷新未 resolve 前就同步挂出 loading 宿主：可返回、零受保护元信息', async () => {
    const gate = deferred();
    const titleOf = vi.fn(() => PROTECTED);
    const h = host({ runtime: gatedRuntime(gate.promise), titleOf });
    const base = getBackHandlerCountOf('layer');
    const opened = h.player.open('c1'); // 故意不 await：断言的就是"第一个 await 之前"
    const layer = shellOf(h.mount);
    expect(layer).not.toBeNull();
    expect(layer?.dataset.phase).toBe('loading');
    expect(layer?.getAttribute('aria-busy')).toBe('true');
    expect(layer?.querySelector('.prism-player-host__title')?.textContent).toBe('');
    expect(h.mount.textContent).not.toContain(PROTECTED);
    expect(document.body.textContent).not.toContain(PROTECTED); // 卡片标题/剧目名不许提前进树
    expect(h.player.isOpen()).toBe(true);
    expect(h.api.title).not.toHaveBeenCalled();
    expect(getBackHandlerCountOf('layer')).toBe(base + 1);
    // 冷启动 runtime 再慢也必须能返回：层只关自己这一层
    expect(await dispatchBackButtonForTest()).toBe(true);
    expect(shellOf(h.mount)).toBeNull();
    expect(getBackHandlerCountOf('layer')).toBe(base);
    gate.release();
    expect(await opened).toBe(false);
    await settle();
    expect(titleOf).not.toHaveBeenCalled(); // 未核验身份前不读 titleOf
    expect(h.api.title).not.toHaveBeenCalled(); // 取消后的旧代连详情请求都不该再发出去
    expect(h.mount.childElementCount).toBe(0); // 迟到结果不得复活画面
    expect(h.calls.playback).toEqual([]);
    expect(h.calls.closed).toBe(0);
  });

  it('HP-03a 私密/未知/档位不足/不存在四类失败共用同一句话，且层内两个出口都在', async () => {
    const failures: Array<[unknown, string]> = [
      [new ApiError('NOT_FOUND', 404, '内容不存在'), '404'],
      [new ApiError('PRIVATE_SESSION_REQUIRED', 403, '需要私密会话'), '私密未准入'],
      [new ApiError('TIER_INSUFFICIENT', 402, '需要更高授权档位'), '档位不足'],
      [new Error('boom'), '未知故障']
    ];
    const texts: string[] = [];
    for (const [error, label] of failures) {
      const h = host({ titleError: error });
      const base = getBackHandlerCountOf('layer');
      expect(await h.player.open('c1'), label).toBe(false);
      const layer = shellOf(h.mount);
      expect(layer, label).not.toBeNull();
      expect(layer?.querySelector('.prism-player__state--missing'), label).not.toBeNull();
      expect(document.body.textContent, label).not.toContain(PROTECTED);
      expect(stateText(layer!), label).not.toMatch(/私密|授权|档位|403|404/);
      texts.push(stateText(layer!));
      // 重试与返回两条出口都得点得动：失败层不是不可关闭的死遮罩
      const retry = layer!.querySelector<HTMLButtonElement>('[data-el="host-retry"]');
      const back = layer!.querySelector<HTMLButtonElement>('[data-el="host-back"]');
      expect(retry?.hidden, label).toBe(false);
      expect(back, label).not.toBeNull();
      retry!.click();
      await settle();
      expect(h.api.title, label).toHaveBeenCalledTimes(2);
      expect(h.mount.querySelectorAll('.prism-player-host'), label).toHaveLength(1); // 重试不叠层
      expect(getBackHandlerCountOf('layer'), label).toBe(base + 1);
      back!.click();
      expect(shellOf(h.mount), label).toBeNull();
      expect(getBackHandlerCountOf('layer'), label).toBe(base);
      expect(h.player.isOpen(), label).toBe(false);
    }
    expect(new Set(texts).size).toBe(1); // 三者同构：文案逐字一致，不泄露差异
  });

  it('HP-03a 网络失败如实给离线口径，同样不泄露剧目身份', async () => {
    const h = host({ titleError: new ApiError('NETWORK_ERROR', 0, '网络不可用，请检查连接后重试') });
    expect(await h.player.open('c1')).toBe(false);
    const layer = shellOf(h.mount)!;
    expect(layer.querySelector('.prism-player__state--offline')).not.toBeNull();
    expect(document.body.textContent).not.toContain(PROTECTED);
    expect(layer.querySelector('[data-el="host-retry"]')).not.toBeNull();
    h.player.close();
    expect(shellOf(h.mount)).toBeNull();
  });

  it('HP-03b 详情回来后同一批节点升级为播放层，标题槽此刻才被写入', async () => {
    const gate = deferred();
    const h = host({ titleGate: gate.promise, detail: detailOf({ title: '核验后的剧名' }), titleOf: () => PROTECTED });
    const opened = h.player.open('c1');
    const loading = shellOf(h.mount);
    expect(loading?.dataset.phase).toBe('loading');
    expect(hostState(loading!)).not.toBeNull();
    gate.release();
    expect(await opened).toBe(true);
    await settle();
    expect(shellOf(h.mount)).toBe(loading); // 复用同一节点，不做二次闪烁重建
    expect(shellOf(h.mount)?.dataset.phase).toBe('ready');
    expect(hostState(h.mount.querySelector<HTMLElement>('.prism-player-host')!)).toBeNull();
    expect(shellOf(h.mount)?.querySelector('.prism-player-host__title')?.textContent).toBe('核验后的剧名');
    expect(shellOf(h.mount)?.querySelector('.prism-player')).not.toBeNull();
    h.player.close();
    expect(h.mount.childElementCount).toBe(0);
  });

  it('HP-03b 连点 A/B 只有最新一代提交，旧代迟到不复活也不留第二层', async () => {
    const first = deferred<TitleDetail>();
    const second = deferred<TitleDetail>();
    const h = host({ respondTitle: (id) => (id === 'a' ? first.promise : second.promise) });
    const base = getBackHandlerCountOf('layer');
    const openedA = h.player.open('a');
    const openedB = h.player.open('b');
    expect(h.mount.querySelectorAll('.prism-player-host')).toHaveLength(1);
    second.release(detailOf({ id: 'b', title: '乙剧' }));
    expect(await openedB).toBe(true);
    await settle();
    first.release(detailOf({ id: 'a', title: '甲剧' }));
    expect(await openedA).toBe(false);
    await settle();
    expect(h.mount.querySelectorAll('.prism-player-host')).toHaveLength(1);
    // 标题槽的唯一数据源是注入的 `titleOf()`（受保护候选标题），提交判定改看详情正文。
    expect(h.mount.textContent).toContain('乙剧');
    expect(h.mount.textContent).not.toContain('甲剧');
    expect(getBackHandlerCountOf('layer')).toBe(base + 1);
    h.player.close();
    expect(getBackHandlerCountOf('layer')).toBe(base);
  });

  it('HP-03b setScope 在途时被关闭：旧代不建内核；空清单落可重试层；close 幂等清干净', async () => {
    const gate = deferred();
    const h = host({ runtime: gatedRuntime(gate.promise, 'setScope') });
    const base = getBackHandlerCountOf('layer');
    const opened = h.player.open('c1');
    await settle();
    expect(shellOf(h.mount)).not.toBeNull(); // 详情已回、内核未建：这一段窗口同样必须能退
    h.player.close();
    gate.release();
    expect(await opened).toBe(false);
    await settle();
    expect(h.mount.childElementCount).toBe(0);
    expect(h.calls.playback).toEqual([]);
    h.player.close(); // 幂等：重复关闭不重复通知、不重新挂层
    expect(h.calls.closed).toBe(0);
    expect(getBackHandlerCountOf('layer')).toBe(base);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(shellOf(h.mount)).toBeNull();

    const empty = host({ detail: { item: detailOf().item, episodes: [] } });
    expect(await empty.player.open('c1')).toBe(false);
    const layer = shellOf(empty.mount);
    expect(layer).not.toBeNull(); // 空清单不是静默失败：层内必须有出口
    expect(document.body.textContent).not.toContain(PROTECTED);
    expect(layer?.querySelector('[data-el="host-back"]')).not.toBeNull();
    expect(await dispatchBackButtonForTest()).toBe(true);
    expect(shellOf(empty.mount)).toBeNull();
    expect(getBackHandlerCountOf('layer')).toBe(base);
  });
});
