// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createSettingsView, ERROR_COPY, SETTINGS_PREF_KEYS, formatExpiry,
  type RedeemOutcome, type SettingsApi, type SettingsViewDeps, type VolatileTokens
} from '../../src/views/settings-view';
import { ApiError } from '../../src/core/api/client';
import type { AndroidRelease, DeviceTier, ErrorCode, MonetizationConfig, NudgePolicy, PrivateEligibleTier, RedeemRequest, RedeemSuccessResponse } from '../../edge/src/types/api';
import { ERROR_CODES } from '../../edge/src/types/api';
import type { BridgeSource, PrismNativeBridge } from '../../src/core/native/bridge';
import type { PreferenceStore } from '../../src/core/state/theme';

const NOW = 1_780_000_000;
const LEAKY_MESSAGE = '该卡密已绑定 11/10 台设备，被拒设备 21 台';
const NUDGE: NudgePolicy = { freeTrialSeconds: 54000, stage1UntilSeconds: 72000, stage2UntilSeconds: 90000, stage1IntervalSeconds: 3600, stage2IntervalSeconds: 2700, stage3IntervalSeconds: 1800, dialogTitle: '继续看？', dialogBody: '下载解锁' };
const RELEASE: AndroidRelease = { versionCode: 200, versionName: '2.0.0', changelog: '新增追剧断点与词法搜索', downloadUrl: '/dl/latest/android' };
const GRANTED: RedeemSuccessResponse = { success: true, tier: 'B', tierName: '高级全源卡', expiresAt: NOW + 14 * 86400, token: 'jwt-Ed25519', message: '核销成功' };

interface Options {
  tiers?: PrivateEligibleTier[]; monetizationError?: unknown; tier?: DeviceTier | null; deviceId?: string | null;
  redeemError?: unknown; release?: AndroidRelease; versionError?: unknown; openError?: unknown; closeError?: unknown;
  expiresInSeconds?: number; bridgeSourceOf?: BridgeSource; prefs?: Record<string, string>; seededToken?: string | null;
}

function setup(options: Options = {}) {
  let held = options.seededToken ?? null;
  const calls = { monetization: 0, channels: 0, version: 0, redeem: [] as RedeemRequest[], open: 0, close: 0, secure: [] as boolean[], keepScreen: [] as boolean[], external: [] as string[] };
  const tokens: VolatileTokens = { read: () => held, write: (token) => { held = token; } };
  const prefs: PreferenceStore & { values: Record<string, string> } = {
    values: { 'prism.theme': 'dark', ...options.prefs },
    get: async (key) => prefs.values[key] ?? null,
    set: async (key, value) => { prefs.values[key] = value; }
  };
  const api = {
    monetization: async (): Promise<MonetizationConfig> => {
      calls.monetization += 1;
      if (options.monetizationError !== undefined) throw options.monetizationError;
      const tiers = 'tiers' in options ? options.tiers : (['B', 'Y', 'S'] as PrivateEligibleTier[]);
      return tiers === undefined ? { activeTiers: [], nudgePolicy: NUDGE } : { activeTiers: [], nudgePolicy: NUDGE, privateAccessTiers: tiers };
    },
    version: async () => { calls.version += 1; if (options.versionError !== undefined) throw options.versionError; return { android: options.release ?? RELEASE }; },
    redeem: async (body: RedeemRequest) => { calls.redeem.push(body); if (options.redeemError !== undefined) throw options.redeemError; return GRANTED; },
    openPrivateSession: async () => { calls.open += 1; if (options.openError !== undefined) throw options.openError; held = 'session-token-live'; return options.expiresInSeconds ?? 900; },
    closePrivateSession: async () => { calls.close += 1; if (options.closeError !== undefined) throw options.closeError; held = null; },
    channels: async () => { calls.channels += 1; throw new Error('个人探索资格绝不从 /api/channels 推断'); }
  } as unknown as SettingsApi;
  const bridge = {
    setKeepScreenOn: async (enabled: boolean) => { calls.keepScreen.push(enabled); },
    setSecureScreen: async (enabled: boolean) => { calls.secure.push(enabled); return (options.bridgeSourceOf ?? 'native') === 'native'; },
    openExternalUrl: async (url: string) => { calls.external.push(url); }
  } as unknown as PrismNativeBridge;
  const themeEvents: string[] = [];
  const privateEvents: boolean[] = [];
  const redeemEvents: RedeemOutcome[] = [];
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const deps: SettingsViewDeps = {
    api, prefs, bridge, tokens, root, now: () => NOW,
    onThemeChange: (mode) => void themeEvents.push(mode), onOpenRedeem: (outcome) => void redeemEvents.push(outcome),
    onPrivateSessionChange: (active) => void privateEvents.push(active),
    deviceIdSource: options.deviceId === null ? undefined : { currentDeviceId: async () => options.deviceId ?? 'GY-DEVICE-0001' },
    bridgeSourceOf: () => options.bridgeSourceOf ?? 'native'
  };
  if (options.tier !== null) deps.tierSource = { currentTier: async () => options.tier ?? 'B' };
  const view = createSettingsView(deps);
  return { view, root, calls, tokens, prefs, themeEvents, privateEvents, redeemEvents, readToken: () => held };
}
const pick = (root: HTMLElement, el: string): HTMLElement | null => root.querySelector(`[data-el="${el}"]`);
const stateOf = (root: HTMLElement, el: string): string | undefined => pick(root, el)?.getAttribute('data-state') ?? undefined;
const click = (node: Element | null): void => { (node as HTMLElement).click(); };
const tick = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)); };
const switchOn = (root: HTMLElement, el: string): boolean => pick(root, el)?.getAttribute('aria-checked') === 'true';
const inputOf = (root: HTMLElement, el: string): HTMLInputElement => pick(root, el) as HTMLInputElement;
/** 走完「点开关 → 免责确认」全流程；会话是否真开起来由各自的断言决定。 */
const acceptDisclaimer = async (root: HTMLElement): Promise<void> => { click(pick(root, 'private-switch')); click(pick(root, 'disclaimer-accept')); await tick(); };

describe('设置中心：主题与播放偏好（AC-05 / AC-10 / AC-11）', () => {
  beforeEach(() => { document.body.replaceChildren(); window.localStorage.clear(); });

  it('日夜切换即时生效、写入偏好并回调宿主', async () => {
    const { view, root, prefs, themeEvents } = setup();
    await view.mount();
    expect(switchOn(root, 'theme-toggle')).toBe(false);
    click(pick(root, 'theme-toggle'));
    await tick();
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(prefs.values['prism.theme']).toBe('light');
    expect(themeEvents).toEqual(['light']);
    expect(switchOn(root, 'theme-toggle')).toBe(true);
    expect(pick(root, 'set-appearance')?.textContent).toContain('象牙纯白');
    expect(stateOf(root, 'set-appearance')).toBe('ready');
    const broken = setup();
    broken.prefs.get = async () => { throw new Error('偏好通道断开'); };
    await broken.view.reload();
    expect(stateOf(broken.root, 'set-appearance')).toBe('error');
    expect(broken.root.dataset.state).toBe('error');
  });

  it('后台/息屏开关调用 setKeepScreenOn，Web 宿主如实标注不生效', async () => {
    const web = setup({ bridgeSourceOf: 'web-fallback' });
    await web.view.mount();
    expect(web.root.textContent).toContain('Web 宿主');
    click(pick(web.root, 'keep-screen-on'));
    await tick();
    expect(web.calls.keepScreen).toEqual([true]);
    expect(web.prefs.values[SETTINGS_PREF_KEYS.keepScreenOn]).toBe('1');
    expect(pick(web.root, 'set-playback')?.textContent).toContain('真机');
    const native = setup();
    await native.view.mount();
    expect(native.root.textContent).not.toContain('当前为 Web 宿主');
  });

  it('来电自动暂停写入偏好并说明恢复前置条件', async () => {
    const { view, root, prefs } = setup({ prefs: { [SETTINGS_PREF_KEYS.callAutoPause]: '1' } });
    await view.mount();
    expect(switchOn(root, 'call-auto-pause')).toBe(true);
    click(pick(root, 'call-auto-pause'));
    await tick();
    expect(prefs.values[SETTINGS_PREF_KEYS.callAutoPause]).toBe('0');
    expect(pick(root, 'set-playback')?.textContent).toContain('音频焦点');
  });
});

describe('设置中心：个人探索双重准入（AC-02 全六条）', () => {
  beforeEach(() => { document.body.replaceChildren(); window.localStorage.clear(); });

  it('档位命中云端集合才出现开关；集合改判时开关随之出现或消失（AC-02-1）', async () => {
    const hit = setup({ tiers: ['B', 'Y', 'S'], tier: 'B' });
    await hit.view.mount();
    expect(pick(hit.root, 'private-switch')).not.toBeNull();
    expect(hit.calls.channels).toBe(0);
    const miss = setup({ tiers: ['Y', 'S'], tier: 'B' });
    await miss.view.mount();
    expect(pick(miss.root, 'private-switch')).toBeNull();
    expect(pick(miss.root, 'set-private')).toBeNull();
  });

  it('monetization 失败、缺字段、空集合或无档位来源时开关不存在而不是禁用', async () => {
    for (const options of [{ monetizationError: new ApiError('SERVICE_UNAVAILABLE', 503, '缺配置') }, { tiers: undefined }, { tiers: [] }, { tier: null }]) {
      const { view, root } = setup({ tier: 'B', ...options });
      await view.mount();
      expect(pick(root, 'set-private')).toBeNull();
      expect(pick(root, 'private-switch')).toBeNull();
    }
  });

  it('构造即关：holder 里预置的遗留 token 被清掉，界面不从存量状态点亮（AC-02-2）', async () => {
    const { view, root, readToken, prefs } = setup({ seededToken: 'stale-session-token' });
    await view.mount();
    expect(switchOn(root, 'private-switch')).toBe(false);
    expect(readToken()).toBeNull();
    expect(window.localStorage.length).toBe(0);
    expect(Object.keys(prefs.values).some((key) => /private|session/i.test(key))).toBe(false);
  });

  it('点击先弹阻断式免责：拒绝则不发会话请求，确认才申请当次授权', async () => {
    const { view, root, calls, readToken, privateEvents } = setup();
    await view.mount();
    click(pick(root, 'private-switch'));
    expect(pick(root, 'private-disclaimer')?.getAttribute('aria-modal')).toBe('true');
    expect(calls.open).toBe(0);
    expect(pick(root, 'private-disclaimer')?.textContent).toContain('成人内容');
    expect(pick(root, 'private-disclaimer')?.textContent).toContain('服务端只能证明');
    expect(pick(root, 'private-disclaimer')?.textContent).toContain('无法验证');
    click(pick(root, 'disclaimer-decline'));
    await tick();
    expect(calls.open).toBe(0);
    expect(switchOn(root, 'private-switch')).toBe(false);
    await acceptDisclaimer(root);
    expect(calls.open).toBe(1);
    expect(switchOn(root, 'private-switch')).toBe(true);
    expect(readToken()).toBe('session-token-live');
    expect(calls.secure).toEqual([true]);
    expect(privateEvents).toEqual([true]);
    expect(pick(root, 'set-private')?.textContent).toContain('15 分钟');
    expect(root.querySelectorAll('a[href], [data-el*="share"], [data-el*="export"]').length).toBe(0);
    expect([...root.querySelectorAll('button')].some((node) => /分享|导出|复制链接/.test(node.textContent ?? ''))).toBe(false);
  });

  it('对话框可被 Escape 与点击遮罩关闭', async () => {
    const { view, root, calls } = setup();
    await view.mount();
    click(pick(root, 'private-switch'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(pick(root, 'private-disclaimer')).toBeNull();
    click(pick(root, 'private-switch'));
    (pick(root, 'private-disclaimer')?.parentElement as HTMLElement).click();
    expect(pick(root, 'private-disclaimer')).toBeNull();
    expect(calls.open).toBe(0);
  });

  it('关闭时解除 FLAG_SECURE；关闭失败也立即清除本机凭据（AC-02-4）', async () => {
    const { view, root, calls, readToken, privateEvents } = setup({ closeError: new ApiError('NETWORK_ERROR', 0, '网络不可用') });
    await view.mount();
    await acceptDisclaimer(root);
    click(pick(root, 'private-switch'));
    await tick();
    expect(calls.secure).toEqual([true, false]);
    expect(readToken()).toBeNull();
    expect(switchOn(root, 'private-switch')).toBe(false);
    expect(pick(root, 'set-private')?.textContent).toContain('本机凭据已立即清除');
    expect(privateEvents).toEqual([true, false]);
  });

  it('destroy 一律解除 FLAG_SECURE，并在会话仍开启时撤回凭据', async () => {
    const live = setup();
    await live.view.mount();
    await acceptDisclaimer(live.root);
    live.view.destroy();
    expect(live.calls.secure).toEqual([true, false]);
    expect(live.readToken()).toBeNull();
    expect(live.calls.close).toBe(1);
    expect(live.privateEvents).toEqual([true, false]);
    const cold = setup(); await cold.view.mount(); cold.view.destroy();
    expect(cold.calls.secure).toEqual([false]);
    expect(cold.calls.close).toBe(0);
  });

  it('会话申请被拒时开关保持关闭、不落任何凭据并给出该档专属文案', async () => {
    const { view, root, calls, readToken } = setup({ openError: new ApiError('TIER_INSUFFICIENT', 403, '档位不足') });
    await view.mount();
    await acceptDisclaimer(root);
    expect(switchOn(root, 'private-switch')).toBe(false);
    expect(readToken()).toBeNull();
    expect(calls.secure).toEqual([]);
    expect(pick(root, 'set-private')?.textContent).toContain('不在云端开放的准入档位内');
  });
});

describe('设置中心：卡密核销与 OTA（AC-14 / AC-15）', () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it('核销成功只提交 android，展示人类可读到期时间并把 JWT 交给宿主', async () => {
    const { view, root, calls, redeemEvents } = setup();
    await view.mount();
    inputOf(root, 'redeem-code').value = ' GY-B90D-A7F2-8899 ';
    click(pick(root, 'redeem-submit'));
    await tick();
    expect(calls.redeem).toEqual([{ code: 'GY-B90D-A7F2-8899', deviceId: 'GY-DEVICE-0001', platform: 'android' }]);
    expect(pick(root, 'set-redeem')?.textContent).toContain('高级全源卡');
    expect(stateOf(root, 'set-redeem')).toBe('ready');
    expect(redeemEvents[0]).toEqual({ tier: 'B', tierName: '高级全源卡', expiresAt: GRANTED.expiresAt, token: 'jwt-Ed25519' });
    expect(formatExpiry(-1, NOW)).toBe('永久有效');
    expect(formatExpiry(NOW + 86400, NOW)).toContain('剩余 1 天');
  });

  it('闭集错误码逐条各有文案，且不外泄卡密计数与服务端原文', async () => {
    const keys: string[] = Object.keys(ERROR_COPY);
    for (const code of [...ERROR_CODES, 'NETWORK_ERROR', 'UNEXPECTED_RESPONSE']) expect(keys).toContain(code);
    expect(new Set(Object.values(ERROR_COPY)).size).toBe(keys.length);
    for (const code of ERROR_CODES) {
      const { view, root } = setup({ redeemError: new ApiError(code as ErrorCode, 400, LEAKY_MESSAGE) });
      await view.mount();
      inputOf(root, 'redeem-code').value = 'GY-Q90D-A7F2-8899';
      click(pick(root, 'redeem-submit'));
      await tick();
      const band = pick(root, 'set-redeem') as HTMLElement;
      expect(band.getAttribute('data-state')).toBe('error');
      expect(band.textContent).toContain(ERROR_COPY[code as ErrorCode]);
      expect(band.textContent).not.toContain('11/10');
      expect(band.textContent).not.toContain('21 台');
    }
  });

  it('没有设备标识时核销分区进入禁用，且绝不提交请求', async () => {
    const { view, root, calls } = setup({ deviceId: null });
    await view.mount();
    expect(stateOf(root, 'set-redeem')).toBe('disabled');
    inputOf(root, 'redeem-code').value = 'GY-Q90D-A7F2-8899';
    click(pick(root, 'redeem-submit'));
    await tick();
    expect(calls.redeem).toEqual([]);
  });

  it('OTA 先空态，检测后给版本号与日志，只给 Android 下载且不渲染任何链接', async () => {
    const { view, root, calls } = setup({ release: { ...RELEASE, force: true } });
    await view.mount();
    expect(stateOf(root, 'set-ota')).toBe('empty');
    click(pick(root, 'ota-check'));
    await tick();
    expect(calls.version).toBe(1);
    expect(pick(root, 'ota-result')?.textContent).toContain('2.0.0');
    expect(pick(root, 'ota-result')?.textContent).toContain('强制更新');
    expect(root.textContent).toContain('更新日志');
    click(pick(root, 'ota-download'));
    await tick();
    expect(calls.external).toEqual(['/dl/latest/android']);
    expect(root.querySelectorAll('a[href]').length).toBe(0);
    const targets = [...root.querySelectorAll('button')].filter((node) => (node.textContent ?? '').includes('下载')).map((node) => node.closest('[data-download-url]')?.getAttribute('data-download-url'));
    expect(targets).toEqual(['/dl/latest/android']);
    expect(root.innerHTML).not.toMatch(/\/dl\/latest\/(pc|windows|mac|exe)/i);
    const failed = setup({ versionError: new ApiError('NETWORK_ERROR', 0, '网络不可用') });
    await failed.view.mount();
    click(pick(failed.root, 'ota-check'));
    await tick();
    expect(stateOf(failed.root, 'set-ota')).toBe('error');
    expect(failed.root.textContent).toContain('需联网');
  });
});
