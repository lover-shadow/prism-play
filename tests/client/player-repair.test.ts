// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { setup, settle } from './player-harness';
import { createWebFallbackBridge } from '../../src/core/native/bridge';

describe('R26 player repair', () => {
  it('Web brightness refuses without painting a fake dim overlay', async () => {
    document.documentElement.style.removeProperty('--native-dim');
    const result = await createWebFallbackBridge().setBrightness(0.2);
    expect(result).toEqual({ brightness: 1, supported: false });
    expect(document.documentElement.style.getPropertyValue('--native-dim')).toBe('');
  });

  it('normal rates reach the engine, survive episode changes and reject unsupported rates', async () => {
    const h = setup(); await h.player.load(11);
    for (const rate of [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4]) {
      expect(h.player.setPlaybackRate(rate)).toBe(true);
      expect(h.state.rate).toBe(rate);
    }
    expect(h.player.setPlaybackRate(5)).toBe(false);
    await h.player.load(12);
    expect(h.state.rate).toBe(4);
    h.player.destroy();
  });

  it.each(['pointerup', 'pointercancel', 'pointerleave', 'blur', 'lock', 'leave', 'focus', 'destroy'])
  ('temporary injected rate restores on %s without persisting', async (end) => {
    const saved = vi.fn(); let hold = 3;
    const h = setup({ playbackPreferences: { normalRate: () => 1.25, holdRate: () => hold, onNormalRate: saved } });
    await h.player.load(11);
    h.player.setPlaybackRate(1.5); hold = 4;
    h.pointer('pointerdown', 320, 100); h.clock.advance(500);
    expect(h.state.rate).toBe(4);
    if (end === 'blur') window.dispatchEvent(new Event('blur'));
    else if (end === 'lock') h.player.setLocked(true);
    else if (end === 'leave') h.player.notifyLeave();
    else if (end === 'focus') h.player.notifyAudioFocus('lost');
    else if (end === 'destroy') h.player.destroy();
    else h.pointer(end, 320, 100);
    expect(h.state.rate).toBe(1.5);
    expect(saved).toHaveBeenCalledTimes(1);
    h.player.destroy();
  });

  it('selection closes its independent sheet and back consumes only the top overlay', async () => {
    const h = setup(); await h.player.load(11); h.player.openDrawer();
    expect(h.player.dismissOverlay()).toBe(true);
    expect(h.player.dismissOverlay()).toBe(false);
    h.player.openDrawer(); h.q<HTMLButtonElement>('[data-episode-id="12"]')?.click(); await settle();
    expect(h.q<HTMLElement>('.prism-drawer')?.hidden).toBe(true);
    expect(h.player.state().episodeId).toBe(12);
    h.player.destroy();
  });

  it('current episode callback follows actual ready state, metadata never advances episodes', async () => {
    const change = vi.fn(); const h = setup({ onEpisodeChange: change });
    await h.player.load(11); h.fire('loadedmetadata'); await settle();
    expect(change.mock.calls.map(([ep]) => ep.episodeId)).toEqual([11]);
    h.fire('ended'); await settle();
    expect(change.mock.calls.map(([ep]) => ep.episodeId)).toEqual([11, 12]);
    h.player.destroy();
  });
});
