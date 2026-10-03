/**
 * `GET /s/{drama_id}` - the share landing page (SPEC-STATIC-PAGES v2 S-1/S-2, SPEC 5, AC-12, AC-13).
 *
 * The suite is organised around the properties that make this page safe and useful to expose:
 *   1. undifferentiated denial - unknown / unpublished / unshareable / private / illegal ep are
 *      byte-identical 404s, and an illegal `?ep=` never degrades into episode 1 (AC-S1-3);
 *   2. no upstream exposure - v2 §1.2 moved the media address out of the document entirely: the page
 *      names only same-origin paths and the player resolves the stream at run time;
 *   3. escaping - titles and `ref` come from outside the process and must never reach the DOM raw;
 *   4. P0 visual rules - zero pictographs, one same-origin script and nothing else external.
 */

import { describe, expect, it } from 'vitest';
import { dramaIdFromPath, handleShare, parseRequestedEpisode } from '../../edge/src/routes/share';
import { SHARE_DEFAULT_EPISODE } from '../../edge/src/core/constants';
import { notFoundResponse } from '../../edge/src/http/errors';
import { SHARE_ENDED_HEADLINE } from '../../edge/src/html/share-page';
import { HLS_SCRIPT_PATH } from '../../edge/src/html/share-page';
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
 * on emptiness - that is what makes the 404 bodies comparable.
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

async function render(path = '/s/work-share?ep=2&ref=GY-1024ABCD'): Promise<{ html: string; response: Response }> {
  const env = await shareFixture();
  const response = await handleShare(shareRequest(path), env, env.clock);
  return { html: await response.text(), response };
}

describe('/s denial is undifferentiated (AC-02-6 / 五.1 404 铁律)', () => {
  it('answers byte-identical 404 for unknown, unpublished, unshareable and private causes', async () => {
    const env = await shareFixture();
    const paths = ['/s/work-unknown', '/s/work-draft', '/s/work-unshareable', '/s/work-private'];
    const prints: string[] = [];
    for (const path of paths) prints.push(await fingerprint(await handleShare(shareRequest(path), env, env.clock)));
    for (const print of prints) expect(print).toBe(prints[0]);
    expect(prints[0]).toContain('404|application/json; charset=utf-8|no-store|');
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
    const paths = ['/s/work-share?ep=99', '/s/work-share?ep=999999', '/s/work-share?ep=0', '/s/work-share?ep=abc', '/s/work-share?ep=-1'];
    for (const path of paths) {
      expect(await fingerprint(await handleShare(shareRequest(path), env, env.clock)), path).toBe(baseline);
    }
    expect(parseRequestedEpisode(null)).toBe(SHARE_DEFAULT_EPISODE);
    expect(parseRequestedEpisode('2')).toBe(2);
    expect(parseRequestedEpisode('1e3')).toBeNull();
  });
});

describe('/s 200 document (AC-S1 / AC-S2 / AC-12 / AC-13)', () => {
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

  it('removes the canPlayType dead end: the probe routes to one of two channels (S-1.1, S-1.2)', async () => {
    const { html } = await render();
    // The old block returned before assigning any source; the probe may now only route between the
    // two channels, so both channel bodies must be present in the same script.
    expect(html).toContain('application/vnd.apple.mpegurl');
    expect(html).toContain('video.src = url;');
    expect(html).toContain('engine.attachMedia(video);');
    expect(html).toContain(HLS_SCRIPT_PATH);
    expect(HLS_SCRIPT_PATH).toBe('/assets/hls.min.js');
    // The engine is created by DOM API, so the document never carries a markup-level script source.
    expect(html).toContain('createElement("script")');
    expect(html).toMatch(/isSupported/);
    expect(html).toMatch(/attachMedia/);
  });

  it('carries the WeChat X5 inline-playback attributes and never a fullscreen takeover (S-1.3)', async () => {
    const { html } = await render();
    const video = /<video[^>]*><\/video>/.exec(html)?.[0] ?? '';
    expect(video).toContain('playsinline');
    expect(video).toContain('webkit-playsinline');
    expect(video).toContain('x5-video-player-type="h5-page"');
    expect(video).toContain('x5-video-player-fullscreen="true"');
  });

  it('attempts autoplay but always ships the one-tap fallback control (五.1, SPEC 11 trap 5)', async () => {
    const { html } = await render();
    expect(html).toContain('id="prism-play"');
    expect(html).toContain('立即播放');
    expect(html).toContain('video.play()');
    expect(html).not.toMatch(/<video[^>]+\bautoplay\b/i);
    expect(html).toContain('只作尝试');
  });

  it('reveals the 截流 card on the ended event only (AC-13, AC-S1-5)', async () => {
    const { html } = await render();
    expect(html).toContain("addEventListener('ended'");
    expect(html).toMatch(/id="prism-card"[^>]*hidden/);
    expect(html).not.toContain("addEventListener('timeupdate'");
  });

  it('names no media address at all: the player resolves it from the same-origin manifest', async () => {
    const { html } = await render('/s/work-share?ep=2');
    // v2 §1.2-2: no sealed proxy handle, no D1 source row, no upstream host in the document.
    expect(html).not.toContain('/proxy/');
    expect(html).not.toContain(UPSTREAM_HOST);
    expect(html).toContain('/api/titles/work-share');
    expect(html).toMatch(/"manifest":"\/api\/titles\/work-share"/);
    expect(html).toMatch(/"episode":2/);
    expect(html).toMatch(/"maxSwitches":2/);
  });

  it('ships the whole download funnel and keeps the guidance inert (S-2.1, S-2.2, S-2.4)', async () => {
    const { html } = await render();
    expect(html).toContain('position: sticky;');
    expect(html).toContain('id="prism-bar-download"');
    expect(html).toContain('id="prism-dock"');
    expect(html).toContain('下载 APP 免费看全集');
    expect(html).toContain('id="prism-rail"');
    expect(html).toMatch(/id="prism-mask"[^>]*hidden/);
    expect(html).toContain('不承诺绕过任何平台限制');
  });

  it('renders one byte-identical document for every UA: the branching is client-side only (五.5)', async () => {
    const env = await shareFixture();
    const prints: string[] = [];
    for (const ua of ['Mozilla/5.0 (Linux; Android 13) MicroMessenger/8.0.40', 'Mozilla/5.0 (Windows NT 10.0)']) {
      const response = await handleShare(new Request(`${ORIGIN}/s/work-share?ep=1`, { headers: { 'User-Agent': ua } }), env, env.clock);
      expect(response.status).toBe(200);
      expect(response.headers.get('Vary')).toBeNull();
      prints.push(await response.text());
    }
    expect(prints[1]).toBe(prints[0]);
    // The container is matched in script by a lower-cased fingerprint, never named in the document.
    expect(prints[0]).not.toContain('MicroMessenger');
  });

  it('exposes no cross-origin asset and no third-party host', async () => {
    const { html } = await render();
    expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/@font-face|@import/i);
    for (const value of html.match(/https?:\/\/[^"'()\s]+/g) ?? []) expect(value.startsWith(ORIGIN)).toBe(true);
    // The only script the page may pull is the self-hosted engine, on the same origin, under /assets/.
    expect(countOccurrences(html, '/assets/')).toBe(1);
    expect(html).not.toMatch(/cdn|unpkg|jsdelivr/i);
  });

  it('keeps the P0 rules: zero pictographs, colour only from the token block', async () => {
    const { html } = await render();
    expect(pictographs(html)).toEqual([]);
    expect(html).toContain('var(--accent)');
    // The share page is the night surface: exactly the token block plus the theme-color meta.
    expect(html.match(HEX_LITERAL)?.sort()).toEqual([...inlineThemeStyles().match(HEX_LITERAL) as string[], NIGHT_BACKGROUND].sort());
    expect(html).not.toMatch(/prefers-color-scheme: light/);
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
    expect(script).toContain('"manifest":"/api/titles/work-share"');
    expect(script).not.toContain('a' + String.fromCharCode(0x2028) + 'b');
    expect(html.match(/<script>[\s\S]*?<\/script>/g)).toHaveLength(1);
  });
});

describe('/s no longer reads the retired source table (v2 §1.2-2)', () => {
  it('renders the same document whether or not an enabled source row exists', async () => {
    const withSources = await render('/s/work-share?ep=1');
    expect(withSources.response.status).toBe(200);
    const env = await shareFixture();
    env.db.execute('UPDATE episode_sources SET enabled = 0');
    const stripped = await handleShare(shareRequest('/s/work-share?ep=1'), env, env.clock);
    expect(stripped.status).toBe(200);
    expect(stripped.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(await stripped.text()).toBe(withSources.html);
    // An unavailable line is now a client-side state card, present but inert until the player fails.
    expect(withSources.html).toMatch(/id="prism-state"[^>]*hidden/);
    expect(withSources.html).toContain('当前线路暂不可用');
  });
});
