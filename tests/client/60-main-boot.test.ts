// @vitest-environment jsdom
/**
 * 组合根集成测试（AC-01 / AC-02-3 / AC-15 / AC-18 的 Web 宿主面）。
 *
 * 这一层专门证"能力缺席时必须如实退化"：jsdom 里没有端侧 SQLite、没有 Keystore、没有内置验签公钥，
 * 所以【追剧】必须落 disabled 而不是空历史，【个人探索】开关必须不出现而不是灰着，
 * 断网必须退回离线态而不是伪造目录。任何"看起来更友好"的兜底都在这里被证伪。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boot } from '../../src/main';
import type { PrismApp } from '../../src/main';
import type { PrismNativeBridge } from '../../src/core/native/bridge';

const CHANNELS = {
  version: 7,
  channels: [
    { id: 'drama', name: '短剧精选', order: 1, requiresTier: [], categories: ['都市', '古装'] },
    { id: 'movie', name: '院线电影', order: 2, requiresTier: [], categories: ['动作'] },
    { id: 'anime', name: '热血动漫', order: 3, requiresTier: [], categories: [] },
    { id: 'documentary', name: '人文纪录', order: 4, requiresTier: [], categories: [] }
  ]
};
const NUDGE = { freeTrialSeconds: 54000, stage1UntilSeconds: 72000, stage2UntilSeconds: 90000, stage1IntervalSeconds: 3600, stage2IntervalSeconds: 2700, stage3IntervalSeconds: 1800, dialogTitle: '继续看？', dialogBody: '下载解锁' };
/** 频道拓扑可按用例替换（AC-02-4 要模拟"已获双重准入"的下发结果），默认是四公开频道。 */
let CHANNEL_OVERRIDE: unknown = CHANNELS;

const item = (over: Record<string, unknown> = {}) => ({
  id: 'a', channelId: 'drama', title: '凤逆天下', category: '都市', isPrivate: false, shareable: true, ...over
});

function route(path: string, search: URLSearchParams): unknown {
  if (path === '/api/channels') return CHANNEL_OVERRIDE;
  if (path === '/api/config/monetization') return { activeTiers: [], nudgePolicy: NUDGE, privateAccessTiers: ['B', 'Y', 'S'] };
  if (path === '/api/version') return { android: { versionCode: 200, versionName: '2.0.0', changelog: '断点续播', downloadUrl: '/dl/latest/android' } };
  const channel = search.get('channel') ?? 'drama';
  return { items: [item({ id: `${channel}_a`, channelId: channel, isPrivate: channel === 'private' })], page: Number(search.get('page') ?? '1'), pageSize: 24, total: 1, revision: 41 };
}

interface Probe { authorization?: string | null; requests: string[] }

function server(probe: Probe, options: { offline?: boolean; catalogItems?: unknown[] } = {}) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url, 'https://play.prismos.org');
    probe.requests.push(`${parsed.pathname}${parsed.search}`);
    probe.authorization = new Headers(init?.headers).get('authorization');
    if (options.offline === true) throw new TypeError('fetch failed');
    const body = parsed.pathname === '/api/catalog' && options.catalogItems !== undefined
      ? { items: options.catalogItems, page: 1, pageSize: 24, total: options.catalogItems.length, revision: 41 }
      : route(parsed.pathname, parsed.searchParams);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

function mountDom(): void {
  document.body.innerHTML =
    '<div id="app" class="app-shell"><header id="app-header"></header><main id="app-main" tabindex="-1"></main><nav id="app-tabbar"></nav></div>';
}

async function start(options: { offline?: boolean; catalogItems?: unknown[]; bridge?: PrismNativeBridge | null; channels?: unknown } = {}): Promise<{ app: PrismApp | null; probe: Probe }> {
  mountDom();
  const probe: Probe = { requests: [] };
  // JSON 客户端与整包下载是独立通道；此套件验证无 seed / 未部署整包时的网络启动。
  vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
  if (options.channels !== undefined) CHANNEL_OVERRIDE = options.channels;
  const app = await boot({
    apiBaseUrl: 'https://play.prismos.org',
    fetchImpl: server(probe, options),
    nowSeconds: () => 1_780_000_000,
    ...( 'bridge' in options ? { bridge: options.bridge } : {})
  });
  return { app, probe };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

const query = <T extends Element>(selector: string): T | null => document.querySelector<T>(selector);

describe('组合根：Web 宿主启动', () => {
  afterEach(() => vi.unstubAllGlobals());
  beforeEach(() => {
    document.body.replaceChildren();
    window.localStorage.clear();
    delete window.PrismNativeMedia;
    CHANNEL_OVERRIDE = CHANNELS;
  });

  it('缺四个挂载点之一就拒绝启动，而不是抛错留白屏', async () => {
    document.body.innerHTML = '<div id="app"></div>';
    const probe: Probe = { requests: [] };
    expect(await boot({ fetchImpl: server(probe) })).toBeNull();
    expect(probe.requests).toEqual([]);
  });

  it('首屏装配三主 Tab 与云端下发的频道名，海报逐字采用响应内容', async () => {
    const { app } = await start();
    expect(app).not.toBeNull();
    expect(document.querySelectorAll('.app-tab')).toHaveLength(3);
    // 搜索降级为全屏 Overlay（A-3）：底栏不再有搜索键，入口改由首页搜索条承担。
    expect(document.querySelector('.app-tab[data-tab="search"]')).toBeNull();
    expect(document.querySelector('.home-search-bar')).not.toBeNull();
    expect([...document.querySelectorAll('.channel-tab')].map((node) => node.textContent))
      .toEqual(['短剧精选', '院线电影', '热血动漫', '人文纪录']);
    expect(query('.channel-tab[aria-current="true"]')?.getAttribute('data-channel-id')).toBe('drama');
    expect(document.body.textContent).toContain('凤逆天下');
    expect(query<HTMLElement>('.home-poster-grid')?.dataset.state).toBe('ready');
  });

  it('拉取过的端点只碰公开目录链路，且完成后落定一次在线校验时点', async () => {
    const { probe } = await start();
    expect(probe.requests.some((url) => url.startsWith('/api/channels'))).toBe(true);
    expect(probe.requests.some((url) => url.startsWith('/api/catalog'))).toBe(true);
    expect(window.localStorage.getItem('prism.lastOnlineCheck')).toBe('1780000000');
    expect(probe.requests.filter((url) => url.startsWith('/api/private'))).toHaveLength(0);
  });

  it('已存凭证随请求上行：Bearer 由凭证域读出，不经任何本地伪造', async () => {
    window.localStorage.setItem('prism.insecure.auth.jwt.ed25519', 'eyJhbGciOiJPdFAifQ.eyJzdWIiOiJHWS0xMTIyMzMzNCJ9.sig');
    const { probe } = await start();
    expect(probe.authorization).toBe('Bearer eyJhbGciOiJPdFAifQ.eyJzdWIiOiJHWS0xMTIyMzMzNCJ9.sig');
  });

  it('无端侧 SQLite 时【追剧】整视图 disabled，绝不渲染空历史冒充"你没看过"', async () => {
    const { app } = await start();
    await app?.shell.activate('history');
    const view = query<HTMLElement>('.app-view[data-tab="history"]');
    expect(view?.dataset.state).toBe('disabled');
    expect(document.body.textContent).toContain('本机历史库尚未就绪');
    const resume = query<HTMLElement>('[data-el="band-resume"]');
    expect(resume?.dataset.state).toBe('disabled');
    expect(resume?.querySelectorAll('.pv-row')).toHaveLength(0);
    expect(document.querySelectorAll('.pv-row[data-el="finished-row"]')).toHaveLength(0);
    // 缓存度量行属另一分区，与历史库可用性无关，必须照常可见（disabled 不是整页空白）。
    expect(query('[data-el="cache-metric"]')).not.toBeNull();
  });

  it('无内置验签公钥时【个人探索】开关不出现；档位判定 fail-closed', async () => {
    const { app } = await start();
    await app?.shell.activate('settings');
    expect(query('[data-el="private-switch"]')).toBeNull();
    expect(query('[data-el="set-private"]')).toBeNull();
  });

  it('未获双重准入的整个界面里没有私密频道字样，也没有私密 Tab', async () => {
    const { app } = await start();
    await app?.shell.activate('settings');
    expect(document.querySelectorAll('.app-tab[data-tab="private"]')).toHaveLength(0);
    expect(document.querySelector('.app-shell')?.textContent).not.toMatch(/个人探索|私密/);
  });

  it('断网退回离线态：目录不伪造、点播提示需联网、启动不崩', async () => {
    const { app } = await start({ offline: true });
    expect(app).not.toBeNull();
    expect(query<HTMLElement>('[data-state="offline"]')).not.toBeNull();
    expect(document.querySelector('.app-notice')?.textContent).toContain('需联网');
    expect(document.querySelectorAll('.poster-card')).toHaveLength(0);
  });

  it('私密条目混进公开目录响应时不落任何缓存域，界面也不显示它', async () => {
    const { app } = await start({ catalogItems: [item({ id: 'p', title: '不应出现', isPrivate: true, channelId: 'private' })] });
    expect(app).not.toBeNull();
    expect(document.body.textContent).not.toContain('不应出现');
    const dumped = Object.keys(window.localStorage).map((key) => window.localStorage.getItem(key)).join('|');
    expect(dumped).not.toContain('不应出现');
  });

  it('destroy 归还通知钩子并拆掉全部视图宿主与搜索 Overlay', async () => {
    const { app } = await start();
    expect(window.PrismNativeMedia).toBeDefined();
    // 点首页搜索条拉起全屏 Overlay（A-3），再整体拆除：Overlay 的节点与 handler 都必须跟着消失。
    document.querySelector<HTMLElement>('.home-search-bar')?.click();
    expect(document.querySelector('.app-overlay')).not.toBeNull();
    app?.destroy();
    expect(window.PrismNativeMedia).toBeUndefined();
    expect(document.querySelector('.app-overlay')).toBeNull();
    expect(document.querySelectorAll('.app-view')).toHaveLength(0);
    expect(document.querySelectorAll('.app-tab')).toHaveLength(0);
  });

  it('AC-02-4：切入【个人探索】频道即挂 FLAG_SECURE，切回公开频道即解除', async () => {
    const secure: boolean[] = [];
    const bridge = {
      secureRead: async () => null,
      secureWrite: async () => undefined,
      secureClear: async () => undefined,
      isKeystoreBacked: async () => true,
      getBrightness: async () => ({ brightness: 1, supported: true }),
      setBrightness: async (value: number) => ({ brightness: value, supported: true }),
      getSystemVolume: async () => ({ volume: 1, supported: true }),
      setSystemVolume: async (value: number) => ({ volume: value, supported: true }),
      setSecureScreen: async (enabled: boolean) => { secure.push(enabled); return true; },
      setKeepScreenOn: async () => undefined,
      startBackgroundAudio: async () => undefined,
      stopBackgroundAudio: async () => undefined,
      openExternalUrl: async () => undefined,
      onCallState: () => () => undefined
    } as unknown as PrismNativeBridge;
    const admitted = {
      version: 9,
      channels: [...CHANNELS.channels, { id: 'private', name: '个人探索', order: 5, requiresTier: ['B', 'Y', 'S'], categories: ['成人'] }]
    };
    const { app } = await start({ bridge, channels: admitted });
    expect(app).not.toBeNull();
    // 未获双重准入时私密节点根本不会出现在响应里；这里模拟"已获准"的下发结果。
    const privateTab = document.querySelector<HTMLButtonElement>('.channel-tab[data-channel-id="private"]');
    expect(privateTab).not.toBeNull();
    // 首屏落在公开频道：组合根主动要求"解除"，而不是留着上一次的挂载状态不管。
    expect(secure).toEqual([false]);

    privateTab?.click();
    await flush();
    expect(secure.at(-1)).toBe(true);
    expect(secure.filter((value) => value === true)).toEqual([true]);

    document.querySelector<HTMLButtonElement>('.channel-tab[data-channel-id="drama"]')?.click();
    await flush();
    expect(secure.at(-1)).toBe(false);
    expect(secure.filter((value) => value === true)).toEqual([true]);
  });
});
