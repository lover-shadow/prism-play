/**
 * 选集抽屉与分集断点上报（SPEC §7 / AC-02-6 / §6.1）。
 *
 * Both halves of this file are derived from the same object — the `episodes[]` of a loaded `TitleDetail`:
 * the drawer renders it, the reporter turns the current position inside it into a `WatchHistoryRow`.
 *
 * Two privacy rules are enforced structurally rather than by hiding a button:
 *
 * 1. A private work gets no share affordance at all — not a disabled one — because AC-02-6 requires the
 *    entry point to be absent from the DOM. `isPrivate` is re-derived with the same predicate the storage
 *    interceptor uses (`isPrivateSubject`), so a payload claiming `isPrivate: false` while filed under the
 *    `private` channel still gets the private treatment.
 * 2. Background-audio persistence is only offered when the composition root has injected the permission
 *    flag. The drawer never calls the bridge itself; it reports intent upward.
 *
 * The reporter never writes storage either (SPEC §6.1): it emits into the injected `onProgress` sink and
 * attaches the privacy subject, so the storage interceptor — not the player — holds the write gate. All
 * upstream text goes through `textContent`, never `innerHTML`, so catalogue strings cannot inject DOM.
 */

import type { EpisodeItem, TitleDetail } from '../../edge/src/types/api';
import { icon } from '../components/icons';
import { isPrivateSubject } from '../core/storage/storage-domains';
import type { WatchHistoryRow, WriteGuardSubject } from '../core/storage/storage-domains';
import type { Clock } from './sleep-timer';

export interface EpisodeDrawerOptions {
  root: HTMLElement;
  onSelect(episodeId: number): void;
  onClose(): void;
  /** Share is opt-in from the host and unconditionally absent for private works. */
  allowShare?: boolean;
  onShare?: (episode: EpisodeItem) => void;
  /** Injected permission flag for 后台/息屏播放 (AC-10 is the native host's promise, not this module's). */
  allowBackgroundAudio?: boolean;
  onBackgroundAudioToggle?: (enabled: boolean) => void;
  backgroundAudioEnabled?: () => boolean;
}

export interface EpisodeDrawer {
  el: HTMLElement;
  open(detail: TitleDetail, currentEpisodeId: number): void;
  close(): void;
  /** Re-marks the current episode without rebuilding the list. */
  refresh(currentEpisodeId: number): void;
  isOpen(): boolean;
  destroy(): void;
}

function isPrivateWork(detail: TitleDetail): boolean {
  return isPrivateSubject({ isPrivate: detail.item.isPrivate, channelId: detail.item.channelId });
}

function episodeLabel(episode: EpisodeItem): string {
  const number = `第 ${episode.episodeNumber} 集`;
  const minutes = episode.durationSeconds === undefined ? '' : ` · ${Math.round(episode.durationSeconds / 60)} 分钟`;
  const name = episode.title === undefined || episode.title === '' ? '' : ` · ${episode.title}`;
  return `${number}${name}${minutes}`;
}

function glyph(name: 'share' | 'list'): HTMLElement {
  const holder = document.createElement('span');
  holder.className = 'prism-drawer__glyph';
  holder.innerHTML = icon(name, { size: 16 });
  return holder;
}

export function createEpisodeDrawer(options: EpisodeDrawerOptions): EpisodeDrawer {
  const doc = options.root.ownerDocument;

  const shell = doc.createElement('div');
  shell.className = 'prism-drawer';
  shell.dataset['prismUi'] = 'drawer';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-modal', 'true');
  shell.setAttribute('aria-label', '选集');
  shell.hidden = true;

  const heading = doc.createElement('h2');
  heading.className = 'prism-drawer__title';

  const closeButton = doc.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'prism-drawer__close';
  closeButton.setAttribute('aria-label', '关闭选集');
  closeButton.innerHTML = icon('close', { size: 20, label: '关闭选集' });

  const bar = doc.createElement('header');
  bar.className = 'prism-drawer__bar';
  bar.append(heading, closeButton);

  const list = doc.createElement('ul');
  list.className = 'prism-drawer__list';

  const shareButton = doc.createElement('button');
  shareButton.type = 'button';
  shareButton.className = 'prism-drawer__action';
  shareButton.append(glyph('share'), doc.createTextNode('分享本剧'));

  const backgroundInput = doc.createElement('input');
  backgroundInput.type = 'checkbox';
  backgroundInput.className = 'prism-drawer__checkbox';
  const background = doc.createElement('label');
  background.className = 'prism-drawer__switch';
  background.append(backgroundInput, doc.createTextNode('后台/息屏播放'));

  const actions = doc.createElement('footer');
  actions.className = 'prism-drawer__actions';

  shell.append(bar, list, actions);
  options.root.append(shell);

  let detail: TitleDetail | null = null;
  let currentId = Number.NaN;
  let restoreFocus: Element | null = null;
  let rows: HTMLElement[] = [];

  const mark = (): void => {
    for (const row of rows) {
      const button = row.firstElementChild;
      if (!(button instanceof HTMLElement)) continue;
      const current = button.dataset['episodeId'] === String(currentId);
      button.classList.toggle('is-current', current);
      if (current) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
  };

  const renderList = (): void => {
    if (detail === null) return;
    rows = detail.episodes.map((episode) => {
      const li = doc.createElement('li');
      li.className = 'prism-drawer__row';
      const item = doc.createElement('button');
      item.type = 'button';
      item.className = 'prism-drawer__item';
      item.dataset['episodeId'] = String(episode.episodeId);
      item.textContent = episodeLabel(episode);
      li.append(item);
      return li;
    });
    list.replaceChildren(...rows);
    mark();
  };

  const renderActions = (): void => {
    actions.replaceChildren();
    if (detail === null) return;
    const shareable = options.allowShare === true && !isPrivateWork(detail) && detail.item.shareable !== false;
    if (shareable) actions.append(shareButton);
    if (options.allowBackgroundAudio === true) {
      backgroundInput.checked = options.backgroundAudioEnabled?.() ?? false;
      actions.append(background);
    }
  };

  const closeDrawer = (): void => {
    if (shell.hidden) return;
    shell.hidden = true;
    shell.classList.remove('is-open');
    options.onClose();
    if (restoreFocus instanceof HTMLElement) restoreFocus.focus();
    restoreFocus = null;
  };

  shell.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('.prism-drawer__close') !== null) closeDrawer();
    const row = target.closest<HTMLElement>('.prism-drawer__item');
    if (row === null || row.dataset['episodeId'] === undefined) return;
    const selected = Number(row.dataset['episodeId']);
    if (!Number.isSafeInteger(selected) || selected < 1 || !detail?.episodes.some((episode) => episode.episodeId === selected)) return;
    currentId = selected;
    mark();
    options.onSelect(currentId);
  });

  shareButton.addEventListener('click', () => {
    const episode = detail?.episodes.find((candidate) => candidate.episodeId === currentId);
    if (episode !== undefined) options.onShare?.(episode);
  });

  backgroundInput.addEventListener('change', () => {
    options.onBackgroundAudioToggle?.(backgroundInput.checked);
  });

  return {
    el: shell,

    open: (next, episodeId) => {
      const rebuilt = detail?.item.id !== next.item.id;
      detail = next;
      currentId = episodeId;
      if (rebuilt) {
        heading.textContent = next.item.title;
        renderList();
      } else mark();
      renderActions();
      restoreFocus = doc.activeElement;
      shell.hidden = false;
      shell.classList.add('is-open');
      (list.querySelector<HTMLElement>('.prism-drawer__item.is-current') ?? closeButton).focus();
    },

    close: closeDrawer,

    refresh: (episodeId) => {
      currentId = episodeId;
      mark();
    },

    isOpen: () => !shell.hidden,

    destroy: () => {
      shell.remove();
      rows = [];
      detail = null;
    }
  };
}

/**
 * Escape handling for the drawer. Bound by the player on its own root so the unsubscribe travels with the
 * lifecycle — `destroy()` must leave no listener behind.
 */
export function bindDrawerKeyboard(target: EventTarget, drawer: EpisodeDrawer): () => void {
  const handler = (event: Event): void => {
    if ((event as KeyboardEvent).key === 'Escape' && drawer.isOpen()) {
      event.preventDefault();
      drawer.close();
    }
  };
  target.addEventListener('keydown', handler);
  return () => target.removeEventListener('keydown', handler);
}

/* ==========================================================================
   分集断点上报（SPEC §6.1 写入闸门的上游）
   ========================================================================== */

export interface ProgressContext extends WriteGuardSubject {
  episodeId: number;
  episodeNumber: number;
  episodeTotal: number;
}

export interface ProgressReporter {
  /** True when it emitted. `force` ignores the throttle, for pause / ended / leave. */
  emit(force?: boolean): boolean;
  due(): boolean;
}

export function createProgressReporter(input: {
  clock: Clock;
  intervalMs?: number;
  detail(): TitleDetail | null;
  episodeId(): number | null;
  position(): number;
  duration(): number;
  onProgress?(row: WatchHistoryRow, context: ProgressContext): void;
  onBlocked?(message: string): void;
}): ProgressReporter {
  const intervalMs = input.intervalMs ?? 5_000;
  let lastAt = 0;
  const due = (): boolean => input.clock.now() - lastAt >= intervalMs;
  const privacy = (): WriteGuardSubject => {
    const item = input.detail()?.item;
    return { isPrivate: item?.isPrivate ?? false, channelId: item?.channelId, contentId: item?.id };
  };
  return {
    due,
    emit: (force = false) => {
      const item = input.detail()?.item;
      const episodeId = input.episodeId();
      if (item === undefined || episodeId === null || (!force && !due())) return false;
      const position = input.position();
      const duration = input.duration() || position;
      const episodes = input.detail()?.episodes ?? [];
      const number = episodes.find((episode) => episode.episodeId === episodeId)?.episodeNumber ?? 0;
      lastAt = input.clock.now();
      const row: WatchHistoryRow = {
        content_id: item.id, title: item.title, cover_url: item.coverUrl ?? null, last_episode_id: episodeId,
        last_episode_number: number, position_seconds: Math.round(position), duration_seconds: Math.round(duration),
        total_episodes: episodes.length, updated_at: Math.round(lastAt / 1_000)
      };
      try {
        input.onProgress?.(row, { ...privacy(), episodeId, episodeNumber: number, episodeTotal: episodes.length });
      } catch (error) {
        // The sink's refusal is the AC-02 zero-disk boundary: surface it, never retry it, never write here.
        input.onBlocked?.(error instanceof Error ? error.message : String(error));
      }
      return true;
    }
  };
}
