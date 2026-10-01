/**
 * `GET /api/config/monetization` and `GET /api/version` - the cloud-delivered configuration surfaces.
 *
 * The property under test is the one SPEC 10 makes a hard rule: no valid config means NO paywall, so
 * the edge must never repair a broken value. Every malformed entry therefore has to produce the same
 * leak-free 503, and a 200 must contain exactly the fields the operator stored and nothing else.
 * `SENTINEL` is injected into every stored document: if any part of the stored value were echoed into
 * an error, or any unknown field passed through, the assertion catches it.
 */

import { describe, expect, it } from 'vitest';
import { handleMonetizationConfig } from '../../edge/src/routes/monetization';
import { handleVersion } from '../../edge/src/routes/version';
import { CONFIG_MAX_AGE_SECONDS, isSameOriginDownloadUrl } from '../../edge/src/config/kv-config';
import { MONETIZATION_KV_KEY, VERSION_KV_KEY } from '../../edge/src/core/constants';
import { errorResponse } from '../../edge/src/http/errors';
import type { MonetizationConfig, VersionResponse } from '../../edge/src/types/api';
import { createTestEnv, type PrismTestEnv } from '../support/test-env';

const ORIGIN = 'http://localhost:8787';
const SENTINEL = 'SENTINEL-DO-NOT-ECHO';
const APK_URL = `${ORIGIN}/dl/latest/android`;

type Stored = Record<string, unknown>;

function validMonetization(): Stored {
  return {
    activeTiers: [
      { tier: 'Q', name: '季度畅享卡', durationDays: 90, priceYuan: 9.9, desc: '90 天免打扰纯净畅看' }
    ],
    nudgePolicy: {
      freeTrialSeconds: 54000,
      stage1UntilSeconds: 108000,
      stage2UntilSeconds: 180000,
      stage1IntervalSeconds: 3600,
      stage2IntervalSeconds: 2700,
      stage3IntervalSeconds: 1800,
      dialogTitle: '老板，看剧辛苦，借一步说话',
      dialogBody: '一个人维护多源与边缘服务器，不接广告不偷扣费。'
    },
    operatorNote: SENTINEL
  };
}

function validVersion(): Stored {
  return {
    android: {
      versionCode: 200,
      versionName: 'v2.0.0',
      changelog: '1. 大视界频道架构升级',
      downloadUrl: APK_URL,
      minVersionCode: 100,
      force: false
    },
    windows: { versionCode: 1, downloadUrl: 'https://other.example/installer' }
  };
}

async function kvEnv(key: string, value: string | null): Promise<PrismTestEnv> {
  const env = await createTestEnv();
  if (value !== null) await env.kv.put(key, value);
  return env;
}

function request(path: string): Request {
  return new Request(`${ORIGIN}${path}`);
}

async function monetizationWith(config: Stored | null): Promise<{ status: number; text: string; headers: Headers }> {
  const env = await kvEnv(MONETIZATION_KV_KEY, config === null ? null : JSON.stringify(config));
  const response = await handleMonetizationConfig(request('/api/config/monetization'), env, env.clock);
  return { status: response.status, text: await response.text(), headers: response.headers };
}

async function versionWith(config: Stored | null): Promise<{ status: number; text: string; headers: Headers }> {
  const env = await kvEnv(VERSION_KV_KEY, config === null ? null : JSON.stringify(config));
  const response = await handleVersion(request('/api/version'), env, env.clock);
  return { status: response.status, text: await response.text(), headers: response.headers };
}

function mutate(config: Stored, path: string[], value: unknown): void {
  let cursor: Record<string, unknown> = config;
  for (const segment of path.slice(0, -1)) cursor = cursor[segment] as Record<string, unknown>;
  if (value === undefined) delete cursor[path[path.length - 1] as string];
  else cursor[path[path.length - 1] as string] = value;
}

describe('GET /api/config/monetization', () => {
  it('serves a valid cloud config, including the A-3 privateAccessTiers passthrough', async () => {
    const config = validMonetization();
    config.privateAccessTiers = ['B', 'Y', 'S'];
    const result = await monetizationWith(config);
    expect(result.status).toBe(200);
    expect(result.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(result.headers.get('Cache-Control')).toBe(`public, max-age=${CONFIG_MAX_AGE_SECONDS}`);
    const body = JSON.parse(result.text) as MonetizationConfig;
    expect(body.activeTiers[0]?.priceYuan).toBe(9.9);
    expect(body.privateAccessTiers).toEqual(['B', 'Y', 'S']);
    expect(body.nudgePolicy.stage2UntilSeconds).toBe(180000);
    // Unknown stored fields are rebuilt away, so the sentinel never reaches the wire.
    expect(result.text).not.toContain(SENTINEL);
  });

  it('omits privateAccessTiers when the operator has not configured it (M-3: no code default)', async () => {
    const result = await monetizationWith(validMonetization());
    expect(result.status).toBe(200);
    expect(Object.keys(JSON.parse(result.text) as Stored)).not.toContain('privateAccessTiers');
    expect(result.text).not.toContain('privateAccessTiers');
  });

  it('deduplicates a configured eligibility set without inventing tiers', async () => {
    const config = validMonetization();
    config.privateAccessTiers = ['S', 'B', 'S'];
    const body = JSON.parse((await monetizationWith(config)).text) as MonetizationConfig;
    expect(body.privateAccessTiers).toEqual(['S', 'B']);
  });

  const rejections: readonly [string, (config: Stored) => void][] = [
    ['empty activeTiers', (c) => mutate(c, ['activeTiers'], [])],
    ['missing activeTiers', (c) => mutate(c, ['activeTiers'], undefined)],
    ['activeTiers is not an array', (c) => mutate(c, ['activeTiers'], 'Q')],
    ['unknown tier code', (c) => mutate(c, ['activeTiers', '0', 'tier'], 'X')],
    ['empty tier name', (c) => mutate(c, ['activeTiers', '0', 'name'], '   ')],
    ['fractional durationDays', (c) => mutate(c, ['activeTiers', '0', 'durationDays'], 1.5)],
    ['zero priceYuan', (c) => mutate(c, ['activeTiers', '0', 'priceYuan'], 0)],
    ['negative priceYuan', (c) => mutate(c, ['activeTiers', '0', 'priceYuan'], -9.9)],
    ['priceYuan as a string', (c) => mutate(c, ['activeTiers', '0', 'priceYuan'], '9.9')],
    ['missing nudgePolicy', (c) => mutate(c, ['nudgePolicy'], undefined)],
    ['free trial not below stage 1', (c) => mutate(c, ['nudgePolicy', 'freeTrialSeconds'], 108000)],
    ['stage 1 not below stage 2', (c) => mutate(c, ['nudgePolicy', 'stage1UntilSeconds'], 180000)],
    ['stage bound below 1', (c) => mutate(c, ['nudgePolicy', 'stage2UntilSeconds'], 0)],
    ['zero interval', (c) => mutate(c, ['nudgePolicy', 'stage3IntervalSeconds'], 0)],
    ['fractional interval', (c) => mutate(c, ['nudgePolicy', 'stage1IntervalSeconds'], 60.5)],
    ['empty dialog copy', (c) => mutate(c, ['nudgePolicy', 'dialogBody'], '')],
    ['private tier outside B/Y/S', (c) => mutate(c, ['privateAccessTiers'], ['Q'])],
    ['private tier not an array', (c) => mutate(c, ['privateAccessTiers'], 'B')]
  ];

  for (const [label, apply] of rejections) {
    it(`rejects ${label} with a leak-free 503 and no fallback price`, async () => {
      const config = validMonetization();
      apply(config);
      const result = await monetizationWith(config);
      expect(result.status).toBe(503);
      expect(result.headers.get('Cache-Control')).toBe('no-store');
      // The body is the shared SERVICE_UNAVAILABLE payload, byte for byte.
      expect(result.text).toBe(await errorResponse('SERVICE_UNAVAILABLE').text());
      expect(result.text).not.toContain(SENTINEL);
      expect(result.text).not.toContain('9.9');
      expect(result.text).not.toContain('季度畅享卡');
      expect(Object.keys(JSON.parse(result.text) as Stored).sort()).toEqual(['code', 'message', 'success']);
    });
  }

  it('treats an empty KV and a corrupt value identically: 503, never a guessed price', async () => {
    for (const raw of [null, '', '   ', 'not-json', '[]', 'null']) {
      const env = await kvEnv(MONETIZATION_KV_KEY, raw);
      const response = await handleMonetizationConfig(request('/api/config/monetization'), env, env.clock);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('9.9');
    }
  });

  it('carries whatever price the operator stored, so no value is hardcoded here', async () => {
    const config = validMonetization();
    mutate(config, ['activeTiers', '0', 'priceYuan'], 42.5);
    mutate(config, ['activeTiers', '0', 'tier'], 'Y');
    const body = JSON.parse((await monetizationWith(config)).text) as MonetizationConfig;
    expect(body.activeTiers[0]?.priceYuan).toBe(42.5);
    expect(body.activeTiers[0]?.tier).toBe('Y');
  });

  it('accepts a permanent tier whose durationDays is the -1 sentinel', async () => {
    const config = validMonetization();
    mutate(config, ['activeTiers', '0', 'tier'], 'S');
    mutate(config, ['activeTiers', '0', 'durationDays'], -1);
    expect((await monetizationWith(config)).status).toBe(200);
  });
});

describe('GET /api/version', () => {
  it('serves the android release only, and never a windows key', async () => {
    const result = await versionWith(validVersion());
    expect(result.status).toBe(200);
    expect(result.headers.get('Cache-Control')).toBe(`public, max-age=${CONFIG_MAX_AGE_SECONDS}`);
    const body = JSON.parse(result.text) as VersionResponse & Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['android']);
    expect(body.android.versionCode).toBe(200);
    expect(body.android.downloadUrl).toBe(APK_URL);
    expect(result.text).not.toContain('windows');
    expect(result.text).not.toContain('other.example');
    expect(result.text).not.toContain(SENTINEL);
  });

  const versionRejections: readonly [string, (config: Stored) => void][] = [
    ['missing android', (c) => mutate(c, ['android'], undefined)],
    ['cross-origin download url', (c) => mutate(c, ['android', 'downloadUrl'], 'https://other.example/dl/latest/android')],
    ['same-origin but wrong path', (c) => mutate(c, ['android', 'downloadUrl'], `${ORIGIN}/dl/latest/pc`)],
    ['download url with a query', (c) => mutate(c, ['android', 'downloadUrl'], `${APK_URL}?token=x`)],
    ['protocol-relative download url', (c) => mutate(c, ['android', 'downloadUrl'], '//other.example/dl/latest/android')],
    ['missing downloadUrl', (c) => mutate(c, ['android', 'downloadUrl'], undefined)],
    ['non-integer versionCode', (c) => mutate(c, ['android', 'versionCode'], '200')],
    ['zero versionCode', (c) => mutate(c, ['android', 'versionCode'], 0)],
    ['empty versionName', (c) => mutate(c, ['android', 'versionName'], '  ')],
    ['non-boolean force', (c) => mutate(c, ['android', 'force'], 'yes')],
    ['negative minVersionCode', (c) => mutate(c, ['android', 'minVersionCode'], -1)]
  ];

  for (const [label, apply] of versionRejections) {
    it(`rejects ${label} with the shared 503`, async () => {
      const config = validVersion();
      apply(config);
      const result = await versionWith(config);
      expect(result.status).toBe(503);
      expect(result.headers.get('Cache-Control')).toBe('no-store');
      expect(result.text).toBe(await errorResponse('SERVICE_UNAVAILABLE').text());
      expect(result.text).not.toContain(SENTINEL);
      expect(result.text).not.toContain('other.example');
    });
  }

  it('404-free on empty KV: an unprovisioned bulletin is a 503, not a fake version', async () => {
    for (const raw of [null, '', 'garbage', '{}']) {
      const env = await kvEnv(VERSION_KV_KEY, raw);
      const response = await handleVersion(request('/api/version'), env, env.clock);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain('2.0.0');
    }
  });

  it('pins the same-origin test to the request origin, not a constant domain', () => {
    expect(isSameOriginDownloadUrl(APK_URL, ORIGIN)).toBe(true);
    expect(isSameOriginDownloadUrl(`${ORIGIN}/dl/latest/android`, 'https://play.prismos.org')).toBe(false);
    expect(isSameOriginDownloadUrl('not a url', ORIGIN)).toBe(false);
  });

  it('keeps optional fields optional', async () => {
    const config = validVersion();
    mutate(config, ['android', 'changelog'], undefined);
    mutate(config, ['android', 'minVersionCode'], undefined);
    mutate(config, ['android', 'force'], undefined);
    const body = JSON.parse((await versionWith(config)).text) as VersionResponse;
    expect(Object.keys(body.android).sort()).toEqual(['downloadUrl', 'versionCode', 'versionName']);
  });
});
