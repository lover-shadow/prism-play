// @vitest-environment jsdom
/**
 * AC-26 二级分类胶囊「视觉 28px / 命中 ≥44px」双口径对账。
 *
 * 单独成文件的原因：`scan_p0.py` 对测试同样执行 §10 的 300 行红线，而这两条断言钉的是
 * 无障碍下限——压缩行数时最容易顺手牺牲的恰恰是这类"看起来重复"的分层校验。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createCapsuleRail } from '../../src/components/capsule-rail';

const readSource = (relative: string): string => {
  let directory = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(directory, relative);
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    directory = dirname(directory);
  }
  throw new Error(`找不到样式正本 ${relative}`);
};

const homeCss = readSource('src/styles/home.css');
const tokensCss = readSource('src/styles/design-tokens.css');
const declaration = (selector: string): string =>
  homeCss.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`))?.[1] ?? '';

describe('AC-26 胶囊双口径的样式权威', () => {
  it('命中区挂在这颗 `<button>` 自己的盒子上，而不是靠外层 rail 的 padding 撑行', () => {
    // padding 不扩大命中区。写成"外层补 padding 凑 44px"就是看着合规、实测 28px 的无障碍破口。
    const capsule = declaration('.capsule');
    expect(capsule).toMatch(/min-height:\s*var\(--capsule-hit\)/);
    // 按钮本体不再是那颗可见胶囊：圆角与描边都必须已经内移到 pill，否则 44px 会画成一个胖胶囊。
    expect(capsule).not.toMatch(/border-radius:/);
    expect(capsule).not.toMatch(/border:\s*1px/);
  });

  it('观感胶囊是内层元素，28px 只作用在它身上', () => {
    const pill = declaration('.capsule-pill');
    expect(pill).toMatch(/height:\s*var\(--capsule-height\)/);
    expect(pill).toMatch(/border-radius:\s*var\(--radius-pill\)/);
    expect(pill).toMatch(/border:\s*1px solid var\(--border-subtle\)/);
    expect(pill).toMatch(/padding:\s*0 var\(--space-3\)/);
    // 激活态底色必须落在内层，否则视觉上 44px 整块被点亮，双口径当场失效。
    expect(homeCss).toMatch(/\.capsule\.is-active \.capsule-pill\s*\{[^}]*background:\s*var\(--accent\)/);
  });

  it('一级频道上梯级到 17px 并加粗，确立对二级胶囊的支配力', () => {
    expect(declaration('.channel-tab')).toMatch(/font-size:\s*var\(--text-md\)/);
    expect(declaration('.channel-tab')).not.toMatch(/font-size:\s*1[0-9]px/);
    expect(declaration('.channel-tab.is-active')).toMatch(/font-weight:\s*700/);
    expect(declaration('.capsule')).toMatch(/font-size:\s*var\(--text-xs\)/);
    expect(tokensCss).toMatch(/--text-md:\s*17px/);
    expect(tokensCss).toMatch(/--capsule-height:\s*28px/);
    expect(tokensCss).toMatch(/--capsule-hit:\s*44px/);
  });

  it('rail 行不再自带垂直 padding——44px 命中高度已由按钮本体占满', () => {
    // 留着 rail 的上下 padding 会把整行撑到 60px，双口径就变成"28 视觉 + 60 行高"的第三种口径。
    expect(declaration('.capsule-rail')).not.toMatch(/padding:\s*var\(--space-2\)/);
  });
});

describe('AC-26 胶囊 DOM 结构', () => {
  it('按钮盒承载命中区与语义，文字位于内层 pill，选中态仍按类别落定', () => {
    const root = document.createElement('div');
    const rail = createCapsuleRail({ root, onSelect: () => undefined });
    rail.render(['都市', '战神'], '战神');
    const chips = Array.from(root.querySelectorAll<HTMLButtonElement>('.capsule'));
    expect(chips).toHaveLength(3);
    for (const chip of chips) {
      expect(chip.classList.contains('touch-target')).toBe(true);
      expect(chip.querySelector('.capsule-pill')?.textContent).toBe(chip.dataset.category);
    }
    const active = root.querySelector<HTMLButtonElement>('.capsule.is-active');
    expect(active?.getAttribute('aria-current')).toBe('true');
    expect(active?.dataset.category).toBe('战神');
    rail.destroy();
  });

  it('点击内层 pill 仍命中按钮的 onSelect（内层不得吞掉事件语义）', () => {
    const picked: string[] = [];
    const root = document.createElement('div');
    const rail = createCapsuleRail({ root, onSelect: (label) => picked.push(label) });
    rail.render(['都市', '战神']);
    const pills = Array.from(root.querySelectorAll<HTMLElement>('.capsule-pill'));
    expect(pills.map((pill) => pill.textContent)).toEqual(['全部', '都市', '战神']);
    pills[2].click();
    expect(picked).toEqual(['战神']);
    rail.destroy();
  });
});
