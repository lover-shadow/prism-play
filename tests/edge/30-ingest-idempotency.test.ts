import { describe, expect, it } from 'vitest';
import { createInMemoryAdapter, type ProviderAdapter, type ProviderPage, type ProviderWork } from '../../edge/src/ingest/adapter';
import { INGEST_MAX_PAGES_PER_RUN, runIngestCycle, type IngestRunReport, type IngestSourceReport } from '../../edge/src/ingest/cron';
import { insert, seedProvider, seedStandardChannels } from '../support/seed';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';

const NOW = TEST_BASE_TIME_SECONDS;
const PROVIDER = 'provider_s1';

function makeWork(sourceItemId: string, sourceRevision: string, title = '都市夜未眠', category = '都市'): ProviderWork {
  return {
    sourceItemId,
    sourceRevision,
    title,
    category,
    synopsis: '一名程序员在深夜的机房里找回生活节奏。',
    coverUrl: 'https://cdn.invalid/poster-night.jpg',
    episodes: [
      { sourceEpisodeId: `${sourceItemId}-e1`, episodeNumber: 1, durationSeconds: 96 },
      { sourceEpisodeId: `${sourceItemId}-e2`, episodeNumber: 2, durationSeconds: 104 }
    ]
  };
}

async function freshEnv(providerId = PROVIDER, enabled = 1): Promise<PrismTestEnv> {
  const env = await createTestEnv();
  seedStandardChannels(env.db);
  seedProvider(env.db, { id: providerId, channelId: 'drama' });
  insert(env.db, 'ingest_sources', { provider_id: providerId, enabled, cursor: null, last_success_at: null, updated_at: NOW });
  return env;
}

function adaptersFor(adapter: ProviderAdapter): Map<string, ProviderAdapter> {
  return new Map([[adapter.providerId, adapter]]);
}

function recordOf(env: PrismTestEnv, sourceItemId: string, sourceRevision: string): Record<string, unknown> | undefined {
  return env.db.selectOne(
    'SELECT * FROM source_records WHERE provider_id = ? AND source_item_id = ? AND source_revision = ?',
    PROVIDER,
    sourceItemId,
    sourceRevision
  );
}

function sourceRow(env: PrismTestEnv): Record<string, unknown> | undefined {
  return env.db.selectOne('SELECT * FROM ingest_sources WHERE provider_id = ?', PROVIDER);
}

/** Sources are reported in `ingest_sources` order (provider id), so entries are addressed by provider. */
function sourceReport(report: IngestRunReport, providerId: string): IngestSourceReport {
  const entry = report.sources.find((candidate) => candidate.providerId === providerId);
  if (entry === undefined) throw new Error(`run report holds no entry for ${providerId}`);
  return entry;
}

describe('F-14 idempotent ingestion (AC-17)', () => {
  it('stores one record per idempotency key and links it without publishing raw rows', async () => {
    const env = await freshEnv();
    const adapter = createInMemoryAdapter(PROVIDER, [{ items: [makeWork('s-1', 'r1'), makeWork('s-2', 'r1', '古风长歌行', '古装')], nextCursor: null }]);

    const report = await runIngestCycle({ db: env.DB, adapters: adaptersFor(adapter), clock: env.clock });

    expect(report.sources).toHaveLength(1);
    expect(report.sources[0].recordsInserted).toBe(2);
    expect(report.sources[0].linked).toBe(2);
    expect(env.db.count('source_records')).toBe(2);
    expect(env.db.selectAll('SELECT status, link_evidence, content_id FROM source_records').map((row) => row.status)).toEqual(['linked', 'linked']);
    expect(env.db.count('content_items')).toBe(2);
    expect(env.db.count('content_episodes')).toBe(4);
    expect(env.db.count('source_episode_links')).toBe(4);
    expect(env.db.count('public_catalog_changes')).toBe(0);

    const first = recordOf(env, 's-1', 'r1');
    expect(first?.metadata_json).toContain('"sourceItemId":"s-1"');
    expect(Number(env.db.selectOne('SELECT json_valid(metadata_json) AS ok FROM source_records WHERE id = ?', Number(first?.id))?.ok)).toBe(1);
    expect(env.db.selectOne('SELECT COUNT(*) AS n FROM source_records WHERE classification_json IS NOT NULL OR model_version IS NOT NULL')?.n).toBe(0);

    const item = env.db.selectOne('SELECT * FROM content_items WHERE id = ?', String(first?.content_id));
    expect(item?.channel_id).toBe('drama');
    expect(item?.category).toBe('都市');
    expect(item?.is_private).toBe(0);
    expect(item?.shareable).toBe(0);
    expect(item?.enabled).toBe(0);
    expect(env.db.selectOne('SELECT category FROM content_items WHERE title = ?', '古风长歌行')?.category).toBe('古装');
  });

  it('re-running the same cycle is a no-op on row counts and stored record state', async () => {
    const env = await freshEnv();
    const pages: ProviderPage[] = [{ items: [makeWork('s-1', 'r1'), makeWork('s-2', 'r1')], nextCursor: null }];
    const adapter = createInMemoryAdapter(PROVIDER, pages);
    await runIngestCycle({ db: env.DB, adapters: adaptersFor(adapter), clock: env.clock });

    const before = env.db.selectAll('SELECT id, updated_at, status, content_id FROM source_records ORDER BY id');
    const countsBefore = {
      records: env.db.count('source_records'),
      items: env.db.count('content_items'),
      episodes: env.db.count('content_episodes'),
      links: env.db.count('source_episode_links')
    };

    const second = await runIngestCycle({ db: env.DB, adapters: adaptersFor(adapter), clock: env.clock });

    expect(adapter.requestedCursors).toEqual([null, null]);
    expect(second.sources[0].recordsDuplicate).toBe(2);
    expect(second.sources[0].recordsInserted).toBe(0);
    expect(second.sources[0].linked).toBe(0);
    expect(env.db.selectAll('SELECT id, updated_at, status, content_id FROM source_records ORDER BY id')).toEqual(before);
    expect({
      records: env.db.count('source_records'),
      items: env.db.count('content_items'),
      episodes: env.db.count('content_episodes'),
      links: env.db.count('source_episode_links')
    }).toEqual(countsBefore);
  });

  it('treats a new source_revision as a fresh record that re-opens processing on the same work', async () => {
    const env = await freshEnv();
    const firstRun = createInMemoryAdapter(PROVIDER, [{ items: [makeWork('s-1', 'r1')], nextCursor: null }]);
    await runIngestCycle({ db: env.DB, adapters: adaptersFor(firstRun), clock: env.clock });
    const originalContentId = String(recordOf(env, 's-1', 'r1')?.content_id);

    const revised = makeWork('s-1', 'r2', '  都市夜未眠·重制版  ');
    const secondRun = createInMemoryAdapter(PROVIDER, [{ items: [revised], nextCursor: null }]);
    await runIngestCycle({ db: env.DB, adapters: adaptersFor(secondRun), clock: env.clock });

    expect(env.db.count('source_records')).toBe(2);
    expect(env.db.count('content_items')).toBe(1);
    const r2 = recordOf(env, 's-1', 'r2');
    expect(r2?.status).toBe('linked');
    expect(r2?.link_evidence).toBe('same_source_id');
    expect(r2?.content_id).toBe(originalContentId);
    expect(env.db.selectOne('SELECT title FROM content_items WHERE id = ?', originalContentId)?.title).toBe('都市夜未眠·重制版');
    expect(env.db.selectOne('SELECT COUNT(*) AS n FROM content_episodes WHERE content_id = ?', originalContentId)?.n).toBe(2);
  });

  it('reports a same-key payload conflict instead of rewriting the stored revision', async () => {
    const env = await freshEnv();
    await runIngestCycle({
      db: env.DB,
      adapters: adaptersFor(createInMemoryAdapter(PROVIDER, [{ items: [makeWork('s-1', 'r1', '都市夜未眠')], nextCursor: null }])),
      clock: env.clock
    });
    const stored = recordOf(env, 's-1', 'r1');

    const rewritten = await runIngestCycle({
      db: env.DB,
      adapters: adaptersFor(createInMemoryAdapter(PROVIDER, [{ items: [makeWork('s-1', 'r1', '标题被改写')], nextCursor: null }])),
      clock: env.clock
    });

    expect(rewritten.sources[0].payloadConflicts).toBe(1);
    expect(rewritten.sources[0].recordsDuplicate).toBe(1);
    expect(env.db.count('source_records')).toBe(1);
    expect(recordOf(env, 's-1', 'r1')?.title).toBe(stored?.title);
    expect(recordOf(env, 's-1', 'r1')?.metadata_json).toBe(stored?.metadata_json);
    expect(recordOf(env, 's-1', 'r1')?.updated_at).toBe(stored?.updated_at);
  });

  it('bounds one wake to the documented page cap and resumes exactly where the cursor stopped', async () => {
    const env = await freshEnv();
    const pages: ProviderPage[] = [];
    for (let index = 1; index <= INGEST_MAX_PAGES_PER_RUN + 2; index += 1) {
      pages.push({ items: [makeWork(`s-${index}`, 'r1')], nextCursor: `c${index + 1}` });
    }
    pages[pages.length - 1].nextCursor = null;

    const capped = await runIngestCycle({
      db: env.DB,
      adapters: adaptersFor(createInMemoryAdapter(PROVIDER, pages)),
      clock: env.clock
    });
    expect(capped.sources[0].pagesFetched).toBe(INGEST_MAX_PAGES_PER_RUN);
    expect(capped.sources[0].passComplete).toBe(false);
    expect(capped.sources[0].cursorAfter).toBe(`c${INGEST_MAX_PAGES_PER_RUN + 1}`);
    expect(sourceRow(env)?.cursor).toBe(`c${INGEST_MAX_PAGES_PER_RUN + 1}`);
    expect(env.db.count('source_records')).toBe(INGEST_MAX_PAGES_PER_RUN);

    const resumeAdapter = createInMemoryAdapter(PROVIDER, pages);
    const resumed = await runIngestCycle({ db: env.DB, adapters: adaptersFor(resumeAdapter), clock: env.clock });
    expect(resumeAdapter.requestedCursors).toEqual([`c${INGEST_MAX_PAGES_PER_RUN + 1}`, `c${INGEST_MAX_PAGES_PER_RUN + 2}`]);
    expect(resumed.sources[0].passComplete).toBe(true);
    expect(resumed.sources[0].recordsInserted).toBe(2);
    expect(sourceRow(env)?.cursor).toBeNull();
    expect(env.db.count('source_records')).toBe(INGEST_MAX_PAGES_PER_RUN + 2);
  });

  it('keeps the cursor at the last consumed page when a provider throws mid-pass', async () => {
    const env = await freshEnv();
    const other = 'provider_m1';
    seedProvider(env.db, { id: other, channelId: 'movie' }, NOW);
    insert(env.db, 'ingest_sources', { provider_id: other, enabled: 1, cursor: null, last_success_at: null, updated_at: NOW });

    const otherAdapter = createInMemoryAdapter(other, [{ items: [makeWork('m-1', 'r1')], nextCursor: null }]);
    const failing: ProviderAdapter = {
      providerId: PROVIDER,
      async fetchPage(cursor: string | null): Promise<ProviderPage> {
        if (cursor !== null) throw new Error('upstream refused');
        return { items: [makeWork('s-1', 'r1')], nextCursor: 'c2' };
      }
    };

    const report = await runIngestCycle({
      db: env.DB,
      adapters: new Map([[PROVIDER, failing], [other, otherAdapter]]),
      clock: env.clock
    });

    const interrupted = sourceReport(report, PROVIDER);
    expect(interrupted.adapterErrorCode).toBe('ADAPTER_UNAVAILABLE');
    expect(interrupted.adapterErrorMessage).toContain('upstream refused');
    expect(interrupted.recordsInserted).toBe(1);
    expect(interrupted.linked).toBe(1);
    expect(sourceRow(env)?.cursor).toBe('c2');
    expect(sourceRow(env)?.last_success_at).toBe(NOW);
    expect(env.db.selectOne('SELECT COUNT(*) AS n FROM source_records WHERE provider_id = ? AND source_item_id = ?', other, 'm-1')?.n).toBe(1);
    expect(env.db.count('source_records')).toBe(2);
  });

  it('never pulls an ingest source that operations disabled', async () => {
    const env = await freshEnv(PROVIDER, 0);
    const adapter = createInMemoryAdapter(PROVIDER, [{ items: [makeWork('s-1', 'r1')], nextCursor: null }]);

    const report = await runIngestCycle({ db: env.DB, adapters: adaptersFor(adapter), clock: env.clock });

    expect(report.sources).toEqual([]);
    expect(adapter.requestedCursors).toEqual([]);
    expect(env.db.count('source_records')).toBe(0);
    expect(env.db.count('content_items')).toBe(0);
  });
});
