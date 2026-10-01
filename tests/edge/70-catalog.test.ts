import { describe, expect, it } from 'vitest';
import { buildClaims, getEdgeKeyMaterial, signJwt } from '../../edge/src/auth/jwt';
import { hashPrivateSessionToken, issuePrivateSession, revokeSession } from '../../edge/src/auth/private-session';
import { PRIVATE_SESSION_HEADER } from '../../edge/src/core/admission';
import { CATALOG_DEFAULT_PAGE_SIZE, CATALOG_MAX_PAGE_SIZE, PRIVATE_SESSION_TTL_SECONDS } from '../../edge/src/core/constants';
import { handleCatalog } from '../../edge/src/routes/catalog';
import { seedContent, seedDevice, seedStandardChannels } from '../support/seed';
import { seedCatalogChange, seedPublishedWork } from '../support/seed-catalog';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';
import type { CatalogResponse, DeviceTier } from '../../edge/src/types/api';

const LIVE_UNTIL = TEST_BASE_TIME_SECONDS + 86_400;
const DEVICE_B = 'GY-BBBB0001';
const DEVICE_Q = 'GY-QQQQ0001';
const PRIVATE_WORK = 'd_priv_0001';
const PRIVATE_GONE = 'd_priv_0002';
const PRIVATE_TITLE = '夜间档案';
const UPSTREAM_MARK = 'upstream.invalid';
const NOT_FOUND_BYTES = JSON.stringify({ success: false, code: 'NOT_FOUND', message: '内容不存在或已下架' });

function catalog(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:8787/api/catalog${query}`, { headers });
}

async function bearer(env: PrismTestEnv, deviceId: string, tier: DeviceTier): Promise<string> {
  const { signing } = await getEdgeKeyMaterial(env.JWT_PRIVATE_KEY_JWK);
  const claims = buildClaims({ deviceId, tier, expiresAt: LIVE_UNTIL, issuedAt: TEST_BASE_TIME_SECONDS, jti: `j-${deviceId}` });
  return `Bearer ${await signJwt(claims, signing, 'p2026')}`;
}

async function sessionFor(env: PrismTestEnv, deviceId: string): Promise<{ token: string; exp: number }> {
  const issued = await issuePrivateSession(env.PRIVATE_SESSION_SECRET, deviceId, env.clock.nowSeconds(), PRIVATE_SESSION_TTL_SECONDS);
  return { token: issued.token, exp: issued.payload.exp };
}

async function revokedSessionFor(env: PrismTestEnv, deviceId: string): Promise<string> {
  const { token } = await sessionFor(env, deviceId);
  await revokeSession(env.DB, await hashPrivateSessionToken(token), LIVE_UNTIL, env.clock.nowSeconds());
  return token;
}

async function bodyOf(response: Response): Promise<CatalogResponse> {
  return JSON.parse(await response.clone().text()) as CatalogResponse;
}

async function grantedHeaders(env: PrismTestEnv): Promise<Record<string, string>> {
  return { Authorization: await bearer(env, DEVICE_B, 'B'), [PRIVATE_SESSION_HEADER]: (await sessionFor(env, DEVICE_B)).token };
}

/** Three published drama cards, one movie, one delisted drama and two private works (one delisted). */
async function fixture(): Promise<PrismTestEnv> {
  const env = await createTestEnv();
  seedStandardChannels(env.db);
  seedDevice(env.db, { deviceId: DEVICE_B, tier: 'B', tierName: '高级全源卡', expiresAt: LIVE_UNTIL });
  seedDevice(env.db, { deviceId: DEVICE_Q, tier: 'Q', tierName: '季度畅享卡', expiresAt: LIVE_UNTIL });
  seedPublishedWork(env.db, { id: 'd_a', title: '逆风剧集', category: '逆袭', episodes: 2 });
  seedPublishedWork(env.db, { id: 'd_b', title: '海岸线以西', category: '都市' });
  seedPublishedWork(env.db, { id: 'd_c', title: '深夜便利店', category: '逆袭' });
  seedPublishedWork(env.db, { id: 'm_a', title: '长夜将尽', channelId: 'movie', category: '悬疑' });
  seedContent(env.db, { id: 'd_off', channelId: 'drama', title: '已下架剧集', enabled: 0 });
  seedPublishedWork(env.db, { id: PRIVATE_WORK, title: PRIVATE_TITLE, channelId: 'private', isPrivate: 1, shareable: 0 });
  seedContent(env.db, { id: PRIVATE_GONE, channelId: 'private', title: '熄灯的私档', isPrivate: 1, shareable: 0, enabled: 0 });
  // Posters are stored as upstream URLs, which is exactly why they may never reach the wire.
  env.db.execute('UPDATE content_items SET cover_url = ? WHERE id IN (?, ?)', `https://${UPSTREAM_MARK}/cover.jpg`, 'd_a', PRIVATE_WORK);
  return env;
}

describe('GET /api/catalog — public paging, defaults and revision', () => {
  it('page 1 reports the public revision, the defaults and the id-ordered cards', async () => {
    const env = await fixture();
    const response = await handleCatalog(catalog('?channel=drama'), env, env.clock);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(response.headers.get('Vary')).toBe(`Authorization, ${PRIVATE_SESSION_HEADER}`);
    const body = await bodyOf(response);
    expect([body.page, body.pageSize, body.total]).toEqual([1, CATALOG_DEFAULT_PAGE_SIZE, 3]);
    expect(body.items.map((item) => item.id)).toEqual(['d_a', 'd_b', 'd_c']);
    expect(body.revision).toBe(Number(env.db.selectOne('SELECT MAX(revision) AS r FROM public_catalog_changes')?.r));
    expect(body.items.map((item) => item.channelId)).toEqual(['drama', 'drama', 'drama']);
    expect(body.items.every((item) => item.isPrivate === false && item.enabled === true)).toBe(true);
  });

  it('derives coverUrl from the request origin and never ships the stored upstream poster', async () => {
    const env = await fixture();
    const text = await (await handleCatalog(catalog('?channel=drama'), env, env.clock)).text();
    expect(text).toContain('http://localhost:8787/proxy/img/d_a');
    expect(text).not.toContain(UPSTREAM_MARK);
  });

  it('clamps an oversized pageSize and falls back to the defaults on garbage', async () => {
    const env = await fixture();
    expect((await bodyOf(await handleCatalog(catalog('?channel=drama&pageSize=500'), env, env.clock))).pageSize).toBe(CATALOG_MAX_PAGE_SIZE);
    expect(await bodyOf(await handleCatalog(catalog('?channel=drama&pageSize=abc&page=0'), env, env.clock))).toMatchObject({ page: 1, pageSize: CATALOG_DEFAULT_PAGE_SIZE });
    expect(await bodyOf(await handleCatalog(catalog('?channel=drama&page=-3&pageSize=0'), env, env.clock))).toMatchObject({ page: 1, pageSize: CATALOG_DEFAULT_PAGE_SIZE });
  });

  it('walks pages without overlap and repeats the same total and revision', async () => {
    const env = await fixture();
    const first = await bodyOf(await handleCatalog(catalog('?channel=drama&pageSize=2'), env, env.clock));
    const second = await bodyOf(await handleCatalog(catalog(`?channel=drama&pageSize=2&page=2&revision=${first.revision}`), env, env.clock));
    expect(first.items.map((item) => item.id)).toEqual(['d_a', 'd_b']);
    expect(second.items.map((item) => item.id)).toEqual(['d_c']);
    expect([first.page, second.page, second.pageSize, second.total, second.revision]).toEqual([1, 2, 2, 3, first.revision]);
  });

  it('filters by category and honours the filter in total', async () => {
    const env = await fixture();
    const body = await bodyOf(await handleCatalog(catalog('?channel=drama&category=%E9%80%86%E8%A2%AD'), env, env.clock));
    expect(body.items.map((item) => item.id)).toEqual(['d_a', 'd_c']);
    expect(body.total).toBe(2);
    expect(env.db.selectOne("SELECT COUNT(*) AS n FROM content_items WHERE channel_id = 'drama' AND category = '逆袭' AND enabled = 1")?.n).toBe(2);
  });

  it('never lists a delisted work and proves the row is still disabled in D1', async () => {
    const env = await fixture();
    const body = await bodyOf(await handleCatalog(catalog('?channel=drama&pageSize=50'), env, env.clock));
    expect(body.items.some((item) => item.id === 'd_off')).toBe(false);
    expect(body.total).toBe(3);
    expect(env.db.selectOne('SELECT enabled FROM content_items WHERE id = ?', 'd_off')?.enabled).toBe(0);
  });

  it('answers 404 without enumerating channels for a missing, empty, unknown or miscased channel', async () => {
    const env = await fixture();
    for (const query of ['', '?channel=', '?channel=nonexistent', '?channel=PRIVATE', '?channel=private2']) {
      const response = await handleCatalog(catalog(query), env, env.clock);
      expect(response.status, query).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.text(), query).toBe(NOT_FOUND_BYTES);
    }
  });

  it('409s a later page whose revision cursor no longer matches, carrying no catalogue data', async () => {
    const env = await fixture();
    const first = await bodyOf(await handleCatalog(catalog('?channel=drama&pageSize=2'), env, env.clock));
    seedCatalogChange(env.db, 'd_b', 'delete', env.clock.nowSeconds());
    const response = await handleCatalog(catalog(`?channel=drama&pageSize=2&page=2&revision=${first.revision}`), env, env.clock);
    expect(response.status).toBe(409);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ success: false, code: 'CATALOG_REVISION_CONFLICT' });
    for (const leak of ['items', 'total', 'd_a', 'revision']) expect(text).not.toContain(leak);
  });

  it('ignores an unparseable revision instead of 409ing, and accepts an exact one', async () => {
    const env = await fixture();
    expect((await handleCatalog(catalog('?channel=drama&revision=abc'), env, env.clock)).status).toBe(200);
    expect((await handleCatalog(catalog('?channel=drama&revision=4'), env, env.clock)).status).toBe(200);
    expect((await handleCatalog(catalog('?channel=drama&revision=3'), env, env.clock)).status).toBe(409);
  });

  it('keeps private rows out of every public page and proves the D1 CHECK makes it structural', async () => {
    const env = await fixture();
    for (const channel of ['drama', 'movie', 'anime', 'documentary']) {
      const text = await (await handleCatalog(catalog(`?channel=${channel}&pageSize=50`), env, env.clock)).text();
      expect(text, channel).not.toContain(PRIVATE_WORK);
      expect(text, channel).not.toContain(PRIVATE_TITLE);
    }
    // A private card inside a public channel is refused by the schema, not merely by the query.
    expect(() =>
      env.db.execute(
        'INSERT INTO content_items (id, channel_id, title, category, is_private, enabled, shareable, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1, 0, ?, ?)',
        'd_evil', 'drama', '伪装剧集', '逆袭', TEST_BASE_TIME_SECONDS, TEST_BASE_TIME_SECONDS
      )
    ).toThrow();
  });
});

interface Cell {
  label: string;
  granted: boolean;
  headers(env: PrismTestEnv): Promise<Record<string, string>>;
}

const PRIVATE_MATRIX: Cell[] = [
  { label: 'anonymous', granted: false, headers: async () => ({}) },
  { label: 'live Q tier', granted: false, headers: (env) => bearer(env, DEVICE_Q, 'Q').then((Authorization) => ({ Authorization })) },
  { label: 'live B tier without a session', granted: false, headers: (env) => bearer(env, DEVICE_B, 'B').then((Authorization) => ({ Authorization })) },
  { label: 'live B tier with a live session', granted: true, headers: async (env) => ({ Authorization: await bearer(env, DEVICE_B, 'B'), [PRIVATE_SESSION_HEADER]: (await sessionFor(env, DEVICE_B)).token }) },
  { label: 'live B tier with a revoked session', granted: false, headers: async (env) => ({ Authorization: await bearer(env, DEVICE_B, 'B'), [PRIVATE_SESSION_HEADER]: await revokedSessionFor(env, DEVICE_B) }) }
];

describe('GET /api/catalog — channel=private double admission', () => {
  for (const cell of PRIVATE_MATRIX) {
    it(`${cell.label} → ${cell.granted ? 'cards with session-bound posters' : 'byte-identical 404'}`, async () => {
      const env = await fixture();
      const response = await handleCatalog(catalog('?channel=private&pageSize=50', await cell.headers(env)), env, env.clock);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const text = await response.text();
      if (!cell.granted) {
        expect(response.status).toBe(404);
        expect(text).toBe(NOT_FOUND_BYTES);
        for (const secret of ['private', '个人探索', PRIVATE_TITLE, PRIVATE_WORK, PRIVATE_GONE, UPSTREAM_MARK]) {
          expect(text.toLowerCase(), secret).not.toContain(secret.toLowerCase());
        }
        return;
      }
      expect(response.status).toBe(200);
      const body = JSON.parse(text) as CatalogResponse;
      expect(body.items.map((item) => item.id)).toEqual([PRIVATE_WORK]);
      expect(body.total).toBe(1);
      expect(body.items[0].coverUrl).toContain('/proxy/img/');
      expect(body.items[0].coverUrl).toContain('sig=');
      expect(text).not.toContain(UPSTREAM_MARK);
      expect(env.db.selectOne('SELECT COUNT(*) AS n FROM public_catalog_changes WHERE content_id = ?', PRIVATE_WORK)?.n).toBe(0);
    });
  }

  it('a private card without a stored poster carries no coverUrl at all, signed or otherwise', async () => {
    const env = await fixture();
    seedContent(env.db, { id: 'd_priv_0003', channelId: 'private', title: '无海报私档', isPrivate: 1, shareable: 0, enabled: 1 });
    const response = await handleCatalog(
      catalog('?channel=private&pageSize=50', await grantedHeaders(env)),
      env,
      env.clock
    );
    const text = await response.text();
    const body = JSON.parse(text) as CatalogResponse;
    expect(body.items.map((item) => item.id)).toEqual([PRIVATE_WORK, 'd_priv_0003']);
    expect(body.items[1].coverUrl).toBeUndefined();
    expect(text).not.toContain('/proxy/img/d_priv_0003');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
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
    env.db.execute("UPDATE channels SET enabled = 0 WHERE id = 'private'");
    const response = await handleCatalog(
      catalog('?channel=private', { Authorization: await bearer(env, DEVICE_B, 'B'), [PRIVATE_SESSION_HEADER]: (await sessionFor(env, DEVICE_B)).token }),
      env,
      env.clock
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe(NOT_FOUND_BYTES);
  });

  it('the signed poster expires with the session, never beyond it', async () => {
    const env = await fixture();
    const session = await sessionFor(env, DEVICE_B);
    const response = await handleCatalog(
      catalog('?channel=private', { Authorization: await bearer(env, DEVICE_B, 'B'), [PRIVATE_SESSION_HEADER]: session.token }),
      env,
      env.clock
    );
    const cover = (await bodyOf(response)).items[0].coverUrl ?? '';
    expect(Number(new URL(cover).searchParams.get('exp'))).toBeLessThanOrEqual(session.exp);
    expect(Number(new URL(cover).searchParams.get('exp'))).toBeGreaterThan(env.clock.nowSeconds());
  });
});
