/**
 * `GET /dl` and `GET /dl/latest/{platform}` - the download funnel (API-SPEC 五.2/五.3, SPEC 3 out-of-scope).
 *
 * Also carries the `escape.ts` primitive unit tests, because these pages are where the referrer
 * controlled `?ref=` reaches the DOM and where the three renderers are asserted independently.
 */

import { describe, expect, it } from 'vitest';
import {
  ANDROID_APK_KEY,
  detectAudience,
  handleApkDownload,
  handleDownloadLanding,
  platformFromPath,
  resolveApkLocation,
  type DlEnv
} from '../../edge/src/routes/dl';
import {
  embedJson,
  escapeAttribute,
  escapeText,
  sanitizeDisplayToken,
  tag
} from '../../edge/src/html/escape';
import { renderAndroidDownloadPage, renderUnsupportedNoticePage, renderWeChatGuidePage } from '../../edge/src/html/dl-page';
import { ICON_SIZES } from '../../edge/src/html/theme';
import { createTestEnv, type PrismTestEnv } from '../support/test-env';

const ORIGIN = 'http://localhost:8787';
const HOSTILE_REF = '"><img src=x onerror=alert(1)>';
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

async function landing(userAgent: string | null, query = ''): Promise<{ html: string; response: Response }> {
  const env = await createTestEnv();
  const headers: Record<string, string> = {};
  if (userAgent !== null) headers['User-Agent'] = userAgent;
  const response = await handleDownloadLanding(new Request(`${ORIGIN}/dl${query}`, { headers }), env, env.clock);
  return { html: await response.text(), response };
}

const WECHAT_UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 MicroMessenger/8.0.40(0x18002832)';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';

function bucketWith(keys: readonly string[]): R2Bucket {
  return {
    async head(key: string): Promise<unknown> {
      return keys.includes(key) ? { key, size: 4_200_000 } : null;
    }
  } as unknown as R2Bucket;
}

async function apkEnv(bucket: R2Bucket | undefined, publicBase: string | undefined): Promise<PrismTestEnv> {
  const env = await createTestEnv();
  const view = env as DlEnv;
  view.APK_BUCKET = bucket;
  view.APK_PUBLIC_BASE_URL = publicBase;
  return env;
}

describe('/dl UA branching (五.2)', () => {
  it('classifies WeChat before Android, and treats everything else honestly', () => {
    expect(detectAudience(WECHAT_UA)).toBe('wechat');
    expect(detectAudience('micromessenger')).toBe('wechat');
    expect(detectAudience('MicroMessenger/8.0 (iPhone)')).toBe('wechat');
    expect(detectAudience(ANDROID_UA)).toBe('android');
    expect(detectAudience(WINDOWS_UA)).toBe('windows');
    expect(detectAudience(IPHONE_UA)).toBe('other');
    expect(detectAudience(null)).toBe('other');
  });

  it('renders the WeChat guidance page and claims no bypass and no direct APK download', async () => {
    const { html } = await landing(WECHAT_UA);
    expect(html).toContain('请在浏览器中打开继续下载');
    expect(html).toContain('点击右上角');
    expect(html).toContain('在浏览器打开');
    // SPEC: 不承诺防封. Nothing here may advertise a bypass or an in-WebView download.
    expect(html).toContain('不承诺绕过微信的限制');
    expect(html).not.toContain('防封');
    expect(html).not.toContain('/dl/latest/android');
    expect(html).not.toContain('立即下载');
  });

  it('renders the Android card pointing at the single real entry', async () => {
    const { html } = await landing(ANDROID_UA);
    expect(html).toContain('Android 安装包');
    expect(html).toMatch(/<a[^>]+href="\/dl\/latest\/android"/);
    expect(html).not.toContain('请在浏览器中打开');
    expect(html).toContain('本期仅提供 Android 版本');
  });

  it('renders an honest Windows notice with no PC link and no 404 bait', async () => {
    const { html } = await landing(WINDOWS_UA);
    expect(html).toContain('当前仅提供 Android 版本');
    expect(html).toContain('Windows 电脑');
    expect(html).not.toContain('/dl/latest/pc');
    expect(html).not.toMatch(/\.exe|\.msi|\.dmg/i);
    expect(html).not.toMatch(/<a[^>]+href="\/dl\/latest\//);
  });

  it('renders the same honest notice for any other device, naming no fake package', async () => {
    const { html } = await landing(IPHONE_UA);
    expect(html).toContain('当前设备不提供安装包下载');
    expect(html).not.toContain('/dl/latest/pc');
    expect(html).not.toMatch(/\.exe|\.msi|\.apk"/i);
  });

  it('serves HTML that varies by UA and escapes ref in every branch', async () => {
    for (const userAgent of [WECHAT_UA, ANDROID_UA, WINDOWS_UA, IPHONE_UA, null]) {
      const { html, response } = await landing(userAgent, `?ref=${encodeURIComponent(HOSTILE_REF)}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      expect(response.headers.get('Vary')).toBe('User-Agent');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(html).not.toContain('<img src=x onerror=alert(1)>');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).not.toContain('<script');
      expect(pictographs(html)).toEqual([]);
      expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
      expect(html).not.toMatch(/<link\b/i);
    }
  });

  it('keeps icons inside the locked 16/20/24px set and uses no emoji as an icon', () => {
    for (const html of [renderWeChatGuidePage({}), renderAndroidDownloadPage({}), renderUnsupportedNoticePage({ audience: 'windows' })]) {
      const sizes = [...html.matchAll(/<svg class="icon" width="(\d+)" height="\1"/g)].map((match) => Number(match[1]));
      expect(sizes.length).toBeGreaterThan(0);
      for (const size of sizes) expect(ICON_SIZES).toContain(size as (typeof ICON_SIZES)[number]);
      expect(html).toMatch(/stroke-width="2"/);
      expect(pictographs(html)).toEqual([]);
    }
  });
});

describe('/dl/latest/{platform} (五.3)', () => {
  it('accepts only android in the path', () => {
    expect(platformFromPath('/dl/latest/android')).toBe('android');
    expect(platformFromPath('/dl/latest/PC')).toBe('pc');
    expect(platformFromPath('/dl/latest/')).toBeNull();
    expect(platformFromPath('/dl/latest/a/b')).toBeNull();
    expect(platformFromPath('/dl')).toBeNull();
  });

  it('404s every platform this period does not ship, pc included', async () => {
    const env = await apkEnv(bucketWith([ANDROID_APK_KEY]), 'https://release.invalid/');
    for (const platform of ['pc', 'windows', 'ios', 'android-tv']) {
      const response = await handleApkDownload(new Request(`${ORIGIN}/dl/latest/${platform}`), env as DlEnv, env.clock);
      expect(response.status).toBe(404);
      expect(response.headers.get('Location')).toBeNull();
    }
  });

  it('302s to the verified R2 location when the artifact exists', async () => {
    const env = await apkEnv(bucketWith([ANDROID_APK_KEY]), 'https://release.invalid/pub');
    const response = await handleApkDownload(new Request(`${ORIGIN}/dl/latest/android`), env as DlEnv, env.clock);
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://release.invalid/pub/releases/android/latest.apk');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toBe('');
  });

  it('404s when the artifact, the bucket or the public base is missing', async () => {
    const cases: (readonly [R2Bucket | undefined, string | undefined])[] = [
      [bucketWith([]), 'https://release.invalid/pub'],
      [undefined, 'https://release.invalid/pub'],
      [bucketWith([ANDROID_APK_KEY]), undefined],
      [bucketWith([ANDROID_APK_KEY]), '   ']
    ];
    for (const [bucket, publicBase] of cases) {
      const env = await apkEnv(bucket, publicBase);
      const response = await handleApkDownload(new Request(`${ORIGIN}/dl/latest/android`), env as DlEnv, env.clock);
      expect(response.status).toBe(404);
    }
  });

  it('never invents a redirect target: a malformed base is treated as unconfigured', () => {
    expect(resolveApkLocation('not a url')).toBeNull();
    expect(resolveApkLocation('ftp://release.invalid/pub')).toBeNull();
    expect(resolveApkLocation('https://user:pw@release.invalid/pub')).toBeNull();
    expect(resolveApkLocation('https://release.invalid/pub?token=secret')).toBeNull();
    expect(resolveApkLocation('release.invalid/pub')).toBeNull();
    expect(resolveApkLocation('https://release.invalid/pub/')).toBe('https://release.invalid/pub/releases/android/latest.apk');
    expect(resolveApkLocation(undefined)).toBeNull();
  });
});

describe('escape.ts primitives (the XSS boundary)', () => {
  it('escapes text and attributes for their own contexts', () => {
    expect(escapeText('<b>a & b</b>')).toBe('&lt;b&gt;a &amp; b&lt;/b&gt;');
    expect(escapeText(HOSTILE_REF)).toBe('"&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(escapeAttribute(HOSTILE_REF)).toBe('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
    expect(escapeText('&lt;')).toBe('&amp;lt;');
  });

  it('neutralises script-breaking characters inside embedded JSON', () => {
    const hostile = '</script><img src=x onerror=alert(1)>';
    const embedded = embedJson({ url: hostile, note: `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c` });
    expect(embedded).not.toContain('<');
    expect(embedded).not.toContain('>');
    expect(embedded).not.toContain('&');
    expect(embedded).not.toContain(String.fromCharCode(0x2028));
    expect(embedded).not.toContain(String.fromCharCode(0x2029));
    // Still the same value once the browser parses it.
    const decoded = JSON.parse(embedded.replace(/\\u003C/g, '<').replace(/\\u003E/g, '>').replace(/\\u0026/g, '&')) as { url: string; note: string };
    expect(decoded.url).toBe(hostile);
    expect(decoded.note).toBe(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`);
  });

  it('bounds and cleans display-only tokens', () => {
    expect(sanitizeDisplayToken(null)).toBeNull();
    expect(sanitizeDisplayToken('   ')).toBeNull();
    expect(sanitizeDisplayToken('ab\u0000c\u001Fd')).toBe('abcd');
    expect(sanitizeDisplayToken('x'.repeat(200)) as string).toHaveLength(80);
    expect(sanitizeDisplayToken('short', 5)).toBe('short');
  });

  it('builds elements with escaped attributes only', () => {
    const markup = tag('a', { href: '/dl', title: HOSTILE_REF, hidden: null }, '下载');
    expect(markup).toBe('<a href="/dl" title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">下载</a>');
    expect(tag('br', {}, '', true)).toBe('<br />');
  });
});
