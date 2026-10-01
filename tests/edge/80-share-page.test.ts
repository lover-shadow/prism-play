/**
 * `GET /s/{drama_id}` - the share landing page (SPEC 5, AC-02-6, AC-12, AC-13, SPEC 10 分享页资源策略).
 *
 * The suite is organised around the four properties that make this route safe to expose anonymously:
 *   1. undifferentiated denial - unknown / unpublished / unshareable / private are byte-identical;
 *   2. no upstream exposure - the only media URL is a same-origin sealed `/proxy/media` handle;
 *   3. escaping - titles and `ref` come from outside the process and must never reach the DOM raw;
 *   4. P0 visual rules - zero pictographs, no external assets, colour only from `theme.ts`.
 */

import { describe, expect, it } from 'vitest';
import { dramaIdFromPath, handleShare, parseRequestedEpisode } from '../../edge/src/routes/share';
import { createMediaHandleCodec } from '../../edge/src/core/media-handle';
import { verifyProxySignature } from '../../edge/src/core/proxy-signature';
import { PLAYBACK_HANDLE_TTL_SECONDS, SHARE_DEFAULT_EPISODE } from '../../edge/src/core/constants';
import { notFoundResponse } from '../../edge/src/http/errors';
import { SHARE_ENDED_HEADLINE } from '../../edge/src/html/share-page';
import { NIGHT_BACKGROUND, inlineThemeStyles } from '../../edge/src/html/theme';
import { seedContent, seedEpisode, seedEpisodeSource, seedProvider, seedStandardChannels } from '../support/seed';
import { seedPublishedWork } from '../support/seed-catalog';
import { createTestEnv, type PrismTestEnv } from '../support/test-env';

const UPSTREAM_HOST = 'upstream.invalid';
const ORIGIN = 'http://localhost:8787';
const HOSTILE_TITLE = '</title><script>alert(1)</script>';
const HOSTILE_REF = '"><img src=x onerror=alert(1)>';
const HEX_LITERAL = new RegExp('[#][0-9A-Fa-f]{3,8}\\b', 'g');
/** scan_p0.py ranges, rebuilt from code points so this file carries no pictograph either. */
const PICTOGRAPHS: readonly (readonly [number, number])[] = [
  [0x1f000, 0x1faff],
  [0x2600, 0x27bf],
  [0x2b00, 0x2bff],
  [0xfe0f, 0xfe0f],
  [0x1f1e6, 0x1f1ff]
];

function shareRequest(path: string): Request {
  return new Request(`${ORIGIN}${path}`);
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function pictographs(text: string): string[] {
  return [...text].filter((character) =>
    PICTOGRAPHS.some(([low, high]) => {
      const code = character.codePointAt(0) as number;
      return code >= low && code <= high;
    })
  );
}

/**
 * One fixture, five states: shareable+published, published-but-unshareable, private, an unpublished
 * draft and a hostile title. Each has episodes and a healthy source, so a denial can never be blamed
 * on emptiness - that is what makes the four 404 bodies comparable.
 */
async function shareFixture(): Promise<PrismTestEnv> {
  const env = await createTestEnv();
  seedStandardChannels(env.db);
  seedProvider(env.db, { id: 'provider_s1', channelId: 'drama', upstreamUrl: `https://${UPSTREAM_HOST}/catalog` });
  const works = [
    { id: 'work-share', title: '战神归来', episodes: 3 },
    { id: 'work-unshareable', title: '未开放分享', shareable: 0, episodes: 2 },
    { id: 'work-private', title: '私密探索剧目', channelId: 'private', isPrivate: 1, shareable: 0, episodes: 2 },
    { id: 'work-hostile', title: HOSTILE_TITLE, episodes: 1 }
  ];
  for (const work of works) {
    const seeded = seedPublishedWork(env.db, work);
    for (const episodeId of seeded.episodeIds) {
      seedEpisodeSource(env.db, {
        episodeId,
        providerId: 'provider_s1',
        upstreamMediaUrl: `https://${UPSTREAM_HOST}/hls/${work.id}/${episodeId}.m3u8`
      });
    }
  }
  // The publish gate is separate from the share gate: an enabled=0 row with real content behind it.
  seedContent(env.db, { id: 'work-draft', channelId: 'drama', title: '未上架剧目', enabled: 0, shareable: 1 });
  seedEpisodeSource(env.db, { episodeId: seedEpisode(env.db, 'work-draft', 1, 120), providerId: 'provider_s1' });
  return env;
}

async function fingerprint(response: Response): Promise<string> {
  return [
    response.status,
    response.headers.get('Content-Type'),
    response.headers.get('Cache-Control'),
    await response.text()
  ].join('|');
}

function extractMediaUrl(html: string): URL {
  const captured = /"url":"([^"]*)"/.exec(html);
  expect(captured, 'the inline config must carry the media url').not.toBeNull();
  // embedJson turns `&` into a six-character escape, so decode it back before parsing.
  return new URL((captured?.[1] as string).replace(/\\u0026/g, '&'));
}

describe('/s denial is undifferentiated (AC-02-6 / 五.1 404 铁律)', () => {
  it('answers byte-identical 404 for unknown, unpublished, unshareable and private causes', async () => {
    const env = await shareFixture();
    const paths = ['/s/work-unknown', '/s/work-draft', '/s/work-unshareable', '/s/work-private'];
    const prints: string[] = [];
    for (const path of paths) prints.push(await fingerprint(await handleShare(shareRequest(path), env, env.clock)));
    for (const print of prints) expect(print).toBe(prints[0]);
    expect(prints[0]).toContain('404|application/json; charset=utf-8|no-store|');
    // The body is the shared NOT_FOUND payload; this route has no error dialect of its own.
    expect(prints[0]).toContain(await notFoundResponse().text());
  });

  it('leaks no metadata and no private word in a denial', async () => {
    const env = await shareFixture();
    const text = await handleShare(shareRequest('/s/work-private'), env, env.clock).then((response) => response.text());
    expect(text).not.toContain('私密探索剧目');
    expect(text).not.toContain('个人探索');
    expect(text.toLowerCase()).not.toContain('private');
  });

  it('rejects malformed paths before touching the database', async () => {
    const env = await shareFixture();
    for (const path of ['/s/', '/s/a/b', '/s/%2e%2e/work-share', `/s/${'x'.repeat(140)}`]) {
      expect((await handleShare(shareRequest(path), env, env.clock)).status).toBe(404);
    }
    expect(dramaIdFromPath('/s/work-share')).toBe('work-share');
    expect(dramaIdFromPath('/api/channels')).toBeNull();
    expect(dramaIdFromPath('/s/a/b')).toBeNull();
  });

  it('keys on the requested episode: missing or malformed ep is 404, never a silent fallback', async () => {
    const env = await shareFixture();
    const baseline = await fingerprint(await handleShare(shareRequest('/s/work-unknown'), env, env.clock));
    for (const path of ['/s/work-share?ep=99', '/s/work-share?ep=0', '/s/work-share?ep=abc', '/s/work-share?ep=-1']) {
      expect(await fingerprint(await handleShare(shareRequest(path), env, env.clock))).toBe(baseline);
    }
    expect(parseRequestedEpisode(null)).toBe(SHARE_DEFAULT_EPISODE);
    expect(parseRequestedEpisode('2')).toBe(2);
    expect(parseRequestedEpisode('1e3')).toBeNull();
  });
});

describe('/s 200 document (AC-12 / AC-13 / SPEC 10)', () => {
  async function render(path = '/s/work-share?ep=2&ref=GY-1024ABCD'): Promise<{ html: string; response: Response }> {
    const env = await shareFixture();
    const response = await handleShare(shareRequest(path), env, env.clock);
    return { html: await response.text(), response };
  }

  it('serves HTML for the requested single episode only', async () => {
    const { html, response } = await render('/s/work-share?ep=3');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(html).toContain('战神归来');
    expect(html).toContain('第 3 集');
    expect(html).not.toContain('第 1 集');
    expect(html).toContain('光影Play');
    expect(SHARE_ENDED_HEADLINE).toBe('本集已播放完毕，如果继续看，请下载【光影Play】');
    expect(html).toContain(SHARE_ENDED_HEADLINE);
    expect(html).toContain('/dl/latest/android');
    expect(html).toContain('查看下载说明');
  });

  it('attempts autoplay but always ships the one-tap fallback control (五.1, SPEC 11 trap 5)', async () => {
    const { html } = await render();
    expect(html).toContain('id="prism-play"');
    expect(html).toContain('立即播放');
    expect(html).toContain('video.play()');
    // AC-12 is an attempt, never a promise: no forced autoplay attribute, and the copy says so.
    expect(html).not.toMatch(/<video[^>]+\bautoplay\b/i);
    expect(html).toContain('只作尝试');
  });

  it('reveals the 截流 card on the ended event only', async () => {
    const { html } = await render();
    expect(html).toContain("addEventListener('ended'");
    expect(html).toMatch(/id="prism-card"[^>]*hidden/);
    expect(html).not.toContain("addEventListener('timeupdate'");
  });

  it('never performs WeChat exit guidance, whatever the UA (五.5: the funnel is /dl only)', async () => {
    const env = await shareFixture();
    for (const ua of ['MicroMessenger/8.0 Android', 'Mozilla/5.0 (Windows NT 10.0)']) {
      const response = await handleShare(new Request(`${ORIGIN}/s/work-share?ep=1`, { headers: { 'User-Agent': ua } }), env, env.clock);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).not.toContain('点击右上角');
      expect(html).not.toContain('MicroMessenger');
      expect(html).not.toContain('在浏览器中打开');
    }
  });

  it('carries exactly one same-origin sealed proxy media url with exp and sig', async () => {
    const env = await shareFixture();
    const html = await handleShare(shareRequest('/s/work-share?ep=2'), env, env.clock).then((r) => r.text());
    expect(countOccurrences(html, '/proxy/media/')).toBe(1);
    const url = extractMediaUrl(html);
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname.startsWith('/proxy/media/')).toBe(true);
    const handle = url.pathname.slice('/proxy/media/'.length);
    const exp = Number(url.searchParams.get('exp'));
    expect(exp).toBe(env.clock.nowSeconds() + PLAYBACK_HANDLE_TTL_SECONDS);
    const sig = url.searchParams.get('sig');
    const kind = 'media' as const;
    expect(await verifyProxySignature(env.PROXY_SIGNING_SECRET, { kind, handle, exp: String(exp), sig }, env.clock.nowSeconds())).toBe('valid');
    // Sealed, not encoded: only the server can turn the handle back into the upstream target.
    const parsed = await (await createMediaHandleCodec(env.PROXY_SIGNING_SECRET)).parse(handle);
    expect(parsed?.episodeId).toBeGreaterThan(0);
    expect(parsed?.targetUrl).toContain(UPSTREAM_HOST);
  });

  it('exposes no upstream host and no cross-origin asset', async () => {
    const { html } = await render();
    expect(html).not.toContain(UPSTREAM_HOST);
    expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@font-face|@import/i);
    expect(html).not.toMatch(/hls\.js|artplayer/i);
    for (const value of html.match(/https?:\/\/[^"'()\s]+/g) ?? []) expect(value.startsWith(ORIGIN)).toBe(true);
  });

  it('keeps the P0 rules: zero pictographs, colour only from the token block', async () => {
    const { html } = await render();
    expect(pictographs(html)).toEqual([]);
    expect(html).toContain('var(--accent)');
    // The document inlines `theme.ts`, so its hex multiset must be exactly the token block plus the
    // one exported night background used by the `theme-color` meta. A page-level colour fails this.
    expect(html.match(HEX_LITERAL)?.sort()).toEqual([...inlineThemeStyles().match(HEX_LITERAL) as string[], NIGHT_BACKGROUND].sort());
  });
});

describe('/s escaping is the only thing between D1 and the DOM', () => {
  it('never emits a hostile title or ref raw', async () => {
    const env = await shareFixture();
    const response = await handleShare(shareRequest(`/s/work-hostile?ep=1&ref=${encodeURIComponent(HOSTILE_REF)}`), env, env.clock);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('</title><script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // An escaped payload must never be able to open a second script block.
    expect(countOccurrences(html, '<script>')).toBe(1);
    expect(countOccurrences(html, '</script>')).toBe(1);
  });

  it('keeps the inline script free of raw data delimiters', async () => {
    const env = await shareFixture();
    const hostileRef = `a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`;
    const html = await handleShare(shareRequest(`/s/work-share?ep=1&ref=${encodeURIComponent(hostileRef)}`), env, env.clock).then((r) => r.text());
    const script = html.slice(html.indexOf('<script>'), html.indexOf('</script>'));
    expect(script).not.toContain(String.fromCharCode(0x2028));
    expect(script).not.toContain(String.fromCharCode(0x2029));
    expect(script).toContain('"url":"http://localhost:8787/proxy/media/');
    // The ref is display-only attribution: it reaches the footer text, never the script payload.
    expect(script).not.toContain('a' + String.fromCharCode(0x2028) + 'b');
    expect(html.match(/<script>[\s\S]*?<\/script>/g)).toHaveLength(1);
  });
});

describe('/s unavailable source', () => {
  it('answers 503 with an honest HTML state instead of a silent episode-1 fallback', async () => {
    const env = await shareFixture();
    env.db.execute('UPDATE episode_sources SET enabled = 0');
    const response = await handleShare(shareRequest('/s/work-share?ep=1'), env, env.clock);
    const html = await response.text();
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(html).toContain('本集暂时找不到可用播放源');
    expect(html).not.toContain('/proxy/media/');
    expect(html).not.toContain('id="prism-video"');
    expect(html).toContain('/dl/latest/android');
  });
});
