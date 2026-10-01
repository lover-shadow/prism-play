import { describe, expect, it } from 'vitest';
import { buildClaims, getEdgeKeyMaterial, signJwt } from '../../edge/src/auth/jwt';
import { hashPrivateSessionToken, issuePrivateSession, revokeSession } from '../../edge/src/auth/private-session';
import { PLAYBACK_HANDLE_TTL_SECONDS, PRIVATE_SESSION_TTL_SECONDS } from '../../edge/src/core/constants';
import { createMediaHandleCodec } from '../../edge/src/core/media-handle';
import { buildProxyUrl, issueSignedProxyUrl, signProxyTarget } from '../../edge/src/core/proxy-signature';
import type { TargetRejectionReason, UpstreamFetcher } from '../../edge/src/media/upstream';
import { assertAllowedTarget, UpstreamTargetRejectedError } from '../../edge/src/media/upstream';
import { handleProxy } from '../../edge/src/routes/proxy';
import { PERMANENT_EXPIRES_AT } from '../../edge/src/types/api';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';
import { seedContent, seedDevice, seedEpisode, seedEpisodeSource, seedProvider, seedStandardChannels } from '../support/seed';

const ORIGIN = 'http://localhost:8787';
const UP = 'https://cdn.invalid';
const DEVICE_B = 'GY-BBBB0001';
const PUBLIC_TARGET = `${UP}/hls/master.m3u8`;
const PRIVATE_TARGET = `${UP}/hls/private-master.m3u8`;
const UNKNOWN_EPISODE = 999_999;
const TINY_PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:10,\nseg-1.ts\n#EXT-X-ENDLIST\n';

/** Nothing in this suite may reach the network: an unstubbed call fails closed into a 503. */
const NO_NETWORK: UpstreamFetcher = {
  fetch: async () => {
    throw new Error('the suite must inject a fake upstream');
  }
};

function stub(body: string, contentType: string, extra?: Record<string, string>) {
  const calls: string[] = [];
  return {
    calls,
    fetcher: {
      fetch: async (url: string) => {
        calls.push(url);
        return new Response(body, { status: 200, headers: { 'Content-Type': contentType, ...extra } });
      }
    } as UpstreamFetcher
  };
}

interface Fixture {
  env: PrismTestEnv;
  publicEpisode: number;
  privateEpisode: number;
}

async function fixture(): Promise<Fixture> {
  const env = await createTestEnv();
  seedStandardChannels(env.db);
  seedDevice(env.db, { deviceId: DEVICE_B, tier: 'B', tierName: '高级全源卡', expiresAt: PERMANENT_EXPIRES_AT });
  seedProvider(env.db, { id: 'provider_s1', channelId: 'drama', upstreamUrl: `${UP}/catalog`, latencyMs: 40 });
  seedContent(env.db, { id: 'd_public', channelId: 'drama', title: '公开剧', coverUrl: `${UP}/cover/d_public.jpg`, coverVersion: 'v7' });
  seedContent(env.db, { id: 'd_private', channelId: 'private', title: '私密剧', isPrivate: 1, shareable: 0, coverUrl: `${UP}/cover/d_private.jpg`, coverVersion: 'v8' });
  seedContent(env.db, { id: 'd_off', channelId: 'drama', title: '已下架剧', enabled: 0 });
  const publicEpisode = seedEpisode(env.db, 'd_public', 1, 132);
  const privateEpisode = seedEpisode(env.db, 'd_private', 1, 100);
  seedEpisodeSource(env.db, { episodeId: publicEpisode, providerId: 'provider_s1', upstreamMediaUrl: PUBLIC_TARGET });
  seedEpisodeSource(env.db, { episodeId: privateEpisode, providerId: 'provider_s1', upstreamMediaUrl: PRIVATE_TARGET });
  return { env, publicEpisode, privateEpisode };
}

/** Mints exactly what `GET .../playback` would mint, so the guard under test is the route's own path. */
async function signedMedia(env: PrismTestEnv, episodeId: number, target: string, secret = env.PROXY_SIGNING_SECRET): Promise<string> {
  const handle = await (await createMediaHandleCodec(env.PROXY_SIGNING_SECRET)).mint(episodeId, target);
  const exp = env.clock.nowSeconds() + PLAYBACK_HANDLE_TTL_SECONDS;
  return buildProxyUrl(ORIGIN, 'media', handle, {
    expSeconds: exp,
    signature: await signProxyTarget(secret, 'media', handle, exp)
  });
}

function ask(env: PrismTestEnv, url: string, headers: HeadersInit = {}, fetcher: UpstreamFetcher = NO_NETWORK): Promise<Response> {
  return handleProxy(new Request(url, { headers }), env, env.clock, { fetcher });
}

async function admitted(env: PrismTestEnv): Promise<{ headers: HeadersInit; token: string; exp: number }> {
  const { signing } = await getEdgeKeyMaterial(env.JWT_PRIVATE_KEY_JWK);
  const claims = buildClaims({ deviceId: DEVICE_B, tier: 'B', expiresAt: PERMANENT_EXPIRES_AT, issuedAt: TEST_BASE_TIME_SECONDS, jti: 'j-proxy' });
  const issued = await issuePrivateSession(env.PRIVATE_SESSION_SECRET, DEVICE_B, env.clock.nowSeconds(), PRIVATE_SESSION_TTL_SECONDS);
  return {
    headers: { Authorization: `Bearer ${await signJwt(claims, signing, 'p2026')}`, 'X-Private-Session': issued.token },
    token: issued.token,
    exp: issued.payload.exp
  };
}

/** Absolute targets that must never be fetched, each with the rejection reason it must produce. */
const REJECTIONS: readonly (readonly [string, string, TargetRejectionReason])[] = [
  ['回环 IPv4', 'http://127.0.0.1/x.m3u8', 'forbidden_ip'],
  ['云元数据', 'http://169.254.169.254/latest/meta-data', 'forbidden_ip'],
  ['私网 10/8', 'http://10.1.2.3/x.m3u8', 'forbidden_ip'],
  ['私网 192.168/16', 'http://192.168.4.1/x.m3u8', 'forbidden_ip'],
  ['未指定地址', 'http://0.0.0.0/x.m3u8', 'forbidden_ip'],
  ['非规范 IPv4', 'http://127.1/x.m3u8', 'forbidden_ip'],
  ['十进制整数 IP', 'http://2130706433/x.m3u8', 'forbidden_ip'],
  ['IPv6 环回', 'http://[::1]/x.m3u8', 'forbidden_ip'],
  ['IPv6 唯一本地', 'http://[fd00::10]/x.m3u8', 'forbidden_ip'],
  ['IPv6 链路本地', 'http://[fe80::1]/x.m3u8', 'forbidden_ip'],
  ['IPv4 映射 IPv6', 'http://[::ffff:127.0.0.1]/x.m3u8', 'forbidden_ip'],
  ['6to4 内嵌环回', 'http://[2002:7f00:1::]/x.m3u8', 'forbidden_ip'],
  ['localhost', 'https://localhost/x.m3u8', 'reserved_hostname'],
  ['mDNS 后缀', 'https://router.local/x.m3u8', 'reserved_hostname'],
  ['内网后缀', 'https://origin.internal/x.m3u8', 'reserved_hostname'],
  ['file 协议', 'file:///etc/passwd', 'scheme'],
  ['data 协议', 'data:text/plain,hello', 'scheme'],
  ['gopher 协议', 'gopher://cdn.invalid/x', 'scheme'],
  ['协议降级', 'ftp://cdn.invalid/x.m3u8', 'scheme'],
  ['内嵌凭据', 'https://admin:pwned@cdn.invalid/x.m3u8', 'credentials'],
  ['前缀伪装主机', 'https://cdn.invalid.evil.test/x.m3u8', 'not_allowlisted'],
  ['相似端口', 'https://cdn.invalid:8443/x.m3u8', 'not_allowlisted'],
  ['不可解析', 'not a url at all', 'unparseable']
];

describe('controlled proxy target guard (API-SPEC §六 白名单 + 防 SSRF)', () => {
  it('refuses every hostile target form before any network call', () => {
    const allowed = new Set([UP]);
    for (const [label, target, reason] of REJECTIONS) {
      expect(() => assertAllowedTarget(target, allowed), label).toThrowError(UpstreamTargetRejectedError);
      try {
        assertAllowedTarget(target, allowed);
      } catch (error) {
        expect((error as UpstreamTargetRejectedError).reason, label).toBe(reason);
      }
    }
  });

  it('refuses a special-purpose IP literal even when an operator whitelists it', () => {
    const hostile = ['http://127.0.0.1/x.m3u8', 'http://169.254.169.254/', 'http://[::1]/x', 'http://10.0.0.9/x'];
    const permissive = new Set(['http://127.0.0.1', 'http://169.254.169.254', 'http://[::1]', 'http://10.0.0.9']);
    for (const target of hostile) {
      expect(() => assertAllowedTarget(target, permissive), target).toThrowError(UpstreamTargetRejectedError);
    }
  });

  it('accepts an allowlisted origin and keeps path, query and fragment intact', () => {
    const url = assertAllowedTarget(`${UP}/hls/a.m3u8?x=1,2#frag`, new Set([UP]));
    expect(url.origin).toBe(UP);
    expect(url.pathname).toBe('/hls/a.m3u8');
    expect(url.search).toBe('?x=1,2');
    expect(url.hash).toBe('#frag');
  });

  it('refuses unsigned, expired, foreign-signed and tampered media URLs with one indistinguishable 403', async () => {
    const { env, publicEpisode, privateEpisode } = await fixture();
    const unsigned = new URL(await signedMedia(env, publicEpisode, PUBLIC_TARGET));
    unsigned.searchParams.delete('sig');
    unsigned.searchParams.delete('exp');
    const foreign = await signedMedia(env, publicEpisode, PUBLIC_TARGET, 'another-tenant-secret');
    const valid = await signedMedia(env, publicEpisode, PUBLIC_TARGET);
    const tampered = valid.replace('sig=', 'sig=deadbeef');
    const privateUnsigned = new URL(await signedMedia(env, privateEpisode, PRIVATE_TARGET));
    privateUnsigned.searchParams.delete('sig');
    privateUnsigned.searchParams.delete('exp');
    env.clock.advance(PLAYBACK_HANDLE_TTL_SECONDS + 1);
    const bodies: string[] = [];
    const cases: readonly (readonly [string, string])[] = [
      ['完全未签名', unsigned.toString()],
      ['缺少签名', privateUnsigned.toString()],
      ['异密钥签名', foreign],
      ['篡改签名', tampered],
      ['已过期', valid]
    ];
    for (const [label, url] of cases) {
      const response = await ask(env, url);
      expect(response.status, label).toBe(403);
      expect(response.headers.get('Cache-Control'), label).toBe('no-store');
      const text = await response.text();
      // Ruling G2 A-1 gave this refusal its own ratified code; the body still reveals nothing about the
      // target, so unsigned / expired / foreign-key / tampered / non-whitelisted stay indistinguishable.
      expect(JSON.parse(text), label).toMatchObject({ success: false, code: 'PROXY_SIGNATURE_INVALID' });
      expect(response.headers.get('Cache-Control'), label).toBe('no-store');
      bodies.push(`${response.status}|${response.headers.get('Cache-Control')}|${text}`);
    }
    // The 403 is raised before D1 is consulted, so it cannot single out a private target: public and
    // private unsigned URLs answer with one indistinguishable status and header set.
    expect(new Set(bodies).size, '五种失效共用一个不可区分的响应体').toBe(1);
  });

  it('answers a correctly signed but unparseable sealed handle with the undifferentiated 404', async () => {
    const { env } = await fixture();
    const handle = 'e_5.aW52YWxpZGl2dg.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const exp = env.clock.nowSeconds() + 600;
    const signature = await signProxyTarget(env.PROXY_SIGNING_SECRET, 'media', handle, exp);
    const response = await ask(env, buildProxyUrl(ORIGIN, 'media', handle, { expSeconds: exp, signature }));
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('refuses a signed media URL whose sealed target left the whitelist, without fetching it', async () => {
    const { env, publicEpisode } = await fixture();
    const drifted = stub(TINY_PLAYLIST, 'application/vnd.apple.mpegurl');
    const response = await ask(env, await signedMedia(env, publicEpisode, 'https://drifted.invalid/master.m3u8'), {}, drifted.fetcher);
    expect(response.status).toBe(403);
    expect(drifted.calls).toEqual([]);
    expect(await response.text()).not.toContain('drifted.invalid');
  });

  it('makes a private episode without a session indistinguishable from an unknown episode', async () => {
    const { env, privateEpisode } = await fixture();
    const upstream = stub(TINY_PLAYLIST, 'application/vnd.apple.mpegurl');
    const privateResponse = await ask(env, await signedMedia(env, privateEpisode, PRIVATE_TARGET), {}, upstream.fetcher);
    const unknownResponse = await ask(env, await signedMedia(env, UNKNOWN_EPISODE, PUBLIC_TARGET), {}, upstream.fetcher);
    expect(privateResponse.status).toBe(404);
    expect(unknownResponse.status).toBe(404);
    expect(await privateResponse.text()).toBe(await unknownResponse.text());
    expect(privateResponse.headers.get('Cache-Control')).toBe('no-store');
    expect(unknownResponse.headers.get('Cache-Control')).toBe('no-store');
    expect(upstream.calls).toEqual([]);
  });

  it('serves a private episode while admitted and 404s it again after the revocation write', async () => {
    const { env, privateEpisode } = await fixture();
    const session = await admitted(env);
    const url = await signedMedia(env, privateEpisode, PRIVATE_TARGET);
    const upstream = stub(TINY_PLAYLIST, 'application/vnd.apple.mpegurl');
    const granted = await ask(env, url, session.headers, upstream.fetcher);
    expect(granted.status).toBe(200);
    expect(granted.headers.get('Cache-Control')).toBe('no-store');
    expect(granted.headers.get('Vary')).toBeNull();
    expect(await granted.text()).toContain('#EXTM3U');
    expect(upstream.calls).toEqual([PRIVATE_TARGET]);

    // The DELETE /api/private-sessions effect: a hash-only tombstone that the next request must see.
    await revokeSession(env.DB, await hashPrivateSessionToken(session.token), session.exp, env.clock.nowSeconds());
    const revoked = await ask(env, url, session.headers, upstream.fetcher);
    expect(revoked.status).toBe(404);
    expect(revoked.headers.get('Cache-Control')).toBe('no-store');
    expect(await revoked.text()).toContain('NOT_FOUND');
  });

  it('404s identically when the only source is disabled and when the row is withdrawn', async () => {
    const { env, publicEpisode } = await fixture();
    env.db.execute('UPDATE episode_sources SET enabled = 0 WHERE episode_id = ?', publicEpisode);
    const noSource = await ask(env, await signedMedia(env, publicEpisode, PUBLIC_TARGET));
    expect(noSource.status).toBe(404);
    env.db.execute('UPDATE episode_sources SET enabled = 1 WHERE episode_id = ?', publicEpisode);
    env.db.execute('UPDATE content_items SET enabled = 0 WHERE id = ?', 'd_public');
    const withdrawn = await ask(env, await signedMedia(env, publicEpisode, PUBLIC_TARGET));
    expect(withdrawn.status).toBe(404);
    expect(await withdrawn.text()).toBe(await noSource.text());
  });

  it('serves a public poster unsigned with an ETag, then 304s without touching upstream', async () => {
    const { env } = await fixture();
    let fetched = 0;
    const fetcher: UpstreamFetcher = {
      fetch: async () => {
        fetched += 1;
        return new Response(new Uint8Array([0xff, 0xd8, 0x1, 0x2]), {
          status: 200,
          headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=99999', 'Set-Cookie': 'session=leak' }
        });
      }
    };
    const first = await ask(env, `${ORIGIN}/proxy/img/d_public`, {}, fetcher);
    expect(first.status).toBe(200);
    expect(first.headers.get('ETag')).toBe('"img-d_public-v7"');
    expect(first.headers.get('Content-Type')).toBe('image/jpeg');
    expect(first.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(first.headers.get('Set-Cookie')).toBeNull();
    expect((await first.arrayBuffer()).byteLength).toBe(4);
    expect(fetched).toBe(1);

    const revalidated = await ask(env, `${ORIGIN}/proxy/img/d_public`, { 'If-None-Match': '"img-d_public-v7"' }, fetcher);
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('ETag')).toBe('"img-d_public-v7"');
    expect(fetched, 'a 304 must not reach upstream').toBe(1);
  });

  it('requires both admission and a valid signature for a private poster, and 404s either way', async () => {
    const { env } = await fixture();
    const poster = `${ORIGIN}/proxy/img/d_private`;
    expect((await ask(env, poster)).status).toBe(404);
    const session = await admitted(env);
    expect((await ask(env, poster, session.headers)).status, '无签名的私密海报仍是 404').toBe(404);

    const issued = await issueSignedProxyUrl(ORIGIN, env.PROXY_SIGNING_SECRET, 'img', 'd_private', env.clock.nowSeconds(), PRIVATE_SESSION_TTL_SECONDS);
    const upstream = stub('\u00ff\u00d8bytes', 'image/jpeg', { 'Cache-Control': 'public, max-age=600' });
    const granted = await ask(env, issued.url, session.headers, upstream.fetcher);
    expect(granted.status).toBe(200);
    expect(granted.headers.get('Cache-Control'), '私密海报强制 no-store').toBe('no-store');

    env.clock.advance(PRIVATE_SESSION_TTL_SECONDS + 1);
    expect((await ask(env, issued.url, session.headers, upstream.fetcher)).status).toBe(404);
  });

  it('treats an unknown kind, an unsafe handle and a stray segment as the same 404', async () => {
    const { env } = await fixture();
    for (const path of ['/proxy/video/d_public', '/proxy/img/d_public/extra', '/proxy/img/../etc/passwd', '/proxy/img', '/proxy/img/d%20public']) {
      const response = await ask(env, `${ORIGIN}${path}`);
      expect(response.status, path).toBe(404);
      expect(response.headers.get('Cache-Control'), path).toBe('no-store');
    }
  });
});
