// @vitest-environment jsdom
/**
 * 睡眠定时与来电暂挂（AC-09 / AC-11）—— 全部由注入时钟驱动，零真实等待。
 */
import { describe, expect, it } from 'vitest';
import {
  createCallInterruptPolicy,
  createSleepTimer,
  FADE_WINDOW_MS,
  SLEEP_CHOICES,
  SLEEP_LABELS
} from '../../src/player/sleep-timer';
import type { CallPolicyHost, Clock, SleepTimerHost } from '../../src/player/sleep-timer';

interface FakeClock extends Clock {
  current(): number;
  advance(ms: number): void;
  pending(): number[];
}

function fakeClock(): FakeClock {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; cb: () => void }>();
  return {
    now: () => now,
    setTimer: (cb, ms) => {
      seq += 1;
      timers.set(seq, { at: now + Math.max(0, ms), cb });
      return seq;
    },
    clearTimer: (id) => void timers.delete(id),
    current: () => now,
    pending: () => [...timers.keys()],
    advance: (ms) => {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        if (due.length === 0) break;
        const [id, timer] = due[0];
        timers.delete(id);
        now = Math.max(now, timer.at);
        timer.cb();
      }
      now = target;
    }
  };
}

function fakeHost(start = 0.8) {
  const volumes: number[] = [];
  let gain = start;
  let stops = 0;
  const host: SleepTimerHost = {
    getVolume: () => gain,
    setVolume: (value) => {
      volumes.push(value);
      gain = value;
    },
    stop: () => {
      stops += 1;
    }
  };
  return { host, volumes, stops: () => stops, gain: () => gain };
}

const FIFTEEN = 15 * 60_000;

describe('睡眠定时（AC-09）', () => {
  it('offers 15/30/60 分钟、播完本集、播完本剧', () => {
    expect(SLEEP_CHOICES).toEqual(['timer-15', 'timer-30', 'timer-60', 'episode-end', 'series-end']);
    expect(SLEEP_LABELS['timer-15']).toBe('15 分钟');
    expect(SLEEP_LABELS['episode-end']).toBe('播完本集');
    expect(SLEEP_LABELS['series-end']).toBe('播完本剧');
  });

  it('does not touch the gain until the last three seconds', () => {
    const clock = fakeClock();
    const spy = fakeHost(0.8);
    const timer = createSleepTimer(clock, spy.host);
    timer.schedule('timer-15');
    clock.advance(FIFTEEN - FADE_WINDOW_MS - 1_000);
    expect(spy.volumes).toHaveLength(0);
    expect(timer.remainingMs()).toBe(1_000 + FADE_WINDOW_MS);
    expect(timer.isFading()).toBe(false);
  });

  it('fades linearly across the 3s window and reaches exactly zero at the deadline', () => {
    const clock = fakeClock();
    const spy = fakeHost(0.8);
    const timer = createSleepTimer(clock, spy.host);
    timer.schedule('timer-15');
    clock.advance(FIFTEEN - FADE_WINDOW_MS);
    expect(timer.isFading()).toBe(true);
    expect(spy.volumes.at(0)).toBeCloseTo(0.8, 10);
    clock.advance(1_500);
    expect(spy.volumes.at(-1)).toBeCloseTo(0.4, 10);
    clock.advance(1_000);
    expect(spy.volumes.at(-1)).toBeCloseTo(0.8 * (500 / 3_000), 10);
    clock.advance(500);
    expect(spy.volumes.at(-1)).toBe(0);
    expect(spy.stops()).toBe(1);
    expect(timer.mode()).toBe('off');
    const monotonic = spy.volumes.every((value, index) => index === 0 || value <= (spy.volumes[index - 1] as number) + 1e-9);
    expect(monotonic).toBe(true);
  });

  it('a cancelled timer never fades audio and never stops playback', () => {
    const clock = fakeClock();
    const spy = fakeHost(0.8);
    const timer = createSleepTimer(clock, spy.host);
    timer.schedule('timer-30');
    timer.cancel();
    clock.advance(30 * 60_000 + 5_000);
    expect(spy.volumes).toHaveLength(0);
    expect(spy.stops()).toBe(0);
    expect(clock.pending()).toHaveLength(0);
    expect(timer.mode()).toBe('off');
  });

  it('cancel mid-fade hands the borrowed gain back and stops writing', () => {
    const clock = fakeClock();
    const spy = fakeHost(0.8);
    const timer = createSleepTimer(clock, spy.host);
    timer.schedule('timer-15');
    clock.advance(FIFTEEN - 1_500);
    expect(spy.volumes.length).toBeGreaterThan(1);
    expect(spy.gain()).toBeLessThan(0.8);
    timer.cancel();
    expect(spy.gain()).toBe(0.8);
    const writes = spy.volumes.length;
    clock.advance(FIFTEEN);
    expect(spy.volumes).toHaveLength(writes);
    expect(spy.stops()).toBe(0);
  });

  it('re-scheduling replaces the old deadline instead of stacking two fades', () => {
    const clock = fakeClock();
    const spy = fakeHost(1);
    const timer = createSleepTimer(clock, spy.host);
    timer.schedule('timer-60');
    timer.schedule('timer-15');
    expect(timer.remainingMs()).toBe(FIFTEEN);
    clock.advance(FIFTEEN + 10);
    expect(spy.stops()).toBe(1);
    expect(timer.remainingMs()).toBeNull();
  });

  it('播完本集 stops after the current episode, 播完本剧 only after the last one', () => {
    const clock = fakeClock();
    const spy = fakeHost(1);
    const timer = createSleepTimer(clock, spy.host);
    timer.schedule('episode-end');
    expect(timer.remainingMs()).toBeNull();
    expect(timer.onEpisodeEnded({ episodeIndex: 0, episodeTotal: 3 })).toBe('stop');
    expect(spy.stops()).toBe(1);

    timer.schedule('series-end');
    expect(timer.onEpisodeEnded({ episodeIndex: 0, episodeTotal: 3 })).toBe('continue');
    expect(timer.onEpisodeEnded({ episodeIndex: 1, episodeTotal: 3 })).toBe('continue');
    expect(spy.stops()).toBe(1);
    expect(timer.onEpisodeEnded({ episodeIndex: 2, episodeTotal: 3 })).toBe('stop');
    expect(spy.stops()).toBe(2);

    timer.schedule('off');
    expect(timer.mode()).toBe('off');
    expect(timer.onEpisodeEnded({ episodeIndex: 0, episodeTotal: 3 })).toBe('continue');
  });

  it('destroy leaves no timer behind and cannot fire afterwards', () => {
    const clock = fakeClock();
    const spy = fakeHost(1);
    const timer = createSleepTimer(clock, spy.host);
    timer.schedule('timer-15');
    expect(clock.pending()).toHaveLength(2);
    timer.destroy();
    expect(clock.pending()).toHaveLength(0);
    clock.advance(FIFTEEN + 1_000);
    expect(spy.stops()).toBe(0);
    expect(spy.volumes).toHaveLength(0);
  });
});

function callHost(playing: boolean) {
  const events: string[] = [];
  let at = 42;
  const host: CallPolicyHost = {
    playing: () => playing,
    position: () => at,
    pause: () => {
      playing = false;
      events.push('pause');
    },
    resume: (position) => {
      at = position;
      playing = true;
      events.push(`resume:${position}`);
    }
  };
  return { host, events, isPlaying: () => playing, move: (to: number) => void (at = to) };
}

describe('来电暂挂（AC-11）', () => {
  it('pauses on ringing and records the breakpoint', () => {
    const spy = callHost(true);
    const policy = createCallInterruptPolicy(spy.host);
    policy.onCallState('ringing');
    expect(spy.events).toEqual(['pause']);
    expect(spy.isPlaying()).toBe(false);
    expect(policy.active()).toBe(true);
    expect(policy.pausingForCall()).toBe(false);
  });

  it('resumes only when playing before, untouched and focus restored', () => {
    const spy = callHost(true);
    const policy = createCallInterruptPolicy(spy.host);
    policy.onCallState('ringing');
    policy.onCallState('offhook');
    policy.audioFocus('restored');
    policy.onCallState('idle');
    expect(spy.events).toEqual(['pause', 'resume:42']);
    expect(spy.isPlaying()).toBe(true);
    expect(policy.active()).toBe(false);
  });

  it('stays paused when the viewer paused during the call', () => {
    const spy = callHost(true);
    const policy = createCallInterruptPolicy(spy.host);
    policy.onCallState('ringing');
    policy.noteUserAction();
    policy.audioFocus('restored');
    policy.onCallState('idle');
    expect(spy.events).toEqual(['pause']);
    expect(spy.isPlaying()).toBe(false);
  });

  it('stays paused while audio focus was never handed back', () => {
    const spy = callHost(true);
    const policy = createCallInterruptPolicy(spy.host);
    policy.onCallState('ringing');
    policy.audioFocus('lost');
    policy.onCallState('idle');
    expect(spy.events).toEqual(['pause']);
    const again = callHost(true);
    const policy2 = createCallInterruptPolicy(again.host);
    policy2.onCallState('offhook');
    policy2.onCallState('idle');
    expect(again.events).toEqual(['pause']);
  });

  it('never starts playing for a call that arrived while paused', () => {
    const spy = callHost(false);
    const policy = createCallInterruptPolicy(spy.host);
    policy.onCallState('ringing');
    policy.audioFocus('restored');
    policy.onCallState('idle');
    expect(spy.events).toEqual([]);
    expect(spy.isPlaying()).toBe(false);
  });

  it('the bridge keeps one active interruption per call', () => {
    const spy = callHost(true);
    const policy = createCallInterruptPolicy(spy.host);
    policy.onCallState('ringing');
    spy.move(88);
    policy.onCallState('offhook');
    policy.audioFocus('restored');
    policy.onCallState('idle');
    expect(spy.events).toEqual(['pause', 'resume:42']);
  });
});
