// @vitest-environment jsdom
/**
 * HP-08 全屏限定的紧凑透明控制层（HOME-PLAYER-REPAIR §3 HP-08 / §5.1 HP-08a·HP-08b / §4.1 B6 行）。
 *
 * 分工口径与 `58` / `59` 一致，不重复它们的断言：
 * - `58` 证 chrome 的层叠与五按钮预算（全屏那条带子怎么摆）；
 * - `59` 证收起判据与非全屏物理摘除（带子什么时候存在）；
 * - 本文件只证 HP-08 新增的三件事：**横贯实心背景撤掉**、**常驻大状态胶囊换成图标 + 无障碍名称**、
 *   **视觉高度与命中区分开（图标 24px / 触区 --player-hit 44px）**。
 *
 * jsdom 不做级联与布局，所以观感规则钉样式正本的声明文本，DOM/ARIA 走真断言；
 * 像素 rect 归真实视口待验清单（§5「有效浏览器与真实媒体」），不在这里冒充视觉通过。
 */
import { describe, expect, it } from 'vitest';
import { hostCss, playerCss, readSource, rule } from './player-sheet-harness';
import { settle, setup } from './player-harness';

const tokensCss = readSource('src/styles/design-tokens.css');

describe('HP-08 控制层不再横贯实心背景', () => {
  it('.prism-player__chrome 撤掉实心底与下边框，改吃顶部渐隐遮罩 token', () => {
    const chrome = rule(playerCss, '.prism-player__chrome');
    expect(chrome).not.toMatch(/background:\s*var\(--surface-overlay\)/);
    expect(chrome).not.toMatch(/border-bottom:/);
    expect(chrome).toMatch(/background:\s*var\(--player-chrome-scrim\)/);
    // 遮罩本身必须是 Token，而不是把 rgba 写在组件样式里（P0-3）。
    expect(tokensCss).toMatch(/--player-chrome-scrim:\s*linear-gradient\(/);
    expect(tokensCss).toMatch(/--player-chrome-h:/);
    expect(rule(playerCss, '.prism-player')).toMatch(/--prism-chrome-h:\s*calc\(var\(--player-chrome-h\)/);
  });

  it('非全屏把手势面顶部让给 chrome 的那条带子收回到 0（画面不被空切一刀）', () => {
    const reclaim = hostCss.match(
      /\.prism-player-host:not\(\.prism-player-host--fullscreen\)\s+\.prism-player\s*\{[^}]*--prism-chrome-h:\s*0px/
    );
    expect(reclaim, '非全屏没有把 --prism-chrome-h 归零').not.toBeNull();
  });

  it('控制层按钮：触区走 --player-hit（44px），底色描边一起撤掉，视觉只剩图标', () => {
    expect(tokensCss).toMatch(/--player-hit:\s*44px/);
    expect(tokensCss).toMatch(/--player-glyph:\s*24px/);
    const compact = rule(playerCss, '.prism-player__chrome .prism-player__button');
    expect(compact).toMatch(/min-height:\s*var\(--player-hit\)/);
    expect(compact).toMatch(/min-width:\s*var\(--player-hit\)/);
    expect(compact).toMatch(/background:\s*transparent/);
    expect(compact).toMatch(/border-color:\s*transparent/);
    // 倍速那颗是唯一的文字控件（它同时是菜单的选中值），同样不得留实心胶囊底。
    expect(rule(playerCss, '.prism-player__chrome .prism-player__pill')).toMatch(/background:\s*transparent/);
  });
});

describe('HP-08 常驻大状态胶囊 → 图标 + 无障碍名称', () => {
  it('定时/锁定/选集三颗都是 Lucide 图标按钮，本体零文字，状态名进 aria-label', async () => {
    const h = setup();
    await h.player.load(11); await settle();
    const chrome = h.q<HTMLElement>('.prism-player__chrome')!;
    for (const action of ['sleep', 'lock', 'list']) {
      const button = chrome.querySelector<HTMLElement>(`[data-action="${action}"]`)!;
      expect(button.querySelector('svg'), `${action} 不是内联 SVG 图标`).not.toBeNull();
      expect(button.classList.contains('prism-player__button'), `${action} 仍是文字胶囊`).toBe(true);
      expect((button.textContent ?? '').trim(), `${action} 把状态写成了画面文字`).toBe('');
      expect(button.getAttribute('aria-label'), `${action} 缺少无障碍名称`).toBeTruthy();
    }
    expect(chrome.textContent).not.toMatch(/已锁定|已解锁/);
    h.player.destroy();
  });

  it('锁定与定时的状态改由 aria-label + aria-pressed 说话', async () => {
    const h = setup();
    await h.player.load(11); await settle();
    const lock = h.q<HTMLElement>('[data-action="lock"]')!;
    const sleep = h.q<HTMLElement>('[data-action="sleep"]')!;
    expect(lock.getAttribute('aria-pressed')).toBe('false');
    expect(lock.getAttribute('aria-label')).toContain('锁定手势');
    h.player.setLocked(true);
    expect(lock.getAttribute('aria-pressed')).toBe('true');
    expect(lock.getAttribute('aria-label')).toContain('已锁定');
    expect(sleep.getAttribute('aria-label')).toContain('睡眠定时');
    expect(sleep.getAttribute('aria-pressed')).toBe('false');
    h.player.scheduleSleep('timer-30');
    expect(sleep.getAttribute('aria-pressed')).toBe('true');
    expect(sleep.getAttribute('aria-label')).toMatch(/睡眠定时.*30/);
    h.player.destroy();
  });

  it('P0-1 / P0-3：控制层正本零 emoji、零裸色值，图标尺寸只有 24', () => {
    expect(playerCss).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
    expect(playerCss).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u);
    const hud = readSource('src/player/hud.ts');
    const sizes = [...hud.matchAll(/icon\('[a-zA-Z]+',\s*\{[^}]*size:\s*(\d+)/g)].map((m) => Number(m[1]));
    for (const size of sizes) expect([16, 20, 24], `图标尺寸越界：${size}`).toContain(size);
  });
});
