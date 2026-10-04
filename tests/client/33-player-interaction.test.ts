// @vitest-environment jsdom
/**
 * 播放器交互层（AC-06…AC-11）：分屏手势 HUD、触控锁、睡眠定时、来电焦点、选集抽屉与资源拆除。
 * 亮度走窗口级原生通道、音量在 Web 端只能动元素增益，这些差异全部由断言固定下来。
 */
import { describe, expect, it } from 'vitest';
import { detailOf, settle, setup } from './player-harness';

describe('手势 HUD 与原生通道', () => {
  it('right drag moves only the element gain and the HUD states the web limit (AC-06)', async () => {
    const h = setup();
    await h.player.load(11); await settle();
    h.swipe(360, 60, 150); await settle();
    expect(h.calls.systemVolume).toHaveLength(0);
    expect([h.state.vol < 1, h.hud('volume').classList.contains('is-visible')]).toEqual([true, true]);
    expect(h.hud('volume').textContent).toMatch(/音量 \d{1,3}%/);
    expect(h.hud('volume').querySelector('.prism-hud__notice')?.textContent).toContain('Android');
    h.clock.advance(700);
    expect(h.hud('volume').classList.contains('is-visible')).toBe(false);
  });

  it('left drag asks the bridge for window brightness and shows the amber HUD (AC-07)', async () => {
    const h = setup();
    await h.player.load(11); await settle();
    h.swipe(40, 180, 96); await settle();
    expect(h.calls.brightness).toHaveLength(1);
    expect([h.hud('brightness').classList.contains('is-visible'), h.hud('volume').classList.contains('is-visible')]).toEqual([true, false]);
    expect(h.hud('brightness').textContent).toMatch(/亮度 \d{1,3}%/);
    expect(h.hud('brightness').querySelector('.prism-hud__notice')?.textContent).toContain('亮度');
  });

  it('a native bridge gets one call per animation frame and never touches the element gain', async () => {
    const h = setup({ native: true });
    await h.player.load(11); await settle();
    h.pointer('pointerdown', 360, 180);
    for (let y = 172; y > 60; y -= 8) h.pointer('pointermove', 360, y);
    expect(h.frames.size()).toBe(1);
    h.frames.run(); await settle();
    expect([h.calls.systemVolume.length, h.state.vol]).toEqual([1, 1]);
    expect(h.hud('volume').querySelector('.prism-hud__notice')?.hasAttribute('hidden')).toBe(true);
  });

  it('double tap seeks ±10s while a single tap only toggles the chrome (AC-08)', async () => {
    const h = setup();
    await h.player.load(11); await settle();
    h.state.t = 50;
    h.pointer('pointerdown', 320, 100); h.pointer('pointerup', 320, 100);
    h.clock.advance(90);
    h.pointer('pointerdown', 320, 100); h.pointer('pointerup', 320, 100);
    expect(h.state.t).toBe(60);
    h.clock.advance(400);
    h.pointer('pointerdown', 60, 100); h.pointer('pointerup', 60, 100);
    expect([h.state.toggles, h.state.t]).toEqual([0, 60]);
    h.clock.advance(400);
    expect([h.state.toggles, h.state.t]).toEqual([1, 60]);
  });

  it('touch lock suppresses gestures while playback and the unlock control stay live', async () => {
    const h = setup();
    await h.player.load(11); await settle();
    h.player.setLocked(true);
    h.swipe(360, 60, 170);
    h.pointer('pointerdown', 320, 100); h.pointer('pointerup', 320, 100); h.clock.advance(400);
    await settle();
    expect([h.state.vol, h.state.toggles, h.player.state().locked]).toEqual([1, 0, true]);
    h.player.play();
    expect(h.state.playing).toBe(true);
    h.q<HTMLElement>('[data-action="lock"]')?.click();
    expect(h.player.state().locked).toBe(false);
  });
});

describe('定时、来电、抽屉与拆除', () => {
  it('sleep timer fades the last 3s then pauses and releases the handle (AC-09)', async () => {
    const h = setup();
    await h.player.load(11); await settle();
    h.player.scheduleSleep('timer-15');
    h.swipe(360, 60, 96); await settle();
    const gain = h.state.vol;
    expect([h.player.state().sleepMode, gain < 1]).toEqual(['timer-15', true]);
    h.clock.advance(15 * 60_000 - 3_000);
    expect(h.state.vol).toBe(gain);
    h.clock.advance(1_500);
    expect(h.state.vol).toBeCloseTo(gain / 2, 3);
    h.clock.advance(1_500); await settle();
    expect([h.state.vol, h.state.playing, h.state.destroyed]).toEqual([0, false, true]);
    expect(h.player.state()).toMatchObject({ phase: 'idle', sleepMode: 'off' });
  });

  it('a call pauses with a breakpoint; resume needs all three preconditions (AC-11)', async () => {
    const h = setup();
    await h.player.load(11);
    h.player.play(); h.state.t = 42; await settle();
    h.calls.listener?.('ringing');
    expect([h.state.playing, h.progress.mock.calls.length > 1]).toEqual([false, true]);
    h.player.notifyAudioFocus('restored');
    h.calls.listener?.('idle');
    expect([h.state.playing, h.state.t]).toEqual([true, 42]);
    for (const veto of ['user-pause', 'no-focus', 'leave'] as const) {
      const cold = setup();
      await cold.player.load(11);
      cold.player.play(); await settle();
      cold.calls.listener?.('offhook');
      if (veto === 'user-pause') cold.fire('pause');
      if (veto === 'leave') cold.player.notifyLeave();
      if (veto !== 'no-focus') cold.player.notifyAudioFocus('restored');
      cold.calls.listener?.('idle');
      expect(cold.state.playing, veto).toBe(false);
    }
  });

  it('background audio never starts without the injected permission flag (AC-10)', async () => {
    const denied = setup();
    await denied.player.load(11);
    denied.player.play(); await settle();
    expect(denied.calls.startBackground).toHaveLength(0);
    const granted = setup({ allowBackgroundAudio: true });
    await granted.player.load(11);
    granted.player.play(); await settle();
    expect([granted.calls.startBackground, granted.calls.keepScreenOn.includes(true)]).toEqual([['测试剧'], true]);
  });

  it('drawer lists episodes, marks the current one and hides share plus the unflagged switch', async () => {
    const h = setup({ allowShare: true, detail: detailOf() });
    await h.player.load(12); await settle();
    h.player.openDrawer();
    const rows = () => h.root.querySelectorAll<HTMLElement>('.prism-drawer__item');
    expect([rows().length, rows()[1].classList.contains('is-current'), h.q('.prism-drawer__action') !== null]).toEqual([3, true, true]);
    rows()[2].click(); await settle();
    expect(h.api.playback).toHaveBeenLastCalledWith(13);
    expect(rows()[2].classList.contains('is-current')).toBe(true);
    const secret = setup({ allowShare: true, allowBackgroundAudio: true, detail: detailOf({ isPrivate: true, channelId: 'private' }) });
    await secret.player.load(11); await settle();
    secret.player.openDrawer();
    expect([secret.q('.prism-drawer__action'), secret.q('.prism-drawer__switch') !== null, secret.calls.startBackground]).toEqual([null, true, []]);
    const unflagged = setup({ allowShare: true, detail: detailOf() });
    await unflagged.player.load(11); await settle();
    unflagged.player.openDrawer();
    expect(unflagged.q('.prism-drawer__switch')).toBeNull();
  });

  it('destroy leaves no timer, listener or bridge subscription behind', async () => {
    const h = setup({ allowBackgroundAudio: true });
    await h.player.load(11);
    h.player.play();
    h.player.scheduleSleep('timer-60'); await settle();
    expect(h.clock.pending().length).toBeGreaterThan(0);
    h.player.destroy();
    expect([h.clock.pending().length, h.frames.size(), h.calls.unsubs, h.calls.stopBackground]).toEqual([0, 0, 1, 1]);
    expect([h.calls.keepScreenOn.at(-1), h.state.destroyed, h.player.state().phase]).toEqual([false, true, 'destroyed']);
    const writes = h.progress.mock.calls.length;
    h.fire('timeupdate');
    h.swipe(360, 60, 170); h.frames.run();
    h.calls.listener?.('ringing');
    h.q<HTMLElement>('[data-action="sleep"]')?.click(); await settle();
    expect([h.progress.mock.calls.length, h.calls.brightness.length]).toEqual([writes, 0]);
    h.player.destroy();
    expect(h.calls.stopBackground).toBe(1);
  });
});
