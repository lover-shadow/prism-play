// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';

afterEach(() => {
  document.body.replaceChildren();
  document.documentElement.className = '';
});

describe('原生播放与全屏海报底片层叠样式（AC-R07）', () => {
  const playerCss = fs.readFileSync('src/player/player.css', 'utf8');
  const hostCss = fs.readFileSync('src/player/player-host.css', 'utf8');

  function setupDom(nativeActive: boolean, fullscreen: boolean, isPlaying: boolean): HTMLElement {
    const style = document.createElement('style');
    style.textContent = `${playerCss}\n${hostCss}`;
    document.head.append(style);

    if (nativeActive) document.documentElement.classList.add('prism-native-active');

    const host = document.createElement('div');
    host.className = 'prism-player-host';
    if (fullscreen) host.classList.add('prism-player-host--fullscreen');

    const player = document.createElement('div');
    player.className = 'prism-player';
    if (isPlaying) player.classList.add('is-playing');

    const backdrop = document.createElement('div');
    backdrop.className = 'prism-player__backdrop';

    player.append(backdrop);
    host.append(player);
    document.body.append(host);
    return backdrop;
  }

  it('原生播放激活时，全屏且播放中的海报底片仍保持 hidden，不遮挡底层原生画面', () => {
    const backdrop = setupDom(true, true, true);
    const computed = window.getComputedStyle(backdrop);
    expect(computed.visibility).toBe('hidden');
  });

  it('原生激活 + 暂停（无 is-playing）：底片仍 hidden——“原生画面不得被任何 WebView 层遮挡”不因播放状态回退', () => {
    const backdrop = setupDom(true, true, false);
    expect(window.getComputedStyle(backdrop).visibility).toBe('hidden');
  });

  it('原生激活 + 非全屏（详情台）：底片同样 hidden（规则不依赖全屏态）', () => {
    const backdrop = setupDom(true, false, true);
    expect(window.getComputedStyle(backdrop).visibility).toBe('hidden');
  });

  it('非原生网页播放时，全屏且播放中的海报底片为 visible 充当留白背景', () => {
    const backdrop = setupDom(false, true, true);
    const computed = window.getComputedStyle(backdrop);
    expect(computed.visibility).toBe('visible');
    expect(computed.opacity).toBe('1');
  });

  it('非原生 + 非全屏 + 播放中：底片淡出（opacity 0 / hidden），画面不被海报覆盖', () => {
    const backdrop = setupDom(false, false, true);
    const computed = window.getComputedStyle(backdrop);
    expect(computed.opacity).toBe('0');
    expect(computed.visibility).toBe('hidden');
  });
});
