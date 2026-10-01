import { describe, expect, it } from 'vitest';
import { PLAYBACK_HANDLE_TTL_SECONDS } from '../../edge/src/core/constants';
import { createMediaHandleCodec, type MediaHandleCodec } from '../../edge/src/core/media-handle';
import { buildProxyUrl, signProxyTarget } from '../../edge/src/core/proxy-signature';
import type { UpstreamFetcher } from '../../edge/src/media/upstream';
import { HlsReferenceUnresolvableError, rewriteMediaPlaylist } from '../../edge/src/media/hls-rewrite';
import { assertAllowedTarget, UpstreamTargetRejectedError } from '../../edge/src/media/upstream';
import { handleProxy } from '../../edge/src/routes/proxy';
import { createTestEnv, type PrismTestEnv } from '../support/test-env';
import { seedContent, seedEpisode, seedEpisodeSource, seedProvider, seedStandardChannels } from '../support/seed';

const ORIGIN = 'http://localhost:8787';
const UP = 'https://cdn.invalid';
const BASE = `${UP}/hls/d_public/1/`;
const MASTER_TARGET = `${BASE}master.m3u8`;
const ALLOWED = new Set([UP]);

/** A realistic master: a quoted comma inside NAME, a relative child, an absolute child, query + fragment. */
const MASTER_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:4',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '',
  '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="zh",NAME="中文,字幕",DEFAULT=YES,AUTOSELECT=YES,URI="subs/zh.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720,CODECS="avc1.64001e,mp4a.40.2",SUBTITLES="subs"',
  '720/playlist.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=640x360',
  'low/playlist.m3u8?tab=1#tail',
  '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="iframe.m3u8"',
  '# a reader comment must survive'
].join('\n');

/** A media playlist whose key URI contains a comma and whose attribute order must survive. */
const MEDIA_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:10',
  '#EXT-X-MEDIA-SEQUENCE:100',
  '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.invalid/keys/key?v=1,2",IV=0x0a1b,KEYFORMAT="identity",KEYFORMATVERSIONS="1"',
  '#EXT-X-MAP:URI="init.mp4?tag=a,b"',
  '#EXTINF:10.0,',
  'seg-100.ts',
  '#EXT-X-DISCONTINUITY',
  '#EXTINF:9.5,',
  `${UP}/abs/seg-101.ts`,
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="原声",URI="audio/main.m3u8"',
  '#EXTINF:8.0,',
  'seg-102.ts?t=1,2#note',
  '#EXT-X-ENDLIST',
  ''
].join('\n');

function spyRewriter(playlistUrl: string) {
  const targets: string[] = [];
  return {
    targets,
    input: {
      playlistUrl,
      allowedOrigins: ALLOWED,
      mintChildUrl: async (target: string) => {
        targets.push(target);
        return `/proxy/media/e_7.${targets.length}?exp=1&sig=x`;
      }
    }
  };
}

interface RouteFixture {
  env: PrismTestEnv;
  fetcher: UpstreamFetcher;
  calls: string[];
  inits: RequestInit[];
  codec: MediaHandleCodec;
  episodeId: number;
}

async function routeFixture(): Promise<RouteFixture> {
  const env = await createTestEnv();
  seedStandardChannels(env.db);
  seedProvider(env.db, { id: 'provider_s1', channelId: 'drama', upstreamUrl: `${UP}/catalog` });
  seedContent(env.db, { id: 'd_public', channelId: 'drama', title: '公开剧' });
  const episodeId = seedEpisode(env.db, 'd_public', 1, 132);
  seedEpisodeSource(env.db, { episodeId, providerId: 'provider_s1', upstreamMediaUrl: MASTER_TARGET });
  const calls: string[] = [];
  const inits: RequestInit[] = [];
  const fetcher: UpstreamFetcher = {
    fetch: async (url, init) => {
      calls.push(url);
      inits.push(init ?? {});
      if (url === MASTER_TARGET) {
        return new Response(MASTER_PLAYLIST, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
      }
      if (url.endsWith('.m3u8')) {
        const sub = '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\na.ts\n#EXTINF:9,\nb.ts\n#EXT-X-ENDLIST\n';
        return new Response(sub, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
      }
      if (url === `${BASE}seg-100.ts`) {
        return new Response('x'.repeat(100), {
          status: 206,
          headers: {
            'Content-Range': 'bytes 0-99/1000',
            'Content-Length': '100',
            'Accept-Ranges': 'bytes',
            'Content-Type': 'video/mp2t',
            'ETag': '"seg-100"',
            'Set-Cookie': 'upstream=leak',
            'Cache-Control': 'public, max-age=60'
          }
        });
      }
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }
  };
  return { env, fetcher, calls, inits, codec: await createMediaHandleCodec(env.PROXY_SIGNING_SECRET), episodeId };
}

async function signedMedia(env: PrismTestEnv, episodeId: number, target: string): Promise<string> {
  const handle = await (await createMediaHandleCodec(env.PROXY_SIGNING_SECRET)).mint(episodeId, target);
  const exp = env.clock.nowSeconds() + PLAYBACK_HANDLE_TTL_SECONDS;
  return buildProxyUrl(ORIGIN, 'media', handle, {
    expSeconds: exp,
    signature: await signProxyTarget(env.PROXY_SIGNING_SECRET, 'media', handle, exp)
  });
}

function ask(fixture: RouteFixture, url: string, headers?: HeadersInit): Promise<Response> {
  return handleProxy(new Request(url, { headers }), fixture.env, fixture.env.clock, { fetcher: fixture.fetcher });
}

const ABSOLUTE_URL = /https?:\/\/[^",\s]+/g;

describe('HLS playlist rewriting (edge/src/media/hls-rewrite.ts)', () => {
  it('rewrites every child, keeps tag lines byte-identical and the line count stable', async () => {
    const spy = spyRewriter(`${BASE}media.m3u8`);
    const before = MEDIA_PLAYLIST.split('\n');
    const after = (await rewriteMediaPlaylist(spy.input, MEDIA_PLAYLIST)).split('\n');
    expect(after.length).toBe(before.length);
    for (const index of [0, 1, 2, 3, 6, 8, 9, 12, 14, 15]) expect(after[index], before[index]).toBe(before[index]);
    expect(after[4]).toBe('#EXT-X-KEY:METHOD=AES-128,URI="/proxy/media/e_7.1?exp=1&sig=x",IV=0x0a1b,KEYFORMAT="identity",KEYFORMATVERSIONS="1"');
    expect(after[5]).toBe('#EXT-X-MAP:URI="/proxy/media/e_7.2?exp=1&sig=x"');
    expect(after[11]).toBe('#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="原声",URI="/proxy/media/e_7.5?exp=1&sig=x"');
    expect(spy.targets).toEqual([
      `${UP}/keys/key?v=1,2`,
      `${BASE}init.mp4?tag=a,b`,
      `${BASE}seg-100.ts`,
      `${UP}/abs/seg-101.ts`,
      `${BASE}audio/main.m3u8`,
      `${BASE}seg-102.ts?t=1,2#note`
    ]);
  });

  it('does not read a quoted comma as an attribute separator', async () => {
    const spy = spyRewriter(`${BASE}master.m3u8`);
    const after = await rewriteMediaPlaylist(spy.input, MASTER_PLAYLIST);
    expect(after.split('\n').length).toBe(MASTER_PLAYLIST.split('\n').length);
    expect(after).toContain('NAME="中文,字幕"');
    expect(after).toContain('# a reader comment must survive');
    expect(spy.targets).toEqual([
      `${BASE}subs/zh.m3u8`,
      `${BASE}720/playlist.m3u8`,
      `${BASE}low/playlist.m3u8?tab=1#tail`,
      `${BASE}iframe.m3u8`
    ]);
  });

  it('refuses to rewrite a child whose resolved origin is not whitelisted', async () => {
    const spy = spyRewriter(`${BASE}media.m3u8`);
    const hostileKey = MEDIA_PLAYLIST.replace(`${UP}/keys/key`, 'https://key.invalid.evil.test/keys/key');
    await expect(rewriteMediaPlaylist(spy.input, hostileKey)).rejects.toThrowError(UpstreamTargetRejectedError);
    await expect(rewriteMediaPlaylist(spy.input, '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nhttp://169.254.169.254/x\n')).rejects.toThrowError(
      UpstreamTargetRejectedError
    );
    // A playlist whose own base URL is unusable cannot resolve any relative child: refuse, never pass through.
    await expect(rewriteMediaPlaylist({ ...spy.input, playlistUrl: 'no-such-base' }, '#EXTM3U\n#EXTINF:1,\na.ts\n')).rejects.toThrowError(
      HlsReferenceUnresolvableError
    );
    expect(() => assertAllowedTarget(`${UP}/ok.m3u8`, ALLOWED)).not.toThrow();
  });

  it('serves a master through the proxy with only same-origin children and no upstream host', async () => {
    const fixture = await routeFixture();
    const url = await signedMedia(fixture.env, fixture.episodeId, MASTER_TARGET);
    const response = await ask(fixture, url);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/vnd.apple.mpegurl');
    expect(response.headers.get('Accept-Ranges')).toBe('none');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text();
    expect(text).not.toContain('cdn.invalid');
    expect(text.split('\n').length).toBe(MASTER_PLAYLIST.split('\n').length);

    const children = text.match(ABSOLUTE_URL) ?? [];
    expect(children.length).toBe(4);
    for (const child of children) {
      expect(child.startsWith(`${ORIGIN}/proxy/media/`), child).toBe(true);
      const parsed = new URL(child);
      const decoded = await fixture.codec.parse(parsed.pathname.slice('/proxy/media/'.length));
      expect(decoded?.episodeId, child).toBe(fixture.episodeId);
      expect(decoded?.targetUrl.startsWith(BASE), decoded?.targetUrl).toBe(true);
      expect(parsed.searchParams.get('exp'), child).toBe(new URL(url).searchParams.get('exp'));
      expect(parsed.searchParams.get('sig')).not.toBeNull();
    }
  });

  it('re-authorizes each child: a sub-playlist rewrites again and a Range segment is relayed', async () => {
    const fixture = await routeFixture();
    const master = await ask(fixture, await signedMedia(fixture.env, fixture.episodeId, MASTER_TARGET));
    const childUrl = (await master.text()).split('\n')[6];
    const sub = await ask(fixture, childUrl);
    expect(sub.status).toBe(200);
    expect(fixture.calls).toContain(`${BASE}720/playlist.m3u8`);
    const subText = await sub.text();
    expect(subText).not.toContain('cdn.invalid');
    expect(subText.split('\n').filter((line) => line.startsWith('#EXTINF'))).toHaveLength(2);

    const segment = await ask(fixture, await signedMedia(fixture.env, fixture.episodeId, `${BASE}seg-100.ts`), { Range: 'bytes=0-99' });
    expect(segment.status).toBe(206);
    expect(segment.headers.get('Content-Range')).toBe('bytes 0-99/1000');
    expect(segment.headers.get('Content-Length')).toBe('100');
    expect(segment.headers.get('Accept-Ranges')).toBe('bytes');
    expect(segment.headers.get('Content-Type')).toBe('video/mp2t');
    expect(segment.headers.get('ETag')).toBe('"seg-100"');
    expect(segment.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(segment.headers.get('Set-Cookie')).toBeNull();
    expect(await segment.text()).toBe('x'.repeat(100));
    expect(new Headers(fixture.inits[fixture.inits.length - 1]?.headers).get('Range')).toBe('bytes=0-99');
    for (const init of fixture.inits) expect(init.redirect).toBe('manual');
  });

  it('refuses a Range request for a manifest instead of relaying an un-rewritten one', async () => {
    const fixture = await routeFixture();
    const response = await ask(fixture, await signedMedia(fixture.env, fixture.episodeId, MASTER_TARGET), { Range: 'bytes=0-10' });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('cdn.invalid');
  });

  it('follows a whitelisted redirect but refuses one that leaves it, without leaking Location', async () => {
    const fixture = await routeFixture();
    const hops: string[] = [];
    const redirecter: UpstreamFetcher = {
      fetch: async (url) => {
        hops.push(url);
        if (url === MASTER_TARGET) return new Response(null, { status: 302, headers: { Location: `${BASE}master-alt.m3u8` } });
        if (url === `${BASE}master-alt.m3u8`) return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/steal' } });
        return new Response(MASTER_PLAYLIST, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
      }
    };
    const response = await handleProxy(new Request(await signedMedia(fixture.env, fixture.episodeId, MASTER_TARGET)), fixture.env, fixture.env.clock, {
      fetcher: redirecter
    });
    expect(response.status).toBe(403);
    expect(hops).toEqual([MASTER_TARGET, `${BASE}master-alt.m3u8`]);
    expect(response.headers.get('Location')).toBeNull();
    expect(await response.text()).not.toContain('127.0.0.1');
  });

  it('answers 503 for an upstream failure and never relays its body or headers', async () => {
    const fixture = await routeFixture();
    const response = await handleProxy(new Request(await signedMedia(fixture.env, fixture.episodeId, `${BASE}seg-7.ts`)), fixture.env, fixture.env.clock, {
      fetcher: { fetch: async () => new Response('上游内部错误 500', { status: 500, headers: { 'X-Upstream-Server': 'cdn.invalid' } }) }
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('X-Upstream-Server')).toBeNull();
    const text = await response.text();
    expect(text).toContain('SERVICE_UNAVAILABLE');
    expect(text).not.toContain('上游内部错误');
  });

  it('never invents a content type for a segment that upstream left unspecified', async () => {
    const fixture = await routeFixture();
    const response = await ask(fixture, await signedMedia(fixture.env, fixture.episodeId, `${BASE}init.mp4`));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBeNull();
    expect(response.headers.get('Accept-Ranges'), 'a full 200 media response advertises byte ranges').toBe('bytes');
    expect(response.headers.get('Cache-Control'), 'upstream gave no directive so it stays uncacheable').toBe('no-store');
  });
});
