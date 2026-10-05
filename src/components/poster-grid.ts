/**
 * 四模海报网格（SPEC AC-04，UIUX §4）。
 *
 * 排版切换只有一条实现路径：**重新套用 design-tokens.css 里那个模式的 `.grid-posters-*` 类**。
 * JS 绝不算列数、绝不写 `grid-template-columns`，否则 768/1024 断点的列数倍增就会变成两套真相。
 * 模式来源是注入的 `mode()` getter，因此用户偏好（经 `onPosterModeChange` 持久化）天然穿越重绘。
 *
 * A-5 定案：卡片右上角的分享浮层按钮已**物理拔除**——用户没看内容就不会分享，挂在海报上还高发误触。
 * 分享 100% 收敛在播放器内（`player-detail.ts` / `episode-drawer.ts`）。`isShareable()` 与
 * `sharePathFor()` 作为分享出站口径继续导出，播放器与边缘 `/s/:id` 仍按同一判据走。
 */

import type { ContentItem } from '../../edge/src/types/api';
import type { BadgeKind } from '../core/recommendation';
import { POSTER_MODE_CLASS, POSTER_MODE_LABEL, POSTER_MODES, isPosterMode, type PosterMode } from '../core/state/theme';
import { clearChildren, element, iconNode } from './state-views';
import type { IconName } from './icons';

export const POSTER_GRID_BASE_CLASS = 'home-poster-grid';
export const DEFAULT_SKELETON_COUNT = 12;

/** 左上角微光角标文案（§1.8.5 / AC-29，口径由 HP-10 判回类型事实）：文字本身就是依据，不借任何图形符号（P0-1 零 Emoji）。 */
export const CORNER_BADGE_LABEL: Readonly<Record<BadgeKind, string>> = {
  ai: 'Ai剧',
  hot: '热门',
  recommend: '推荐'
};

/**
 * HP-10：`ai` 角标的**渲染侧依据**。判定表（`recommendation.ts`）负责"这颗贴什么"，渲染侧再核一次
 * "数据是否真的说了它是 AI"——`isAi !== true` 就留白。缺依据不是缺样式，缺依据也不能贴标；
 * 而 `Ai剧` 只陈述制作类型：旧文案把类型说成了质量评价，已按 HP-10 撤掉，不得在任何界面重新出现。
 */
export function cornerBadgeVisible(item: ContentItem, kind: BadgeKind): boolean {
  return kind !== 'ai' || item.isAi === true;
}

/** 角标类名唯一生成点：判定权在 `recommendation.ts`，本组件只负责把它翻译成 tokens 样式，绝不自行定性。 */
export function cornerBadgeClass(kind: BadgeKind): string {
  return `poster-corner-badge poster-corner-badge--${kind}`;
}

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

/**
 * AC-02-6：私密内容永不出现分享入口；未显式 `shareable: true` 也不出现。缺席，而非禁用。
 * A-5 后海报卡不再消费它——判据唯一留给播放器内的分享键与边缘 `/s/:id` 出站。
 */
export function isShareable(item: ContentItem): boolean {
  return item.shareable === true && item.isPrivate !== true;
}

/** 边缘直出的分享落地页路径（SPEC §5）：分享出站口径的唯一生成点，私密与未知剧目在服务端一律 404。 */
export function sharePathFor(contentId: string): string {
  return `/s/${encodeURIComponent(contentId)}`;
}

export interface PosterGridDeps {
  root: HTMLElement;
  mode: () => PosterMode;
  onOpenTitle: (contentId: string) => void;
}

export interface PosterGrid {
  /**
   * `badges` 是混排引擎给出的**判定表**（contentId → 角标种类）：缺项即留白不贴标。
   * 本组件不读 `isAi` / `isHot`、也不按 tags 猜——贴标唯一判据必须集中在 `recommendation.ts` 一处。
   */
  render(items: readonly ContentItem[], badges?: ReadonlyMap<string, BadgeKind>): void;
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
    button.setAttribute('aria-label', POSTER_MODE_LABEL[mode]);
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

  function media(item: ContentItem, badge?: BadgeKind): HTMLElement {
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
    // 左上角微光角标与右下角 `.poster-ep-badge` 形成黄金对角呼应；后者的位置是既有权威，不得移动（§1.8.5）。
    if (badge !== undefined && cornerBadgeVisible(item, badge)) {
      box.appendChild(element('span', cornerBadgeClass(badge), CORNER_BADGE_LABEL[badge]));
    }
    return box;
  }

  /**
   * HP-12 副标签：只把"字段真的供出来了"的条目变成节点。空数组是**假值形态的缺席**
   * （`metadata-policy` 在写侧就拒绝它），读侧同样一枚都不渲染；去重、上限与词表口径不在这里复制第二份。
   */
  function subTags(item: ContentItem): string[] {
    return Array.isArray(item.tags) ? item.tags.filter((tag) => typeof tag === 'string' && tag.trim() !== '') : [];
  }

  /** HP-11 元信息：年份/地区/语言逐个判在不在，缺一个就少一条，绝不补位也绝不写成"未知"。 */
  function metaFacts(item: ContentItem): string[] {
    const facts: string[] = [];
    const year = item.releaseYear;
    if (typeof year === 'number' && Number.isSafeInteger(year) && year > 0) facts.push(String(year));
    for (const value of [item.region, item.language]) {
      const text = typeof value === 'string' ? value.trim() : '';
      if (text !== '') facts.push(text);
    }
    return facts;
  }

  /**
   * 卡片信息块（HP-11 / HP-12）：**有则展示、无则压缩**。
   * 主分类 `category` 仍是筛选口径那一条，副标签 `tags` 与它并存各占自己的节点；
   * 摘要原样落进安全文本节点（读侧已按 `metadata-policy` 消毒并限长，界面不再做第二次截断，
   * 也不再复制长度／条数／年份区间这类边界数字——那是第二份口径）；一条信息都没有时就只剩标题——
   * 不编兜底文案，也不留一块撑高的空槽。全部经 `element()` 的 textContent 写出，原料里的 HTML 只是文字。
   */
  function infoBlock(item: ContentItem): HTMLElement {
    const body = element('span', 'poster-body');
    body.appendChild(element('span', 'poster-title', item.title));

    const category = typeof item.category === 'string' ? item.category.trim() : '';
    const tags = subTags(item);
    if (category !== '' || tags.length > 0) {
      const meta = element('span', 'poster-meta');
      if (category !== '') meta.appendChild(element('span', 'poster-tag', category));
      for (const tag of tags) meta.appendChild(element('span', 'poster-subtag', tag));
      body.appendChild(meta);
    }

    const facts = metaFacts(item);
    if (facts.length > 0) {
      const row = element('span', 'poster-facts');
      for (const fact of facts) row.appendChild(element('span', 'poster-fact', fact));
      body.appendChild(row);
    }

    const synopsis = typeof item.synopsis === 'string' ? item.synopsis : '';
    if (synopsis.trim() !== '') body.appendChild(element('span', 'poster-synopsis', synopsis));
    return body;
  }

  function card(item: ContentItem, badge?: BadgeKind): HTMLElement {
    const box = element('article', 'poster-card');
    box.dataset.contentId = item.id;

    const open = element('button', 'poster-open');
    open.type = 'button';
    open.setAttribute('aria-label', `《${item.title}》`);
    open.appendChild(media(item, badge));
    open.appendChild(infoBlock(item));
    open.addEventListener('click', () => deps.onOpenTitle(item.id));
    box.appendChild(open);

    // A-5：此处不再挂任何分享入口（私密与公开都不挂）——卡片只保留"进详情"这一个动作。
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
    render: (items, badges) => {
      clearChildren(deps.root);
      const grid = mountGrid('ready');
      for (const item of items) grid.appendChild(card(item, badges?.get(item.id)));
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
