import { describe, expect, it } from 'vitest';
import { buildClaims, getEdgeKeyMaterial, signJwt } from '../../edge/src/auth/jwt';
import { hashPrivateSessionToken, issuePrivateSession, revokeSession } from '../../edge/src/auth/private-session';
import { PRIVATE_SESSION_HEADER } from '../../edge/src/core/admission';
import { PRIVATE_SESSION_TTL_SECONDS } from '../../edge/src/core/constants';
import { handleTitles } from '../../edge/src/routes/titles';
import { titleKey } from '../../edge/src/library/paths';
import { cardFixture, clearPrivateManifest, forbidD1Reads, libraryEnv, seedLibraryAssets, seedPrivateManifest, seedTitleAsset, type LibraryEnv } from './library-fixtures';
import { seedDevice, seedStandardChannels } from '../support/seed';
import { TEST_BASE_TIME_SECONDS } from '../support/test-env';
import type { ContentItem, DeviceTier } from '../../edge/src/types/api';
import type { TitleAssetResponse } from '../../edge/src/library/title-asset';

const REVISION = 12;
const PRIVATE_REVISION = 4;
const LIVE_UNTIL = TEST_BASE_TIME_SECONDS + 86_400;
const DEVICE_B = 'GY-BBBB0001';
const DEVICE_Q = 'GY-QQQQ0001';
const PUBLIC_WORK = 'd_a';
const PRIVATE_WORK = 'd_priv_0001';
const PRIVATE_TITLE = '夜间档案';
const UPSTREAM_MARK = 'upstream.invalid';
const NOT_FOUND_BYTES = JSON.stringify({ success: false, code: 'NOT_FOUND', message: '内容不存在或已下架' });

function titles(id: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:8787/api/titles/${id}`, { headers });
}

async function bodyOf(response: Response): Promise<TitleAssetResponse> {
  return JSON.parse(await response.clone().text()) as TitleAssetResponse;
}

async function bearer(env: LibraryEnv, deviceId: string, tier: DeviceTier): Promise<string> {
  const { signing } = await getEdgeKeyMaterial(env.JWT_PRIVATE_KEY_JWK);
  const claims = buildClaims({ deviceId, tier, expiresAt: LIVE_UNTIL, issuedAt: TEST_BASE_TIME_SECONDS, jti: `j-${deviceId}` });
  return `Bearer ${await signJwt(claims, signing, 'p2026')}`;
}

async function sessionFor(env: LibraryEnv, deviceId: string): Promise<{ token: string; exp: number }> {
  const issued = await issuePrivateSession(env.PRIVATE_SESSION_SECRET, deviceId, env.clock.nowSeconds(), PRIVATE_SESSION_TTL_SECONDS);
  return { token: issued.token, exp: issued.payload.exp };
}

async function grantedHeaders(env: LibraryEnv): Promise<Record<string, string>> {
  return { Authorization: await bearer(env, DEVICE_B, 'B'), [PRIVATE_SESSION_HEADER]: (await sessionFor(env, DEVICE_B)).token };
}

async function revokedHeaders(env: LibraryEnv): Promise<Record<string, string>> {
  const token = (await sessionFor(env, DEVICE_B)).token;
  await revokeSession(env.DB, await hashPrivateSessionToken(token), LIVE_UNTIL, env.clock.nowSeconds());
  return { Authorization: await bearer(env, DEVICE_B, 'B'), [PRIVATE_SESSION_HEADER]: token };
}

/** One public work with a three-episode manifest, one private work with its own manifest, one delisted. */
async function fixture(): Promise<LibraryEnv> {
  const env = await libraryEnv();
  seedStandardChannels(env.db);
  seedDevice(env.db, { deviceId: DEVICE_B, tier: 'B', tierName: '高级全源卡', expiresAt: LIVE_UNTIL });
  seedDevice(env.db, { deviceId: DEVICE_Q, tier: 'Q', tierName: '季度畅享卡', expiresAt: LIVE_UNTIL });
  await seedLibraryAssets(env, { revision: REVISION, channels: { drama: [cardFixture(PUBLIC_WORK, { title: '逆风剧集' })] } });
  await seedTitleAsset(env, {
    revision: REVISION,
    workId: PUBLIC_WORK,
    title: '逆风剧集',
    category: '逆袭',
    episodes: [{ episodeNumber: 3, durationSeconds: 90 }, { episodeNumber: 1, title: '第1集', durationSeconds: 120 }, { episodeNumber: 2 }]
  });
  await seedPrivateManifest(env, PRIVATE_REVISION);
  await seedTitleAsset(env, {
    revision: PRIVATE_REVISION,
    workId: PRIVATE_WORK,
    title: PRIVATE_TITLE,
    channelId: 'private',
    isPrivate: true,
    // A stored upstream cover address, which must never be echoed: the route re-derives a signed handle.
    coverUrl: `https://${UPSTREAM_MARK}/c.jpg`,
    episodes: [{ episodeNumber: 1, lines: [{ providerId: 'provider_m1', mediaUrl: 'https://play.invalid/p1.m3u8' }] }]
  });
  return env;
}

describe('GET /api/titles/{id} — public episode manifest from R2', () => {
  it('serves the §3.2 manifest with a day of CDN cache and zero D1 row reads (AC-C3b-1)', async () => {
    const env = await fixture();
    env.DB = forbidD1Reads();
    const response = await handleTitles(titles(PUBLIC_WORK), env, env.clock);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400');
    expect(response.headers.get('Vary')).toBe(`Authorization, ${PRIVATE_SESSION_HEADER}`);
    const body = await bodyOf(response);
    expect([body.workId, body.title, body.channelId, body.isPrivate]).toEqual([PUBLIC_WORK, '逆风剧集', 'drama', false]);
    expect(body.generatedAt).toBe(1_790_000_000);
    expect(body.episodes.map((episode) => episode.episodeNumber)).toEqual([1, 2, 3]);
    expect(body.episodes[0]).toMatchObject({ title: '第1集', durationSeconds: 120 });
    expect(body.episodes[0].lines).toEqual([{ providerId: 'provider_m1', mediaUrl: `https://play.invalid/${PUBLIC_WORK}/e1.m3u8` }]);
    expect(body.episodes[2].durationSeconds).toBe(90);
  });

  it('keeps a compat card projection whose poster is a same-origin handle, never the stored value', async () => {
    const env = await fixture();
    const body = await bodyOf(await handleTitles(titles(PUBLIC_WORK), env, env.clock));
    expect(body.item).toMatchObject({ id: PUBLIC_WORK, channelId: 'drama', title: '逆风剧集', category: '逆袭', isPrivate: false });
    expect(body.item.coverUrl).toBe('http://localhost:8787/proxy/img/d_a');
    expect(body.item.episodeCount).toBe(3);
    expect(await (await handleTitles(titles(PUBLIC_WORK), env, env.clock)).text()).not.toContain(UPSTREAM_MARK);
  });

  it('a card stored without a cover yields no coverUrl on the compat item', async () => {
    const env = await fixture();
    await seedTitleAsset(env, { revision: REVISION, workId: 'd_nocover', coverUrl: null });
    const body = await bodyOf(await handleTitles(titles('d_nocover'), env, env.clock));
    expect(body.item.coverUrl).toBeUndefined();
  });

  it('carries the §3.1 ranking fields when the manifest has them', async () => {
    const env = await fixture();
    await seedTitleAsset(env, { revision: REVISION, workId: 'd_rank', hitsTotal: 4_242, firstPublishedAt: 1_789_999_999 });
    const item: ContentItem = (await bodyOf(await handleTitles(titles('d_rank'), env, env.clock))).item;
    expect(item.hitsTotal).toBe(4_242);
    expect(item.firstPublishedAt).toBe(1_789_999_999);
  });

  it('a work dropped by the next publish is gone on the very next request', async () => {
    const env = await fixture();
    await seedLibraryAssets(env, { revision: 13, channels: { drama: [] } });
    const response = await handleTitles(titles(PUBLIC_WORK), env, env.clock);
    expect(response.status).toBe(404);
    expect(env.r2.objects.has(titleKey(REVISION, PUBLIC_WORK))).toBe(true);
    expect(env.r2.objects.has(titleKey(13, PUBLIC_WORK))).toBe(false);
  });
});

describe('GET /api/titles/{id} — anti-probing 404 is one byte sequence', () => {
  it('answers unknown, unadmitted private and malformed ids with the shared 404', async () => {
    const env = await fixture();
    const probes: [string, Record<string, string>][] = [
      ['d_unknown', {}],
      [PRIVATE_WORK, {}],
      [PRIVATE_WORK, { Authorization: await bearer(env, DEVICE_Q, 'Q') }],
      [PRIVATE_WORK, { Authorization: await bearer(env, DEVICE_B, 'B') }],
      [PRIVATE_WORK, await revokedHeaders(env)]
    ];
    for (const [id, headers] of probes) {
      const response = await handleTitles(titles(id, headers), env, env.clock);
      expect(response.status, id).toBe(404);
      expect(response.headers.get('Cache-Control'), id).toBe('no-store');
      const text = await response.text();
      expect(text, id).toBe(NOT_FOUND_BYTES);
      expect(text.toLowerCase(), id).not.toContain('private');
      expect(text, id).not.toContain(PRIVATE_TITLE);
    }
  });

  it('refuses an empty or traversal-shaped path and tolerates one trailing slash', async () => {
    const env = await fixture();
    for (const id of ['', 'd%2Fa', 'd_a/related', '../api/catalog', 'd_a%2F..']) {
      const response = await handleTitles(titles(id), env, env.clock);
      expect(response.status, id).toBe(404);
      expect(await response.text(), id).toBe(NOT_FOUND_BYTES);
    }
    expect((await handleTitles(titles(`${PUBLIC_WORK}/`), env, env.clock)).status).toBe(200);
  });

  it('refuses to serve a private manifest that a broken publish stored under the public prefix', async () => {
    const env = await fixture();
    await seedTitleAsset(env, { revision: REVISION, workId: 'd_leak', isPrivate: true, title: PRIVATE_TITLE, channelId: 'private' });
    const denied = await handleTitles(titles('d_leak'), env, env.clock);
    expect(denied.status).toBe(404);
    expect(await denied.text()).toBe(NOT_FOUND_BYTES);
    // Even a granted caller is not handed the public-prefix object: the private door reads the private
    // prefix only, and there is no `d_leak` there.
    const granted = await handleTitles(titles('d_leak', await grantedHeaders(env)), env, env.clock);
    expect(granted.status).toBe(404);
    expect(await granted.text()).not.toContain(PRIVATE_TITLE);
  });
});

describe('GET /api/titles/{id} — private manifest behind the double admission', () => {
  it('serves the admitted caller no-store with a session-bound poster (§C-3b-1)', async () => {
    const env = await fixture();
    const session = await sessionFor(env, DEVICE_B);
    const response = await handleTitles(
      titles(PRIVATE_WORK, { Authorization: await bearer(env, DEVICE_B, 'B'), [PRIVATE_SESSION_HEADER]: session.token }),
      env,
      env.clock
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text();
    const body = JSON.parse(text) as TitleAssetResponse;
    expect(body.item).toMatchObject({ id: PRIVATE_WORK, channelId: 'private', title: PRIVATE_TITLE, isPrivate: true });
    expect(body.item.coverUrl).toContain('/proxy/img/');
    expect(body.item.coverUrl).toContain('sig=');
    expect(Number(new URL(body.item.coverUrl ?? '').searchParams.get('exp'))).toBeLessThanOrEqual(session.exp);
    // The playable address lives only here (§3.2), and the provider stays an abstract code.
    expect(body.episodes[0].lines).toEqual([{ providerId: 'provider_m1', mediaUrl: 'https://play.invalid/p1.m3u8' }]);
    // The stored cover address is never echoed: the handle is re-derived from the work id and signed.
    expect(text).not.toContain(UPSTREAM_MARK);
    expect(text).not.toContain('c.jpg');
  });

  it('404s a private work the private revision does not publish', async () => {
    const env = await fixture();
    const response = await handleTitles(titles('d_priv_missing', await grantedHeaders(env)), env, env.clock);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(NOT_FOUND_BYTES);
  });

  it('404s a private work when the private manifest is not published at all', async () => {
    const env = await fixture();
    await clearPrivateManifest(env);
    expect((await handleTitles(titles(PRIVATE_WORK, await grantedHeaders(env)), env, env.clock)).status).toBe(404);
  });

  it('reads the private object only after the predicate grants it', async () => {
    const env = await fixture();
    let reads = 0;
    const realGet = env.r2.get.bind(env.r2);
    env.r2.get = async (key: string) => {
      if (String(key).startsWith('private/')) reads += 1;
      return realGet(key);
    };
    await handleTitles(titles(PRIVATE_WORK), env, env.clock);
    expect(reads).toBe(0);
    await handleTitles(titles(PRIVATE_WORK, await grantedHeaders(env)), env, env.clock);
    expect(reads).toBe(1);
  });
});

describe('GET /api/titles/{id} — a stored object that is not §3.2 is refused', () => {
  it('503s a malformed public manifest instead of guessing a detail page', async () => {
    const env = await fixture();
    env.r2.putText(titleKey(REVISION, PUBLIC_WORK), 'not json');
    const response = await handleTitles(titles(PUBLIC_WORK), env, env.clock);
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toContain('SERVICE_UNAVAILABLE');
  });

  it('503s a manifest whose episode line is not an http(s) address', async () => {
    const env = await fixture();
    env.r2.putText(
      titleKey(REVISION, PUBLIC_WORK),
      JSON.stringify({
        workId: PUBLIC_WORK,
        title: '逆风剧集',
        channelId: 'drama',
        isPrivate: false,
        generatedAt: 1_790_000_000,
        episodes: [{ episodeNumber: 1, lines: [{ providerId: 'provider_m1', mediaUrl: 'javascript:alert(1)' }] }]
      })
    );
    expect((await handleTitles(titles(PUBLIC_WORK), env, env.clock)).status).toBe(503);
  });

  it('503s a manifest whose workId disagrees with the id that was asked for', async () => {
    const env = await fixture();
    env.r2.putText(titleKey(REVISION, PUBLIC_WORK), JSON.stringify({ workId: 'd_other', title: 'x', channelId: 'drama', episodes: [], generatedAt: 1 }));
    expect((await handleTitles(titles(PUBLIC_WORK), env, env.clock)).status).toBe(503);
  });

  it('503s without the R2 binding and without the manifest, and never reads D1 to decide', async () => {
    const env = await fixture();
    const unbound = { ...env, APK_BUCKET: undefined };
    expect((await handleTitles(titles(PUBLIC_WORK), unbound, env.clock)).status).toBe(503);

    await env.kv.delete('catalog:manifest');
    env.DB = forbidD1Reads();
    expect((await handleTitles(titles(PUBLIC_WORK), env, env.clock)).status).toBe(503);
  });

  it('falls back to the revision-free stable key when the versioned manifest is absent (bootstrap shape)', async () => {
    const env = await fixture();
    // Bootstrap ships each title once under the stable key; the versioned read must miss and the
    // stable copy must answer with byte-identical payload semantics.
    const seeded = env.r2.storedBytes(titleKey(REVISION, PUBLIC_WORK)) as string;
    env.r2.putText('library/titles/d_stable.json', seeded.replace(`"workId":"${PUBLIC_WORK}"`, '"workId":"d_stable"'));
    const response = await handleTitles(titles('d_stable'), env, env.clock);
    expect(response.status).toBe(200);
    expect((await bodyOf(response)).workId).toBe('d_stable');
  });

  it('reads only the episode manifest: a detail request never spends a directory shard read', async () => {
    const env = await fixture();
    const keys: string[] = [];
    const realGet = env.r2.get.bind(env.r2);
    env.r2.get = async (key: string) => {
      keys.push(key);
      return realGet(key);
    };
    expect((await handleTitles(titles(PUBLIC_WORK), env, env.clock)).status).toBe(200);
    expect(keys).toEqual([titleKey(REVISION, PUBLIC_WORK)]);
    expect(keys.some((key) => key.includes('chunk-'))).toBe(false);
  });
});
