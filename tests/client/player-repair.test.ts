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
    await h.player.load(11); h.fire('loadedmetadata'); h.fire('play'); h.fire('playing'); await settle();
    expect(change.mock.calls.map(([ep]) => ep.episodeId)).toEqual([11]);
    h.fire('ended'); await settle();
    expect(change.mock.calls.map(([ep]) => ep.episodeId)).toEqual([11, 12]);
    h.player.destroy();
  });

  it.each(['playing', 'seeked', 'waiting', 'seeking', 'pause', 'timeupdate', 'loadedmetadata'] as const)
  ('HP-01: %s never uses the old ended fallback to advance an episode', async (event) => {
    const h = setup(); await h.player.load(11); h.fire('playing'); await settle();
    h.fire(event); await settle();
    expect(h.player.state().episodeId).toBe(11);
    h.player.destroy();
  });

  it('HP-01: only a valid ended advances once, including after natural pause', async () => {
    const boundary = vi.fn(async () => undefined); const h = setup({ onNaturalBoundary: boundary });
    await h.player.load(11); h.fire('play'); h.fire('ended'); await settle();
    expect(h.player.state().episodeId).toBe(12); expect(boundary).toHaveBeenCalledTimes(1);
    h.fire('ended'); await settle(); expect(h.player.state().episodeId).toBe(12);
    h.player.destroy();
  });

  it('HP-01: a replaced media source cannot commit its old position to the new episode', async () => {
    const h = setup(); await h.player.load(11); h.state.t = 80;
    const before = h.progress.mock.calls.length;
    h.player.pause();
    expect(h.progress.mock.calls.slice(before).every(([, context]) => (context as { sourceEpisodeId: number }).sourceEpisodeId === 11)).toBe(true);
    expect(h.progress.mock.calls.at(-1)?.[0]).toMatchObject({ last_episode_id: 11, position_seconds: 80 });
    h.state.t = 0;
    await h.player.load(12); h.player.pause();
    expect(h.progress.mock.calls.at(-1)?.[0]).toMatchObject({ last_episode_id: 12, position_seconds: 0 });
    h.player.destroy();
  });

  it('HP-01: unknown duration is not inferred from position or marked complete', async () => {
    const h = setup(); h.state.duration = 0; await h.player.load(11); h.state.t = 80; h.clock.advance(6_000); h.fire('timeupdate');
    expect(h.progress.mock.calls.at(-1)?.[0]).toMatchObject({ position_seconds: 80, duration_seconds: 0 });
    h.player.destroy();
  });

  it('HP-01: an error is never interpreted as a natural episode boundary', async () => {
    const h = setup(); await h.player.load(11); h.fire('error'); await settle();
    expect(h.player.state()).toMatchObject({ episodeId: 11, phase: 'error' });
    h.player.destroy();
  });
});
