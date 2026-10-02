// @vitest-environment jsdom
/**
 * WP2 全屏自适应与画幅重塑（AC-19 / AC-20 / AC-21）。
 *
 * 这一组测试钉的是"权威只有一个"这件事本身：
 * 旧缺陷不是某条 CSS 写错，而是三方权威（app.css 的 `!important` 链、`art.fullscreenWeb` 触发的原生
 * 全屏容器、宿主 CSS 类）互不相知，于是每修一次换一种错。所以这里既有行为时序断言，也有源码级静态断言。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createPlayerHost } from '../../src/player-host';
import type { PlayerHostDeps } from '../../src/player-host';
import type { PlayerEngine } from '../../src/player/engine-seam';
import type { OrientationPort } from '../../src/core/native/orientation';
import { letterboxRatio, orientationOf } from '../../src/player/aspect';
import type { CallState, PrismNativeBridge } from '../../src/core/native/bridge';
import type { TitleDetail } from '../../edge/src/types/api';
import { dispatchBackButtonForTest } from '../../src/core/native/back-button';
import { detailOf, settle } from './player-harness';

const readSource = (relative: string): string => {
  let directory = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(directory, relative);
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    directory = dirname(directory);
  }
  throw new Error(`找不到正本 ${relative}`);
};

const bridged = (): PrismNativeBridge => ({
  getSystemVolume: async () => ({ volume: 1, supported: false }),
  getBrightness: async () => ({ brightness: 1, supported: false }),
  setSystemVolume: async () => ({ volume: 1, supported: false }),
  setBrightness: async () => ({ brightness: 1, supported: false }),
  setKeepScreenOn: async () => undefined,
  startBackgroundAudio: async () => undefined,
  stopBackgroundAudio: async () => undefined,
  setSecureScreen: async () => false,
  onCallState: (_listener: (state: CallState) => void) => () => undefined
} as unknown as PrismNativeBridge);

/** 内核替身：把 `on()` 登记的事件暴露成 `emit()`，好让测试自己触发 `loadedmetadata`。 */
function fakeEngine(): PlayerEngine & { emit(event: string): void } {
  const handlers = new Map<string, Array<() => void>>();
  const engine = {
    play: () => undefined, pause: () => undefined, playing: () => true, destroy: () => undefined,
    currentTime: () => 10, duration: () => 100, volume: () => 1, setVolume: () => undefined,
    setCurrentTime: () => undefined, setSource: () => undefined, toggleControls: () => undefined,
    resize: vi.fn(),
    on: (event: string, handler: () => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((item) => item !== handler));
    },
    emit: (event: string): void => (handlers.get(event) ?? []).forEach((handler) => handler())
  };
  return engine as unknown as PlayerEngine & { emit(event: string): void };
}

/** jsdom 没有媒体管线，真实 `<video>` 永远不会自己带上解码尺寸，所以按 SPEC §1.2.1 的字段手工钉死。 */
function stageVideo(mount: HTMLElement, width: number, height: number): void {
  const stage = mount.querySelector('.prism-player__stage');
  if (stage === null) throw new Error('播放器舞台尚未挂出');
  const video = document.createElement('video');
  Object.defineProperty(video, 'videoWidth', { value: width, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: height, configurable: true });
  stage.appendChild(video);
}

function harness(over: Partial<PlayerHostDeps> & { detail?: TitleDetail } = {}) {
  const { detail = detailOf(), ...rest } = over;
  const mount = document.createElement('div');
  document.body.replaceChildren(mount);
  const engine = fakeEngine();
  const locks: string[] = [];
  const orientation: OrientationPort = {
    lock: async (to) => { locks.push(`lock:${to}`); return true; },
    unlock: async () => { locks.push('unlock'); return true; }
  };
  const host = createPlayerHost({
    mount,
    bridge: bridged(),
    api: { title: vi.fn(async () => detail), playback: vi.fn(async (id: number) => ({ episodeId: id, url: 'https://play.prismos.org/proxy/m3u8/h1', mimeType: 'application/vnd.m3u8+playlist', durationSeconds: 100 })) },
    onProgress: () => undefined,
    allowBackgroundAudio: () => false,
    onPrivacyChange: () => undefined,
    orientation,
    engine: async () => engine,
    ...rest
  });
  const fullscreenButton = (): HTMLButtonElement | undefined =>
    Array.from(mount.querySelectorAll<HTMLButtonElement>('.action-island-item'))
      .find((button) => button.textContent?.includes('沉浸全屏'));
  const fullscreenOn = (): boolean => mount.querySelector('.prism-player-host--fullscreen') !== null;
  return { host, mount, engine, locks, orientation, fullscreenButton, fullscreenOn };
}

describe('AC-19 / AC-20 画幅嗅探（SPEC §1.2.1）', () => {
  it('只认 videoHeight > videoWidth 为竖屏，元数据未就绪时判为未知而不是竖屏', () => {
    expect(orientationOf(1080, 1920)).toBe('portrait');
    expect(orientationOf(1920, 1080)).toBe('landscape');
    // 正方画幅不属于"竖屏短剧"，不该被锁进竖屏路径。
    expect(orientationOf(1000, 1000)).toBe('landscape');
    expect(orientationOf(0, 0)).toBeNull();
    expect(orientationOf(1080, 0)).toBeNull();
    expect(orientationOf(0, 1920)).toBeNull();
  });

  it('§1.2.2 的留白数学：9:16 短剧放进 20:9 屏必留约 20% 高度，这就是底片存在的理由', () => {
    // 1080×1920 的视频放进 1080×2400 的视口：contain 后画面高 1920，上下共留 480px = 视口高的 20%。
    expect(letterboxRatio(1080, 2400, 1080, 1920)).toBeCloseTo(0.2, 5);
    // 横屏影视放进竖屏视口：按宽适配后画面只占约四分之一高度，垂直留白反而更大。
    // 这条同样由底片填充——所以"按画幅切换 object-fit"从来不是解法，解法只有底片。
    expect(letterboxRatio(1080, 2400, 1920, 1080)).toBeCloseTo(0.746875, 5);
    expect(letterboxRatio(0, 0, 0, 0)).toBe(0);
  });
});

describe('AC-19 竖屏短剧全屏：不转屏，舞台即视口', () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it('竖屏剧目进全屏绝不锁方向，只切宿主类并让内核重算尺寸', async () => {
    const h = harness();
    expect(await h.host.open('c1')).toBe(true);
    stageVideo(h.mount, 1080, 1920);
    h.engine.emit('loadedmetadata');
    await settle();
    h.fullscreenButton()?.click();
    await settle();
    expect(h.fullscreenOn()).toBe(true);
    // 强制旋转竖屏短剧是明确的禁止项：一次方向调用都不许发生。
    expect(h.locks).toEqual([]);
    expect(h.engine.resize).toHaveBeenCalled();
  });

  it('画幅尚未嗅到时进全屏同样不动方向，等元数据到达再联动', async () => {
    const h = harness();
    await h.host.open('c1');
    h.fullscreenButton()?.click();
    await settle();
    expect(h.fullscreenOn()).toBe(true);
    expect(h.locks).toEqual([]);
    // 元数据迟到且是横屏：此时才补上联动。
    stageVideo(h.mount, 1920, 1080);
    h.engine.emit('loadedmetadata');
    await settle();
    expect(h.locks).toEqual(['lock:landscape']);
  });
});

describe('AC-20 横屏影视全屏：联动锁横屏，退出解锁', () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it('16:9 剧目进全屏锁 landscape，退出全屏解锁', async () => {
    const h = harness();
    await h.host.open('c1');
    stageVideo(h.mount, 1920, 1080);
    h.engine.emit('loadedmetadata');
    await settle();
    h.fullscreenButton()?.click();
    await settle();
    expect(h.locks).toEqual(['lock:landscape']);
    h.fullscreenButton();
    h.host.close();
    await settle();
    expect(h.locks).toEqual(['lock:landscape', 'unlock']);
  });

  it('重复进入同一方向不重复锁，解锁后再次进全屏才重新锁', async () => {
    const h = harness();
    await h.host.open('c1');
    stageVideo(h.mount, 1920, 1080);
    h.engine.emit('loadedmetadata');
    await settle();
    const button = h.fullscreenButton();
    button?.click(); await settle();
    button?.click(); await settle();   // 退出全屏
    expect(h.locks).toEqual(['lock:landscape', 'unlock']);
    button?.click(); await settle();   // 再次进全屏
    expect(h.locks).toEqual(['lock:landscape', 'unlock', 'lock:landscape']);
  });

  it('平台拒绝锁定不算失败：全屏仍然成立，且不会谎报已锁', async () => {
    const refused: string[] = [];
    const h = harness({ orientation: { lock: async (to) => { refused.push(`lock:${to}`); return false; }, unlock: async () => { refused.push('unlock'); return true; } } });
    await h.host.open('c1');
    stageVideo(h.mount, 1920, 1080);
    h.engine.emit('loadedmetadata');
    await settle();
    h.fullscreenButton()?.click();
    await settle();
    expect(h.fullscreenOn()).toBe(true);
    // 锁失败后不得在退出时谎称"我锁过"而乱调 unlock。
    h.host.close();
    await settle();
    expect(refused).toEqual(['lock:landscape']);
  });
});

describe('AC-21 返回键级联退出', () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it('全屏态第一下只退全屏，非全屏第二下才关播放器', async () => {
    const h = harness();
    await h.host.open('c1');
    h.fullscreenButton()?.click();
    await settle();
    expect(h.fullscreenOn()).toBe(true);

    expect(await dispatchBackButtonForTest()).toBe(true);
    await settle();
    // 浮层还在，只是不再是全屏——详情生态台恢复。
    expect(h.mount.querySelector('.prism-player-host')).not.toBeNull();
    expect(h.fullscreenOn()).toBe(false);

    expect(await dispatchBackButtonForTest()).toBe(true);
    await settle();
    expect(h.mount.querySelector('.prism-player-host')).toBeNull();
    expect(h.host.isOpen()).toBe(false);
  });

  it('Escape 与系统返回走同一条级联，不退全屏直接关播放器视为缺陷', async () => {
    const h = harness();
    await h.host.open('c1');
    h.fullscreenButton()?.click();
    await settle();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(h.host.isOpen()).toBe(true);
    expect(h.fullscreenOn()).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(h.host.isOpen()).toBe(false);
  });
});

describe('全屏唯一权威的源码级守卫（SPEC §1.2.0 / 铁律 7）', () => {
  it('客户端零 `fullscreenWeb` 调用，零 `.prism-player--fullscreen` 第二权威', () => {
    const player = readSource('src/player/prism-player.ts');
    const engine = readSource('src/player/art-engine.ts');
    const seam = readSource('src/player/engine-seam.ts');
    const playerCss = readSource('src/player/player.css');
    for (const source of [player, engine, seam]) {
      // 注释里可以提这个名字（正是在解释为什么不能用），代码里一处都不许有。
      expect(source.split('\n').filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
        .join('\n')).not.toMatch(/fullscreenWeb/);
    }
    expect(playerCss).not.toMatch(/\.prism-player--fullscreen/);
    expect(player).not.toMatch(/prism-player--fullscreen/);
  });

  it('全屏样式段零 `!important`，宿主类是唯一开关', () => {
    const css = readSource('src/player/player-host.css');
    const range = css.slice(css.indexOf('.prism-player-host--fullscreen {'), css.indexOf('/* 非全屏剧集详情生态台'));
    // 只量声明体：注释里出现 `!important` 是在解释为什么不再需要它，把它算成破口等于禁掉说明。
    const declarations = range.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(declarations).not.toMatch(/!important/);
    expect(declarations).toMatch(/\.prism-player-host--fullscreen \.prism-player-host__stage\s*\{[^}]*position:\s*fixed/);
    // AC-19 的"无纯黑死边"：起播后底片必须继续亮着，而不是靠 cover 裁画面。
    expect(declarations).toMatch(/is-playing \.prism-player__backdrop\s*\{[^}]*opacity:\s*1/);
    expect(declarations).not.toMatch(/object-fit:\s*cover/);
  });

  it('app.css 不再持有播放浮层，也就不再持有那 7 条 `!important` 链', () => {
    const app = readSource('src/styles/app.css');
    expect(app).not.toMatch(/prism-player-host/);
    expect(app.match(/!important/g) ?? []).toHaveLength(1);
  });

  it('底片落在画面之下，这是全屏留白不变成黑边的前提', () => {
    const css = readSource('src/player/player.css');
    expect(css).toMatch(/\.prism-player__backdrop\s*\{[^}]*z-index:\s*0/);
  });
});
