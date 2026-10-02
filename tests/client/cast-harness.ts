// @vitest-environment jsdom
/**
 * 投屏面板测试的共享替身（AC-24）。
 *
 * 抽出来是因为 `cast-panel.ts` 与它的用例都受 §10 的 300 行红线约束：把 90 行假桥与假时钟留在用例里，
 * 挤出的是真正要钉住的行为断言。假桥在这里只承担一件事——**让 UDP 与 SOAP 的时序变成可确定性驱动的**。
 *
 * 两条纪律：
 *   • 查询一律限定在本次 harness 自己的子树（`node()`），同一测试挂两只面板时全局 querySelector 会命中
 *     上一只，于是"第二个断言其实在测第一台设备"——那种红查半天，最后人只会去松一条真规则。
 *   • `TimerPort` 是注入的假时钟，连播等待（整集时长 + `AUTO_CONTINUE_GRACE_MS`）因此能被精确断言；
 *     jsdom 里等不到真实时间，"提前掐片尾"这类缺陷只有把时钟变成可控量才测得出来。
 */
import { afterEach } from 'vitest';
import { createCastPanel } from '../../src/player/cast-panel';
import type { CastPanel, CastStreamSource, TimerPort } from '../../src/player/cast-ports';
import type { CastClient, CastDevice } from '../../src/core/native/cast';
import { detailOf, settle } from './player-harness';

export const DEVICE: CastDevice = {
  id: 'lan-1',
  name: '客厅的小米电视',
  ip: '192.168.31.88',
  port: 49152,
  controlUrl: 'http://192.168.31.88:49152/upnp/control/avtransport',
  location: 'http://192.168.31.88:49152/description.xml'
};
export const PROXY = 'https://play.prismos.org/proxy/media/h1?exp=1&sig=abc';

export interface FakeTimer extends TimerPort {
  delays: number[];
  armed(): boolean;
  fire(): void;
}

function fakeTimer(): FakeTimer {
  let pending: (() => void) | null = null;
  const delays: number[] = [];
  return {
    delays,
    set(callback: () => void, ms: number): number {
      delays.push(ms);
      pending = callback;
      return delays.length;
    },
    clear(): void {
      pending = null;
    },
    armed: () => pending !== null,
    fire(): void {
      const next = pending;
      pending = null;
      if (next !== null) next();
    }
  };
}

const panels: CastPanel[] = [];

export interface HarnessOptions {
  devices?: CastDevice[];
  supported?: boolean;
  probesSent?: number;
  multicastAvailable?: boolean;
  durationSeconds?: number | null;
  discoverError?: string;
  /** 默认私密判定为假；私密零上报用例把它翻成 true。 */
  isPrivate?: () => boolean;
}

export function harness(options: HarnessOptions = {}) {
  const calls: string[] = [];
  const pushed: Array<{ id: string; url: string; title?: string }> = [];
  const devices = options.devices ?? [DEVICE];
  const client: CastClient = {
    supported: options.supported ?? true,
    discover: async () => {
      calls.push('discover');
      if (options.discoverError !== undefined) throw new Error(options.discoverError);
      return {
        devices,
        count: devices.length,
        probesSent: options.probesSent ?? 2,
        multicastAvailable: options.multicastAvailable ?? true,
        multicastLockReleased: true
      };
    },
    stop: async () => {
      calls.push('stop');
    },
    cast: async (device, stream) => {
      calls.push(`cast:${device.id}`);
      pushed.push({ id: device.id, url: stream.url, title: stream.title });
      return { deviceId: device.id, deviceName: device.name, state: 'playing' };
    },
    control: async (device, action) => {
      calls.push(`control:${action}`);
      return { deviceId: device.id, deviceName: device.name, state: action === 'pause' ? 'paused' : 'playing' };
    }
  };
  const timers = fakeTimer();
  const duration = options.durationSeconds === null ? undefined : (options.durationSeconds ?? 100);
  const stream: CastStreamSource = async (episodeId) => ({
    url: `${PROXY}&ep=${episodeId}`,
    mimeType: 'application/vnd.apple.mpegurl',
    durationSeconds: duration
  });
  const state = { current: 11 };
  const root = document.createElement('div');
  document.body.append(root);
  const island = document.createElement('div');
  root.append(island);
  const panel = createCastPanel({
    root,
    episodes: detailOf().episodes,
    titleOf: () => '测试剧',
    currentEpisodeId: () => state.current,
    isPrivate: options.isPrivate ?? (() => false),
    client,
    stream,
    timers
  });
  panel.attach(island);
  panels.push(panel);
  const node = (selector: string): HTMLElement => {
    const found = root.querySelector(selector);
    if (found === null) throw new Error(`找不到 ${selector}`);
    return found as HTMLElement;
  };
  return {
    panel,
    root,
    calls,
    pushed,
    timers,
    node,
    text: (selector: string) => node(selector).textContent ?? '',
    setCurrent: (id: number) => {
      state.current = id;
    },
    status: () => node('.prism-cast__status').textContent ?? '',
    sheet: () => node('.prism-cast'),
    banner: () => node('.prism-cast-banner')
  };
}

/** 走完"扫描 → 列出设备 → 点第一台"的真实动线，而不许直接扳状态。 */
export const pick = async (h: ReturnType<typeof harness>): Promise<void> => {
  h.panel.open();
  await settle();
  h.node('.prism-cast__device').click();
  await settle();
};

afterEach(() => {
  for (const panel of panels.splice(0)) panel.destroy();
  document.body.replaceChildren();
});
