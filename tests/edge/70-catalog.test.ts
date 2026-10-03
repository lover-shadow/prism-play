import { describe, expect, it } from 'vitest';
import { handleCatalog } from '../../edge/src/routes/catalog';
import { PRIVATE_SESSION_HEADER } from '../../edge/src/core/admission';
import { CATALOG_PAGE_SIZE } from '../../edge/src/library/manifest';
import { chunkKey } from '../../edge/src/library/paths';
import { cardFixture, cardRun, clearCatalogManifest, forbidD1Reads, libraryEnv, putRawManifest, putRawShard, seedLibraryAssets, type LibraryEnv } from './library-fixtures';
import type { CatalogResponse } from '../../edge/src/types/api';

const REVISION = 12;
const NOT_FOUND_BYTES = JSON.stringify({ success: false, code: 'NOT_FOUND', message: '内容不存在或已下架' });
const UNAVAILABLE_BYTES = JSON.stringify({ success: false, code: 'SERVICE_UNAVAILABLE', message: '服务暂不可用，请稍后重试' });
const UPSTREAM_MARK = 'upstream.invalid';

function catalog(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost:8787/api/catalog${query}`, { headers });
}

async function bodyOf(response: Response): Promise<CatalogResponse> {
  return JSON.parse(await response.clone().text()) as CatalogResponse;
}

/** Two drama cards and one movie, published as one §3.1 revision of shards plus the KV pointer. */
async function fixture(): Promise<LibraryEnv> {
  const env = await libraryEnv();
  await seedLibraryAssets(env, {
    revision: REVISION,
    channels: {
      drama: [
        cardFixture('d_a', { title: '逆风剧集', category: '逆袭', coverVersion: 'v1', isAi: true, isHot: false }),
        cardFixture('d_b', { title: '海岸线以西', category: '都市', firstPublishedAt: 1_790_000_001, hitsTotal: 12 })
      ],
      movie: [cardFixture('m_a', { channelId: 'movie', title: '长夜将尽', category: '悬疑', firstPublishedAt: 1_790_000_002, hitsTotal: 7 })]
    }
  });
  return env;
}

describe('GET /api/catalog — R2 shard passthrough', () => {
  it('serves chunk-(page-1) byte-for-byte with the §3.1 paging fields (§C-3-2)', async () => {
    const env = await fixture();
    const response = await handleCatalog(catalog('?channel=drama'), env, env.clock);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toBe(env.r2.storedBytes(chunkKey(REVISION, 'drama', 0)));
    const body = JSON.parse(text) as CatalogResponse;
    expect([body.page, body.pageSize, body.total, body.revision]).toEqual([1, CATALOG_PAGE_SIZE, 2, REVISION]);
    expect(body.items.map((item) => item.id)).toEqual(['d_a', 'd_b']);
    expect(body.items.map((item) => item.channelId)).toEqual(['drama', 'drama']);
    expect(body.items.every((item) => item.isPrivate === false)).toBe(true);
  });

  it('ships the two §3.1 ranking fields so the device boards can sort without a query', async () => {
    const env = await fixture();
    const body = await bodyOf(await handleCatalog(catalog('?channel=drama'), env, env.clock));
    expect(body.items[0]).toMatchObject({ firstPublishedAt: 1_790_000_000, hitsTotal: 9_867, isAi: true });
    expect(body.items[1]).toMatchObject({ firstPublishedAt: 1_790_000_001, hitsTotal: 12 });
  });

  it('reads zero D1 rows on the browse path (AC-C3-1)', async () => {
    const env = await fixture();
    env.DB = forbidD1Reads();
    const response = await handleCatalog(catalog('?channel=movie'), env, env.clock);
    expect(response.status).toBe(200);
    expect((await bodyOf(response)).items.map((item) => item.id)).toEqual(['m_a']);
  });

  it('writes the first screen to the Cache API at 300s and replays from it (§C-3-1, AC-C3-2)', async () => {
    const env = await fixture();
    const store = new Map<string, Response>();
    let writes = 0;
    (globalThis as Record<string, unknown>).caches = {
      default: {
        match: async (request: Request) => store.get(request.url),
        put: async (request: Request, response: Response) => {
          store.set(request.url, response.clone());
          writes += 1;
        }
      }
    };
    try {
      const first = await handleCatalog(catalog('?channel=drama'), env, env.clock);
      expect(first.headers.get('Cache-Control')).toBe('public, max-age=300');
      expect(writes).toBe(1);

      // The replay must come from the cache namespace, so the bucket it was read from is taken away.
      env.r2.objects.clear();
      const replay = await handleCatalog(catalog('?channel=drama'), env, env.clock);
      expect(replay.status).toBe(200);
      expect((await bodyOf(replay)).items.map((item) => item.id)).toEqual(['d_a', 'd_b']);
      expect(writes).toBe(1);

      const later = await handleCatalog(catalog('?channel=drama&page=2'), env, env.clock);
      expect(later.headers.get('Cache-Control')).toBe('public, max-age=60');
      expect(writes).toBe(1);
    } finally {
      delete (globalThis as Record<string, unknown>).caches;
    }
  });

  it('advertises the credential Vary so a shared cache can never merge a private answer', async () => {
    const env = await fixture();
    const response = await handleCatalog(catalog('?channel=drama'), env, env.clock);
    expect(response.headers.get('Vary')).toBe(`Authorization, ${PRIVATE_SESSION_HEADER}`);
  });

  it('maps page N to chunk-(N-1) across the 60-card boundary without overlap', async () => {
    const env = await fixture();
    await seedLibraryAssets(env, { revision: 13, channels: { drama: cardRun('drama', 121) } });
    const pages = await Promise.all(
      [1, 2, 3].map(async (page) => bodyOf(await handleCatalog(catalog(`?channel=drama&page=${page}&revision=13`), env, env.clock)))
    );
    expect(pages.map((body) => body.items.length)).toEqual([60, 60, 1]);
    expect(pages.map((body) => body.page)).toEqual([1, 2, 3]);
    expect(pages.every((body) => body.total === 121 && body.revision === 13)).toBe(true);
    const ids = pages.flatMap((body) => body.items.map((item) => item.id));
    expect(new Set(ids).size).toBe(121);
  });

  it('serves an honest empty page past the declared inventory instead of a 404', async () => {
    const env = await fixture();
    const response = await handleCatalog(catalog('?channel=drama&page=9'), env, env.clock);
    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ items: [], page: 9, pageSize: CATALOG_PAGE_SIZE, total: 2, revision: REVISION });
  });

  it('narrows a page by category while leaving the shard\'s paging fields to the client', async () => {
    const env = await fixture();
    const hit = await bodyOf(await handleCatalog(catalog('?channel=drama&category=%E9%80%86%E8%A2%AD'), env, env.clock));
    expect(hit.items.map((item) => item.id)).toEqual(['d_a']);
    expect([hit.page, hit.pageSize, hit.total, hit.revision]).toEqual([1, CATALOG_PAGE_SIZE, 2, REVISION]);
    const miss = await bodyOf(await handleCatalog(catalog('?channel=drama&category=nope'), env, env.clock));
    expect([miss.items, miss.total]).toEqual([[], 2]);
  });

  it('honours the shard page size: a requested pageSize never re-splits a page (§3.1 pins 60)', async () => {
    const env = await fixture();
    for (const query of ['?channel=drama&pageSize=500', '?channel=drama&pageSize=abc', '?channel=drama&pageSize=0', '?channel=drama&pageSize=20']) {
      expect((await bodyOf(await handleCatalog(catalog(query), env, env.clock))).pageSize).toBe(CATALOG_PAGE_SIZE);
    }
    expect((await bodyOf(await handleCatalog(catalog('?channel=drama&page=0'), env, env.clock))).page).toBe(1);
    expect((await bodyOf(await handleCatalog(catalog('?channel=drama&page=-3'), env, env.clock))).page).toBe(1);
  });

  it('derives the page from the shard and never ships a stored upstream cover address', async () => {
    const env = await fixture();
    const text = await (await handleCatalog(catalog('?channel=drama'), env, env.clock)).text();
    expect(text).toContain('/proxy/img/d_a');
    expect(text).not.toContain(UPSTREAM_MARK);
  });
});

describe('GET /api/catalog — refusals that must never look like a page', () => {
  it('answers 404 without enumerating channels for a missing, empty, unknown or miscased channel', async () => {
    const env = await fixture();
    for (const query of ['', '?channel=', '?channel=nonexistent', '?channel=DRAMA', '?channel=drama2']) {
      const response = await handleCatalog(catalog(query), env, env.clock);
      expect(response.status, query).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.text(), query).toBe(NOT_FOUND_BYTES);
    }
  });

  it('409s a page whose revision cursor no longer matches and carries no catalogue data', async () => {
    const env = await fixture();
    const response = await handleCatalog(catalog('?channel=drama&page=2&revision=11'), env, env.clock);
    expect(response.status).toBe(409);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text();
    for (const leak of ['items', 'total', 'd_a', 'revision']) expect(text, text).not.toContain(leak);
  });

  it('ignores an unparseable revision instead of 409ing, and accepts an exact one', async () => {
    const env = await fixture();
    expect((await handleCatalog(catalog('?channel=drama&revision=abc'), env, env.clock)).status).toBe(200);
    expect((await handleCatalog(catalog('?channel=drama&revision=12'), env, env.clock)).status).toBe(200);
    expect((await handleCatalog(catalog('?channel=drama&revision=11'), env, env.clock)).status).toBe(409);
  });

  it('503s a missing, unusable or contradictory manifest instead of inventing an empty catalogue', async () => {
    const env = await fixture();
    await clearCatalogManifest(env);
    expect(await (await handleCatalog(catalog('?channel=drama'), env, env.clock)).text()).toBe(UNAVAILABLE_BYTES);

    for (const bad of ['not json', '{"revision":12}', '{"revision":12,"pageSize":20,"channels":{"drama":{"chunks":1,"total":1}}}', '{"revision":12,"channels":"drama"}']) {
      await putRawManifest(env, bad);
      const response = await handleCatalog(catalog('?channel=drama'), env, env.clock);
      expect(response.status, bad).toBe(503);
      expect(response.headers.get('Cache-Control'), bad).toBe('no-store');
    }
  });

  it('503s without the R2 binding, and when the manifest points at a shard that is not on the bucket', async () => {
    const env = await fixture();
    const unbound = { ...env, APK_BUCKET: undefined };
    expect((await handleCatalog(catalog('?channel=drama'), unbound, env.clock)).status).toBe(503);

    env.r2.objects.delete(chunkKey(REVISION, 'drama', 0));
    const response = await handleCatalog(catalog('?channel=drama'), env, env.clock);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe(UNAVAILABLE_BYTES);
  });

  it('refuses a shard that carries a private card, so §2.2 isolation is enforced at the edge as well', async () => {
    const env = await fixture();
    putRawShard(env, REVISION, 'drama', 1, {
      items: [{ id: 'd_secret', channelId: 'private', title: '私密剧', category: '探索', isPrivate: true }],
      page: 1,
      pageSize: CATALOG_PAGE_SIZE,
      total: 1,
      revision: REVISION
    });
    const text = await (await handleCatalog(catalog('?channel=drama'), env, env.clock)).text();
    expect(text).toBe(UNAVAILABLE_BYTES);
    expect(text).not.toContain('d_secret');
    expect(text).not.toContain('私密剧');
  });

  it('refuses a shard whose cover is an upstream address instead of a same-origin handle', async () => {
    const env = await fixture();
    putRawShard(env, REVISION, 'drama', 1, {
      items: [cardFixture('d_a', { coverUrl: `https://${UPSTREAM_MARK}/c.jpg` })],
      page: 1,
      pageSize: CATALOG_PAGE_SIZE,
      total: 1,
      revision: REVISION
    });
    const response = await handleCatalog(catalog('?channel=drama'), env, env.clock);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(UPSTREAM_MARK);
  });

  it('refuses a shard whose revision disagrees with the manifest that pointed at it', async () => {
    const env = await fixture();
    putRawShard(env, REVISION, 'drama', 1, { items: [], page: 1, pageSize: CATALOG_PAGE_SIZE, total: 0, revision: 11 });
    expect((await handleCatalog(catalog('?channel=drama'), env, env.clock)).status).toBe(503);
  });

  it('refuses a shard whose card is missing the contract identity fields', async () => {
    const env = await fixture();
    for (const card of [{ id: 'ok', channelId: 'drama', title: '', category: '都市' }, { id: 'bad/../id', channelId: 'drama', title: 'x', category: '都市' }, { id: 'ok2', channelId: 'drama', title: 'x', category: 1 }]) {
      putRawShard(env, REVISION, 'drama', 1, { items: [card], page: 1, pageSize: CATALOG_PAGE_SIZE, total: 1, revision: REVISION });
      expect((await handleCatalog(catalog('?channel=drama'), env, env.clock)).status, JSON.stringify(card)).toBe(503);
    }
  });
});
