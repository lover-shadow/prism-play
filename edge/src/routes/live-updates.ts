/**
 * W9: Web Bundle 热更新包签名分发与防降版控制接口 (SPEC §6.5)。
 * `GET /api/updates/check`
 */

import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import { jsonResponse } from '../http/json';
import { publicConfigHeaders, readKvText } from '../config/kv-config';

export const WEB_BUNDLE_RELEASE_KV_KEY = 'config:web-bundle-release';

export interface WebBundleManifest {
  releaseSequence: number;
  controlSequence: number;
  bundleVersion: string;
  sha256: string;
  byteLength: number;
  minNativeCode: number;
  downloadUrl: string;
  signature?: string;
  changelog?: string;
}

export interface LiveUpdateCheckResponse {
  updateAvailable: boolean;
  reason?: 'up_to_date' | 'native_incompatible' | 'no_release';
  manifest?: WebBundleManifest;
  minNativeCode?: number;
}

export function validateWebBundleManifest(raw: unknown): WebBundleManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.releaseSequence !== 'number' || o.releaseSequence < 1) return null;
  if (typeof o.controlSequence !== 'number' || o.controlSequence < 0) return null;
  if (typeof o.bundleVersion !== 'string' || o.bundleVersion.trim() === '') return null;
  if (typeof o.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(o.sha256)) return null;
  if (typeof o.byteLength !== 'number' || o.byteLength <= 0) return null;
  if (typeof o.minNativeCode !== 'number' || o.minNativeCode < 0) return null;
  if (typeof o.downloadUrl !== 'string' || o.downloadUrl.trim() === '') return null;

  return {
    releaseSequence: o.releaseSequence,
    controlSequence: o.controlSequence,
    bundleVersion: o.bundleVersion.trim(),
    sha256: o.sha256,
    byteLength: o.byteLength,
    minNativeCode: o.minNativeCode,
    downloadUrl: o.downloadUrl.trim(),
    signature: typeof o.signature === 'string' ? o.signature : undefined,
    changelog: typeof o.changelog === 'string' ? o.changelog : undefined
  };
}

export async function handleLiveUpdateCheck(
  request: Request,
  env: Env,
  _clock: Clock
): Promise<Response> {
  const url = new URL(request.url);
  const currentSeq = parseInt(url.searchParams.get('currentSequence') ?? '0', 10);
  const nativeCode = parseInt(url.searchParams.get('nativeCode') ?? '0', 10);

  const rawJson = await readKvText(env.KV, WEB_BUNDLE_RELEASE_KV_KEY);
  if (!rawJson) {
    return jsonResponse({ updateAvailable: false, reason: 'no_release' }, 200, publicConfigHeaders());
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return jsonResponse({ updateAvailable: false, reason: 'no_release' }, 200, publicConfigHeaders());
  }

  const manifest = validateWebBundleManifest(parsed);
  if (!manifest) {
    return jsonResponse({ updateAvailable: false, reason: 'no_release' }, 200, publicConfigHeaders());
  }

  // 1. 本地原生版本低于最低要求：不可热更，需升级原生 APK
  if (nativeCode > 0 && nativeCode < manifest.minNativeCode) {
    return jsonResponse({
      updateAvailable: false,
      reason: 'native_incompatible',
      minNativeCode: manifest.minNativeCode
    }, 200, publicConfigHeaders());
  }

  // 2. 本地已是最新或更高序号：无需更新（防重放与防降版）
  if (currentSeq >= manifest.releaseSequence) {
    return jsonResponse({
      updateAvailable: false,
      reason: 'up_to_date'
    }, 200, publicConfigHeaders());
  }

  // 3. 存在可用且兼容的新版本
  return jsonResponse({
    updateAvailable: true,
    manifest
  }, 200, publicConfigHeaders());
}
