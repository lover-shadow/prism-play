import { icon } from '../components/icons';
import { createGestureHud, createPlayerChrome, type ChromeAction, type GestureHud, type PlayerChrome } from './hud';
import { createStateOverlay, type StateOverlay } from './state-overlay';
import type { TitleDetail } from '../../edge/src/types/api';
import type { Clock } from './sleep-timer';

export interface PlayerDomNodes {
  backdrop: HTMLElement;
  speedPill: HTMLElement;
  pulse: HTMLElement;
  overlay: StateOverlay;
  hud: GestureHud;
  chrome: PlayerChrome;
}

export function createPlayerDom(
  root: HTMLElement,
  detail: TitleDetail | null,
  clock: Clock,
  onChromeAction: (action: ChromeAction) => void,
  onPlayClick: () => void
): PlayerDomNodes {
  root.classList.add('prism-player');
  const backdrop = document.createElement('div'), speedPill = document.createElement('div'), pulse = document.createElement('div');
  backdrop.className = 'prism-player__backdrop'; speedPill.className = 'prism-player__speed-pill';
  if (detail?.item.coverUrl) {
    const image = document.createElement('img'), glow = document.createElement('div');
    image.className = 'prism-player__backdrop-img'; image.src = detail.item.coverUrl; image.alt = '';
    glow.className = 'prism-player__backdrop-glow'; backdrop.append(image, glow);
  }
  pulse.className = 'prism-player__pulse'; pulse.innerHTML = icon('play', { size: 24 });
  pulse.addEventListener('click', onPlayClick);
  root.append(backdrop, pulse, speedPill);
  const overlay = createStateOverlay(root);
  const hud = createGestureHud(root, clock);
  const chrome = createPlayerChrome(root, onChromeAction);
  return { backdrop, speedPill, pulse, overlay, hud, chrome };
}
