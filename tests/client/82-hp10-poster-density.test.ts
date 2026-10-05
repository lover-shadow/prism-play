// @vitest-environment jsdom
/**
 * HP-10 海报密度与类型角标（HOME-PLAYER-REPAIR §3 HP-10 / §5.1 HP-10 / §4.3「旧 6–8px 与试验 4px 区别」）。
 *
 * 三条判据各归一处，不许互相顶替：
 * 1. **间距**：四模的横纵间距统一收到两个 token（密集 4px / 舒适 12px），断点只加列数、不再顺手把
 *    gap 放回 16/20px；卡片自身的描边与底版在密集模式下撤掉，内边距单独收成 `--poster-pad-card`，
 *    避免"描边 + 底版 + 内边距"三层叠加把宽度还给空气。
 * 2. **Ai剧**：`AI精品` 是质量评价，HP-10 判回类型事实——文案只有 `Ai剧`，且渲染侧再核一次
 *    `isAi === true`；判定表说 ai 而数据没这个字段时**留白不贴标**（缺依据不是缺样式）。
 * 3. **不许连带压缩触区**：密度只作用于海报网格，导航按钮的 44px 与胶囊的 28/44 双口径一字不动。
 *
 * 这些是样式正本 + DOM 断言；真实视口里"更密之后图文是否仍清晰、点击是否仍准确"必须浏览器实测。
 */
import { describe, expect, it } from 'vitest';
import type { ContentItem } from '../../edge/src/types/api';
import type { BadgeKind } from '../../src/core/recommendation';
import { CORNER_BADGE_LABEL, createPosterGrid } from '../../src/components/poster-grid';
import { readSource, rule } from './player-sheet-harness';

const tokensCss = readSource('src/styles/design-tokens.css');
const homeCss = readSource('src/styles/home.css');
const gridSource = readSource('src/components/poster-grid.ts');

function item(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: 'c-1', channelId: 'drama', title: '战神之龙王归来', category: '战神', isPrivate: false,
    coverUrl: 'https://cdn.example/cover-1.jpg', episodeCount: 80, shareable: false, ...overrides
  };
}

function render(items: ContentItem[], badges?: ReadonlyMap<string, BadgeKind>): HTMLElement {
  const node = document.createElement('div');
  document.body.replaceChildren(node);
  createPosterGrid({ root: node, mode: () => 'compact-3', onOpenTitle: () => undefined }).render(items, badges);
  return node;
}

const tablet = tokensCss.slice(tokensCss.indexOf('@media (min-width: 768px)'), tokensCss.indexOf('@media (min-width: 1024px)'));
const desktop = tokensCss.slice(tokensCss.indexOf('@media (min-width: 1024px)'));

describe('HP-10 四模间距统一收紧（Token 单一真相）', () => {
  it('密集 4px / 舒适 12px 两枚 token 定义在通用段，四模只引用它们', () => {
    expect(tokensCss).toMatch(/--poster-gap-tight:\s*4px/);
    expect(tokensCss).toMatch(/--poster-gap-wide:\s*12px/);
    for (const mode of ['.grid-posters-compact-3', '.grid-posters-bookshelf-4']) {
      expect(rule(tokensCss, mode)).toMatch(/gap:\s*var\(--poster-gap-tight\)/);
    }
    for (const mode of ['.grid-posters-comfort-2', '.grid-posters-list-1']) {
      expect(rule(tokensCss, mode)).toMatch(/gap:\s*var\(--poster-gap-wide\)/);
    }
    // 断点只许改列数与外层 padding，不许把 gap 换回 --space-4 / --space-5。
    for (const segment of [tablet, desktop]) {
      expect(segment).not.toMatch(/gap:\s*var\(--space-[45]\)/);
      for (const mode of ['.grid-posters-compact-3', '.grid-posters-bookshelf-4']) {
        expect(segment).toContain(`${mode}`);
      }
    }
  });

  it('密集模式撤掉卡片描边与底版，内边距单独收到 --poster-pad-card（叠加浪费归零）', () => {
    expect(tokensCss).toMatch(/--poster-pad-card:\s*2px/);
    expect(homeCss).toMatch(/\.grid-posters-compact-3 \.poster-card[^{]*\{[^}]*border:\s*0/);
    expect(homeCss).toMatch(/\.grid-posters-bookshelf-4 \.poster-card[^{]*\{[^}]*border:\s*0/);
    expect(rule(homeCss, '.grid-posters-compact-3 .poster-open'))
      .toMatch(/padding:\s*var\(--poster-pad-card\)/);
  });

  it('HP-10 密度回归自查：密集档的副标签只许一行截断，不许换行把行高还给空气', () => {
    expect(rule(homeCss, '.poster-meta')).toMatch(/flex-wrap:\s*wrap/);
    expect(homeCss).toMatch(/\.grid-posters-compact-3 \.poster-meta\s*\{[^}]*flex-wrap:\s*nowrap/);
    expect(homeCss).toMatch(/\.poster-subtag\s*\{[^}]*text-overflow:\s*ellipsis/);
  });

  it('密度只作用于网格：导航触区与胶囊双口径一字未动', () => {
    expect(tokensCss).toMatch(/--capsule-height:\s*28px/);
    expect(tokensCss).toMatch(/--capsule-hit:\s*44px/);
    expect(homeCss).toMatch(/\.mode-btn\s*\{[^}]*width:\s*30px[^}]*height:\s*30px/);
    expect(homeCss).not.toMatch(/\.app-tab\s*\{/);
  });

  it('P0-3：网格与卡片样式正本零裸色值、零裸 rgb（角标颜色同样走 token）', () => {
    expect(homeCss).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
    expect(homeCss).not.toMatch(/[^\w-]rgba?\(/);
    expect(tokensCss).toMatch(/--badge-ai:/);
  });
});

describe('HP-10 角标文案与可信依据', () => {
  it('AI 角标文案是类型而非质量：逐字 Ai剧，全表不残留旧口径', () => {
    expect(CORNER_BADGE_LABEL.ai).toBe('Ai剧');
    expect(CORNER_BADGE_LABEL.ai).not.toMatch(/精品|优质|精选|推荐/);
    expect(CORNER_BADGE_LABEL.hot).toBe('热门');
    expect(CORNER_BADGE_LABEL.recommend).toBe('推荐');
    for (const source of [gridSource, homeCss, tokensCss, readSource('src/styles/design-tokens.json')]) {
      expect(source, '旧的质量化文案仍留在口径里').not.toMatch(/AI精品/);
    }
  });

  it('只有 isAi === true 才贴 Ai剧；判定表说有、数据没说时留白（缺依据不是缺样式）', () => {
    const badges = new Map<string, BadgeKind>([['c-1', 'ai'], ['c-2', 'ai'], ['c-3', 'ai'], ['c-4', 'hot']]);
    const node = render([
      item({ id: 'c-1', isAi: true }),
      item({ id: 'c-2', isAi: false }),
      item({ id: 'c-3' }),
      item({ id: 'c-4', isHot: true })
    ], badges);

    expect(node.querySelector('[data-content-id="c-1"] .poster-corner-badge')?.textContent).toBe('Ai剧');
    expect(node.querySelector('[data-content-id="c-2"] .poster-corner-badge')).toBeNull();
    expect(node.querySelector('[data-content-id="c-3"] .poster-corner-badge')).toBeNull();
    expect(node.querySelector('[data-content-id="c-4"] .poster-corner-badge')?.textContent).toBe('热门');
    expect(node.querySelectorAll('.poster-corner-badge')).toHaveLength(2);
  });

  it('Ai剧 角标仍落在海报盒左上、与右下角集数标对角呼应（AC-29 既有权威不移动）', () => {
    const node = render([item({ isAi: true })], new Map([['c-1', 'ai' as BadgeKind]]));
    const media = node.querySelector('.poster-media') as HTMLElement;
    expect(media.querySelector('.poster-corner-badge--ai')).not.toBeNull();
    expect(media.querySelector('.poster-ep-badge')).not.toBeNull();
    expect(rule(homeCss, '.poster-corner-badge')).toMatch(/position:\s*absolute/);
  });
});
