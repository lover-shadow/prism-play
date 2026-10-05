// @vitest-environment jsdom
/** 四模海报网格（AC-04；A-5 海报分享入口物理缺席）与样式真相源静态对账。 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from 'vitest';
import type { ContentItem } from '../../edge/src/types/api';
import { POSTER_MODES, POSTER_MODE_CLASS, type PosterMode } from '../../src/core/state/theme';
import {
  DEFAULT_SKELETON_COUNT,
  createModeSwitch,
  createPosterGrid,
  episodeBadgeText,
  isShareable,
  posterGridClass,
  sharePathFor
} from '../../src/components/poster-grid';
import { renderStateView } from '../../src/components/state-views';

/** 静态对账用的样式正本：从当前工作目录向上找到仓库根，避免依赖 vitest 的 cwd 假设。 */
function readSource(relative: string): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(directory, relative);
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    directory = dirname(directory);
  }
  throw new Error(`找不到样式正本 ${relative}（自 ${process.cwd()} 向上查找）`);
}

const tokensCss = readSource('src/styles/design-tokens.css');
const homeCss = readSource('src/styles/home.css');

function item(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: 'c-1',
    channelId: 'drama',
    title: '战神之龙王归来',
    category: '战神',
    isPrivate: false,
    coverUrl: 'https://cdn.example/cover-1.jpg',
    episodeCount: 80,
    shareable: false,
    synopsis: '五年前他被剥夺战功扫地出门，五年后万龙俯首重返临海。',
    ...overrides
  };
}

const mounted: HTMLElement[] = [];

function host(): HTMLElement {
  const node = document.createElement('div');
  document.body.appendChild(node);
  mounted.push(node);
  return node;
}

function gridFor(
  options: { mode?: PosterMode; onOpenTitle?: (id: string) => void } = {}
) {
  let mode = options.mode ?? 'compact-3';
  const node = host();
  const grid = createPosterGrid({
    root: node,
    mode: () => mode,
    onOpenTitle: options.onOpenTitle ?? (() => undefined)
  });
  return { node, grid, setMode: (next: PosterMode) => (mode = next) };
}

afterEach(() => {
  document.body.replaceChildren();
  mounted.length = 0;
});

describe('poster-grid：四模只靠重贴 design-tokens 的类', () => {
  it('每个模式的类名 = 基类 + 该模式的 .grid-posters-*，且只有一颗网格类', () => {
    for (const mode of POSTER_MODES) {
      const applied = posterGridClass(mode);
      expect(applied.split(' ')).toHaveLength(2);
      expect(applied).toContain(POSTER_MODE_CLASS[mode]);
      expect(applied.startsWith('home-poster-grid')).toBe(true);
    }
    expect(() => posterGridClass('nope' as PosterMode)).toThrow(/未知海报排版模式/);
  });

  it('渲染 24 张卡片：DOM 里没有 JS 计算的列数，只有类名', () => {
    const { node, grid } = gridFor();
    grid.render(Array.from({ length: 24 }, (_, index) => item({ id: `c-${index}` })));
    const gridEl = node.querySelector('.home-poster-grid') as HTMLElement;

    expect(node.querySelectorAll('.poster-card').length).toBe(24);
    expect(gridEl.className).toBe('home-poster-grid grid-posters-compact-3');
    expect(gridEl.dataset.mode).toBe('compact-3');
    expect(gridEl.getAttribute('style')).toBeNull();
    expect(gridEl.style.gridTemplateColumns).toBe('');
    expect(node.innerHTML).not.toMatch(/grid-template-columns|repeat\(/);
  });

  it('applyMode 就地重贴类名，四模轮转后仍是单一网格类', () => {
    const { node, grid } = gridFor();
    grid.render([item()]);
    const gridEl = node.querySelector('.home-poster-grid') as HTMLElement;

    for (const mode of POSTER_MODES) {
      grid.applyMode(mode);
      expect(gridEl.className).toBe(`home-poster-grid ${POSTER_MODE_CLASS[mode]}`);
      expect(gridEl.dataset.mode).toBe(mode);
      expect(gridEl.getAttribute('style')).toBeNull();
    }
  });

  it('偏好持久化后重绘沿用当前模式（mode() 是唯一真相源）', () => {
    const { node, grid, setMode } = gridFor();
    grid.render([item()]);
    setMode('bookshelf-4');
    grid.render([item(), item({ id: 'c-2' })]);

    const gridEl = node.querySelector('.home-poster-grid') as HTMLElement;
    expect(gridEl.className).toContain('grid-posters-bookshelf-4');
    expect(node.querySelectorAll('.poster-card').length).toBe(2);
  });

  it('卡片含剧名、集数角标与懒加载封面；缺封面时只留 Token 占位', () => {
    const { node, grid } = gridFor();
    grid.render([item(), item({ id: 'c-2', coverUrl: undefined })]);

    const first = node.querySelector('[data-content-id="c-1"]') as HTMLElement;
    const img = first.querySelector('img.poster-cover') as HTMLImageElement;
    expect(img.loading).toBe('lazy');
    expect(img.getAttribute('src')).toBe('https://cdn.example/cover-1.jpg');
    expect(img.alt).toBe('');
    expect(first.querySelector('.poster-title')?.textContent).toBe('战神之龙王归来');
    expect(first.querySelector('.poster-ep-badge')?.textContent).toBe('共 80 集');
    expect((first.querySelector('.poster-open') as HTMLButtonElement).getAttribute('aria-label')).toBe('《战神之龙王归来》');

    const second = node.querySelector('[data-content-id="c-2"]') as HTMLElement;
    expect(second.querySelector('img')).toBeNull();
    expect(second.querySelector('.poster-media')?.classList.contains('is-fallback')).toBe(true);
    expect(second.querySelector('svg')).not.toBeNull();
  });

  it('封面加载失败回落 Token 占位，不留下破图', () => {
    const { node, grid } = gridFor();
    grid.render([item()]);
    const media = node.querySelector('.poster-media') as HTMLElement;
    const img = media.querySelector('img') as HTMLImageElement;
    img.dispatchEvent(new Event('error'));

    expect(media.querySelector('img')).toBeNull();
    expect(media.classList.contains('is-fallback')).toBe(true);
  });

  it('集数缺失或为 0 不渲染角标；1 集文案单独', () => {
    expect(episodeBadgeText(1)).toBe('全 1 集');
    expect(episodeBadgeText(80)).toBe('共 80 集');
    const { node, grid } = gridFor();
    grid.render([item({ episodeCount: undefined }), item({ id: 'c-2', episodeCount: 0 })]);
    expect(node.querySelectorAll('.poster-ep-badge').length).toBe(0);
  });

  it('AC-02-6 + A-5：海报卡物理不存在分享入口，公开与私密都一样', () => {
    const { node, grid } = gridFor();
    grid.render([
      item({ shareable: true }),
      item({ id: 'c-2', shareable: false }),
      item({ id: 'c-4', shareable: true, isPrivate: true })
    ]);

    // 分享按钮不是"隐藏"或"disabled"，而是根本不存在：整棵树零 `.poster-share`，每卡只剩一颗进详情按钮。
    expect(node.querySelectorAll('.poster-share').length).toBe(0);
    expect(node.querySelectorAll('button')).toHaveLength(node.querySelectorAll('.poster-open').length);
    expect(node.innerHTML).not.toMatch(/poster-share|分享《/);
    // 判据本身仍然导出且口径不变：播放器内的分享键与边缘 `/s/:id` 用的就是这一条。
    expect(isShareable(item({ shareable: true }))).toBe(true);
    expect(isShareable(item({ shareable: true, isPrivate: true }))).toBe(false);
    expect(isShareable(item({ shareable: undefined }))).toBe(false);
    expect(sharePathFor('c 1/中文')).toBe('/s/c%201%2F%E4%B8%AD%E6%96%87');
  });

  it('A-5 卡片只有"进详情"一个动作，点卡回调 contentId', () => {
    const opened: string[] = [];
    const { node, grid } = gridFor({ onOpenTitle: (id) => opened.push(id) });
    grid.render([item({ shareable: true })]);

    (node.querySelector('.poster-open') as HTMLButtonElement).click();
    expect(opened).toEqual(['c-1']);
    expect(node.querySelectorAll('.poster-open')).toHaveLength(1);
  });

  it('loading 态铺骨架且不可交互，默认 12 颗', () => {
    const { node, grid } = gridFor();
    grid.showSkeleton();
    const gridEl = node.querySelector('.home-poster-grid') as HTMLElement;

    expect(node.querySelectorAll('.poster-card--skeleton').length).toBe(DEFAULT_SKELETON_COUNT);
    expect(node.querySelectorAll('.poster-open, .poster-share').length).toBe(0);
    expect(gridEl.dataset.state).toBe('loading');
    expect(gridEl.getAttribute('aria-busy')).toBe('true');

    grid.showSkeleton(6);
    expect(node.querySelectorAll('.poster-card--skeleton').length).toBe(6);
  });

  it('replaceWith 让状态视图与网格互斥', () => {
    const { node, grid } = gridFor();
    grid.render([item()]);
    grid.replaceWith(renderStateView('offline'));

    expect(node.querySelector('.home-poster-grid')).toBeNull();
    expect(node.querySelector('.state-view--offline')).not.toBeNull();
    grid.destroy();
    expect(node.childElementCount).toBe(0);
  });
});

describe('mode-switch：四模切换器', () => {
  it('每个模式一颗带文字标签的按钮，aria-pressed 跟随当前模式', () => {
    const node = host();
    const changes: PosterMode[] = [];
    let mode: PosterMode = 'comfort-2';
    const switcher = createModeSwitch({ root: node, mode: () => mode, onChange: (next) => { mode = next; changes.push(next); } });

    const buttons = Array.from(node.querySelectorAll<HTMLButtonElement>('.mode-btn'));
    expect(buttons.map((button) => button.dataset.mode)).toEqual([...POSTER_MODES]);
    expect(buttons.every((button) => (button.textContent ?? '').trim() !== '')).toBe(true);
    expect(node.getAttribute('role')).toBe('group');
    expect(node.getAttribute('aria-label')).toBe('海报排版模式');

    expect(buttons.find((button) => button.getAttribute('aria-pressed') === 'true')?.dataset.mode).toBe('comfort-2');
    buttons[0].click();
    expect(changes).toEqual(['compact-3']);
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    expect(buttons[1].getAttribute('aria-pressed')).toBe('false');

    switcher.paint();
    buttons[3].click();
    expect(changes).toEqual(['compact-3', 'list-1']);
    switcher.destroy();
    expect(node.childElementCount).toBe(0);
  });
});

describe('样式真相源静态对账（AC-04 / §10 / P0-3）', () => {
  it('design-tokens.css 独占四模列数，并在 768/1024 断点倍增', () => {
    expect(tokensCss).toMatch(/\.grid-posters-compact-3\s*\{[^}]*repeat\(3/);
    expect(tokensCss).toMatch(/\.grid-posters-comfort-2\s*\{[^}]*repeat\(2/);
    expect(tokensCss).toMatch(/\.grid-posters-bookshelf-4\s*\{[^}]*repeat\(4/);
    expect(tokensCss).toMatch(/\.grid-posters-list-1\s*\{[^}]*display:\s*flex/);

    const tablet = tokensCss.slice(tokensCss.indexOf('@media (min-width: 768px)'));
    const desktop = tokensCss.slice(tokensCss.indexOf('@media (min-width: 1024px)'));
    expect(tablet).toMatch(/\.grid-posters-compact-3\s*\{[^}]*repeat\(4/);
    expect(tablet).toMatch(/\.grid-posters-comfort-2\s*\{[^}]*repeat\(3/);
    expect(tablet).toMatch(/\.grid-posters-bookshelf-4\s*\{[^}]*repeat\(6/);
    expect(tablet).toMatch(/\.grid-posters-list-1\s*\{[^}]*repeat\(2/);
    expect(desktop).toMatch(/\.grid-posters-compact-3\s*\{[^}]*repeat\(6/);
    expect(desktop).toMatch(/\.grid-posters-comfort-2\s*\{[^}]*repeat\(4/);
    expect(desktop).toMatch(/\.grid-posters-bookshelf-4\s*\{[^}]*repeat\(8/);
    expect(desktop).toMatch(/\.grid-posters-list-1\s*\{[^}]*repeat\(3/);
    expect(tokensCss).toMatch(/--poster-ratio:\s*3 \/ 4/);
  });

  it('home.css 零裸色值、零 rgb、零 grid-template-columns 声明', () => {
    expect(homeCss).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
    expect(homeCss).not.toMatch(/\brgba?\(/);
    expect(homeCss).not.toMatch(/grid-template-columns\s*:/);
    expect(homeCss).toMatch(/aspect-ratio:\s*var\(--poster-ratio\)/);
    // 两层导航合成一个吸顶块贴在 #app-header 之下；44px 触控下限来自 Token。
    expect(homeCss).toMatch(/\.home-sticky\s*\{[^}]*position:\s*sticky/);
    expect(tokensCss).toMatch(/--subnav-height:\s*44px/);
    expect(tokensCss).toMatch(/--header-height:\s*52px/);
  });

  it('HP-10 统一收紧后的间距真相：密集 4px / 舒适 12px，断点倍增只加列数不加间距', () => {
    // 口径迁移（HP-10）：旧 AC-A4 钉的是 6px/8px 与内边距 --space-1；断言换值不换含义，仍是"断点只加列数"。
    expect(tokensCss).toMatch(/--poster-gap-tight:\s*4px/);
    expect(tokensCss).toMatch(/--poster-gap-wide:\s*12px/);
    const compact = tokensCss.match(/\.grid-posters-compact-3\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(compact).toMatch(/gap:\s*var\(--poster-gap-tight\)/);
    expect(compact).toMatch(/padding:\s*0 var\(--poster-gap-tight\)/);
    const tablet = tokensCss.slice(tokensCss.indexOf('@media (min-width: 768px)'), tokensCss.indexOf('@media (min-width: 1024px)'));
    const desktop = tokensCss.slice(tokensCss.indexOf('@media (min-width: 1024px)'));
    // 平板/大屏若把 gap 放回 --space-4(16px)，6 列就会被摊成碎图（AC-A4-4）。
    for (const segment of [tablet, desktop]) {
      expect(segment).toMatch(/\.grid-posters-compact-3\s*\{[^}]*gap:\s*var\(--poster-gap-tight\)/);
    }
    // 卡片内边距同步收紧，把宽度还给海报本身。
    expect(homeCss).toMatch(/\.grid-posters-compact-3 \.poster-open\s*\{[^}]*padding:\s*var\(--poster-pad-card\)/);
  });

  it('A-5 分享样式与手动加载按钮都已物理拔除，收起态与哨兵样式同步落地', () => {
    // 判据是"规则声明"而不是"字样出现"：拔除说明里还会留痕，样式表里不许再有这条规则。
    expect(homeCss).not.toMatch(/\.poster-share\s*[,{]/);
    expect(homeCss).not.toMatch(/\.home-more-btn\s*[,{]/);
    expect(homeCss).toMatch(/\.home-search-bar--hidden\s*\{[^}]*transform:\s*translateY\(-100%\)/);
    expect(homeCss).toMatch(/\.home-sentinel\s*\{[^}]*height:\s*1px/);
  });

});

