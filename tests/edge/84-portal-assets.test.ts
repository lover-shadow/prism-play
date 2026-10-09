/**
 * `GET /` (SPEC-STATIC-PAGES v2 S-4) and `GET /assets/{file}` (S-3).
 *
 * Both handlers are asserted at the handler level: `edge/src/index.ts` is wired by the supervision
 * agent, so this file proves the behaviour the ROUTES entries will expose. The rules that matter here
 * are the ones a portal can quietly break - an invented version number, a dead download link for a
 * platform that has no artifact, a colour outside the token block, or a vendor script served from
 * somewhere that is not our own bucket.
 */

import { describe, expect, it } from 'vitest';
import { VERSION_KV_KEY } from '../../edge/src/core/constants';
import { handlePortal } from '../../edge/src/routes/dl';
import {
  HLS_R2_KEY,
  IMMUTABLE_CACHE_CONTROL,
  assetTargetFrom,
  handleStaticAsset,
  type AssetEnv
} from '../../edge/src/routes/assets';
import { HERO_SHOT_DESKTOP_PATH, HERO_SHOT_PHONE_PATH } from '../../edge/src/html/dl-page';
import { HLS_SCRIPT_PATH } from '../../edge/src/html/share-page';
import { renderLandingPage } from '../../edge/src/html/landing-page';
import { DAY_BACKGROUND, ICON_SIZES, NIGHT_BACKGROUND, inlineDayPaletteStyles, inlineThemeStyles } from '../../edge/src/html/theme';
import { notFoundResponse } from '../../edge/src/http/errors';
import { createTestEnv, type PrismTestEnv } from '../support/test-env';

const ORIGIN = 'http://localhost:8787';
const HEX_LITERAL = new RegExp('[#][0-9A-Fa-f]{3,8}\\b', 'g');
const PICTOGRAPHS: readonly (readonly [number, number])[] = [
  [0x1f000, 0x1faff],
  [0x2600, 0x27bf],
  [0x2b00, 0x2bff],
  [0xfe0f, 0xfe0f],
  [0x1f1e6, 0x1f1ff]
];

function pictographs(text: string): string[] {
  return [...text].filter((character) =>
    PICTOGRAPHS.some(([low, high]) => {
      const code = character.codePointAt(0) as number;
      return code >= low && code <= high;
    })
  );
}

/**
 * The two R2 reads this track performs: `head` for the size, `get` for the engine bytes. A numeric
 * entry declares a size without carrying bytes, so the 40MB artifact stays a number in this file.
 */
function bucketWith(objects: Readonly<Record<string, string | number>>): R2Bucket {
  const sizeOf = (key: string): number => {
    const value = objects[key];
    return typeof value === 'number' ? value : (value ?? '').length;
  };
  return {
    async head(key: string): Promise<unknown> {
      return objects[key] === undefined ? null : { key, size: sizeOf(key) };
    },
    async get(key: string): Promise<unknown> {
      const body = objects[key];
      if (typeof body !== 'string') return null;
      const bytes = new TextEncoder().encode(body);
      return { key, etag: 'aabbccdd', size: bytes.length, body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) };
    }
  } as unknown as R2Bucket;
}

/** `Env` has no clock; the suite's env adds one, and the optional R2 binding is what S-3 needs. */
type TestAssetEnv = PrismTestEnv & AssetEnv;

async function assetEnv(objects: Readonly<Record<string, string | number>>): Promise<TestAssetEnv> {
  const env = (await createTestEnv()) as TestAssetEnv;
  env.APK_BUCKET = bucketWith(objects);
  return env;
}

/** A published APK of 40 MB, or none at all; plus the operator's KV release bulletin. */
async function portalEnv(options: { apk?: boolean; version?: string | null }): Promise<TestAssetEnv> {
  const env = (await createTestEnv()) as TestAssetEnv;
  if (options.version) {
    const published = JSON.parse(options.version), r = published.android;
    r.artifact = { key: `releases/android/${r.versionCode}/${'a'.repeat(64)}.apk`, sha256: 'a'.repeat(64), bytes: 40 * 1024 * 1024 };
    env.APK_BUCKET = { head: async () => options.apk === false ? null : { size: r.artifact.bytes, customMetadata: { sha256: r.artifact.sha256, versionCode: String(r.versionCode), versionName: r.versionName } } } as unknown as R2Bucket;
    await env.kv.put(VERSION_KV_KEY, JSON.stringify(published));
  }

  return env;
}

async function portal(options: { apk?: boolean; version?: string | null }): Promise<{ html: string; response: Response }> {
  const env = await portalEnv(options);
  const response = await handlePortal(new Request(`${ORIGIN}/`), env, env.clock);
  return { html: await response.text(), response };
}

describe('GET /assets/{file} (S-3)', () => {
  it('maps only the closed engine + hero-render name set onto their bucket keys', () => {
    expect(assetTargetFrom('/assets/hls.min.js')?.key).toBe(HLS_R2_KEY);
    expect(assetTargetFrom('/assets/hls.9f2c1d4e.min.js')?.key).toBe(HLS_R2_KEY);
    expect(assetTargetFrom('/assets/hls.min.js')?.contentType).toBe('application/javascript; charset=utf-8');
    expect(HLS_SCRIPT_PATH).toBe('/assets/hls.min.js');
    expect(assetTargetFrom(HERO_SHOT_DESKTOP_PATH)).toEqual({ key: 'assets/hero-showcase-1280.webp', contentType: 'image/webp' });
    expect(assetTargetFrom(HERO_SHOT_PHONE_PATH)).toEqual({ key: 'assets/hero-showcase-768.webp', contentType: 'image/webp' });
    expect(assetTargetFrom('/assets/hero-showcase-1280.9f2c1d4e.webp')?.key).toBe('assets/hero-showcase-1280.9f2c1d4e.webp');
    expect(assetTargetFrom('/assets/library.db.gz')).toEqual({ key: 'assets/library.db.gz', contentType: 'application/gzip' });
    expect(assetTargetFrom('/assets/catalog-bundle.json.gz')).toEqual({ key: 'assets/catalog-bundle.json.gz', contentType: 'application/gzip' });
    // A crop width nobody published, an image type nobody serves, and anything off the closed set.
    for (const path of [
      '/assets/',
      '/assets/hls.min.js.map',
      '/assets/../secret',
      '/assets/hls.min.js/extra',
      '/assets/HLS.MIN.JS',
      '/assets/x.min.js',
      '/assets/evil.js',
      '/assets/hero-showcase-640.webp',
      '/assets/hero-showcase-1280.png',
      '/assets/x.webp',
      '/api/titles/x'
    ]) {
      expect(assetTargetFrom(path), path).toBeNull();
    }
  });

  it('serves the engine from R2 with an immutable cache line and a javascript type', async () => {
    const env = await assetEnv({ [HLS_R2_KEY]: 'var Hls=function(){};' });
    const response = await handleStaticAsset(new Request(`${ORIGIN}${HLS_SCRIPT_PATH}`), env, env.clock);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/javascript; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe(IMMUTABLE_CACHE_CONTROL);
    expect(IMMUTABLE_CACHE_CONTROL).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await response.text()).toContain('Hls');
  });

  it('serves a hero crop as image/webp and 404s the one that was never uploaded', async () => {
    const key = 'assets/hero-showcase-768.webp';
    const env = await assetEnv({ [key]: 'RIFFxxxxWEBP' });
    const hit = await handleStaticAsset(new Request(`${ORIGIN}/${key}`), env, env.clock);
    expect(hit.status).toBe(200);
    expect(hit.headers.get('Content-Type')).toBe('image/webp');
    expect(hit.headers.get('Cache-Control')).toBe(IMMUTABLE_CACHE_CONTROL);
    const miss = await handleStaticAsset(new Request(`${ORIGIN}${HERO_SHOT_DESKTOP_PATH}`), env, env.clock);
    expect(miss.status).toBe(404);
  });

  it('revalidates replaceable library bundles instead of caching them forever', async () => {
    const key = 'assets/catalog-bundle.json';
    const env = await assetEnv({ [key]: '{}' });
    const response = await handleStaticAsset(new Request(`${ORIGIN}/${key}`), env, env.clock);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0, must-revalidate');

    const ifNoneMatchReq = new Request(`${ORIGIN}/${key}`, { headers: { 'If-None-Match': 'W/"aabbccdd"' } });
    const matchResponse = await handleStaticAsset(ifNoneMatchReq, env, env.clock);
    expect(matchResponse.status).toBe(304);
  });

  it('404s an absent object, a missing bucket and any other name, and never guesses bytes', async () => {
    const cases: TestAssetEnv[] = [await assetEnv({}), await createTestEnv() as TestAssetEnv];
    for (const env of cases) {
      const response = await handleStaticAsset(new Request(`${ORIGIN}${HLS_SCRIPT_PATH}`), env, env.clock);
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.text()).toBe(await notFoundResponse().text());
    }
    const env = await assetEnv({ [HLS_R2_KEY]: 'x' });
    expect((await handleStaticAsset(new Request(`${ORIGIN}/assets/evil.js`), env, env.clock)).status).toBe(404);
  });
});

describe('GET / portal (S-4)', () => {
  it('answers 200 HTML for every visitor, with no UA branching', async () => {
    const published = JSON.stringify({ android: { versionCode: 20500, versionName: '2.5.0', downloadUrl: `${ORIGIN}/dl/latest/android` } });
    const prints: string[] = [];
    for (const userAgent of ['Mozilla/5.0 (Linux; Android 13) MicroMessenger/8.0.40', 'Mozilla/5.0 (Windows NT 10.0)', null]) {
      const env = await portalEnv({ version: published, apk: false });
      const headers: Record<string, string> = userAgent === null ? {} : { 'User-Agent': userAgent };
      const response = await handlePortal(new Request(`${ORIGIN}/`, { headers }), env, env.clock);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=300');
      expect(response.headers.get('Vary')).toBeNull();
      prints.push(await response.text());
    }
    expect(new Set(prints).size).toBe(1);
  });

  it('states the published version and artifact size instead of inventing either', async () => {
    const published = JSON.stringify({ android: { versionCode: 20500, versionName: '2.5.0', downloadUrl: `${ORIGIN}/dl/latest/android` } });
    const withFacts = await portal({ version: published });
    expect(withFacts.html).toContain('2.5.0');
    expect(withFacts.html).toContain('APK');
    expect(withFacts.html).toContain('约 40.0 MB');
    const withoutFacts = await portal({ version: null, apk: false });
    expect(withoutFacts.html).not.toContain('v2.5.0');
    expect(withoutFacts.html).toContain('版本号尚未由发布通道配置');
    expect(withoutFacts.html).toContain('好剧随时开场');
  });

  it('never doubles a channel-prefixed version into "vdev_v…"', async () => {
    const devBuild = JSON.stringify({ android: { versionCode: 21111, versionName: 'dev_v2.1.1.1', downloadUrl: `${ORIGIN}/dl/latest/android` } });
    const { html } = await portal({ version: devBuild });
    expect(html).toContain('dev_v2.1.1.1');
    expect(html).not.toContain('vdev_');
  });

  it('is the portal contract: hero, single real funnel, honest device matrix, four capability cards', async () => {
    const { html } = await portal({ version: null });
    expect(html).toContain('数据留在本地');
    expect(html).toContain('立即下载 APK');
    expect(html).toContain('/dl/latest/android');
    expect(html).toContain('即将推出');
    expect(html).toContain('精选短剧一键播放');
    expect(html).toContain('可缓存 可离线观看');
    expect(html).toContain('多源聚合去重');
    expect(html).toContain('多端断点接力');
    expect(html).toContain('匿名同步观看进度');
    expect(html).toContain('光影Play');
    // The hero carries a real UI render from our own origin, not a wireframe placeholder.
    expect(html).toContain(`src="${HERO_SHOT_DESKTOP_PATH}"`);
    expect(html).toContain(`srcset="${HERO_SHOT_PHONE_PATH} 768w, ${HERO_SHOT_DESKTOP_PATH} 1280w"`);
    // Desktop is a two-column hero, not a stretched phone stack.
    expect(html).toContain('@media (min-width: 960px)');
    expect(html).toContain('grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr)');
    // An unpublished platform carries no link at all: no iOS or desktop bait anywhere on the page.
    expect(html).not.toMatch(/href="[^"]*(ios|iphone|apple|pc|windows|tv)/i);
  });

  it('keeps every P0 red line and stays a static, same-origin document', async () => {
    const pages = [renderLandingPage({ release: { versionName: '2.5.0', versionCode: 20500 }, apkSizeBytes: 40_000_000 }), renderLandingPage({ release: null, apkSizeBytes: null })];
    const allowed = [
      ...(inlineThemeStyles().match(HEX_LITERAL) ?? []),
      ...(inlineDayPaletteStyles().match(HEX_LITERAL) ?? []),
      NIGHT_BACKGROUND,
      DAY_BACKGROUND
    ];
    for (const html of pages) {
      expect(pictographs(html)).toEqual([]);
      expect(html).toContain('var(--accent)');
      expect(html).not.toMatch(/linear-gradient|radial-gradient|conic-gradient/i);
      expect((html.match(HEX_LITERAL) ?? []).filter((literal) => !allowed.includes(literal))).toEqual([]);
      expect(html).not.toContain('<script');
      expect(html).not.toMatch(/<link\b|@import|@font-face/i);
      for (const value of html.match(/https?:\/\/[^"'()\s]+/g) ?? []) expect(value.startsWith(ORIGIN)).toBe(true);
      for (const match of html.matchAll(/<svg class="icon" width="(\d+)" height="(\d+)" viewBox="0 0 24 24"/g)) {
        expect(match[1]).toBe(match[2]);
        expect([...ICON_SIZES]).toContain(Number(match[1]));
      }
      // Day/night and the no-horizontal-overflow requirement (AC-S4-3) both come from media queries.
      expect(html).toContain('@media (prefers-color-scheme: light)');
      expect(html).toContain('@media (min-width: 600px)');
      expect(html).toContain('env(safe-area-inset-bottom');
      expect(html).toContain('minmax(0, 1fr)');
    }
  });
});
