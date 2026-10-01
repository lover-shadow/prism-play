/**
 * 播放让行策略 (SPEC F-08 / AC-09 与 F-10 / AC-11).
 *
 * AC-09 is precise about the ending sequence: three seconds before the deadline the volume must start
 * fading linearly, and at the exact moment it runs out the player pauses and releases its handle. Nothing
 * here touches the DOM, storage or a bridge call: both policies are driven by an injected `Clock` and by
 * narrow host callbacks, so they are deterministic under test.
 *
 * Two families of sleep mode exist. Countdown modes (15/30/60 分钟) are wall-clock bounded and fade.
 * Content modes (播完本集 / 播完本剧) are bounded by the media itself: there is nothing to fade because
 * the clip has already run out of audio, so `onEpisodeEnded` stops immediately, and 播完本剧 only counts
 * as satisfied after the LAST episode of the loaded `TitleDetail`.
 *
 * AC-11 lives here because it is the same shape of decision — playback yields to something outside the
 * viewer — and it shares the "never claim more than the platform proved" discipline: the auto-resume
 * needs 通话前在播 + 通话期间未被用户改写 + 音频焦点已恢复, all three, or it stays paused.
 */

import type { CallState } from '../core/native/bridge';

export interface Clock {
  now(): number;
  setTimer(callback: () => void, ms: number): number;
  clearTimer(handle: number): void;
}

/** The production clock. Tests inject their own so no wall time is ever burned. */
export const systemClock: Clock = {
  now: () => Date.now(),
  // `setTimeout` is typed `Timeout` under @types/node but returns a number in every browser and WebView.
  setTimer: (callback, ms) => setTimeout(callback, ms) as unknown as number,
  clearTimer: (handle) => void clearTimeout(handle as unknown as Parameters<typeof clearTimeout>[0])
};

export const SLEEP_MODES = ['off', 'timer-15', 'timer-30', 'timer-60', 'episode-end', 'series-end'] as const;
export type SleepMode = (typeof SLEEP_MODES)[number];

export const SLEEP_LABELS: Readonly<Record<SleepMode, string>> = {
  off: '不定时',
  'timer-15': '15 分钟',
  'timer-30': '30 分钟',
  'timer-60': '60 分钟',
  'episode-end': '播完本集',
  'series-end': '播完本剧'
};

/** Modes offered in the player menu, in display order. `off` is the reset action, not an option. */
export const SLEEP_CHOICES: readonly SleepMode[] = ['timer-15', 'timer-30', 'timer-60', 'episode-end', 'series-end'];

const SLEEP_MINUTES: Readonly<Partial<Record<SleepMode, number>>> = { 'timer-15': 15, 'timer-30': 30, 'timer-60': 60 };

/** AC-09: the fade window, and how often it is recomputed. */
export const FADE_WINDOW_MS = 3000;
export const FADE_TICK_MS = 250;

export interface SleepTimerHost {
  /** Current player gain, 0..1. Read once when the fade starts so a re-schedule is stable. */
  getVolume(): number;
  setVolume(value: number): void;
  /** Pause the media AND release the playback handle (AC-09 归零瞬间). */
  stop(): void;
}

export interface EpisodeEndContext {
  /** Zero-based index of the episode that just finished, inside the loaded `TitleDetail`. */
  episodeIndex: number;
  /** `episodes.length` of the same loaded detail — 播完本剧 is only satisfied at that boundary. */
  episodeTotal: number;
}

export interface SleepTimer {
  schedule(mode: SleepMode): void;
  cancel(): void;
  mode(): SleepMode;
  /** Wall-clock remaining for countdown modes; `null` for content-bounded and inactive modes. */
  remainingMs(): number | null;
  isFading(): boolean;
  onEpisodeEnded(context: EpisodeEndContext): 'stop' | 'continue';
  destroy(): void;
}

function isSleepMode(value: SleepMode): value is 'timer-15' | 'timer-30' | 'timer-60' {
  return SLEEP_MINUTES[value] !== undefined;
}

export function createSleepTimer(clock: Clock, host: SleepTimerHost): SleepTimer {
  let mode: SleepMode = 'off';
  let endAt = 0;
  let deadline: number | null = null;
  let tick: number | null = null;
  let fadeFrom: number | null = null;

  const clearAll = (): void => {
    if (deadline !== null) clock.clearTimer(deadline);
    if (tick !== null) clock.clearTimer(tick);
    deadline = null;
    tick = null;
  };

  const stopNow = (): void => {
    clearAll();
    mode = 'off';
    fadeFrom = null;
    endAt = 0;
    host.setVolume(0);
    host.stop();
  };

  const tickFade = (): void => {
    tick = null;
    if (mode === 'off') return;
    const remaining = endAt - clock.now();
    if (remaining <= 0) {
      stopNow();
      return;
    }
    if (remaining <= FADE_WINDOW_MS) {
      if (fadeFrom === null) fadeFrom = host.getVolume();
      host.setVolume(fadeFrom * (remaining / FADE_WINDOW_MS));
    }
    tick = clock.setTimer(tickFade, FADE_TICK_MS);
  };

  const arm = (ms: number): void => {
    endAt = clock.now() + ms;
    deadline = clock.setTimer(stopNow, ms);
    tick = clock.setTimer(tickFade, FADE_TICK_MS);
  };

  return {
    schedule: (next) => {
      clearAll();
      fadeFrom = null;
      if (next === 'off') {
        mode = 'off';
        endAt = 0;
        return;
      }
      mode = next;
      if (isSleepMode(next)) arm((SLEEP_MINUTES[next] as number) * 60_000);
    },

    cancel: () => {
      clearAll();
      const restore = fadeFrom;
      mode = 'off';
      endAt = 0;
      fadeFrom = null;
      // A cancelled fade must not leave the viewer muted.
      if (restore !== null) host.setVolume(restore);
    },

    mode: () => mode,

    remainingMs: () => (mode === 'off' || !isSleepMode(mode) ? null : Math.max(0, endAt - clock.now())),

    isFading: () => fadeFrom !== null,

    onEpisodeEnded: (context) => {
      if (mode === 'episode-end') {
        stopNow();
        return 'stop';
      }
      if (mode !== 'series-end') return 'continue';
      const last = context.episodeIndex >= context.episodeTotal - 1;
      if (last) stopNow();
      return last ? 'stop' : 'continue';
    },

    destroy: () => clearAll()
  };
}

/* ==========================================================================
   AC-11 来电暂挂：与睡眠定时同属“播放让行”策略，共用注入时钟与同一套判定纪律。
   ========================================================================== */

export interface CallPolicyHost {
  playing(): boolean;
  position(): number;
  pause(): void;
  resume(position: number): void;
}

export interface CallInterruptPolicy {
  /** Wire straight to `bridge.onCallState`. */
  onCallState(state: CallState): void;
  /** Audio focus is the host's fact: without 'restored' the player never auto-resumes. */
  audioFocus(focus: 'restored' | 'lost'): void;
  /** Any user pause / play / navigation during the call vetoes the auto-resume. */
  noteUserAction(): void;
  /** Lets the media `pause` handler tell "we paused it" apart from "the viewer paused it". */
  pausingForCall(): boolean;
  active(): boolean;
}

export function createCallInterruptPolicy(host: CallPolicyHost): CallInterruptPolicy {
  let call: { wasPlaying: boolean; userTouched: boolean; position: number } | null = null;
  let focus: 'unknown' | 'restored' | 'lost' = 'unknown';
  let pausing = false;

  return {
    onCallState: (state) => {
      if (state !== 'idle') {
        if (call !== null) return;
        const playing = host.playing();
        call = { wasPlaying: playing, userTouched: false, position: host.position() };
        // Already paused: no synthetic pause event, so no bogus breakpoint write downstream.
        if (!playing) return;
        pausing = true;
        host.pause();
        pausing = false;
        return;
      }
      const snapshot = call;
      call = null;
      // 恢复前置条件：通话前在播 + 通话期间用户未主动暂停或切走 + 音频焦点已恢复。
      const resume = snapshot !== null && snapshot.wasPlaying && !snapshot.userTouched && focus === 'restored';
      focus = 'unknown';
      if (resume && snapshot !== null) host.resume(snapshot.position);
    },
    audioFocus: (value) => {
      focus = value;
    },
    noteUserAction: () => {
      if (call !== null) call.userTouched = true;
    },
    pausingForCall: () => pausing,
    active: () => call !== null
  };
}
