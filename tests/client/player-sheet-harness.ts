/**
 * 播放器宿主级测试替身：真实 `player-host.ts` 装配，只替内核与原生桥。
 *
 * 存在理由与 `player-harness.ts` 同一条：§10 的 300 行红线也管测试，而"层叠/抽屉三态"与
 * "集号文案/控件收起"两组断言都会继续增长，替身必须只有一份真相，禁止为减行数复制进两个文件。
 *
 * jsdom 的 cssom 解析不了本项目 CSS 里的 `aspect-ratio: 16 / 9` 一类声明（整张表被丢弃），
 * 而 vitest 又把 `*.css?raw` 空装成已处理模块（长度 0）——所以样式正本一律从磁盘直读文本，
 * 断言钉的是"声明了什么"，像素观感仍归真机验收（与 `53-fullscreen-aspect.test.ts` 同一口径）。
 */
import { vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createPlayerHost } from '../../src/player-host';
import type { PlayerHostDeps } from '../../src/player-host';
import type { PlayerEngine } from '../../src/player/engine-seam';
import type { CallState, PrismNativeBridge } from '../../src/core/native/bridge';
import type { TitleDetail } from '../../edge/src/types/api';
import { detailOf } from './player-harness';

export const readSource = (relative: string): string => {
  let directory = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(directory, relative);
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    directory = dirname(directory);
  }
  throw new Error(`找不到正本 ${relative}`);
};

export const playerCss = readSource('src/player/player.css');
export const hostCss = readSource('src/player/player-host.css');

/** 取某条规则的声明体（简单选择器，不含嵌套块）；取不到即视为样式正本缺席该规则。 */
export const rule = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`));
  if (match === null) throw new Error(`样式正本缺规则 ${selector}`);
  return match[0];
};

function fakeHostEngine(): PlayerEngine & { emit(event: string): void } {
  const handlers = new Map<string, Array<() => void>>();
  const engine = {
    play: () => undefined, pause: () => undefined, playing: () => true, destroy: () => undefined,
    currentTime: () => 10, duration: () => 100, volume: () => 1, setVolume: () => undefined,
    setCurrentTime: () => undefined, setSource: () => undefined, toggleControls: () => undefined,
    resize: () => undefined, playbackRate: () => 1, setPlaybackRate: () => undefined,
    on: (event: string, handler: () => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => handlers.set(event, (handlers.get(event) ?? []).filter((item) => item !== handler));
    },
    emit: (event: string): void => (handlers.get(event) ?? []).forEach((handler) => handler())
  };
  return engine as unknown as PlayerEngine & { emit(event: string): void };
}

export function openHost(over: Partial<PlayerHostDeps> & { detail?: TitleDetail } = {}) {
  const { detail = detailOf(), ...rest } = over;
  const mount = document.createElement('div');
  document.body.replaceChildren(mount);
  const engine = fakeHostEngine();
  const calls = { closed: 0 };
  const bridge = {
    getSystemVolume: async () => ({ volume: 1, supported: false }),
    getBrightness: async () => ({ brightness: 1, supported: false }),
    setSystemVolume: async () => ({ volume: 1, supported: false }),
    setBrightness: async () => ({ brightness: 1, supported: false }),
    setKeepScreenOn: async () => undefined,
    startBackgroundAudio: async () => undefined,
    stopBackgroundAudio: async () => undefined,
    setSecureScreen: async () => false,
    onCallState: (_listener: (state: CallState) => void) => () => undefined
  } as unknown as PrismNativeBridge;
  const host = createPlayerHost({
    mount,
    bridge,
    api: {
      title: vi.fn(async () => detail),
      playback: vi.fn(async (id: number) => ({ episodeId: id, url: 'https://play.prismos.org/proxy/m3u8/h1', mimeType: 'application/vnd.m3u8+playlist', durationSeconds: 100 }))
    },
    onProgress: () => undefined,
    allowBackgroundAudio: () => false,
    onPrivacyChange: () => undefined,
    onClose: () => { calls.closed += 1; },
    engine: async () => engine,
    ...rest
  });
  const fullscreenButton = () => Array.from(mount.querySelectorAll<HTMLButtonElement>('.action-island-item'))
    .find((button) => button.textContent?.includes('沉浸全屏'))!;
  return {
    host, mount, engine, calls,
    fullscreenButton,
    fullscreenOn: () => mount.querySelector('.prism-player-host--fullscreen') !== null,
    island: (label: string) => Array.from(mount.querySelectorAll<HTMLButtonElement>('.action-island-item'))
      .find((button) => button.textContent?.includes(label))!,
    q: <T extends Element>(selector: string) => mount.querySelector<T>(selector)
  };
}
