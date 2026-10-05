// @vitest-environment jsdom
/**
 * HP-09 收窄底部导航（HOME-PLAYER-REPAIR §3 HP-09 / §5.1 HP-09 / §4.3「旧仅内容限宽 360 不等于背景承载收窄」）。
 *
 * AC-27 当年的口径是"背景与分隔线铺满视口，只把**内容**限宽 360px"，真机于是量到一条横贯全屏的厚底栏。
 * HP-09 把承载面本身也收窄：`--tabbar-content-max` 这个宽度从此同时约束**背景 + 边框 + 内容**，
 * 所以断言重点从"inner 有 max-width"（AC-27 已钉，见 `50-app-shell`，原样保留）搬到
 * "背景与边框确实搬到了 inner 上，而 `.app-tabbar` 不再自己画一条横贯的带子"。
 *
 * 底部安全区同样只许有一处真相：旧写法是 `.app-shell` 与 `.app-tabbar` 各加一次
 * `env(safe-area-inset-bottom)`，两处相加就是真机上那条"底栏下面还有一截死黑"的重复留白。
 *
 * 命中区（44px）与栅格是否 overlay 归本文件的样式正本断言；具体 rect 归真实视口待验清单。
 */
import { describe, expect, it } from 'vitest';
import { readSource, rule } from './player-sheet-harness';

const appCss = readSource('src/styles/app.css');
const tokensCss = readSource('src/styles/design-tokens.css');
const tokensJson = JSON.parse(readSource('src/styles/design-tokens.json')) as {
  layout: Record<string, { value: string }>;
  radius: Record<string, { value: string }>;
  interaction: { touchTargetMin: { value: string } };
};

const body = (selector: string): string => rule(appCss, selector);

describe('HP-09 背景承载区与内容一起收窄居中', () => {
  it('.app-tabbar 不再自己画横贯底色与分隔线，只负责居中与安全区', () => {
    const bar = body('.app-tabbar');
    expect(bar).not.toMatch(/background:/);
    expect(bar).not.toMatch(/border-top:/);
    expect(bar).toMatch(/padding-inline:\s*var\(--tabbar-inset-x\)/);
    expect(bar).toMatch(/padding-bottom:\s*var\(--safe-area-bottom\)/);
    expect(bar).toMatch(/display:\s*flex/);
    expect(bar).toMatch(/justify-content:\s*center/);
  });

  it('底色、分隔线与圆角都落在 .app-tabbar-inner，与 max-width 同一条盒子上', () => {
    const inner = body('.app-tabbar-inner');
    expect(inner).toMatch(/background:\s*var\(--surface\)/);
    expect(inner).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(inner).toMatch(/border-radius:\s*var\(--radius-lg\)\s*var\(--radius-lg\)\s*0\s*0/);
    expect(inner).toMatch(/max-width:\s*var\(--tabbar-content-max\)/);
    expect(inner).toMatch(/margin:\s*0 auto/);
    expect(inner).toMatch(/width:\s*100%/);
    // 图标与文字"适当靠下"：内容底对齐，条内不再留一条垂直居中死白。
    expect(inner).toMatch(/align-items:\s*flex-end/);
    expect(inner).toMatch(/padding:\s*var\(--space-1\)\s+var\(--space-2\)\s+0/);
  });
});

describe('HP-09 底部安全区只由一处计算', () => {
  it('.app-shell 不再重复计算底部安全区，顶部仍归它', () => {
    const shell = body('.app-shell');
    expect(shell).not.toMatch(/safe-area-inset-bottom/);
    expect(shell).toMatch(/padding-top:\s*env\(safe-area-inset-top/);
  });

  it('全表只有 .app-tabbar 消费 --safe-area-bottom（.app-notice 的偏移是引用同一个 token，不是第二次 env）', () => {
    const consumers = [...appCss.matchAll(/padding-bottom:\s*var\(--safe-area-bottom\)/g)];
    expect(consumers).toHaveLength(1);
    expect(appCss).not.toMatch(/env\(safe-area-inset-bottom/);
    expect(body('.app-notice')).toMatch(/bottom:\s*calc\(var\(--tabbar-height\)\s*\+\s*var\(--safe-area-bottom\)/);
  });

  it('底栏是网格的一行而不是 overlay：结构上就盖不到列表最后一项', () => {
    expect(body('.app-shell')).toMatch(/grid-template-rows:\s*auto 1fr auto/);
    expect(appCss).not.toMatch(/\.app-tabbar\s*\{[^}]*position:\s*fixed/);
  });
});

describe('HP-09 尺寸走 Token 且 CSS/JSON 同源', () => {
  it('底栏高度 56→48、岛外左右留白新增为 token，圆角继续吃既有 --radius-lg', () => {
    expect(tokensCss).toMatch(/--tabbar-height:\s*48px/);
    expect(tokensCss).toMatch(/--tabbar-inset-x:\s*12px/);
    expect(tokensCss).toMatch(/--tabbar-content-max:\s*360px/);
    expect(tokensCss).toMatch(/--radius-lg:\s*14px/);
    expect(tokensJson.layout.tabbarHeight.value).toBe('48px');
    expect(tokensJson.layout.tabbarInsetX.value).toBe('12px');
    expect(tokensJson.layout.tabbarContentMax.value).toBe('360px');
    expect(tokensJson.radius.lg.value).toBe('14px');
  });

  it('导航按钮触区不被压缩：44px 下限与 token 同源，且不随密度改动缩水', () => {
    expect(tokensJson.interaction.touchTargetMin.value).toBe('44px');
    expect(body('.app-tab')).toMatch(/min-width:\s*44px/);
    expect(body('.app-tab')).toMatch(/min-height:\s*44px/);
    expect(body('.app-tabbar button')).toMatch(/min-height:\s*44px/);
  });

  it('app.css 依旧零裸色值（P0-3）', () => {
    expect(appCss).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
    expect(appCss).not.toMatch(/[^\w-]rgba?\(/);
  });
});
