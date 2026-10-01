/**
 * The single native bridge contract shared by the TypeScript app and the Android plugin.
 *
 * Both sides must use these names verbatim: `PrismNative` with the methods below. The Android side is
 * written in Stage 3 and can only be proven on a device; on the web the same interface is answered by
 * an explicit software fallback so no feature silently pretends to be native.
 */

export const PRISM_NATIVE_PLUGIN = 'PrismNative';

export type CallState = 'idle' | 'ringing' | 'offhook';

export interface BrightnessResult {
  /** 0..1 window brightness actually applied, or the value the platform refused to go below. */
  brightness: number;
  supported: boolean;
}

export interface VolumeResult {
  volume: number;
  supported: boolean;
}

export interface PrismNativeBridge {
  /** Domain 1: hardware-backed credential store. Rejects writes that are not credential-shaped. */
  secureRead(key: string): Promise<string | null>;
  secureWrite(key: string, value: string): Promise<void>;
  secureClear(key: string): Promise<void>;
  /** False on the web, where there is no Keystore: the caller must then say so, not pretend. */
  isKeystoreBacked(): Promise<boolean>;

  /** AC-07: window brightness (not the player's own gain). */
  getBrightness(): Promise<BrightnessResult>;
  setBrightness(value: number): Promise<BrightnessResult>;
  /** AC-06: system audio stream volume. Web can only drive the element's own volume. */
  getSystemVolume(): Promise<VolumeResult>;
  setSystemVolume(value: number): Promise<VolumeResult>;

  /** AC-02-4: dynamic FLAG_SECURE while 个人探索 is on screen; off on leaving. */
  setSecureScreen(enabled: boolean): Promise<boolean>;
  /** AC-10: foreground service that keeps audio alive with the screen off. */
  setKeepScreenOn(enabled: boolean): Promise<void>;
  startBackgroundAudio(title: string, episodeLabel: string): Promise<void>;
  stopBackgroundAudio(): Promise<void>;

  /** OTA install hand-off; only a published, verified artifact is offered. */
  openExternalUrl(url: string): Promise<void>;

  /** AC-11: the app subscribes once and maps the state onto pause/resume. */
  onCallState(listener: (state: CallState) => void): () => void;
}

export type BridgeSource = 'native' | 'web-fallback';

let installed: PrismNativeBridge | null = null;
let installedSource: BridgeSource = 'web-fallback';

/**
 * Web fallback. Brightness is a compositor overlay because a browser cannot touch the panel; volume
 * reports `supported: false` rather than lying about the system stream (SPEC AC-06 explicitly scopes
 * the web build to player volume only, and AC-02-4 is Android-only).
 */
export function createWebFallbackBridge(): PrismNativeBridge {
  let dimming = 0;
  const applyDim = (): void => {
    document.documentElement.style.setProperty('--native-dim', String(dimming));
  };
  return {
    secureRead: async (key) => window.localStorage.getItem(`prism.insecure.${key}`),
    secureWrite: async (key, value) => void window.localStorage.setItem(`prism.insecure.${key}`, value),
    secureClear: async (key) => void window.localStorage.removeItem(`prism.insecure.${key}`),
    isKeystoreBacked: async () => false,
    getBrightness: async () => ({ brightness: 1 - dimming, supported: false }),
    setBrightness: async (value) => {
      dimming = Math.min(1, Math.max(0, 1 - value));
      applyDim();
      return { brightness: 1 - dimming, supported: false };
    },
    getSystemVolume: async () => ({ volume: 1, supported: false }),
    setSystemVolume: async () => ({ volume: 1, supported: false }),
    setSecureScreen: async () => false,
    setKeepScreenOn: async () => undefined,
    startBackgroundAudio: async () => undefined,
    stopBackgroundAudio: async () => undefined,
    openExternalUrl: async (url) => void window.open(url, '_blank', 'noopener,noreferrer'),
    onCallState: () => () => undefined
  };
}

export function installNativeBridge(bridge: PrismNativeBridge, source: BridgeSource): void {
  installed = bridge;
  installedSource = source;
}

export function getBridge(): PrismNativeBridge {
  return installed ?? createWebFallbackBridge();
}

export function bridgeSource(): BridgeSource {
  return installed === null ? 'web-fallback' : installedSource;
}

/** True only when a real plugin answered; drives every "本功能需 Android 真机" notice. */
export async function isNativeCapabilityAvailable(): Promise<boolean> {
  if (installedSource !== 'native' || installed === null) return false;
  return await installed.isKeystoreBacked();
}
