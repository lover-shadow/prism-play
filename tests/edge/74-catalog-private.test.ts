import { describe, expect, it } from 'vitest';
import { buildClaims, getEdgeKeyMaterial, signJwt } from '../../edge/src/auth/jwt';
import { hashPrivateSessionToken, issuePrivateSession, revokeSession } from '../../edge/src/auth/private-session';
import { PRIVATE_SESSION_HEADER } from '../../edge/src/core/admission';
import { PRIVATE_SESSION_TTL_SECONDS } from '../../edge/src/core/constants';
import { handleCatalog } from '../../edge/src/routes/catalog';
import { CATALOG_PAGE_SIZE } from '../../edge/src/library/manifest';
import { privateChunkKey } from '../../edge/src/library/paths';
import { cardFixture, libraryEnv, seedLibraryAssets, seedPrivateDirectory, seedPrivateManifest, type LibraryEnv } from './library-fixtures';
import { seedDevice, seedStandardChannels } from '../support/seed';
import { TEST_BASE_TIME_SECONDS } from '../support/test-env';
import type { CatalogResponse, ContentItem, DeviceTier } from '../../edge/src/types/api';

const LIVE_UNTIL = TEST_BASE_TIME_SECONDS + 86_400;
const DEVICE_B = 'GY-BBBB0001';
const DEVICE_Q = 'GY-QQQQ0001';
const PRIVATE_CARD = 'd_priv_0001';
const PRIVATE_TITLE = '夜间档案';
const UPSTREAM_MARK = 'upstream.invalid';
const NOT_FOUND_BYTES = JSON.stringify({ success: false, code: 'NOT_FOUND', message: '内容不存在或已下架' });

function catalog(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:8787/api/catalog${query}`, { headers });
}

async function bodyOf(response: Response): Promise<CatalogResponse> {
  return JSON.parse(await response.clone().text()) as CatalogResponse;
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

async function revokedSessionFor(env: LibraryEnv, deviceId: string): Promise<string> {
  const token = (await sessionFor(env, deviceId)).token;
  await revokeSession(env.DB, await hashPrivateSessionToken(token), LIVE_UNTIL, env.clock.nowSeconds());
  return token;
}

async function grantedHeaders(env: LibraryEnv): Promise<Record<string, string>> {
  return { Authorization: await bearer(env, DEVICE_B, 'B'), [PRIVATE_SESSION_HEADER]: (await sessionFor(env, DEVICE_B)).token };
}

/** Public revision 12 plus the ledger rows the double admission reads (tier, private channel config). */
async function fixture(): Promise<LibraryEnv> {
  const env = await libraryEnv();
  seedStandardChannels(env.db);
  seedDevice(env.db, { deviceId: DEVICE_B, tier: 'B', tierName: '高级全源卡', expiresAt: LIVE_UNTIL });
  seedDevice(env.db, { deviceId: DEVICE_Q, tier: 'Q', tierName: '季度畅享卡', expiresAt: LIVE_UNTIL });
  await seedLibraryAssets(env, { revision: 12, channels: { drama: [cardFixture('d_a', { title: '逆风剧集' })] } });
  return env;
}

function privateCard(id: string, title: string, coverUrl: string | null): ContentItem {
  const card = cardFixture(id, { channelId: 'private', title, category: '探索', isPrivate: true });
  if (coverUrl === null) delete card.coverUrl;
  else card.coverUrl = coverUrl;
  return card;
}

describe('GET /api/catalog?channel=private — the double admission decides, nothing else', () => {
  it.each([
    ['anonymous', async () => ({})],
    ['live Q tier', async (env: LibraryEnv) => ({ Authorization: await bearer(env, DEVICE_Q, 'Q') })],
    ['live B tier without a session', async (env: LibraryEnv) => ({ Authorization: await bearer(env, DEVICE_B, 'B') })],
    ['live B tier with a revoked session', async (env: LibraryEnv) => ({ Authorization: await bearer(env, DEVICE_B, 'B'), [PRIVATE_SESSION_HEADER]: await revokedSessionFor(env, DEVICE_B) })]
  ] as const)('%s → byte-identical 404', async (_label, headersFor) => {
    const env = await fixture();
    await seedPrivateManifest(env, 4);
    const response = await handleCatalog(catalog('?channel=private', await headersFor(env)), env, env.clock);
    expect(response.status).toBe(404);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text();
    expect(text).toBe(NOT_FOUND_BYTES);
    for (const secret of ['private', '个人探索', PRIVATE_TITLE, PRIVATE_CARD, UPSTREAM_MARK]) {
      expect(text.toLowerCase(), secret).not.toContain(secret.toLowerCase());
    }
    // Denied callers never reach the private object at all.
    expect(env.r2.storedBytes(privateChunkKey(4, 0))).toBeUndefined();
  });

  it('denied private and an unknown channel are indistinguishable down to the bytes', async () => {
    const env = await fixture();
    const denied = await handleCatalog(catalog('?channel=private'), env, env.clock);
    const unknown = await handleCatalog(catalog('?channel=no_such_channel'), env, env.clock);
    expect(await denied.text()).toBe(await unknown.text());
    expect(denied.headers.get('Content-Type')).toBe(unknown.headers.get('Content-Type'));
  });

  it('a disabled private channel answers 404 even to a granted session', async () => {
    const env = await fixture();
    await seedPrivateDirectory(env, 4, [privateCard(PRIVATE_CARD, PRIVATE_TITLE, '/proxy/img/d_priv_0001')]);
    env.db.execute("UPDATE channels SET enabled = 0 WHERE id = 'private'");
    const response = await handleCatalog(catalog('?channel=private', await grantedHeaders(env)), env, env.clock);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(NOT_FOUND_BYTES);
  });

  it('granted with no private directory published (§C-2b) is an honest empty page, never a 404', async () => {
    const env = await fixture();
    await seedPrivateManifest(env, 4);
    const response = await handleCatalog(catalog('?channel=private', await grantedHeaders(env)), env, env.clock);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await bodyOf(response)).toEqual({ items: [], page: 1, pageSize: CATALOG_PAGE_SIZE, total: 0, revision: 4 });
    expect(await (await handleCatalog(catalog('?channel=drama'), env, env.clock)).text()).not.toContain(PRIVATE_CARD);
  });

  it('granted with a private directory lists cards with session-bound posters, no-store', async () => {
    const env = await fixture();
    const session = await sessionFor(env, DEVICE_B);
    await seedPrivateDirectory(env, 4, [
      privateCard(PRIVATE_CARD, PRIVATE_TITLE, `/proxy/img/${PRIVATE_CARD}`),
      privateCard('d_priv_0002', '无海报私档', null)
    ]);
    const response = await handleCatalog(
      catalog(`?channel=private&pageSize=50`, { Authorization: await bearer(env, DEVICE_B, 'B'), [PRIVATE_SESSION_HEADER]: session.token }),
      env,
      env.clock
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text();
    const body = JSON.parse(text) as CatalogResponse;
    expect(body.items.map((item) => item.id)).toEqual([PRIVATE_CARD, 'd_priv_0002']);
    expect([body.total, body.revision]).toEqual([2, 4]);
    expect(body.items[0].coverUrl).toContain('/proxy/img/');
    expect(body.items[0].coverUrl).toContain('sig=');
    // A cover the asset does not carry must not become a signed handle out of nothing.
    expect(body.items[1].coverUrl).toBeUndefined();
    expect(text).not.toContain('/proxy/img/d_priv_0002');
    expect(text).not.toContain(UPSTREAM_MARK);
  });

  it('the signed poster expires with the session, never beyond it', async () => {
    const env = await fixture();
    const session = await sessionFor(env, DEVICE_B);
    await seedPrivateDirectory(env, 4, [privateCard(PRIVATE_CARD, PRIVATE_TITLE, `/proxy/img/${PRIVATE_CARD}`)]);
    const response = await handleCatalog(
      catalog('?channel=private', { Authorization: await bearer(env, DEVICE_B, 'B'), [PRIVATE_SESSION_HEADER]: session.token }),
      env,
      env.clock
    );
    const cover = (await bodyOf(response)).items[0].coverUrl ?? '';
    expect(Number(new URL(cover).searchParams.get('exp'))).toBeLessThanOrEqual(session.exp);
    expect(Number(new URL(cover).searchParams.get('exp'))).toBeGreaterThan(env.clock.nowSeconds());
  });

  it('a private directory with an upstream cover address is refused, not re-signed from the leak', async () => {
    const env = await fixture();
    await seedPrivateDirectory(env, 4, [privateCard(PRIVATE_CARD, PRIVATE_TITLE, `https://${UPSTREAM_MARK}/c.jpg`)]);
    const response = await handleCatalog(catalog('?channel=private', await grantedHeaders(env)), env, env.clock);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(UPSTREAM_MARK);
  });

  it('never lists a private card on a public page, whatever the caller presents', async () => {
    const env = await fixture();
    await seedPrivateDirectory(env, 4, [privateCard(PRIVATE_CARD, PRIVATE_TITLE, `/proxy/img/${PRIVATE_CARD}`)]);
    for (const channel of ['drama', 'movie', 'anime', 'documentary']) {
      const text = await (await handleCatalog(catalog(`?channel=${channel}`, await grantedHeaders(env)), env, env.clock)).text();
      expect(text, channel).not.toContain(PRIVATE_CARD);
      expect(text, channel).not.toContain(PRIVATE_TITLE);
    }
  });
});
