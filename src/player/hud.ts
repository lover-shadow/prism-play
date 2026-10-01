/**
 * 播放器浮层渲染器（SPEC AC-06 / AC-07 / §7 异常态）。
 *
 * Owns the three overlays the player draws on top of the media surface: the volume HUD, the brightness
 * HUD and the state card (解析中 / 可重试 / 需网络 / 不存在). All three are separate renderers because
 * SPEC §10 caps a file at 300 lines — splitting by surface keeps every piece reviewable.
 *
 * The two gesture HUDs are independent nodes rather than one shared capsule, because the HUD belongs on
 * the side the finger is on. Shape follows `docs/prototypes/ui-prototype.html` (icon + value + bar) and
 * every colour comes from a design token: `--player-vol-accent` / `--player-bri-accent` on the fill,
 * `--player-hud-bg` / `--player-hud-border` / `--elev-hud` on the shell. No hex, no emoji, ever.
 *
 * Honesty rule (AGENTS.md §二.1, SPEC §4 已知边界): when the platform reports `supported: false` the HUD
 * says so instead of pretending a web page moved the system volume.
 */

import { icon } from '../components/icons';
import type { IconName } from '../components/icons';
import type { ValueChannel } from './gestures';
import type { Clock } from './sleep-timer';

export type HudKind = ValueChannel;

/** AC-06/07 auto-hide window. 600ms reads as "still listening", longer feels like a stuck overlay. */
export const HUD_HIDE_AFTER_MS = 600;

const GLYPH: Readonly<Record<HudKind, IconName>> = { volume: 'volume', brightness: 'brightness' };
const LABEL: Readonly<Record<HudKind, string>> = { volume: '音量', brightness: '亮度' };

/** What the platform refused to do, stated plainly. Kept next to the HUD so copy stays in one place. */
const UNSUPPORTED_COPY: Readonly<Record<HudKind, string>> = {
  volume: '系统音量需在 Android 端调节，此处仅改变播放器音量',
  brightness: '窗口亮度需在 Android 端调节，此处仅改变画面遮罩'
};

export interface HudShowInput {
  kind: HudKind;
  /** 0..1, as the platform actually applied it. */
  value: number;
  /** False renders the notice; the number is still shown because it is real for the player gain. */
  supported: boolean;
}

export interface GestureHud {
  /** Test hook / stacking owner. */
  el: HTMLElement;
  element(kind: HudKind): HTMLElement;
  show(input: HudShowInput): void;
  hide(kind?: HudKind): void;
  destroy(): void;
}

interface HudNodes {
  root: HTMLElement;
  value: HTMLElement;
  fill: HTMLElement;
  notice: HTMLElement;
}

function build(kind: HudKind): HudNodes {
  const root = document.createElement('div');
  root.className = `prism-hud prism-hud--${kind}`;
  root.dataset['kind'] = kind;
  root.dataset['prismUi'] = `hud-${kind}`;
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.setAttribute('aria-hidden', 'true');

  const glyph = document.createElement('span');
  glyph.className = 'prism-hud__icon';
  glyph.innerHTML = icon(GLYPH[kind], { size: 24, label: LABEL[kind] });

  const value = document.createElement('span');
  value.className = 'prism-hud__value';

  const track = document.createElement('span');
  track.className = 'prism-hud__track';
  const fill = document.createElement('span');
  fill.className = 'prism-hud__fill';
  track.append(fill);

  const notice = document.createElement('span');
  notice.className = 'prism-hud__notice';
  notice.hidden = true;

  root.append(glyph, value, track, notice);
  return { root, value, fill, notice };
}

export function createGestureHud(
  root: HTMLElement,
  clock: Clock,
  options: { hideAfterMs?: number } = {}
): GestureHud {
  const hideAfterMs = options.hideAfterMs ?? HUD_HIDE_AFTER_MS;
  const shell = document.createElement('div');
  shell.className = 'prism-hud-layer';
  shell.dataset['prismUi'] = 'hud-layer';
  const nodes: Record<HudKind, HudNodes> = { volume: build('volume'), brightness: build('brightness') };
  shell.append(nodes.volume.root, nodes.brightness.root);
  root.append(shell);

  const timers: Record<HudKind, number | null> = { volume: null, brightness: null };
  const visible: Record<HudKind, boolean> = { volume: false, brightness: false };

  const hide = (kind: HudKind): void => {
    if (timers[kind] !== null) {
      clock.clearTimer(timers[kind] as number);
      timers[kind] = null;
    }
    if (!visible[kind]) return;
    visible[kind] = false;
    nodes[kind].root.classList.remove('is-visible');
    nodes[kind].root.setAttribute('aria-hidden', 'true');
  };

  return {
    el: shell,
    element: (kind) => nodes[kind].root,

    show: ({ kind, value, supported }) => {
      const percent = Math.round(Math.min(1, Math.max(0, value)) * 100);
      const node = nodes[kind];
      node.value.textContent = `${LABEL[kind]} ${percent}%`;
      // Inline width is a measurement, not a colour: tokens stay in player.css.
      node.fill.style.width = `${percent}%`;
      node.notice.textContent = supported ? '' : UNSUPPORTED_COPY[kind];
      node.notice.hidden = supported;
      node.root.classList.add('is-visible');
      node.root.setAttribute('aria-hidden', 'false');
      visible[kind] = true;
      // The other channel never competes for attention with the one being dragged.
      hide(kind === 'volume' ? 'brightness' : 'volume');
      if (timers[kind] !== null) clock.clearTimer(timers[kind] as number);
      timers[kind] = clock.setTimer(() => {
        timers[kind] = null;
        hide(kind);
      }, hideAfterMs);
    },

    hide: (kind) => {
      if (kind === undefined) {
        hide('volume');
        hide('brightness');
        return;
      }
      hide(kind);
    },

    destroy: () => {
      hide('volume');
      hide('brightness');
      shell.remove();
    }
  };
}

/* ==========================================================================
   状态浮层：解析中 / 可重试 / 需网络 / 内容不存在
   ========================================================================== */

export type OverlayState = 'loading' | 'retryable' | 'offline' | 'missing';
export type PlayerErrorKind = Exclude<OverlayState, 'loading'>;

/** AC-15 / AC-02-6: 私密与未知共用同一句话，浮层不泄露任何剧目元信息。 */
const STATE_COPY: Readonly<Record<OverlayState, { title: string; copy: string; retry: boolean }>> = {
  loading: { title: '正在解析可播地址', copy: '请稍候。', retry: false },
  retryable: { title: '暂无可用播放源', copy: '上游源巡检中，请稍后重试。', retry: true },
  offline: { title: '需要网络', copy: '点播必须联网解析可播地址，离线仅可浏览已缓存的公开目录。', retry: true },
  missing: { title: '内容不存在或已下架', copy: '该剧目当前不可用。', retry: false }
};

export interface StateOverlay {
  el: HTMLElement;
  /** The host registers and unbinds the retry action itself, so teardown bookkeeping stays in one place. */
  retryButton: HTMLButtonElement;
  show(kind: OverlayState): void;
  hide(): void;
  destroy(): void;
}

export function createStateOverlay(root: HTMLElement): StateOverlay {
  const el = document.createElement('div');
  el.className = 'prism-player__state';
  el.dataset['prismUi'] = 'state';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.hidden = true;
  const iconBox = document.createElement('span');
  iconBox.className = 'prism-player__state-icon';
  const title = document.createElement('p');
  title.className = 'prism-player__state-title';
  const copy = document.createElement('p');
  copy.className = 'prism-player__state-copy';
  const retryButton = document.createElement('button');
  retryButton.type = 'button';
  retryButton.className = 'prism-player__retry';
  retryButton.innerHTML = icon('refresh', { size: 16 });
  retryButton.append(document.createTextNode('重试'));
  el.append(iconBox, title, copy, retryButton);
  root.append(el);

  return {
    el,
    retryButton,
    show: (kind) => {
      const text = STATE_COPY[kind];
      el.classList.toggle('prism-player__state--offline', kind === 'offline');
      el.classList.toggle('prism-player__state--missing', kind === 'missing');
      iconBox.innerHTML = icon(kind === 'loading' ? 'refresh' : 'alert', { size: 24 });
      title.textContent = text.title;
      copy.textContent = text.copy;
      retryButton.hidden = !text.retry;
      el.hidden = false;
    },
    hide: () => void (el.hidden = true),
    destroy: () => el.remove()
  };
}

/* ==========================================================================
   播放器控件条：解锁 / 定时 / 选集 三个入口（触摸锁必须始终有出口）
   ========================================================================== */

export type ChromeAction = 'lock' | 'sleep' | 'list';

export interface PlayerChrome {
  stage: HTMLDivElement;
  /** The gesture surface: CSS keeps it clear of both control bands. */
  surface: HTMLElement;
  el: HTMLElement;
  render(input: { title: string; locked: boolean; sleepLabel: string; sleeping: boolean }): void;
  setVisible(visible: boolean): void;
  destroy(): void;
}

export function createPlayerChrome(root: HTMLElement, onAction: (action: ChromeAction) => void): PlayerChrome {
  const mk = (tag: string, className: string, attributes: Record<string, string> = {}): HTMLElement => {
    const element = document.createElement(tag);
    element.className = className;
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    return element;
  };
  const stage = mk('div', 'prism-player__stage') as HTMLDivElement;
  const surface = mk('div', 'prism-player__body', { tabindex: '0', role: 'application', 'aria-label': '播放手势区' });
  const el = mk('div', 'prism-player__chrome');
  el.dataset['prismUi'] = 'chrome';
  const title = mk('span', 'prism-player__chrome-title');
  const sleepButton = mk('button', 'prism-player__pill', { type: 'button', 'data-action': 'sleep', 'aria-label': '睡眠定时' });
  const lockButton = mk('button', 'prism-player__pill', { type: 'button', 'data-action': 'lock' });
  const listButton = mk('button', 'prism-player__button', { type: 'button', 'data-action': 'list', 'aria-label': '打开选集' });
  listButton.innerHTML = icon('list', { size: 24, label: '选集' });
  el.append(title, sleepButton, lockButton, listButton);
  root.append(stage, surface, el);

  const click = (event: Event): void => {
    if (!(event.target instanceof Element)) return;
    const action = event.target.closest('[data-action]')?.getAttribute('data-action');
    if (action === 'lock' || action === 'sleep' || action === 'list') onAction(action as ChromeAction);
  };
  el.addEventListener('click', click);

  return {
    stage,
    surface,
    el,
    render: (input) => {
      title.textContent = input.title;
      sleepButton.textContent = input.sleepLabel;
      sleepButton.setAttribute('aria-pressed', String(input.sleeping));
      lockButton.textContent = input.locked ? '已锁定' : '已解锁';
      lockButton.setAttribute('aria-pressed', String(input.locked));
    },
    setVisible: (visible) => void el.classList.toggle('is-visible', visible),
    destroy: () => {
      el.removeEventListener('click', click);
      stage.remove();
      surface.remove();
      el.remove();
    }
  };
}
