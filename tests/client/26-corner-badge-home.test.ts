// @vitest-environment jsdom
/**
 * 微光角标渲染与首页混排挂接（SPEC v2.5 §1.8.5 / §1.8.4，验收 AC-29 + AC-28 端侧挂接面）。
 *
 * 这里证三件事：判定表 → DOM 类名的映射只有一条路径；样式 100% 消费 tokens 且角标在**左上**与右下角
 * 集数标对角呼应；首页渲染顺序确实来自 `weave()`，而 `page / revision / 游标` 的请求形态一字未改。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CatalogResponse, ChannelItem, ContentItem } from '../../edge/src/types/api';
import type { WatchHistoryRow } from '../../src/core/storage/storage-domains';
import { PrismApiClient } from '../../src/core/api/client';
import { CORNER_BADGE_LABEL, cornerBadgeClass, createPosterGrid } from '../../src/components/poster-grid';
import { createHomeView } from '../../src/views/home-view';
import type { BadgeKind } from '../../src/core/recommendation';

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

const entry = (id: string, overrides: Partial<ContentItem> = {}): ContentItem => ({
  id, channelId: 'drama', title: `剧目${id}`, category: '都市', isPrivate: false,
  coverUrl: `https://cdn.example/${id}.jpg`, episodeCount: 40, shareable: true, ...overrides
});

function gridHost(): { node: HTMLElement; grid: ReturnType<typeof createPosterGrid> } {
  const node = document.createElement('div');
  document.body.appendChild(node);
  return { node, grid: createPosterGrid({ root: node, mode: () => 'compact-3', onOpenTitle: () => undefined }) };
}

afterEach(() => document.body.replaceChildren());

describe('AC-29 微光角标 DOM：判定表说什么就贴什么，没说就留白', () => {
  it('AC-29 三种判定各出一颗左上角标，类名与文案由判定唯一决定', () => {
    const { node, grid } = gridHost();
    const items = [entry('c-1'), entry('c-2', { episodeCount: 8 }), entry('c-3'), entry('c-4')];
    const badges = new Map<string, BadgeKind>([['c-1', 'ai'], ['c-2', 'hot'], ['c-3', 'recommend']]);

    grid.render(items, badges);
    const first = node.querySelector('[data-content-id="c-1"]') as HTMLElement;

    expect(node.querySelectorAll('.poster-corner-badge').length).toBe(3);
    expect(first.querySelector('.poster-corner-badge')?.className).toBe(cornerBadgeClass('ai'));
    expect(first.querySelector('.poster-corner-badge')?.textContent).toBe(CORNER_BADGE_LABEL.ai);
    expect(node.querySelector('[data-content-id="c-2"] .poster-corner-badge')?.className).toContain('--hot');
    expect(node.querySelector('[data-content-id="c-2"] .poster-ep-badge')).not.toBeNull();
    expect(node.querySelector('[data-content-id="c-3"] .poster-corner-badge')?.textContent).toBe('推荐');
    expect(node.querySelector('[data-content-id="c-4"] .poster-corner-badge')).toBeNull();
    expect(CORNER_BADGE_LABEL.ai).toBe('AI精品');
  });

  it('AC-29 不传判定表（或判定表为空）时零角标：留白是默认态，不是缺陷', () => {
    const { node, grid } = gridHost();
    grid.render([entry('c-1'), entry('c-2')]);
    expect(node.querySelectorAll('.poster-corner-badge').length).toBe(0);

    grid.render([entry('c-1'), entry('c-2')], new Map());
    expect(node.querySelectorAll('.poster-corner-badge').length).toBe(0);
    expect(node.querySelectorAll('.poster-card').length).toBe(2);
  });

  it('角标容器就是海报盒：与右下角集数标同盒对角，不新增第三层包装', () => {
    const { node, grid } = gridHost();
    grid.render([entry('c-1')], new Map([['c-1', 'ai' as BadgeKind]]));
    const media = node.querySelector('.poster-media') as HTMLElement;

    expect(media.querySelector('.poster-corner-badge')).not.toBeNull();
    expect(media.querySelector('.poster-ep-badge')).not.toBeNull();
    expect(node.querySelectorAll('.poster-corner-badge')).toHaveLength(1);
  });
});

describe('AC-29 角标样式对账：只吃 tokens、位置在左上、高度不硬编码', () => {
  it('.poster-corner-badge 绝对定位左上角，且不写死高度', () => {
    const rule = homeCss.match(/\.poster-corner-badge\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/top:\s*var\(--space-1\)/);
    expect(rule).toMatch(/left:\s*var\(--space-1\)/);
    expect(rule).not.toMatch(/bottom:/);
    expect(rule).not.toMatch(/(?:^|[^\w-])height\s*:/); // 只禁「写死高度」，`line-height` 是行高不是高度
    expect(rule).toMatch(/font-size:\s*var\(--text-2xs\)/);
    expect(rule).toMatch(/border-radius:\s*var\(--radius-xs\)/);
    expect(rule).toMatch(/padding:\s*var\(--badge-pad-y\)\s+var\(--space-2\)/);
    expect(rule).toMatch(/font-weight:\s*500/);
    expect(rule).toMatch(/line-height:\s*var\(--leading-tight\)/);
    expect(rule).toMatch(/background:\s*var\(--badge-bg\)/);
  });

  it('三个修饰类各落一枚 theme-invariant 前景 token，右下角集数标未被挪位', () => {
    expect(homeCss).toMatch(/\.poster-corner-badge--ai\s*\{\s*color:\s*var\(--badge-ai\);\s*\}/);
    expect(homeCss).toMatch(/\.poster-corner-badge--hot\s*\{\s*color:\s*var\(--badge-hot\);\s*\}/);
    expect(homeCss).toMatch(/\.poster-corner-badge--recommend\s*\{\s*color:\s*var\(--badge-recommend\);\s*\}/);
    expect(homeCss).toMatch(/\.poster-ep-badge\s*\{[^}]*right:\s*var\(--space-1\)[^}]*bottom:\s*var\(--space-1\)/);
  });

  it('角标 token 在通用 :root 段声明且浅色主题段零再声明（结构上不可能漂移）', () => {
    const light = tokensCss.slice(tokensCss.indexOf(':root[data-theme="light"]'));
    const badgeDeclarations = tokensCss.match(/--badge-(ai|hot|recommend|bg|pad-y):/g) ?? [];

    expect(badgeDeclarations).toHaveLength(5);
    expect(light.slice(0, light.indexOf('\n:root {'))).not.toMatch(/--badge-/);
    expect(homeCss).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
    expect(homeCss).not.toMatch(/[^\w-]rgba?\(/);
  });
});

describe('AC-28 首页挂接：网格顺序来自 weave()，分页语义一字未动', () => {
  const reply = (body: unknown): Response =>
    ({ ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response);
  const channel = (id: string, name: string, order: number, categories: string[] = []): ChannelItem =>
    ({ id, name, order, requiresTier: [], categories } as ChannelItem);
  const catalog = (items: ContentItem[], page = 1, total = items.length, revision = 99): CatalogResponse =>
    ({ items, page, pageSize: 24, total, revision });
  const flush = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)); };

  const seen: string[] = [];
  /** 第二页可延迟落地：A-4 之后续载由尾部哨兵静默发起，用例必须能"先看不追加、再放行"。 */
  function viewHarness(page1: ContentItem[], page2: ContentItem[] = []) {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const rows: WatchHistoryRow[] = [];
    let release: ((response: Response) => void) | null = null;
    const view = createHomeView({
      api: new PrismApiClient({
        baseUrl: '',
        fetchImpl: async (input: string) => {
          seen.push(input);
          if (input.startsWith('/api/channels')) return reply({ version: 1, channels: [channel('drama', '短剧精选', 1, ['都市', '战神'])] });
          if (input.includes('page=2') && page2.length > 0) {
            return new Promise<Response>((resolve) => { release = resolve; });
          }
          return reply(input.includes('page=2') ? catalog(page2, 2, page1.length + page2.length) : catalog(page1, 1, page1.length + page2.length));
        }
      }),
      root,
      posterMode: () => 'compact-3',
      onPosterModeChange: () => undefined,
      onOpenTitle: () => undefined,
      onResume: () => undefined,
      historyPreview: async () => rows
    });
    return { root, view, settleSecond: () => release?.(reply(catalog(page2, 2, page1.length + page2.length))) };
  }

  it('AI 精品被提到块首槽并带【AI精品】角标，普通条目按判定留白', async () => {
    seen.length = 0;
    const { root, view } = viewHarness([entry('x-1'), entry('x-2', { isAi: true, category: '战神' })]);
    await view.mount();

    expect(seen).toContain('/api/catalog?channel=drama&page=1&pageSize=60');
    expect(Array.from(root.querySelectorAll('.poster-card')).map((card) => (card as HTMLElement).dataset.contentId))
      .toEqual(['x-2', 'x-1']);
    expect(root.querySelector('[data-content-id="x-2"] .poster-corner-badge--ai')?.textContent).toBe('AI精品');
    expect(root.querySelectorAll('.poster-corner-badge').length).toBe(1);
    view.destroy();
  });

  it('A-4 静默续载只追加：已渲染的首块顺序保持不变', async () => {
    seen.length = 0;
    const first = Array.from({ length: 20 }, (_, index) => entry(`b-${String(index + 1).padStart(2, '0')}`, { isAi: index < 3 }));
    const { root, view, settleSecond } = viewHarness(first, [entry('b-21'), entry('b-22', { isAi: true })]);
    await view.mount();

    // 首屏 20 部落定后，尾部哨兵自己去接第二页——没有任何手动按钮参与。
    const before = Array.from(root.querySelectorAll('.poster-card')).map((card) => (card as HTMLElement).dataset.contentId);
    expect(before).toHaveLength(20);
    expect(seen).toContain('/api/catalog?channel=drama&page=2&pageSize=60&revision=99');

    settleSecond();
    await flush();
    const after = Array.from(root.querySelectorAll('.poster-card')).map((card) => (card as HTMLElement).dataset.contentId);
    expect(after).toHaveLength(22);
    // 追加只发生在尾部：首块的相对顺序一位都不许变（混排重排的是展示层，不是分页语义）。
    expect(after.slice(0, 20)).toEqual(before);
    view.destroy();
  });

  it('AC-28 + AC-29 云端未下发 isAi / isHot 时：片单照常渲染、顺序为 id 稳定序、DOM 里一颗角标都没有', async () => {
    seen.length = 0;
    const plain = [entry('q-2'), entry('q-1'), entry('q-3')];
    const { root, view } = viewHarness(plain);
    await view.mount();

    expect(Array.from(root.querySelectorAll('.poster-card')).map((card) => (card as HTMLElement).dataset.contentId))
      .toEqual(['q-1', 'q-2', 'q-3']);
    expect(root.querySelectorAll('.poster-corner-badge').length).toBe(0);
    expect(root.querySelector('.home-grid-host')?.innerHTML).not.toMatch(/AI精品|热门/);
    view.destroy();
  });
});
