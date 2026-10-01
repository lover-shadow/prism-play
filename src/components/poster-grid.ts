/**
 * 四模海报网格（SPEC AC-04，UIUX §4）。
 *
 * 排版切换只有一条实现路径：**重新套用 design-tokens.css 里那个模式的 `.grid-posters-*` 类**。
 * JS 绝不算列数、绝不写 `grid-template-columns`，否则 768/1024 断点的列数倍增就会变成两套真相。
 * 模式来源是注入的 `mode()` getter，因此用户偏好（经 `onPosterModeChange` 持久化）天然穿越重绘。
 */

import type { ContentItem } from '../../edge/src/types/api';
import { POSTER_MODE_CLASS, POSTER_MODE_LABEL, POSTER_MODES, isPosterMode, type PosterMode } from '../core/state/theme';
import { clearChildren, element, iconNode } from './state-views';
import type { IconName } from './icons';

export const POSTER_GRID_BASE_CLASS = 'home-poster-grid';
export const DEFAULT_SKELETON_COUNT = 12;

const MODE_GLYPHS: Readonly<Record<PosterMode, IconName>> = {
  'compact-3': 'grid',
  'comfort-2': 'image',
  'bookshelf-4': 'gridDense',
  'list-1': 'list'
};

/** 模式 → 宿主类名；列数与间距归 design-tokens.css 所有。 */
export function posterGridClass(mode: PosterMode): string {
  const gridClass: string | undefined = POSTER_MODE_CLASS[mode];
  if (gridClass === undefined) throw new Error(`未知海报排版模式：${String(mode)}`);
  return `${POSTER_GRID_BASE_CLASS} ${gridClass}`;
}

export function episodeBadgeText(episodeCount: number): string {
  return episodeCount === 1 ? '全 1 集' : `共 ${episodeCount} 集`;
}

/** AC-02-6：私密内容永不出现分享入口；未显式 `shareable: true` 也不出现。缺席，而非禁用。 */
export function isShareable(item: ContentItem): boolean {
  return item.shareable === true && item.isPrivate !== true;
}

/** 边缘直出的分享落地页（SPEC §5）；没有注入分享落点时的唯一默认动作。 */
export function sharePathFor(contentId: string): string {
  return `/s/${encodeURIComponent(contentId)}`;
}

export interface PosterGridDeps {
  root: HTMLElement;
  mode: () => PosterMode;
  onOpenTitle: (contentId: string) => void;
  /**
   * 分享的真实落点由组合根决定（复制链接 / 原生分享面板）。缺省时退化为打开边缘 `/s/:id`，
   * 这样按钮永远对应真实机制，不做只长样子的假控件。
   */
  onShare?: (item: ContentItem) => void;
}

export interface PosterGrid {
  render(items: readonly ContentItem[]): void;
  showSkeleton(count?: number): void;
  applyMode(mode: PosterMode): void;
  clear(): void;
  /** 非网格状态（empty / error / offline / disabled）占据同一容器，避免两块内容同时可见。 */
  replaceWith(state: HTMLElement): void;
  destroy(): void;
}

/**
 * 四模排版切换器（AC-04 的「排版切换按钮」）。
 * 每个模式一颗带文字标签与 `aria-pressed` 的按钮——不做隐藏的循环按钮，也不靠颜色单独表意。
 */
export interface ModeSwitchDeps {
  root: HTMLElement;
  mode: () => PosterMode;
  onChange: (mode: PosterMode) => void;
}

export interface ModeSwitch {
  /** 传入目标模式即乐观回显（偏好写入通常是异步的）。 */
  paint(active?: PosterMode): void;
  destroy(): void;
}

export function createModeSwitch(deps: ModeSwitchDeps): ModeSwitch {
  deps.root.setAttribute('role', 'group');
  deps.root.setAttribute('aria-label', '海报排版模式');

  function paint(active?: PosterMode): void {
    const current = active ?? deps.mode();
    for (const button of Array.from(deps.root.querySelectorAll<HTMLButtonElement>('.mode-btn'))) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === current));
    }
  }

  for (const mode of POSTER_MODES) {
    const button = element('button', 'mode-btn touch-target');
    button.type = 'button';
    button.dataset.mode = mode;
    button.title = POSTER_MODE_LABEL[mode];
    button.appendChild(iconNode(MODE_GLYPHS[mode], { size: 16, className: 'mode-glyph' }));
    button.appendChild(element('span', 'mode-btn-label', POSTER_MODE_LABEL[mode]));
    button.addEventListener('click', () => {
      if (!isPosterMode(mode)) return;
      deps.onChange(mode);
      paint(mode);
    });
    deps.root.appendChild(button);
  }

  paint();
  return { paint, destroy: () => clearChildren(deps.root) };
}

export function createPosterGrid(deps: PosterGridDeps): PosterGrid {
  function gridElement(): HTMLElement | null {
    return deps.root.querySelector<HTMLElement>(`.${POSTER_GRID_BASE_CLASS}`);
  }

  function mountGrid(state: 'ready' | 'loading'): HTMLElement {
    const grid = element('div', posterGridClass(deps.mode()));
    grid.dataset.mode = deps.mode();
    grid.dataset.state = state;
    if (state === 'loading') grid.setAttribute('aria-busy', 'true');
    deps.root.appendChild(grid);
    return grid;
  }

  function media(item: ContentItem): HTMLElement {
    const box = element('span', 'poster-media');
    const placeholder = iconNode('image', { size: 24, className: 'poster-fallback' });
    placeholder.setAttribute('aria-hidden', 'true');
    box.appendChild(placeholder);

    const url = typeof item.coverUrl === 'string' ? item.coverUrl.trim() : '';
    if (url === '') {
      box.classList.add('is-fallback');
    } else {
      const img = element('img', 'poster-cover');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.addEventListener('error', () => {
        img.remove();
        box.classList.add('is-fallback');
      });
      img.src = url;
      box.insertBefore(img, placeholder);
    }

    if (typeof item.episodeCount === 'number' && item.episodeCount > 0) {
      box.appendChild(element('span', 'poster-ep-badge', episodeBadgeText(item.episodeCount)));
    }
    return box;
  }

  function shareButton(item: ContentItem): HTMLButtonElement {
    const button = element('button', 'poster-share touch-target');
    button.type = 'button';
    button.dataset.contentId = item.id;
    button.setAttribute('aria-label', `分享《${item.title}》`);
    button.appendChild(iconNode('share', { size: 16 }));
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (deps.onShare !== undefined) deps.onShare(item);
      else window.open(sharePathFor(item.id), '_blank', 'noopener,noreferrer');
    });
    return button;
  }

  function card(item: ContentItem): HTMLElement {
    const box = element('article', 'poster-card');
    box.dataset.contentId = item.id;

    const open = element('button', 'poster-open');
    open.type = 'button';
    open.setAttribute('aria-label', `《${item.title}》`);
    open.appendChild(media(item));

    const body = element('span', 'poster-body');
    body.appendChild(element('span', 'poster-title', item.title));
    if (typeof item.category === 'string' && item.category !== '') {
      body.appendChild(element('span', 'poster-tag', item.category));
    }
    if (typeof item.synopsis === 'string' && item.synopsis !== '') {
      body.appendChild(element('span', 'poster-synopsis', item.synopsis));
    }
    open.appendChild(body);
    open.addEventListener('click', () => deps.onOpenTitle(item.id));
    box.appendChild(open);

    if (isShareable(item)) box.appendChild(shareButton(item));
    return box;
  }

  function skeletonCard(): HTMLElement {
    const box = element('div', 'poster-card poster-card--skeleton');
    box.setAttribute('aria-hidden', 'true');
    box.appendChild(element('span', 'poster-media'));
    const body = element('span', 'poster-body');
    body.appendChild(element('span', 'poster-line'));
    body.appendChild(element('span', 'poster-line poster-line--short'));
    box.appendChild(body);
    return box;
  }

  return {
    render: (items) => {
      clearChildren(deps.root);
      const grid = mountGrid('ready');
      for (const item of items) grid.appendChild(card(item));
    },
    showSkeleton: (count = DEFAULT_SKELETON_COUNT) => {
      clearChildren(deps.root);
      const grid = mountGrid('loading');
      for (let index = 0; index < count; index += 1) grid.appendChild(skeletonCard());
    },
    applyMode: (mode) => {
      const grid = gridElement();
      if (grid === null) return;
      grid.className = posterGridClass(mode);
      grid.dataset.mode = mode;
    },
    clear: () => clearChildren(deps.root),
    replaceWith: (state) => {
      clearChildren(deps.root);
      deps.root.appendChild(state);
    },
    destroy: () => clearChildren(deps.root)
  };
}
