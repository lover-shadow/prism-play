import { describe, expect, it } from 'vitest';
import { CHANGES_RETENTION_SECONDS } from '../../edge/src/core/constants';
import { handleChanges } from '../../edge/src/routes/changes';
import { seedContent, seedStandardChannels } from '../support/seed';
import { seedCatalogChange, seedPublishedWork } from '../support/seed-catalog';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';
import type { CatalogChangesResponse, CatalogDeleteChange, CatalogUpsertChange } from '../../edge/src/types/api';

const NOW = TEST_BASE_TIME_SECONDS;
const UPSTREAM_MARK = 'upstream.invalid';
const THREE_KEYS = ['contentId', 'operation', 'revision'];

function changes(query: string): Request {
  return new Request(`http://localhost:8787/api/catalog/changes${query}`);
}

async function call(env: PrismTestEnv, query: string): Promise<Response> {
  return await handleChanges(changes(query), env, env.clock);
}

async function page(env: PrismTestEnv, query: string): Promise<CatalogChangesResponse> {
  return JSON.parse(await (await call(env, query)).text()) as CatalogChangesResponse;
}

const revisionsOf = (body: CatalogChangesResponse): number[] => body.changes.map((change) => change.revision);
const upsertAt = (body: CatalogChangesResponse, index: number): CatalogUpsertChange => body.changes[index] as CatalogUpsertChange;
const deleteAt = (body: CatalogChangesResponse, index: number): CatalogDeleteChange => body.changes[index] as CatalogDeleteChange;
const maxRevision = (env: PrismTestEnv): number => Number(env.db.selectOne('SELECT MAX(revision) AS r FROM public_catalog_changes')?.r);

/** Four published public works at revisions 1..4; d_a carries an upstream poster URL in storage. */
async function fixture(): Promise<PrismTestEnv> {
  const env = await createTestEnv();
  seedStandardChannels(env.db);
  seedPublishedWork(env.db, { id: 'd_a', title: '逆风剧集' });
  seedPublishedWork(env.db, { id: 'd_b', title: '海岸线以西' });
  seedPublishedWork(env.db, { id: 'd_c', title: '深夜便利店' });
  seedPublishedWork(env.db, { id: 'm_a', title: '长夜将尽', channelId: 'movie' });
  env.db.execute('UPDATE content_items SET cover_url = ? WHERE id = ?', `https://${UPSTREAM_MARK}/c.jpg`, 'd_a');
  return env;
}

describe('GET /api/catalog/changes — validation is never a fake empty page', () => {
  it('rejects a missing or malformed after with 400 and no-store', async () => {
    const env = await fixture();
    for (const query of ['', '?after=', '?after=abc', '?after=-1', '?after=1.5', '?after=1e3', '?after=%201', `?after=${'9'.repeat(19)}`]) {
      const response = await call(env, query);
      expect(response.status, query || 'missing after').toBe(400);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
      expect(text).not.toContain('changes');
      expect(text).not.toContain('nextRevision');
    }
  });

  it('rejects a limit outside 1..100 with 400 instead of clamping it', async () => {
    const env = await fixture();
    for (const query of ['?after=0&limit=0', '?after=0&limit=101', '?after=0&limit=abc', '?after=0&limit=-5', '?after=0&limit=1.0']) {
      const response = await call(env, query);
      expect(response.status, query).toBe(400);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
    }
    expect((await call(env, '?after=0&limit=100')).status).toBe(200);
  });

  it('400s a cursor ahead of the current revision instead of pretending the log is empty', async () => {
    const env = await fixture();
    const response = await call(env, '?after=5');
    expect(response.status).toBe(400);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(JSON.parse(await response.text())).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
    expect(maxRevision(env)).toBe(4);
  });
});

describe('GET /api/catalog/changes — replay semantics', () => {
  it('replays upserts and deletes in revision order across a hole, without losing a row', async () => {
    const env = await fixture();
    const full = await page(env, '?after=0');
    expect([revisionsOf(full), full.nextRevision, full.hasMore]).toEqual([[1, 2, 3, 4], 4, false]);

    seedCatalogChange(env.db, 'd_c', 'delete', NOW);
    env.db.execute('DELETE FROM public_catalog_changes WHERE revision = 2');
    expect(env.db.selectOne('SELECT COUNT(*) AS n FROM public_catalog_changes WHERE revision = 2')?.n).toBe(0);
    expect(env.db.selectAll('SELECT revision FROM public_catalog_changes ORDER BY revision').map((row) => Number(row.revision))).toEqual([1, 3, 4, 5]);

    const holes = await page(env, '?after=0');
    expect(revisionsOf(holes)).toEqual([1, 3, 4, 5]);
    expect(holes.changes.map((change) => change.operation)).toEqual(['upsert', 'upsert', 'upsert', 'delete']);
    expect([holes.nextRevision, holes.hasMore]).toEqual([5, false]);
    // The hole never truncates the page and never becomes a fabricated gap-filler entry.
    expect(holes.changes[3]).toEqual({ revision: 5, contentId: 'd_c', operation: 'delete' });
  });

  it('an empty page repeats after and never adds one', async () => {
    const env = await fixture();
    expect(await page(env, '?after=4')).toEqual({ changes: [], nextRevision: 4, hasMore: false });
    expect(await page(env, '?after=4&limit=1')).toEqual({ changes: [], nextRevision: 4, hasMore: false });
    expect(await page(env, '?after=3&limit=1')).toMatchObject({ nextRevision: 4, hasMore: false });
  });

  it('flips hasMore exactly at the limit boundary and pages twice without gaps or duplicates', async () => {
    const env = await fixture();
    const first = await page(env, '?after=0&limit=2');
    expect([revisionsOf(first), first.nextRevision, first.hasMore]).toEqual([[1, 2], 2, true]);
    const second = await page(env, `?after=${first.nextRevision}&limit=2`);
    expect([revisionsOf(second), second.nextRevision, second.hasMore]).toEqual([[3, 4], 4, false]);
    const merged = [...first.changes, ...second.changes];
    expect(new Set(merged.map((change) => change.revision)).size).toBe(4);
    expect(merged.map((change) => change.revision)).toEqual(revisionsOf(await page(env, '?after=0')));
  });

  it('defaults limit to 50 and keeps a 52-row log resumable', async () => {
    const env = await fixture();
    for (let index = 0; index < 48; index += 1) seedCatalogChange(env.db, 'd_a', 'delete', NOW);
    expect(env.db.selectOne('SELECT COUNT(*) AS n FROM public_catalog_changes')?.n).toBe(52);
    const first = await page(env, '?after=0');
    expect(first.changes).toHaveLength(50);
    expect([first.hasMore, first.nextRevision]).toEqual([true, 50]);
    const rest = await page(env, `?after=${first.nextRevision}`);
    expect([rest.changes.length, rest.hasMore, rest.nextRevision]).toEqual([2, false, 52]);
  });

  it('serves a short public cache on pages and no-store on every protocol error', async () => {
    const env = await fixture();
    expect((await call(env, '?after=0')).headers.get('Cache-Control')).toBe('public, max-age=15');
    expect((await call(env, '?after=9')).headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('GET /api/catalog/changes — retention window and 410', () => {
  it('410s a cursor whose needed changes have aged out and asks for a fresh snapshot', async () => {
    const env = await fixture();
    env.clock.advance(CHANGES_RETENTION_SECONDS + 1);
    const response = await call(env, '?after=0');
    expect(response.status).toBe(410);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ success: false, code: 'CATALOG_CURSOR_EXPIRED' });
    expect(text).not.toContain('changes');
    expect(env.db.selectOne('SELECT COUNT(*) AS n FROM public_catalog_changes WHERE changed_at >= ?', env.clock.nowSeconds() - CHANGES_RETENTION_SECONDS)?.n).toBe(0);
  });

  it('serves a page inside the window and never 410s a cursor that needs nothing', async () => {
    const inside = await fixture();
    inside.clock.advance(CHANGES_RETENTION_SECONDS - 86_400);
    expect(revisionsOf(await page(inside, '?after=0'))).toEqual([1, 2, 3, 4]);

    const stale = await fixture();
    stale.clock.advance(CHANGES_RETENTION_SECONDS + 86_400);
    expect((await call(stale, '?after=4')).status).toBe(200);
    expect(await page(stale, '?after=4')).toEqual({ changes: [], nextRevision: 4, hasMore: false });
  });

  it('410s only below the last expired row, so a partially aged log still resyncs without a snapshot', async () => {
    const env = await fixture();
    env.clock.advance(31 * 86_400);
    seedPublishedWork(env.db, { id: 'd_new', title: '黎明巴士' }, env.clock.nowSeconds());
    expect([maxRevision(env), env.db.selectOne('SELECT MIN(revision) AS r FROM public_catalog_changes WHERE changed_at >= ?', NOW + 1)?.r]).toEqual([5, 5]);
    // Revisions 1..4 are needed by `after=0` and are expired.
    expect((await call(env, '?after=0')).status).toBe(410);
    // `after=4` needs only revision 5, which is retained: an expired row behind the cursor is not a gap.
    const resync = await page(env, '?after=4');
    expect([revisionsOf(resync), resync.nextRevision, resync.hasMore]).toEqual([[5], 5, false]);
    expect(upsertAt(resync, 0).item.id).toBe('d_new');
    expect((await call(env, '?after=5')).status).toBe(200);
  });
});

describe('GET /api/catalog/changes — payload rules', () => {
  it('carries a complete public item on upsert and rebuilds it from the CURRENT row', async () => {
    const env = await fixture();
    const body = await page(env, '?after=0');
    expect(Object.keys(body.changes[0]).sort()).toEqual(['contentId', 'item', 'operation', 'revision']);
    expect(upsertAt(body, 0).item).toMatchObject({ id: 'd_a', channelId: 'drama', title: '逆风剧集', isPrivate: false, enabled: true });
    expect(upsertAt(body, 0).item.coverUrl).toBe('http://localhost:8787/proxy/img/d_a');
    expect(JSON.stringify(body)).not.toContain(UPSTREAM_MARK);

    env.db.execute('UPDATE content_items SET title = ?, updated_at = ? WHERE id = ?', '逆风剧集（修复版）', NOW + 60, 'd_a');
    const rebuilt = await page(env, '?after=0');
    expect(upsertAt(rebuilt, 0).item.title).toBe('逆风剧集（修复版）');
    expect(env.db.selectOne('SELECT updated_at AS u FROM content_items WHERE id = ?', 'd_a')?.u).toBe(NOW + 60);
  });

  it('degrades an upsert whose row turned unpublished into a tombstone with no metadata at all', async () => {
    const env = await fixture();
    env.db.execute('UPDATE content_items SET enabled = 0 WHERE id = ?', 'd_b');
    const body = await page(env, '?after=0');
    expect(deleteAt(body, 1)).toEqual({ revision: 2, contentId: 'd_b', operation: 'delete' });
    expect(Object.keys(body.changes[1]).sort()).toEqual(THREE_KEYS);
    expect(JSON.stringify(body)).not.toContain('海岸线以西');
  });

  it('degrades an upsert whose content row is gone to a tombstone', async () => {
    const env = await fixture();
    seedContent(env.db, { id: 'd_orphan', channelId: 'drama', title: '消失剧集' });
    const revision = seedCatalogChange(env.db, 'd_orphan', 'upsert', NOW);
    env.db.execute('DELETE FROM content_items WHERE id = ?', 'd_orphan');
    const body = await page(env, '?after=0');
    expect(deleteAt(body, body.changes.length - 1)).toEqual({ revision, contentId: 'd_orphan', operation: 'delete' });
    expect(JSON.stringify(body)).not.toContain('消失剧集');
  });

  it('never surfaces a private change row written straight into the public log, upsert or tombstone', async () => {
    const env = await fixture();
    seedPublishedWork(env.db, { id: 'd_p', channelId: 'private', title: '私档', isPrivate: 1, shareable: 0 });
    const hiddenUpsert = seedCatalogChange(env.db, 'd_p', 'upsert', NOW);
    expect([hiddenUpsert, maxRevision(env)]).toEqual([5, 5]);

    const body = await page(env, '?after=0');
    expect(revisionsOf(body)).toEqual([1, 2, 3, 4]);
    expect(body.nextRevision).toBe(4);
    expect(JSON.stringify(body)).not.toContain('d_p');
    expect(JSON.stringify(body)).not.toContain('私档');

    seedCatalogChange(env.db, 'd_p', 'delete', NOW);
    expect(env.db.selectOne('SELECT COUNT(*) AS n FROM public_catalog_changes WHERE content_id = ?', 'd_p')?.n).toBe(2);
    expect(revisionsOf(await page(env, '?after=0'))).toEqual([1, 2, 3, 4]);
    // A hidden newest row must not stall the feed: the cursor stays where the public log ends.
    expect(await page(env, '?after=4')).toEqual({ changes: [], nextRevision: 4, hasMore: false });
  });

  it('emits a real delete tombstone with exactly the three contract keys', async () => {
    const env = await fixture();
    seedCatalogChange(env.db, 'd_c', 'delete', NOW);
    const body = await page(env, '?after=3');
    expect(revisionsOf(body)).toEqual([4, 5]);
    expect(Object.keys(body.changes[1]).sort()).toEqual(THREE_KEYS);
    expect(deleteAt(body, 1)).toEqual({ revision: 5, contentId: 'd_c', operation: 'delete' });
    expect(JSON.stringify(body)).not.toContain('深夜便利店');
  });
});
