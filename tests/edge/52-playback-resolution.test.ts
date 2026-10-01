import { describe, expect, it } from 'vitest';
import { buildClaims, getEdgeKeyMaterial, signJwt } from '../../edge/src/auth/jwt';
import { issuePrivateSession } from '../../edge/src/auth/private-session';
import { PLAYBACK_HANDLE_TTL_SECONDS, PRIVATE_SESSION_TTL_SECONDS } from '../../edge/src/core/constants';
import { createMediaHandleCodec } from '../../edge/src/core/media-handle';
import type { UpstreamFetcher } from '../../edge/src/media/upstream';
import { handlePlayback } from '../../edge/src/routes/playback';
import { handleProxy } from '../../edge/src/routes/proxy';
import { PERMANENT_EXPIRES_AT, type PlaybackInfo } from '../../edge/src/types/api';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';
import { seedContent, seedDevice, seedEpisode, seedEpisodeSource, seedProvider, seedStandardChannels } from '../support/seed';

const ORIGIN = 'http://localhost:8787';
const FAST = 'https://cdn.invalid';
const SLOW = 'https://slow.invalid';
const DEVICE_B = 'GY-BBBB0001';
const PLAYLIST = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\na.ts\n#EXT-X-ENDLIST\n';

interface Fixture {
  env: PrismTestEnv;
  episodeId: number;
  draftEpisodeId: number;
  privateEpisodeId: number;
}

async function fixture(): Promise<Fixture> {
  const env = await createTestEnv();
  seedStandardChannels(env.db);
  seedDevice(env.db, { deviceId: DEVICE_B, tier: 'B', tierName: '高级全源卡', expiresAt: PERMANENT_EXPIRES_AT });
  seedProvider(env.db, { id: 'provider_s1', channelId: 'drama', upstreamUrl: `${FAST}/catalog`, latencyMs: 40 });
  seedProvider(env.db, { id: 'provider_s2', channelId: 'drama', upstreamUrl: `${SLOW}/catalog`, latencyMs: 300 });
  seedContent(env.db, { id: 'd_public', channelId: 'drama', title: '公开剧' });
  seedContent(env.db, { id: 'd_draft', channelId: 'drama', title: '未上架剧', enabled: 0 });
  seedContent(env.db, { id: 'd_private', channelId: 'private', title: '私密剧', isPrivate: 1, shareable: 0 });
  const episodeId = seedEpisode(env.db, 'd_public', 1, 132);
  const draftEpisodeId = seedEpisode(env.db, 'd_draft', 1, 60);
  const privateEpisodeId = seedEpisode(env.db, 'd_private', 1, 100);
  seedEpisodeSource(env.db, { episodeId, providerId: 'provider_s1', upstreamMediaUrl: `${FAST}/hls/fast.m3u8` });
  seedEpisodeSource(env.db, { episodeId, providerId: 'provider_s2', upstreamMediaUrl: `${SLOW}/hls/slow.m3u8` });
  seedEpisodeSource(env.db, { episodeId: draftEpisodeId, providerId: 'provider_s1', upstreamMediaUrl: `${FAST}/hls/draft.m3u8` });
  seedEpisodeSource(env.db, { episodeId: privateEpisodeId, providerId: 'provider_s1', upstreamMediaUrl: `${FAST}/hls/private.m3u8` });
  return { env, episodeId, draftEpisodeId, privateEpisodeId };
}

function playback(env: PrismTestEnv, path: string, headers: HeadersInit = {}): Promise<Response> {
  return handlePlayback(new Request(`${ORIGIN}/api/episodes/${path}/playback`, { headers }), env, env.clock);
}

async function playbackBody(env: PrismTestEnv, episodeId: number, headers: HeadersInit = {}): Promise<PlaybackInfo> {
  const response = await playback(env, String(episodeId), headers);
  expect(response.status).toBe(200);
  return (await response.json()) as PlaybackInfo;
}

/** Reads the sealed target back out of the returned URL — the only way to prove which source was picked. */
async function sealedTarget(env: PrismTestEnv, url: string): Promise<{ episodeId: number; targetUrl: string }> {
  const handle = new URL(url).pathname.slice('/proxy/media/'.length);
  const decoded = await (await createMediaHandleCodec(env.PROXY_SIGNING_SECRET)).parse(handle);
  if (decoded === null) throw new Error(`the edge returned a URL whose handle it cannot decode: ${url}`);
  return decoded;
}

async function resolvedTarget(f: Fixture): Promise<string> {
  return (await sealedTarget(f.env, (await playbackBody(f.env, f.episodeId)).url)).targetUrl;
}

async function admitted(env: PrismTestEnv): Promise<HeadersInit> {
  const { signing } = await getEdgeKeyMaterial(env.JWT_PRIVATE_KEY_JWK);
  const claims = buildClaims({ deviceId: DEVICE_B, tier: 'B', expiresAt: PERMANENT_EXPIRES_AT, issuedAt: TEST_BASE_TIME_SECONDS, jti: 'j-playback' });
  const session = await issuePrivateSession(env.PRIVATE_SESSION_SECRET, DEVICE_B, env.clock.nowSeconds(), PRIVATE_SESSION_TTL_SECONDS);
  return { Authorization: `Bearer ${await signJwt(claims, signing, 'p2026')}`, 'X-Private-Session': session.token };
}

describe('episode playback resolution (API-SPEC §一.4)', () => {
  it('returns exactly the PlaybackInfo fields and a same-origin signed manifest handle', async () => {
    const { env, episodeId } = await fixture();
    const response = await playback(env, String(episodeId));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['durationSeconds', 'episodeId', 'expiresInSeconds', 'mimeType', 'url']);
    expect(body).toMatchObject({ episodeId, mimeType: 'application/vnd.apple.mpegurl', durationSeconds: 132 });
    expect(body.expiresInSeconds, 'TTL is the pinned playback handle lifetime').toBe(PLAYBACK_HANDLE_TTL_SECONDS);

    const url = new URL(String(body.url));
    expect(url.origin).toBe(ORIGIN);
    expect(url.pathname).toMatch(/^\/proxy\/media\/e_\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(Number(url.searchParams.get('exp'))).toBe(env.clock.nowSeconds() + PLAYBACK_HANDLE_TTL_SECONDS);
    expect(url.searchParams.get('sig')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await sealedTarget(env, String(body.url))).episodeId).toBe(episodeId);
  });

  it('never names the provider, the upstream address or the source table in the body', async () => {
    const { env, episodeId } = await fixture();
    const text = await (await playback(env, String(episodeId))).text();
    for (const leak of ['cdn.invalid', 'slow.invalid', 'provider', 'upstream', 'apiBase', 'latency', 'healthy']) {
      expect(text, leak).not.toContain(leak);
    }
    expect((await sealedTarget(env, (JSON.parse(text) as PlaybackInfo).url)).targetUrl).toBe(`${FAST}/hls/fast.m3u8`);
  });

  it('picks the lowest-latency healthy source and re-picks when it is disabled or unhealthy', async () => {
    const f = await fixture();
    expect(await resolvedTarget(f)).toBe(`${FAST}/hls/fast.m3u8`);

    f.env.db.execute('UPDATE episode_sources SET enabled = 0 WHERE provider_id = ?', 'provider_s1');
    expect(await resolvedTarget(f), '禁用的分集映射必须跳过').toBe(`${SLOW}/hls/slow.m3u8`);

    f.env.db.execute('UPDATE episode_sources SET enabled = 1 WHERE provider_id = ?', 'provider_s1');
    f.env.db.execute('UPDATE episode_sources SET enabled = 1 WHERE provider_id = ?', 'provider_s1');
    f.env.db.execute('UPDATE source_providers SET healthy = 0 WHERE id = ?', 'provider_s1');
    expect(await resolvedTarget(f), 'Cron 判定不健康的源必须跳过').toBe(`${SLOW}/hls/slow.m3u8`);

    f.env.db.execute('UPDATE source_providers SET healthy = 1, latency_ms = 900 WHERE id = ?', 'provider_s1');
    expect(await resolvedTarget(f), 'Cron 延迟回填后必须改选更快的一路').toBe(`${SLOW}/hls/slow.m3u8`);

    f.env.db.execute('UPDATE source_providers SET latency_ms = 10 WHERE id = ?', 'provider_s1');
    expect(await resolvedTarget(f)).toBe(`${FAST}/hls/fast.m3u8`);
  });

  it('answers 503 when every candidate source is exhausted', async () => {
    const { env, episodeId } = await fixture();
    env.db.execute('UPDATE episode_sources SET enabled = 0 WHERE episode_id = ?', episodeId);
    const response = await playback(env, String(episodeId));
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toContain('SERVICE_UNAVAILABLE');

    // Sources exist again, but no provider is healthy: the other way to run out of candidates.
    env.db.execute('UPDATE episode_sources SET enabled = 1 WHERE episode_id = ?', episodeId);
    env.db.execute('UPDATE source_providers SET healthy = 0');
    expect((await playback(env, String(episodeId))).status).toBe(503);
  });

  it('404s an unknown episode, a draft episode and a malformed id without leaking metadata', async () => {
    const { env, draftEpisodeId } = await fixture();
    const unknown = await playback(env, '999999');
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.text();
    expect(unknownBody).toBe('{"success":false,"code":"NOT_FOUND","message":"内容不存在或已下架"}');
    const draft = await playback(env, String(draftEpisodeId));
    expect(draft.status).toBe(404);
    expect(await draft.text()).toBe(unknownBody);
    for (const path of ['abc', '0', '-3', '1.5', '', '1e3']) {
      expect((await playback(env, path)).status, path).toBe(404);
    }
  });

  it('makes a private episode without a session byte-identical to an unknown episode', async () => {
    const { env, privateEpisodeId } = await fixture();
    const denied = await playback(env, String(privateEpisodeId));
    const unknown = await playback(env, '999999');
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe(await unknown.text());
    expect(denied.headers.get('Cache-Control')).toBe('no-store');
    expect(unknown.headers.get('Cache-Control')).toBe('no-store');

    const granted = await playbackBody(env, privateEpisodeId, await admitted(env));
    expect((await sealedTarget(env, granted.url)).targetUrl).toBe(`${FAST}/hls/private.m3u8`);
  });

  it('omits mimeType rather than guessing when the resolved target has no known suffix', async () => {
    const { env, episodeId } = await fixture();
    env.db.execute('UPDATE episode_sources SET upstream_media_url = ? WHERE provider_id = ?', `${FAST}/hls/stream`, 'provider_s1');
    const body = await playbackBody(env, episodeId);
    expect(Object.keys(body).sort()).toEqual(['durationSeconds', 'episodeId', 'expiresInSeconds', 'url']);
    expect((await sealedTarget(env, body.url)).targetUrl).toBe(`${FAST}/hls/stream`);
  });

  it('hands the client a URL the controlled proxy itself accepts, and revocation of the source kills it', async () => {
    const { env, episodeId } = await fixture();
    const { url } = await playbackBody(env, episodeId);
    const calls: string[] = [];
    const fetcher: UpstreamFetcher = {
      fetch: async (target) => {
        calls.push(target);
        return new Response(PLAYLIST, { status: 200, headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
      }
    };
    const served = await handleProxy(new Request(url), env, env.clock, { fetcher });
    expect(served.status).toBe(200);
    expect(served.headers.get('Cache-Control')).toBe('no-store');
    expect(calls).toEqual([`${FAST}/hls/fast.m3u8`]);
    const text = await served.text();
    expect(text).toContain('#EXTM3U');
    expect(text).not.toContain('cdn.invalid');

    // The source is withdrawn between resolution and取流: the proxy must not honour the old URL.
    env.db.execute('UPDATE episode_sources SET enabled = 0 WHERE episode_id = ?', episodeId);
    expect((await handleProxy(new Request(url), env, env.clock, { fetcher })).status).toBe(404);
  });

  it('rejects a non-GET method and a path that is not the playback endpoint', async () => {
    const { env, episodeId } = await fixture();
    const post = await handlePlayback(new Request(`${ORIGIN}/api/episodes/${episodeId}/playback`, { method: 'POST' }), env, env.clock);
    expect(post.status).toBe(405);
    expect(post.headers.get('Allow')).toBe('GET');
    const stray = await handlePlayback(new Request(`${ORIGIN}/api/episodes/${episodeId}/playback/x`), env, env.clock);
    expect(stray.status).toBe(404);
    expect((await handlePlayback(new Request(`${ORIGIN}/api/episodes/${episodeId}/playback?x=1`), env, env.clock)).status).toBe(200);
  });
});
