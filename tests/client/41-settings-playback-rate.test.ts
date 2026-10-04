// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createSettingsView, type SettingsApi, type SettingsViewDeps, type VolatileTokens } from '../../src/views/settings-view';
import type { AndroidRelease, MonetizationConfig, NudgePolicy, RedeemRequest, RedeemSuccessResponse } from '../../edge/src/types/api';
import type { PrismNativeBridge } from '../../src/core/native/bridge';
import type { PreferenceStore } from '../../src/core/state/theme';

const NOW = 1_780_000_000;
const NUDGE: NudgePolicy = { freeTrialSeconds: 54000, stage1UntilSeconds: 72000, stage2UntilSeconds: 90000, stage1IntervalSeconds: 3600, stage2IntervalSeconds: 2700, stage3IntervalSeconds: 1800, dialogTitle: '继续看？', dialogBody: '下载解锁' };
const RELEASE: AndroidRelease = { versionCode: 200, versionName: '2.0.0', changelog: '新增追剧断点与词法搜索', downloadUrl: '/dl/latest/android' };
const GRANTED: RedeemSuccessResponse = { success: true, tier: 'B', tierName: '高级全源卡', expiresAt: NOW + 14 * 86400, token: 'jwt-Ed25519', message: '核销成功' };

interface Options {
  cache?: SettingsViewDeps['cache']; supportAssets?: SettingsViewDeps['supportAssets'];
}

function setup(options: Options = {}) {
  let held: string | null = null;
  const tokens: VolatileTokens = { read: () => held, write: (token) => { held = token; } };
  const prefs: PreferenceStore & { values: Record<string, string> } = {
    values: { 'prism.theme': 'dark' },
    get: async (key) => prefs.values[key] ?? null,
    set: async (key, value) => { prefs.values[key] = value; }
  };
  const api = {
    monetization: async (): Promise<MonetizationConfig> => ({ activeTiers: [], nudgePolicy: NUDGE, privateAccessTiers: ['B', 'Y', 'S'] }),
    version: async () => ({ android: RELEASE }),
    redeem: async (_body: RedeemRequest) => GRANTED,
    openPrivateSession: async () => { held = 'session-token-live'; return 900; },
    closePrivateSession: async () => { held = null; },
    channels: async () => { throw new Error('个人探索资格绝不从 /api/channels 推断'); }
  } as unknown as SettingsApi;
  const bridge = {
    setKeepScreenOn: async (_enabled: boolean) => undefined,
    setSecureScreen: async (_enabled: boolean) => true,
    openExternalUrl: async (_url: string) => undefined
  } as unknown as PrismNativeBridge;
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const view = createSettingsView({
    api, prefs, bridge, tokens, root, now: () => NOW, cache: options.cache, supportAssets: options.supportAssets,
    onThemeChange: () => undefined, onOpenRedeem: () => undefined, onPrivateSessionChange: () => undefined,
    deviceIdSource: { currentDeviceId: async () => 'GY-DEVICE-0001' },
    bridgeSourceOf: () => 'native', tierSource: { currentTier: async () => 'B' }
  });
  return { view, root };
}
const pick = (root: HTMLElement, el: string): HTMLElement | null => root.querySelector(`[data-el="${el}"]`);
const stateOf = (root: HTMLElement, el: string): string | undefined => pick(root, el)?.getAttribute('data-state') ?? undefined;
const click = (node: Element | null): void => { (node as HTMLElement).click(); };

describe('设置中心：播放倍率与支持资产', () => {
  beforeEach(() => { document.body.replaceChildren(); window.localStorage.clear(); });

  it('接入播放偏好、缓存端口和可选支持资产，销毁时关闭放大层', async () => {
    const { view, root } = setup({
      cache: { measure: async () => ({ usedBytes: 1024, limitBytes: 2048 }), clearPublicCache: async () => ({ clearedBytes: 1024, domains: ['public-cache'] }) },
      supportAssets: { contact: { url: '/images/author-contact.jpg' } }
    });
    await view.mount();
    expect((pick(root, 'hold-rate') as HTMLSelectElement).value).toBe('2');
    expect(pick(root, 'set-cache')?.textContent).toContain('1 KiB');
    click(pick(root, 'support-contact')); expect(root.querySelector('[role="dialog"]')).not.toBeNull();
    view.destroy(); expect(root.children).toHaveLength(0);
    const missing = setup(); await missing.view.mount();
    expect(pick(missing.root, 'set-support')).toBeNull();
    expect(stateOf(missing.root, 'set-cache')).toBe('disabled');
  });
});
