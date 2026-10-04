import type { PlayerEngine } from './engine-seam';
import type { Clock } from './sleep-timer';
import { icon } from '../components/icons';

export const PLAYBACK_RATES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const;
export interface PlaybackPreferences {
  normalRate?(): number;
  holdRate?(): number;
  onNormalRate?(rate: number): void;
}
const valid = (rate: number): boolean => (PLAYBACK_RATES as readonly number[]).includes(rate);
const label = (rate: number): string => rate === 1 ? '正常' : `${rate} 倍`;

/** Only verified engine rates become normal preferences. Temporary rates never enter the sink. */
export function createPlaybackRate(options: {
  root: HTMLElement; surface: HTMLElement; pill: HTMLElement; clock: Clock;
  engine(): PlayerEngine | null; locked(): boolean; preferences?: PlaybackPreferences;
  onError(message: string): void; beforeOpen(): void; onHold(): void;
}) {
  let normal = options.preferences?.normalRate?.() ?? 1;
  if (!valid(normal)) normal = 1;
  let temporary = false, timer: number | null = null;
  let pointer: { id: number; x: number; y: number } | null = null;
  const bound: Array<[EventTarget, string, EventListener]> = [];
  const bind = (target: EventTarget, name: string, fn: EventListener) => {
    target.addEventListener(name, fn); bound.push([target, name, fn]);
  };
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'prism-player__pill'; button.dataset.prismUi = 'rate';
  button.dataset.action = 'rate'; button.setAttribute('aria-label', '播放速度');
  const sheet = document.createElement('div');
  sheet.className = 'prism-rate-sheet'; sheet.dataset.prismUi = 'rate'; sheet.hidden = true;
  sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-label', '播放速度');
  let focus: Element | null = null;
  const close = () => { if (sheet.hidden) return false; sheet.hidden = true; if (focus instanceof HTMLElement) focus.focus(); return true; };
  const render = () => {
    button.textContent = label(normal);
    sheet.querySelectorAll<HTMLButtonElement>('[data-rate]').forEach((item) => item.setAttribute('aria-pressed', String(Number(item.dataset.rate) === normal)));
  };
  const apply = (rate: number): boolean => {
    const engine = options.engine();
    try {
      if (!engine?.setPlaybackRate || !engine.playbackRate) throw new Error('当前内核不支持倍速');
      engine.setPlaybackRate(rate);
      if (Math.abs(engine.playbackRate() - rate) > 0.001) throw new Error('当前设备未接受此倍率');
      return true;
    } catch {
      const message = `无法应用 ${label(rate)}，当前设备不支持`;
      options.onError(message); options.pill.textContent = message; options.pill.classList.add('is-active'); return false;
    }
  };
  const cancel = () => {
    if (timer !== null) options.clock.clearTimer(timer);
    timer = null; pointer = null;
    if (temporary) { temporary = false; apply(normal); }
    options.pill.classList.remove('is-active');
  };
  const set = (rate: number): boolean => {
    cancel(); if (!valid(rate)) return false;
    if (!apply(rate)) { apply(normal); return false; }
    normal = rate; render(); options.preferences?.onNormalRate?.(rate); return true;
  };
  for (const rate of PLAYBACK_RATES) {
    const item = document.createElement('button'); item.type = 'button'; item.className = 'prism-player__pill';
    item.dataset.rate = String(rate); item.textContent = label(rate);
    item.addEventListener('click', () => { if (set(rate)) close(); }); sheet.append(item);
  }
  const exit = document.createElement('button'); exit.type = 'button'; exit.className = 'prism-player__button';
  exit.setAttribute('aria-label', '关闭倍速'); exit.innerHTML = icon('close', { size: 20 }); exit.addEventListener('click', close); sheet.append(exit);
  button.addEventListener('click', () => {
    cancel(); options.beforeOpen(); focus = document.activeElement; sheet.hidden = false;
    sheet.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
  });
  options.root.append(sheet); render();
  bind(options.surface, 'pointerdown', (event) => {
    const e = event as PointerEvent;
    if (options.locked() || pointer !== null || !Number.isFinite(e.pointerId)) { cancel(); return; }
    pointer = { id: e.pointerId, x: e.clientX, y: e.clientY };
    timer = options.clock.setTimer(() => {
      timer = null;
      if (!pointer || options.locked()) return;
      const rate = options.preferences?.holdRate?.() ?? 2;
      if (!valid(rate)) { options.onError('长按倍率偏好无效'); return; }
      temporary = true;
      if (!apply(rate)) { cancel(); return; }
      options.onHold();
      options.pill.replaceChildren(); const glyph = document.createElement('span'); glyph.innerHTML = icon('play', { size: 16 });
      options.pill.append(glyph, document.createTextNode(`${label(rate)} 临时快进`)); options.pill.classList.add('is-active');
    }, 500);
  });
  bind(window, 'pointermove', (event) => {
    const e = event as PointerEvent;
    if (pointer && (e.pointerId !== pointer.id || Math.max(Math.abs(e.clientX - pointer.x), Math.abs(e.clientY - pointer.y)) >= 8)) cancel();
  });
  for (const name of ['pointerup', 'pointercancel']) bind(window, name, cancel);
  bind(options.surface, 'pointerleave', cancel); bind(window, 'blur', cancel);
  bind(document, 'visibilitychange', () => { if (document.hidden) cancel(); });
  return {
    button, set, cancel, close, normal: () => normal,
    reapply: () => { if (normal !== 1 || options.engine()?.setPlaybackRate) apply(normal); },
    destroy: () => { cancel(); for (const [target, name, fn] of bound) target.removeEventListener(name, fn); sheet.remove(); button.remove(); }
  };
}
