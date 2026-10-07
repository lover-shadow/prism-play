import { icon } from '../components/icons';
import type { PlayerEngine } from './engine-seam';

export function createNativeControls(root: HTMLElement, engine: Pick<PlayerEngine, 'playing' | 'play' | 'pause' | 'currentTime' | 'duration' | 'setCurrentTime'>) {
  const bar = document.createElement('div');
  bar.className = 'prism-native-controls'; bar.dataset.prismUi = 'native-controls';
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'prism-player__button';
  const range = document.createElement('input');
  range.type = 'range'; range.min = '0'; range.step = '0.1'; range.setAttribute('aria-label', '播放进度');
  const time = document.createElement('span'); time.className = 'prism-native-controls__time';
  let dragging = false, locked = false;
  const format = (seconds: number): string => {
    const value = Math.max(0, Math.floor(seconds));
    return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
  };
  function update(): void {
    const playing = engine.playing(), duration = engine.duration();
    button.setAttribute('aria-label', playing ? '暂停' : '播放');
    button.innerHTML = icon(playing ? 'pause' : 'play', { size: 24 });
    button.disabled = locked;
    range.disabled = locked || !(duration > 0);
    range.max = String(duration > 0 ? duration : 0);
    if (!dragging) range.value = String(Math.min(Math.max(0, engine.currentTime()), Math.max(0, duration)));
    time.textContent = `${format(dragging ? Number(range.value) : engine.currentTime())} / ${format(duration)}`;
  }
  const togglePlayback = (): void => { if (locked) return; if (engine.playing()) engine.pause(); else engine.play(); };
  const begin = (): void => { if (!range.disabled) dragging = true; };
  const preview = (): void => { if (range.disabled) return; dragging = true; update(); };
  const commit = (): void => { if (dragging && !range.disabled && !bar.hidden) engine.setCurrentTime(Number(range.value)); dragging = false; update(); };
  const cancel = (): void => { dragging = false; update(); };
  button.addEventListener('click', togglePlayback);
  range.addEventListener('pointerdown', begin); range.addEventListener('input', preview);
  range.addEventListener('change', commit); range.addEventListener('pointercancel', cancel);
  range.addEventListener('blur', cancel);
  bar.append(button, range, time); root.append(bar); update();
  return {
    update,
    toggle: () => { bar.hidden = !bar.hidden; if (bar.hidden) cancel(); },
    setVisible: (visible: boolean) => { bar.hidden = !visible; if (!visible) cancel(); },
    setLocked: (value: boolean) => { locked = value; dragging = false; update(); },
    destroy: () => {
      button.removeEventListener('click', togglePlayback);
      range.removeEventListener('pointerdown', begin); range.removeEventListener('input', preview);
      range.removeEventListener('change', commit); range.removeEventListener('pointercancel', cancel);
      range.removeEventListener('blur', cancel); bar.remove();
    }
  };
}
