// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { bindNotificationActions, credentialKeyOrThrow, installBridgeForPlatform, isCredentialKey } from '../../src/core/native/capacitor-bridge';
import { bridgeSource, getBridge } from '../../src/core/native/bridge';
import { installNativeBridge, createWebFallbackBridge } from '../../src/core/native/bridge';

describe('credential domain key allowlist (AC-02 never persists the opt-in)', () => {
  it('accepts only the two credential keys and refuses session-shaped keys', () => {
    expect(isCredentialKey('jwt')).toBe(true);
    expect(isCredentialKey('deviceId')).toBe(true);
    expect(isCredentialKey('privateSession')).toBe(false);
    expect(isCredentialKey('X-Private-Session')).toBe(false);
    expect(() => credentialKeyOrThrow('sessionToken')).toThrow();
    expect(credentialKeyOrThrow('jwt')).toBe('jwt');
  });
});

describe('bridge installation', () => {
  afterEach(() => {
    installNativeBridge(createWebFallbackBridge(), 'web-fallback');
  });

  it('falls back to the web bridge in a browser and reports that honestly', async () => {
    expect(installBridgeForPlatform()).toBe('web-fallback');
    expect(bridgeSource()).toBe('web-fallback');
    const volume = await getBridge().getSystemVolume();
    expect(volume.supported).toBe(false);
    expect(await getBridge().isKeystoreBacked()).toBe(false);
    expect(await getBridge().setSecureScreen(true)).toBe(false);
  });

  it('adopts a host-supplied implementation as native', async () => {
    const calls: string[] = [];
    const installed = installBridgeForPlatform({
      ...createWebFallbackBridge(),
      isKeystoreBacked: async () => true,
      secureWrite: async (key) => {
        calls.push(key);
      }
    });
    expect(installed).toBe('native');
    expect(await getBridge().isKeystoreBacked()).toBe(true);
    await getBridge().secureWrite('deviceId', 'GY-800DF614');
    expect(calls).toEqual(['deviceId']);
  });
});

describe('notification action hook', () => {
  it('forwards only the actions the service actually declares, and restores the window', () => {
    const seen: string[] = [];
    const release = bindNotificationActions((action) => void seen.push(action));
    window.PrismNativeMedia?.onNotificationAction('toggle');
    window.PrismNativeMedia?.onNotificationAction('focus-regained');
    window.PrismNativeMedia?.onNotificationAction('stop');
    expect(seen).toEqual(['toggle', 'focus-regained']);
    release();
    expect(window.PrismNativeMedia).toBeUndefined();
  });
});
