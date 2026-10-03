import { describe, expect, it } from 'vitest';
import { handleChanges } from '../../edge/src/routes/changes';
import { CHANGES_MAX_LIMIT } from '../../edge/src/core/constants';
import { chunkKey } from '../../edge/src/library/paths';
import { CHANGES_DIFF_CHUNK_BUDGET } from '../../edge/src/db/change-repo';
import { cardFixture, cardRun, clearCatalogManifest, libraryEnv, putRawShard, seedLibraryAssets, type LibraryEnv } from './library-fixtures';
import type { CatalogChangesResponse, CatalogDeleteChange, CatalogUpsertChange, ContentItem } from '../../edge/src/types/api';

const THREE_KEYS = ['contentId', 'operation', 'revision'];
const PRIVATE_TITLE = '私档';

function changes(query: string): Request {
  return new Request(`http://localhost:8787/api/catalog/changes${query}`);
}

async function call(env: LibraryEnv, query: string): Promise<Response> {
  return await handleChanges(changes(query), env, env.clock);
}

async function page(env: LibraryEnv, query: string): Promise<CatalogChangesResponse> {
  return JSON.parse(await (await call(env, query)).text()) as CatalogChangesResponse;
}

const idsOf = (body: CatalogChangesResponse): string[] => body.changes.map((change) => change.contentId);
const upsertAt = (body: CatalogChangesResponse, index: number): CatalogUpsertChange => body.changes[index] as CatalogUpsertChange;
const deleteAt = (body: CatalogChangesResponse, index: number): CatalogDeleteChange => body.changes[index] as CatalogDeleteChange;

/**
 * Two adjacent revisions: `d_a` unchanged, `d_b` retitled, `d_new` added, `d_gone` removed, and the
 * movie channel untouched. Revision 13 is the published pointer, so `after=12` is replayable.
 */
async function fixture(): Promise<LibraryEnv> {
  const env = await libraryEnv();
  await seedLibraryAssets(env, {
    revision: 12,
    channels: {
      drama: [cardFixture('d_a', { title: '逆风剧集' }), cardFixture('d_b', { title: '海岸线以西' }), cardFixture('d_gone', { title: '深夜便利店' })],
      movie: [cardFixture('m_a', { channelId: 'movie', title: '长夜将尽', category: '悬疑' })]
    }
  });
  await seedLibraryAssets(env, {
    revision: 13,
    channels: {
      drama: [cardFixture('d_a', { title: '逆风剧集' }), cardFixture('d_b', { title: '海岸线以西（修订版）' }), cardFixture('d_new', { title: '黎明巴士' })],
      movie: [cardFixture('m_a', { channelId: 'movie', title: '长夜将尽', category: '悬疑' })]
    }
  });
  return env;
}

describe('GET /api/catalog/changes — validation is never a fake empty page', () => {
  it('rejects a missing or malformed after with 400 and no-store', async () => {
    const env = await fixture();
    for (const query of ['', '?after=', '?after=abc', '?after=-1', '?after=1.5', '?after=1e3', '?after=%201', `?after=${'9'.repeat(19)}`]) {
      const response = await call(env, query);
      expect(response.status, query || 'missing after').toBe(400);
      expect(response.headers.get('Cache-Control'), query).toBe('no-store');
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
      expect(text).not.toContain('changes');
      expect(text).not.toContain('nextRevision');
    }
  });

  it('rejects a limit outside 1..100 with 400 instead of clamping it', async () => {
    const env = await fixture();
    for (const query of ['?after=12&limit=0', `?after=12&limit=${CHANGES_MAX_LIMIT + 1}`, '?after=12&limit=abc', '?after=12&limit=-5', '?after=12&limit=1.0']) {
      const response = await call(env, query);
      expect(response.status, query).toBe(400);
      expect(response.headers.get('Cache-Control'), query).toBe('no-store');
    }
    expect((await call(env, `?after=12&limit=${CHANGES_MAX_LIMIT}`)).status).toBe(200);
  });

  it('400s a cursor ahead of the current revision instead of pretending the log is empty', async () => {
    const env = await fixture();
    const response = await call(env, '?after=14');
    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(JSON.parse(await response.text())).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
    expect(env.r2.objects.has(chunkKey(14, 'drama', 0))).toBe(false);
  });

  it('503s when the manifest that points at the revisions is gone', async () => {
    const env = await fixture();
    await clearCatalogManifest(env);
    const response = await call(env, '?after=12');
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.text()).toContain('SERVICE_UNAVAILABLE');
  });
});

describe('GET /api/catalog/changes — adjacent-revision diff', () => {
  it('replays one revision step: adds, edits and removes, newest pointer echoed', async () => {
    const env = await fixture();
    const body = await page(env, '?after=12');
    expect(idsOf(body)).toEqual(['d_b', 'd_new', 'd_gone']);
    expect(body.nextRevision).toBe(13);
    expect(body.hasMore).toBe(false);
    expect(body.changes.map((change) => change.revision)).toEqual([13, 13, 13]);
    expect(upsertAt(body, 0).item.title).toBe('海岸线以西（修订版）');
    expect(upsertAt(body, 1).item.id).toBe('d_new');
    expect(deleteAt(body, 2)).toEqual({ revision: 13, contentId: 'd_gone', operation: 'delete' });
    expect(Object.keys(body.changes[2]).sort()).toEqual(THREE_KEYS);
    // A removal never carries metadata of the work it removed.
    expect(JSON.stringify(body)).not.toContain('深夜便利店');
  });

  it('an unchanged card is not replayed, not even when the shard re-ordered its fields', async () => {
    const env = await fixture();
    // Rewrite v12's first drama shard with the same three cards in a different key order, so a naive
    // string comparison would report every one of them as changed.
    putRawShard(env, 12, 'drama', 1, {
      items: [
        { channelId: 'drama', category: '逆袭', coverVersion: 'v1', hitsTotal: 9_867, id: 'd_a', isPrivate: false, synopsis: '三十字以内短简介', title: '逆风剧集', coverUrl: '/proxy/img/d_a', episodeCount: 82, firstPublishedAt: 1_790_000_000 },
        { id: 'd_b', channelId: 'drama', title: '海岸线以西', category: '都市', isPrivate: false, coverUrl: '/proxy/img/d_b', coverVersion: 'v1', episodeCount: 82, firstPublishedAt: 1_790_000_000, hitsTotal: 9_867 },
        { id: 'd_gone', channelId: 'drama', title: '深夜便利店', category: '逆袭', isPrivate: false, coverUrl: '/proxy/img/d_gone', coverVersion: 'v1', synopsis: '三十字以内短简介', episodeCount: 82, firstPublishedAt: 1_790_000_000, hitsTotal: 9_867 }
      ],
      page: 1,
      pageSize: 60,
      total: 3,
      revision: 12
    });
    const body = await page(env, '?after=12');
    expect(idsOf(body)).toEqual(['d_b', 'd_new', 'd_gone']);
    expect(body.changes.some((change) => change.contentId === 'd_a')).toBe(false);
  });

  it('a cursor at the current revision repeats itself and never adds one', async () => {
    const env = await fixture();
    expect(await page(env, '?after=13')).toEqual({ changes: [], nextRevision: 13, hasMore: false });
    expect(await page(env, '?after=13&limit=1')).toEqual({ changes: [], nextRevision: 13, hasMore: false });
  });

  it('serves a short public cache on pages and no-store on every protocol error', async () => {
    const env = await fixture();
    expect((await call(env, '?after=12')).headers.get('Cache-Control')).toBe('public, max-age=15');
    expect((await call(env, '?after=14')).headers.get('Cache-Control')).toBe('no-store');
    expect((await call(env, '?after=9')).headers.get('Cache-Control')).toBe('no-store');
  });

  it('ships the card in the shard dialect: a same-origin handle, never a stored upstream address', async () => {
    const env = await fixture();
    const body = await page(env, '?after=12');
    expect(upsertAt(body, 1).item.coverUrl).toBe('/proxy/img/d_new');
    expect(JSON.stringify(body)).not.toContain('upstream');
  });
});

describe('GET /api/catalog/changes — a cursor the assets cannot replay is 410', () => {
  it('410s a cursor older than the published window, whether it is a hole or a pruned revision', async () => {
    const env = await fixture();
    for (const query of ['?after=10', '?after=11']) {
      const response = await call(env, query);
      expect(response.status, query).toBe(410);
      expect(response.headers.get('Cache-Control'), query).toBe('no-store');
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ success: false, code: 'CATALOG_CURSOR_EXPIRED' });
      expect(text).not.toContain('changes');
    }
  });

  it('replays a fresh after=0 client from the current revision instead of forcing a snapshot', async () => {
    const env = await fixture();
    const body = await page(env, '?after=0');
    expect(idsOf(body)).toEqual(['d_a', 'd_b', 'd_new', 'm_a']);
    expect(body.changes.map((change) => change.revision)).toEqual([13, 13, 13, 13]);
    expect([body.nextRevision, body.hasMore]).toEqual([13, false]);
    expect(body.changes.every((change) => change.operation === 'upsert')).toBe(true);
    // A client that never had the work gets no tombstone for the card its predecessor removed.
    expect(idsOf(body)).not.toContain('d_gone');
  });

  it('410s when the previous revision was pruned from the bucket', async () => {
    const env = await fixture();
    for (const key of [...env.r2.objects.keys()]) {
      if (key.startsWith('library/v12/')) env.r2.objects.delete(key);
    }
    expect((await call(env, '?after=12')).status).toBe(410);
  });

  it('410s instead of dropping deletes when the previous revision was wider', async () => {
    const env = await fixture();
    // The extra shard lives at `chunk-1`, one past the current revision's declared inventory: the
    // probe is what notices the older revision was wider than anything this page can bound.
    putRawShard(env, 12, 'drama', 2, { items: [cardFixture('d_wide', { title: '溢出卡片' })], page: 2, pageSize: 60, total: 61, revision: 12 });
    expect((await call(env, '?after=12')).status).toBe(410);
  });

  it('410s a diff too wide for one page instead of shipping half of it', async () => {
    const env = await fixture();
    expect((await call(env, '?after=12&limit=2')).status).toBe(410);
    expect((await call(env, '?after=12&limit=3')).status).toBe(200);
  });

  it('410s a revision too wide to read inside one invocation, before spending the reads', async () => {
    const env = await libraryEnv();
    const cards: ContentItem[] = cardRun('drama', (CHANGES_DIFF_CHUNK_BUDGET + 1) * 60);
    await seedLibraryAssets(env, { revision: 12, channels: { drama: cards } });
    await seedLibraryAssets(env, { revision: 13, channels: { drama: [...cards.slice(1), cardFixture('d_extra')] } });
    const response = await call(env, '?after=12');
    expect(response.status).toBe(410);
  });

  it('never surfaces a private card that a broken publish left in a public shard', async () => {
    const env = await fixture();
    putRawShard(env, 13, 'drama', 1, {
      items: [
        cardFixture('d_a'),
        cardFixture('d_priv', { channelId: 'private', title: PRIVATE_TITLE, category: '探索', isPrivate: true })
      ],
      page: 1,
      pageSize: 60,
      total: 2,
      revision: 13
    });
    const response = await call(env, '?after=12');
    expect(response.status).toBe(410);
    const text = await response.text();
    expect(text).not.toContain(PRIVATE_TITLE);
    expect(text).not.toContain('d_priv');
  });
});
