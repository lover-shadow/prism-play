// @vitest-environment jsdom
/**
 * HP-11 列表简介与可信元信息 + HP-12 主分类与副标签并存（HOME-PLAYER-REPAIR §3 HP-11/HP-12、§3.3、§5.1）.
 *
 * 界面侧只负责两件事，**不再持有第二份口径**：
 * 1. **有则展示**：`synopsis` 原样进安全文本节点（读侧已由 B3 的 `metadata-policy` 消毒并限长，
 *    这里不再截 30 字、也不再复制 240 / 6×12 / 64 / 年份区间任何数字）；
 *    主分类 `category` 与副标签 `tags` 并存，`releaseYear / region / language` 逐个按"字段在不在"决定渲不渲染。
 * 2. **无则压缩**：字段缺席就不产生节点，信息块自然塌缩；绝不编兜底文案，也绝不把空数组当成有标签。
 *
 * 真实"原料→打包→DTO→渲染"的覆盖链属 B3/B7（§5「元数据传递必须增加集成回归」），
 * 本文件只证渲染层的形状与安全边界，不宣称上游已经供得出这些字段。
 */
import { describe, expect, it } from 'vitest';
import type { ContentItem } from '../../edge/src/types/api';
import { createPosterGrid } from '../../src/components/poster-grid';
import { readSource } from './player-sheet-harness';

const homeCss = readSource('src/styles/home.css');
const tokensCss = readSource('src/styles/design-tokens.css');
const gridSource = readSource('src/components/poster-grid.ts');

const LONG = '五年前他被剥夺战功扫地出门，五年后万龙俯首重返临海，一路查清当年那笔账的每一个经手人。';

function item(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: 'c-1', channelId: 'drama', title: '战神之龙王归来', category: '战神', isPrivate: false,
    coverUrl: 'https://cdn.example/cover-1.jpg', episodeCount: 80, ...overrides
  };
}

function cardOf(overrides: Partial<ContentItem>): HTMLElement {
  const node = document.createElement('div');
  document.body.replaceChildren(node);
  createPosterGrid({ root: node, mode: () => 'list-1', onOpenTitle: () => undefined }).render([item(overrides)]);
  return node.querySelector<HTMLElement>('.poster-card')!;
}

const texts = (root: HTMLElement, selector: string): string[] =>
  [...root.querySelectorAll<HTMLElement>(selector)].map((node) => node.textContent ?? '');

describe('HP-11 有摘要就展示真实摘要', () => {
  it('摘要原样落到安全文本节点，界面不做第二次截断', () => {
    const card = cardOf({ synopsis: LONG });
    const shown = texts(card, '.poster-synopsis');
    expect(shown).toEqual([LONG]);
    expect(shown[0]?.length).toBeGreaterThan(30);
    expect(card.querySelector('.poster-synopsis')?.getAttribute('style')).toBeNull();
  });

  it('列表流的摘要行数与元信息行都由 token 决定（不为省行数把画面留白还给空块）', () => {
    expect(tokensCss).toMatch(/--poster-synopsis-rows:\s*3/);
    expect(homeCss).toMatch(/\.grid-posters-list-1 \.poster-synopsis\s*\{[^}]*-webkit-line-clamp:\s*var\(--poster-synopsis-rows\)/);
    expect(homeCss).toMatch(/\.grid-posters-list-1 \.poster-facts\s*\{[^}]*display:\s*flex/);
    // 密集模式塞不下就不塞：摘要与元信息行在 compact-3 / bookshelf-4 里保持隐藏。
    expect(homeCss).toMatch(/\.poster-synopsis\s*\{[^}]*display:\s*none/);
    expect(homeCss).toMatch(/\.poster-facts\s*\{[^}]*display:\s*none/);
  });
});

describe('HP-11 无摘要时只显示有依据的年份／地区／语言', () => {
  it('字段齐全就逐条渲染，顺序固定为年份、地区、语言', () => {
    const card = cardOf({ synopsis: undefined, releaseYear: 2024, region: '中国大陆', language: '汉语普通话' });
    expect(card.querySelector('.poster-synopsis')).toBeNull();
    expect(texts(card, '.poster-fact')).toEqual(['2024', '中国大陆', '汉语普通话']);
  });

  it('缺一个就少一条，不补位也不写成范围', () => {
    expect(texts(cardOf({ region: '中国香港' }), '.poster-fact')).toEqual(['中国香港']);
    expect(texts(cardOf({ releaseYear: 1998 }), '.poster-fact')).toEqual(['1998']);
    expect(texts(cardOf({ releaseYear: 2024, language: '英语' }), '.poster-fact')).toEqual(['2024', '英语']);
  });

  it('非整数年份、空串与纯空白都算缺供：节点物理缺席', () => {
    const card = cardOf({ releaseYear: 2024.5, region: '   ', language: '' });
    expect(card.querySelector('.poster-facts')).toBeNull();
  });

  it('完全无信息时压缩信息块：标题之外零节点、零编造文案', () => {
    const card = cardOf({ category: '', synopsis: undefined });
    expect(card.querySelector('.poster-meta')).toBeNull();
    expect(card.querySelector('.poster-facts')).toBeNull();
    expect(card.querySelector('.poster-synopsis')).toBeNull();
    expect(texts(card, '.poster-title')).toEqual(['战神之龙王归来']);
    expect(card.textContent).not.toMatch(/暂无|待补充|未知|敬请|默认/);
  });
});

describe('HP-12 主分类与副标签并存', () => {
  it('category 仍是主分类，tags 只作副标签，二者同时出现', () => {
    const card = cardOf({ category: '逆袭', tags: ['末世', '悬疑'] });
    expect(texts(card, '.poster-tag')).toEqual(['逆袭']);
    expect(texts(card, '.poster-subtag')).toEqual(['末世', '悬疑']);
  });

  it('空标签是正常态：空数组按缺供处理，不渲染、也不报错', () => {
    expect(cardOf({ tags: [] }).querySelectorAll('.poster-subtag')).toHaveLength(0);
    const bare = cardOf({ tags: undefined });
    expect(bare.querySelectorAll('.poster-subtag')).toHaveLength(0);
    expect(bare.querySelector('.poster-tag')?.textContent).toBe('战神');
  });

  it('只有一枚副标签也照实渲染，不为数量强造第二条', () => {
    expect(texts(cardOf({ tags: ['穿越'] }), '.poster-subtag')).toEqual(['穿越']);
  });
});

describe('HP-11/HP-12 渲染安全与口径唯一', () => {
  it('原料里的 HTML、URL 与标签文本只作为文字出现，绝不成为节点', () => {
    const nasty = '<img src=x onerror=alert(1)>';
    const card = cardOf({
      synopsis: `<a href="https://evil.example">${nasty}</a>`,
      region: 'mac://site.example/108361/',
      tags: ['<script>alert(1)</script>']
    });
    // 唯一的合法 `<img>` 是海报封面自己造的；信息块里不许长出第二个元素节点——
    // 原料里的 `<img>`／`<script>`／`onerror` 只会作为**文字**存在，所以这里只数节点，不比字符串。
    const info = card.querySelector('.poster-body') as HTMLElement;
    expect(card.querySelectorAll('img')).toHaveLength(1);
    expect(info.querySelectorAll('a, img, script')).toHaveLength(0);
    expect([...info.querySelectorAll('*')].every((node) => node.tagName === 'SPAN')).toBe(true);
    expect(card.querySelector('.poster-synopsis')?.textContent).toBe(`<a href="https://evil.example">${nasty}</a>`);
    expect(texts(card, '.poster-fact')).toEqual(['mac://site.example/108361/']);
    expect(texts(card, '.poster-subtag')).toEqual(['<script>alert(1)</script>']);
  });

  it('界面不复制第二份文本边界（240／6×12／64／年份区间归 metadata-policy）', () => {
    expect(gridSource).not.toMatch(/CODE_POINTS|\bslice\(|\bsubstring\(|\b240\b|\b64\b|slice\(0/);
    expect(gridSource).not.toMatch(/innerHTML\s*=\s*item\./);
  });

  it('P0：卡片信息块零 emoji、零裸色值', () => {
    expect(gridSource).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u);
    expect(homeCss).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
  });
});
