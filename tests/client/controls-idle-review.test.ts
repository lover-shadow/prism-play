import { describe, expect, it } from 'vitest';
import { CONTROLS_IDLE_MS, createControlsIdle } from '../../src/player/controls-idle';
import type { MediaEvent } from '../../src/player/engine-seam';
import { fakeClock } from './player-harness';

function setup() {
  const clock = fakeClock();
  const state = { visible: true, playing: true, fullscreen: true, blocked: false };
  const idle = createControlsIdle({
    clock, visible: () => state.visible, setVisible: (on) => { state.visible = on; },
    playing: () => state.playing, fullscreen: () => state.fullscreen, blocked: () => state.blocked
  });
  const event = (name: MediaEvent) => idle.onMediaEvent(name);
  return { clock, state, idle, event };
}

describe('controls idle review — real-time eligibility and recovery', () => {
  it('play → waiting → playing resumes the idle timer without an external arm', () => {
    const { clock, state, event } = setup();
    event('play');
    clock.advance(1000);
    event('waiting');
    clock.advance(CONTROLS_IDLE_MS);
    expect(state.visible).toBe(true);
    expect(clock.pending()).toHaveLength(0);
    event('playing');
    clock.advance(CONTROLS_IDLE_MS - 1);
    expect(state.visible).toBe(true);
    clock.advance(1);
    expect(state.visible).toBe(false);
  });

  it('seeking → seeked resumes the idle timer when the engine is playing', () => {
    const { clock, state, event } = setup();
    event('play');
    event('seeking');
    expect(clock.pending()).toHaveLength(0);
    event('seeked');
    clock.advance(CONTROLS_IDLE_MS);
    expect(state.visible).toBe(false);
  });

  it('seeking → seeked stays visible and unarmed when the engine is not playing', () => {
    const { clock, state, event } = setup();
    event('play');
    event('seeking');
    state.playing = false;
    event('seeked');
    clock.advance(CONTROLS_IDLE_MS * 2);
    expect(state.visible).toBe(true);
    expect(clock.pending()).toHaveLength(0);
  });

  it('exiting fullscreen before timeout never hides the detail controls', () => {
    const { clock, state, event } = setup();
    event('play');
    clock.advance(CONTROLS_IDLE_MS - 1);
    state.fullscreen = false;
    clock.advance(1);
    expect(state.visible).toBe(true);
    expect(clock.pending()).toHaveLength(0);
  });

  it('an engine paused before timeout stays visible even before pause is forwarded', () => {
    const { clock, state, event } = setup();
    event('play');
    clock.advance(CONTROLS_IDLE_MS - 1);
    state.playing = false;
    clock.advance(1);
    expect(state.visible).toBe(true);
    expect(clock.pending()).toHaveLength(0);
  });

  it('an open menu prevents hiding; closing it allows the next normal timeout', () => {
    const { clock, state, event } = setup();
    event('play');
    state.blocked = true;
    clock.advance(CONTROLS_IDLE_MS * 2);
    expect(state.visible).toBe(true);
    expect(clock.pending()).toHaveLength(1);
    state.blocked = false;
    clock.advance(CONTROLS_IDLE_MS - 1);
    expect(state.visible).toBe(true);
    clock.advance(1);
    expect(state.visible).toBe(false);
  });

  it('tapping outside fullscreen cannot hide detail controls, and restores hidden ones', () => {
    const { clock, state, idle } = setup();
    state.fullscreen = false;
    idle.tap();
    expect(state.visible).toBe(true);
    state.visible = false;
    idle.tap();
    expect(state.visible).toBe(true);
    expect(clock.pending()).toHaveLength(0);
  });

  it.each(['pause', 'waiting', 'seeking', 'ended', 'error'] as const)('%s shows controls and stops the timer', (name) => {
    const { clock, state, event } = setup();
    event('play');
    state.visible = false;
    event(name);
    clock.advance(CONTROLS_IDLE_MS);
    expect(state.visible).toBe(true);
    expect(clock.pending()).toHaveLength(0);
  });

  it('fullscreen taps still toggle controls and rearm after showing', () => {
    const { clock, state, idle } = setup();
    idle.tap();
    expect(state.visible).toBe(false);
    idle.tap();
    expect(state.visible).toBe(true);
    clock.advance(CONTROLS_IDLE_MS);
    expect(state.visible).toBe(false);
    idle.show();
    idle.arm();
    idle.destroy();
    expect(clock.pending()).toHaveLength(0);
  });
});
