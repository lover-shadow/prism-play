/**
 * 选集面板（R26-05 / AC-21）：三态容器 + 分段集号栅格。
 *
 * 三态由宿主的既有真相派生，本模块不持有"是否全屏"的副本：`mode()` 每次现读
 * （非全屏 → 视频下方的 inline 正文流；全屏竖屏 → 底部限高 sheet；全屏横屏 → 右侧 side 抽屉）。
 * 定位规则全部落在 `player.css`，那里每条边只在对应态里出现一次——历史上同一个 fixed 盒子
 * 同时写了 `top` 与 `bottom`，定高盒过约束时浏览器忽略 `bottom`，面板从视口顶边铺满并盖死画面。
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
 * 集号按钮上只允许出现数字（`episode-sheet.ts` 的徽章判据）：真实集名进 `aria-label`，时长与
 * "第 N 集"字样一律不上按钮——栅格是给拇指点的 44px 方块，拼上标题在真机上必然溢出成两行。
 * 所有来自目录的文本都走 `textContent`，绝不 `innerHTML`，片单字符串注入不了 DOM。
 */

import type { EpisodeItem, TitleDetail } from '../../edge/src/types/api';
import { icon } from '../components/icons';
import { isPrivateSubject } from '../core/storage/storage-domains';
import {
  EPISODE_SEGMENT_SIZE, episodeAriaLabel, episodeBadge, segmentLabel, segmentPage, segmentRange, type SheetMode
} from './episode-sheet';

export interface EpisodeDrawerOptions {
  root: HTMLElement;
  /** inline 态的正文槽位（宿主给的视频下方容器）；缺省即挂在播放器根上，与旧行为等价。 */
  mount?: HTMLElement;
  onSelect(episodeId: number): void;
  onClose(): void;
  /** 面板被唤起时上报一次：倍速、投屏据此收起，同一时刻只允许一个菜单。 */
  onOpen?(): void;
  /** 现读模式，返回值同时决定 `data-mode` 与 `aria-modal`。 */
  mode?(): SheetMode;
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
  /** 全屏/转屏后重判模式，并把当前集拉回可见的分段窗口。 */
  setMode(): void;
  isOpen(): boolean;
  destroy(): void;
}

function isPrivateWork(detail: TitleDetail): boolean {
  return isPrivateSubject({ isPrivate: detail.item.isPrivate, channelId: detail.item.channelId });
}

/** 面板内容按集号升序排：分段窗口与"自动落在当前集那一段"都依赖这个顺序。 */
function ordered(detail: TitleDetail): EpisodeItem[] {
  return [...detail.episodes].sort((a, b) => a.episodeNumber - b.episodeNumber);
}

function glyph(name: 'share' | 'list'): HTMLElement {
  const holder = document.createElement('span');
  holder.className = 'prism-drawer__glyph';
  holder.innerHTML = icon(name, { size: 16 });
  return holder;
}

export function createEpisodeDrawer(options: EpisodeDrawerOptions): EpisodeDrawer {
  const doc = options.root.ownerDocument;
  const host = options.mount ?? options.root;

  const shell = doc.createElement('div');
  shell.className = 'prism-drawer';
  shell.dataset['prismUi'] = 'drawer';
  shell.setAttribute('role', 'dialog');
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

  const segments = doc.createElement('div');
  segments.className = 'prism-drawer__segments';
  segments.setAttribute('role', 'group');
  segments.setAttribute('aria-label', '分集区间');

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

  shell.append(bar, segments, list, actions);
  host.append(shell);

  let detail: TitleDetail | null = null;
  let currentId = Number.NaN;
  let page = 0;
  let restoreFocus: Element | null = null;

  const at = (): EpisodeItem[] => (detail === null ? [] : ordered(detail));
  const indexOfCurrent = (): number => at().findIndex((episode) => episode.episodeId === currentId);

  const mark = (): void => {
    for (const button of list.querySelectorAll<HTMLElement>('.prism-drawer__item')) {
      const current = button.dataset['episodeId'] === String(currentId);
      button.classList.toggle('is-current', current);
      if (current) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
    }
  };

  /** 分段导航只在真的超过一段时出现；点一段即换窗口，当前集高亮保持不变。 */
  const renderSegments = (): void => {
    const episodes = at();
    if (episodes.length <= EPISODE_SEGMENT_SIZE) { segments.replaceChildren(); return; }
    const tabs = [];
    for (let start = 0, index = 0; start < episodes.length; start += EPISODE_SEGMENT_SIZE, index += 1) {
      const range = segmentRange(episodes.length, index);
      const tab = doc.createElement('button');
      tab.type = 'button';
      tab.className = 'prism-drawer__segment';
      tab.dataset['page'] = String(index);
      tab.textContent = segmentLabel(episodes[range.from - 1]!.episodeNumber, episodes[range.to - 1]!.episodeNumber);
      tab.classList.toggle('is-active', index === page);
      if (index === page) tab.setAttribute('aria-current', 'true');
      tabs.push(tab);
    }
    segments.replaceChildren(...tabs);
  };

  const renderList = (): void => {
    if (detail === null) return;
    const episodes = at();
    const range = segmentRange(episodes.length, page);
    list.replaceChildren(...episodes.slice(range.from - 1, range.to).map((episode) => {
      const li = doc.createElement('li');
      li.className = 'prism-drawer__row';
      const item = doc.createElement('button');
      item.type = 'button';
      item.className = 'prism-drawer__item';
      item.dataset['episodeId'] = String(episode.episodeId);
      item.setAttribute('aria-label', episodeAriaLabel(episode));
      item.textContent = episodeBadge(episode.episodeNumber, episodes.length);
      li.append(item);
      return li;
    }));
    renderSegments();
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

  /** 模式只在浮动态需要遮罩与模态语义，inline 态是正文，拦焦点就是自找麻烦。 */
  const applyMode = (): void => {
    const mode = options.mode?.() ?? 'inline';
    shell.dataset['mode'] = mode;
    shell.classList.toggle('prism-drawer--inline', mode === 'inline');
    shell.classList.toggle('prism-drawer--sheet', mode === 'sheet');
    shell.classList.toggle('prism-drawer--side', mode === 'side');
    shell.setAttribute('aria-modal', mode === 'inline' ? 'false' : 'true');
    if (mode !== 'inline' && shell.dataset['opened'] === '1') {
      const current = indexOfCurrent();
      if (current >= 0 && segmentPage(at().length, current) !== page) {
        page = segmentPage(at().length, current);
        renderList();
      }
    }
  };

  const closeDrawer = (): void => {
    if (shell.hidden) return;
    shell.dataset['opened'] = '0';
    shell.hidden = true;
    shell.classList.remove('is-open');
    options.onClose();
    if (restoreFocus instanceof HTMLElement) restoreFocus.focus();
    restoreFocus = null;
  };

  shell.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    // `::before` 遮罩命中在面板本体上：点遮罩与点关闭等价。
    if (target === shell) { closeDrawer(); return; }
    const tab = target.closest<HTMLElement>('.prism-drawer__segment');
    if (tab !== null && tab.dataset['page'] !== undefined) {
      page = Number(tab.dataset['page']);
      renderList();
      tab.focus();
      return;
    }
    if (target.closest('.prism-drawer__close') !== null) closeDrawer();
    const row = target.closest<HTMLElement>('.prism-drawer__item');
    if (row === null || row.dataset['episodeId'] === undefined) return;
    const selected = Number(row.dataset['episodeId']);
    if (!Number.isSafeInteger(selected) || selected < 1 || !detail?.episodes.some((episode) => episode.episodeId === selected)) return;
    currentId = selected;
    mark();
    closeDrawer();
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
      if (rebuilt) heading.textContent = next.item.title;
      renderActions();
      // 每次唤起都重新定位到当前集所在的分段：面板不该让用户先找一段再找一集。
      const episodes = ordered(detail);
      const current = episodes.findIndex((episode) => episode.episodeId === episodeId);
      page = segmentPage(episodes.length, current);
      renderList();
      applyMode();
      restoreFocus = doc.activeElement;
      shell.hidden = false;
      shell.dataset['opened'] = '1';
      shell.classList.add('is-open');
      options.onOpen?.();
      (list.querySelector<HTMLElement>('.prism-drawer__item.is-current') ?? closeButton).focus();
    },

    close: closeDrawer,

    refresh: (episodeId) => {
      currentId = episodeId;
      mark();
    },

    setMode: applyMode,

    isOpen: () => !shell.hidden,

    destroy: () => {
      shell.remove();
      detail = null;
    }
  };
}
