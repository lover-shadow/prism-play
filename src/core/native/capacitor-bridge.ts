import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import {
  createWebFallbackBridge,
  installNativeBridge,
  type BrightnessResult,
  type CallState,
  type PrismNativeBridge,
  type VolumeResult
} from './bridge';

/**
 * Adapter from the position-based `PrismNativeBridge` interface onto the Capacitor plugin.
 *
 * Capacitor's `PluginCall` accepts one argument object and resolves one object, so the native side
 * cannot return a bare `string` or `boolean`. Every unwrap below exists because of that platform
 * shape, not because the plugin chose it; the plugin's option and payload keys are listed in the
 * Android delivery report and must stay byte-identical with the names used here.
 */
interface PrismNativePlugin {
  secureRead(args: { key: string }): Promise<{ value: string | null }>;
  secureWrite(args: { key: string; value: string }): Promise<void>;
  secureClear(args: { key: string }): Promise<void>;
  isKeystoreBacked(): Promise<{ value: boolean }>;
  getBrightness(): Promise<BrightnessResult>;
  setBrightness(args: { value: number }): Promise<BrightnessResult>;
  getSystemVolume(): Promise<VolumeResult>;
  setSystemVolume(args: { value: number }): Promise<VolumeResult>;
  setSecureScreen(args: { enabled: boolean }): Promise<{ value: boolean }>;
  setKeepScreenOn(args: { enabled: boolean }): Promise<void>;
  startBackgroundAudio(args: { title: string; episodeLabel: string }): Promise<void>;
  stopBackgroundAudio(): Promise<void>;
  openExternalUrl(args: { url: string }): Promise<void>;
  addListener(eventName: string, listener: (event: { state: CallState }) => void): Promise<PluginListenerHandle>;
}

const PLUGIN_ID = 'PrismNative';

/**
 * Domain 1 accepts only these two keys. A private-session credential must never reach the Keystore
 * store: AC-02 forbids persisting the opt-in, so the refusal belongs on this side too rather than
 * relying on the plugin to catch it.
 */
const CREDENTIAL_KEYS = ['jwt', 'deviceId'] as const;
export type CredentialKey = (typeof CREDENTIAL_KEYS)[number];

export function isCredentialKey(value: string): value is CredentialKey {
  return (CREDENTIAL_KEYS as readonly string[]).includes(value);
}

export function credentialKeyOrThrow(key: string): CredentialKey {
  if (!isCredentialKey(key)) {
    throw new Error(`凭证域仅接受 ${CREDENTIAL_KEYS.join('/')} 键名，收到不合法的存储键`);
  }
  return key;
}

const plugin = registerPlugin<PrismNativePlugin>(PLUGIN_ID);

export function createCapacitorBridge(): PrismNativeBridge {
  return {
    async secureRead(key) {
      const response = await plugin.secureRead({ key: credentialKeyOrThrow(key) });
      return response.value ?? null;
    },
    secureWrite: async (key, value) => {
      await plugin.secureWrite({ key: credentialKeyOrThrow(key), value });
    },
    secureClear: async (key) => {
      await plugin.secureClear({ key: credentialKeyOrThrow(key) });
    },
    isKeystoreBacked: async () => (await plugin.isKeystoreBacked()).value === true,
    getBrightness: () => plugin.getBrightness(),
    setBrightness: async (value) => await plugin.setBrightness({ value }),
    getSystemVolume: () => plugin.getSystemVolume(),
    setSystemVolume: async (value) => await plugin.setSystemVolume({ value }),
    setSecureScreen: async (enabled) => (await plugin.setSecureScreen({ enabled })).value === true,
    setKeepScreenOn: async (enabled) => {
      await plugin.setKeepScreenOn({ enabled });
    },
    startBackgroundAudio: async (title, episodeLabel) => {
      await plugin.startBackgroundAudio({ title, episodeLabel });
    },
    stopBackgroundAudio: async () => {
      await plugin.stopBackgroundAudio();
    },
    openExternalUrl: async (url) => {
      await plugin.openExternalUrl({ url });
    },
    onCallState(listener) {
      let handle: PluginListenerHandle | null = null;
      let closed = false;
      void plugin.addListener('callState', (event) => {
        if (!closed) listener(event.state);
      }).then((added) => {
        handle = added;
        if (closed) void added.remove();
      });
      return () => {
        closed = true;
        if (handle !== null) void handle.remove();
      };
    }
  };
}

/** The host may inject its own implementation (tests, future bridges); everything else keys off the platform. */
export function installBridgeForPlatform(host: PrismNativeBridge | null = null): 'native' | 'web-fallback' {
  if (host !== null) {
    installNativeBridge(host, 'native');
    return 'native';
  }
  if (Capacitor.isNativePlatform() && Capacitor.isPluginAvailable(PLUGIN_ID)) {
    installNativeBridge(createCapacitorBridge(), 'native');
    return 'native';
  }
  installNativeBridge(createWebFallbackBridge(), 'web-fallback');
  return 'web-fallback';
}

/**
 * Notification actions are dispatched by the native service into this global because the shade has no
 * other route into the WebView. Kept as an explicitly named, narrow hook so `main.ts` can wire it and
 * a missing wiring is visible rather than silently inert.
 */
export type NotificationAction = 'toggle' | 'next' | 'previous' | 'focus-lost' | 'focus-regained';

declare global {
  interface Window {
    PrismNativeMedia?: { onNotificationAction: (action: string) => void };
  }
}

export function bindNotificationActions(handler: (action: NotificationAction) => void): () => void {
  const previous = window.PrismNativeMedia;
  window.PrismNativeMedia = {
    onNotificationAction: (action) => {
      if (action === 'toggle' || action === 'next' || action === 'previous' || action === 'focus-lost' || action === 'focus-regained') {
        handler(action);
      }
    }
  };
  return () => {
    window.PrismNativeMedia = previous;
  };
}
