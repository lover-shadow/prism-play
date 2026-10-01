import { describe, expect, it } from 'vitest';
import { createInMemoryAdapter, type ProviderAdapter, type ProviderWork } from '../../edge/src/ingest/adapter';
import { runIngestCycle, type IngestRunReport } from '../../edge/src/ingest/cron';
import { INGEST_RETRY_BACKOFF_SECONDS } from '../../edge/src/ingest/state-machine';
import { INGEST_MAX_AUTO_RETRIES } from '../../edge/src/core/constants';
import { insert, seedProvider, seedStandardChannels } from '../support/seed';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';

const NOW = TEST_BASE_TIME_SECONDS;
const PROVIDER = 'provider_s1';

function goodWork(sourceItemId: string, sourceRevision: string): ProviderWork {
  return {
    sourceItemId,
    sourceRevision,
    title: '雾港缉私',
    category: '悬疑',
    episodes: [{ sourceEpisodeId: `${sourceItemId}-e1`, episodeNumber: 1, durationSeconds: 88 }]
  };
}

/** episode_number 0 violates the DDL CHECK, so the state machine must refuse it before any write. */
function brokenWork(sourceItemId: string, sourceRevision: string): ProviderWork {
  return {
    sourceItemId,
    sourceRevision,
    title: '无名剧目',
    category: '悬疑',
    episodes: [{ sourceEpisodeId: `${sourceItemId}-e0`, episodeNumber: 0 }]
  };
}

async function freshEnv(): Promise<PrismTestEnv> {
  const env = await createTestEnv();
  seedStandardChannels(env.db);
  seedProvider(env.db, { id: PROVIDER, channelId: 'drama' });
  insert(env.db, 'ingest_sources', { provider_id: PROVIDER, enabled: 1, cursor: null, last_success_at: null, updated_at: NOW });
  return env;
}

function adaptersFor(items: ProviderWork[]): Map<string, ProviderAdapter> {
  return new Map([[PROVIDER, createInMemoryAdapter(PROVIDER, [{ items, nextCursor: null }])]]);
}

function recordOf(env: PrismTestEnv, sourceItemId: string): Record<string, unknown> | undefined {
  return env.db.selectOne('SELECT * FROM source_records WHERE provider_id = ? AND source_item_id = ? ORDER BY id DESC LIMIT 1', PROVIDER, sourceItemId);
}

function sourceRow(env: PrismTestEnv): Record<string, unknown> | undefined {
  return env.db.selectOne('SELECT * FROM ingest_sources WHERE provider_id = ?', PROVIDER);
}

/**
 * Keeps waking and jumping the clock to the moment the record itself scheduled, so a test proves the
 * ladder instead of assuming a number of wakes.
 */
async function runUntilQuarantined(env: PrismTestEnv, adapters: Map<string, ProviderAdapter>, sourceItemId: string): Promise<void> {
  for (let wake = 0; wake < INGEST_MAX_AUTO_RETRIES + 2; wake += 1) {
    await runIngestCycle({ db: env.DB, adapters, clock: env.clock });
    const row = recordOf(env, sourceItemId);
    if (row?.status === 'rejected') return;
    if (typeof row?.next_attempt_at !== 'number') return;
    env.clock.advance(Number(row.next_attempt_at) - env.clock.nowSeconds());
  }
  throw new Error(`record ${sourceItemId} never reached quarantine`);
}

describe('F-14 bounded retry and quarantine (AC-17)', () => {
  it('backs off along the documented ladder and quarantines at the attempt cap', async () => {
    const env = await freshEnv();
    const adapters = adaptersFor([brokenWork('s-1', 'r1')]);

    const first = await runIngestCycle({ db: env.DB, adapters, clock: env.clock });
    expect(first.sources[0]).toMatchObject({ recordsInserted: 1, retried: 1, quarantined: 0 });
    expect(recordOf(env, 's-1')).toMatchObject({
      status: 'retry',
      attempt_count: 1,
      error_code: 'PAYLOAD_INVALID',
      next_attempt_at: NOW + INGEST_RETRY_BACKOFF_SECONDS[0]
    });
    expect(env.db.count('content_items')).toBe(0);
    expect(env.db.count('content_episodes')).toBe(0);

    // Not due yet: a second wake at the same instant must not burn another attempt.
    await runIngestCycle({ db: env.DB, adapters, clock: env.clock });
    expect(recordOf(env, 's-1')).toMatchObject({ status: 'retry', attempt_count: 1 });

    env.clock.advance(INGEST_RETRY_BACKOFF_SECONDS[0]);
    await runIngestCycle({ db: env.DB, adapters, clock: env.clock });
    expect(recordOf(env, 's-1')).toMatchObject({
      status: 'retry',
      attempt_count: 2,
      next_attempt_at: NOW + INGEST_RETRY_BACKOFF_SECONDS[0] + INGEST_RETRY_BACKOFF_SECONDS[1]
    });

    env.clock.advance(INGEST_RETRY_BACKOFF_SECONDS[1]);
    const third = await runIngestCycle({ db: env.DB, adapters, clock: env.clock });
    expect(third.sources[0]).toMatchObject({ retried: 0, quarantined: 1 });
    expect(recordOf(env, 's-1')).toMatchObject({
      status: 'rejected',
      attempt_count: INGEST_MAX_AUTO_RETRIES,
      error_code: 'PAYLOAD_INVALID',
      next_attempt_at: null
    });
    expect(env.db.count('source_records')).toBe(1);
  });

  it('never re-tries a quarantined record automatically, however far the clock moves', async () => {
    const env = await freshEnv();
    const adapters = adaptersFor([brokenWork('s-1', 'r1')]);
    await runUntilQuarantined(env, adapters, 's-1');
    const quarantined = recordOf(env, 's-1');
    expect(quarantined).toMatchObject({ status: 'rejected', attempt_count: INGEST_MAX_AUTO_RETRIES, next_attempt_at: null });

    for (let wake = 0; wake < 4; wake += 1) {
      env.clock.advance(86400);
      const repeat: IngestRunReport = await runIngestCycle({ db: env.DB, adapters, clock: env.clock });
      expect(repeat.sources[0]).toMatchObject({ recordsDuplicate: 1, retried: 0, quarantined: 0, linked: 0 });
    }

    expect(recordOf(env, 's-1')).toEqual(quarantined);
    expect(env.db.count('source_records')).toBe(1);
    expect(env.db.selectOne('SELECT COUNT(*) AS n FROM source_records WHERE attempt_count > ?', INGEST_MAX_AUTO_RETRIES)?.n).toBe(0);
  });

  it('keeps the rest of the batch moving and retains the quarantined row', async () => {
    const env = await freshEnv();
    const adapters = adaptersFor([brokenWork('s-bad', 'r1'), goodWork('s-good', 'r1')]);

    const report = await runIngestCycle({ db: env.DB, adapters, clock: env.clock });
    expect(report.sources[0]).toMatchObject({ recordsInserted: 2, linked: 1, retried: 1 });
    expect(recordOf(env, 's-good')).toMatchObject({ status: 'linked', link_evidence: 'new_work' });
    expect(recordOf(env, 's-bad')).toMatchObject({ status: 'retry', attempt_count: 1 });
    const goodContentId = String(recordOf(env, 's-good')?.content_id);
    const goodUpdatedAt = recordOf(env, 's-good')?.updated_at;

    await runUntilQuarantined(env, adapters, 's-bad');

    expect(recordOf(env, 's-bad')).toMatchObject({ status: 'rejected', error_code: 'PAYLOAD_INVALID', content_id: null });
    expect(recordOf(env, 's-good')).toMatchObject({ status: 'linked', content_id: goodContentId, updated_at: goodUpdatedAt });
    expect(env.db.count('source_records')).toBe(2);
    expect(env.db.count('content_items')).toBe(1);
  });

  it('re-opens processing through a new source_revision while the quarantined row stays put', async () => {
    const env = await freshEnv();
    const adapters = adaptersFor([brokenWork('s-1', 'r1')]);
    await runUntilQuarantined(env, adapters, 's-1');
    const quarantined = recordOf(env, 's-1');
    expect(quarantined).toMatchObject({ status: 'rejected', source_revision: 'r1', next_attempt_at: null });

    const reopened = await runIngestCycle({ db: env.DB, adapters: adaptersFor([goodWork('s-1', 'r2')]), clock: env.clock });

    expect(reopened.sources[0]).toMatchObject({ recordsInserted: 1, linked: 1 });
    expect(recordOf(env, 's-1')).toMatchObject({ status: 'linked', source_revision: 'r2', attempt_count: 0, error_code: null });
    expect(env.db.selectOne('SELECT * FROM source_records WHERE source_revision = ?', 'r1')).toEqual(quarantined);
    expect(env.db.count('source_records')).toBe(2);
    expect(env.db.count('content_items')).toBe(1);
    expect(env.db.selectOne('SELECT title FROM content_items')?.title).toBe('雾港缉私');
  });

  it('records an unavailable provider, leaves its cursor untouched and still drains stored work', async () => {
    const env = await freshEnv();
    await runIngestCycle({ db: env.DB, adapters: adaptersFor([brokenWork('s-1', 'r1')]), clock: env.clock });
    const cursorBefore = sourceRow(env)?.cursor;
    const successBefore = sourceRow(env)?.last_success_at;
    expect(successBefore).toBe(NOW);

    const refusing: ProviderAdapter = { providerId: PROVIDER, fetchPage: () => Promise.reject(new Error('专线暂不可用')) };
    env.clock.advance(INGEST_RETRY_BACKOFF_SECONDS[0]);
    const report = await runIngestCycle({ db: env.DB, adapters: new Map([[PROVIDER, refusing]]), clock: env.clock });

    expect(report.sources[0]).toMatchObject({ adapterErrorCode: 'ADAPTER_UNAVAILABLE', pagesFetched: 0, retried: 1 });
    expect(report.sources[0].adapterErrorMessage).toContain('专线暂不可用');
    expect(recordOf(env, 's-1')).toMatchObject({ status: 'retry', attempt_count: 2 });
    expect(sourceRow(env)?.cursor).toBe(cursorBefore);
    expect(sourceRow(env)?.last_success_at).toBe(successBefore);
  });

  it('refuses a payload whose source ids are blank instead of minting a junk work id', async () => {
    const env = await freshEnv();
    const blank: ProviderWork = {
      sourceItemId: '  ',
      sourceRevision: 'r1',
      title: '残缺样本',
      category: '都市',
      episodes: [{ sourceEpisodeId: 'e1', episodeNumber: 1 }]
    };

    const report = await runIngestCycle({ db: env.DB, adapters: adaptersFor([blank]), clock: env.clock });

    expect(report.sources[0]).toMatchObject({ recordsInserted: 1, retried: 1, linked: 0 });
    expect(recordOf(env, '  ')).toMatchObject({ status: 'retry', error_code: 'PAYLOAD_INVALID', content_id: null });
    expect(env.db.count('content_items')).toBe(0);
  });

  it('refuses a mis-wired adapter instead of filing foreign work under this provider', async () => {
    const env = await freshEnv();
    const mismatched = createInMemoryAdapter('provider_other', [{ items: [goodWork('s-1', 'r1')], nextCursor: null }]);

    const report = await runIngestCycle({ db: env.DB, adapters: new Map([[PROVIDER, mismatched]]), clock: env.clock });

    expect(report.sources[0]).toMatchObject({ adapterErrorCode: 'PROVIDER_UNCONFIGURED', pagesFetched: 0, linked: 0 });
    expect(env.db.count('source_records')).toBe(0);
  });
});
