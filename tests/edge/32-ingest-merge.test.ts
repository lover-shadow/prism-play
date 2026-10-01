import { describe, expect, it } from 'vitest';
import { createInMemoryAdapter, type ProviderAdapter, type ProviderWork } from '../../edge/src/ingest/adapter';
import { runIngestCycle, type IngestRunReport, type IngestSourceReport } from '../../edge/src/ingest/cron';
import { INGEST_MAX_AUTO_RETRIES } from '../../edge/src/core/constants';
import { insert, seedContent, seedProvider, seedStandardChannels } from '../support/seed';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';

const NOW = TEST_BASE_TIME_SECONDS;
const S1 = 'provider_s1';
const M1 = 'provider_m1';
const SAME_TITLE = '战神之龙王归来';

function work(sourceItemId: string, sourceRevision: string, title: string, category: string, episodeNumbers: number[]): ProviderWork {
  return {
    sourceItemId,
    sourceRevision,
    title,
    category,
    episodes: episodeNumbers.map((number) => ({ sourceEpisodeId: `${sourceItemId}-e${number}`, episodeNumber: number, durationSeconds: 120 }))
  };
}

async function freshEnv(providers: { id: string; channelId: string }[]): Promise<PrismTestEnv> {
  const env = await createTestEnv();
  seedStandardChannels(env.db);
  for (const provider of providers) {
    seedProvider(env.db, provider, NOW);
    insert(env.db, 'ingest_sources', { provider_id: provider.id, enabled: 1, cursor: null, last_success_at: null, updated_at: NOW });
  }
  return env;
}

function adaptersFor(entries: [string, ProviderWork[]][]): Map<string, ProviderAdapter> {
  return new Map(entries.map(([providerId, items]) => [providerId, createInMemoryAdapter(providerId, [{ items, nextCursor: null }])]));
}

function recordOf(env: PrismTestEnv, providerId: string, sourceItemId: string): Record<string, unknown> | undefined {
  return env.db.selectOne('SELECT * FROM source_records WHERE provider_id = ? AND source_item_id = ? ORDER BY id DESC LIMIT 1', providerId, sourceItemId);
}

/** Sources are reported in `ingest_sources` order (provider id), so entries are addressed by provider. */
function sourceReport(report: IngestRunReport, providerId: string): IngestSourceReport {
  const entry = report.sources.find((candidate) => candidate.providerId === providerId);
  if (entry === undefined) throw new Error(`run report holds no entry for ${providerId}`);
  return entry;
}

async function runUntilQuarantined(env: PrismTestEnv, adapters: Map<string, ProviderAdapter>, providerId: string, sourceItemId: string): Promise<void> {
  for (let wake = 0; wake < INGEST_MAX_AUTO_RETRIES + 2; wake += 1) {
    await runIngestCycle({ db: env.DB, adapters, clock: env.clock });
    const row = recordOf(env, providerId, sourceItemId);
    if (row?.status === 'rejected') return;
    if (typeof row?.next_attempt_at !== 'number') return;
    env.clock.advance(Number(row.next_attempt_at) - env.clock.nowSeconds());
  }
  throw new Error(`record ${sourceItemId} never reached quarantine`);
}

describe('F-14 cross-source merging on trusted evidence only (AC-17)', () => {
  it('keeps two providers carrying an identical title as two separate works', async () => {
    const env = await freshEnv([{ id: S1, channelId: 'drama' }, { id: M1, channelId: 'drama' }]);

    await runIngestCycle({
      db: env.DB,
      adapters: adaptersFor([
        [S1, [work('s-9', 'r1', SAME_TITLE, '战神', [1, 2])]],
        [M1, [work('m-9', 'r1', SAME_TITLE, '热血', [1])]]
      ]),
      clock: env.clock
    });

    const items = env.db.selectAll('SELECT id, title, category FROM content_items ORDER BY category');
    expect(items).toHaveLength(2);
    expect(items.map((row) => row.title)).toEqual([SAME_TITLE, SAME_TITLE]);
    expect(items.map((row) => row.category)).toEqual(['战神', '热血']);
    expect(recordOf(env, S1, 's-9')?.link_evidence).toBe('new_work');
    expect(recordOf(env, M1, 'm-9')?.link_evidence).toBe('new_work');
    expect(String(recordOf(env, S1, 's-9')?.content_id)).not.toBe(String(recordOf(env, M1, 'm-9')?.content_id));
    expect(env.db.selectOne('SELECT COUNT(*) AS n FROM trusted_work_mappings')?.n).toBe(0);
    expect(env.db.selectOne('SELECT COUNT(DISTINCT content_id) AS n FROM source_records')?.n).toBe(2);
    expect(env.db.count('public_catalog_changes')).toBe(0);
  });

  it('merges a second provider onto the recorded work and only adds episodes', async () => {
    const env = await freshEnv([{ id: S1, channelId: 'drama' }]);
    await runIngestCycle({ db: env.DB, adapters: adaptersFor([[S1, [work('s-1', 'r1', '深海档案', '悬疑', [1, 2])]]]), clock: env.clock });
    const contentId = String(recordOf(env, S1, 's-1')?.content_id);

    seedProvider(env.db, { id: M1, channelId: 'drama' }, NOW);
    insert(env.db, 'ingest_sources', { provider_id: M1, enabled: 1, cursor: null, last_success_at: null, updated_at: NOW });
    insert(env.db, 'trusted_work_mappings', {
      provider_id: M1,
      source_item_id: 'm-9',
      content_id: contentId,
      evidence_ref: 'ops-人工核对单-2026-10-01',
      created_at: NOW
    });

    const report = await runIngestCycle({
      db: env.DB,
      adapters: adaptersFor([
        [S1, [work('s-1', 'r1', '深海档案', '悬疑', [1, 2])]],
        [M1, [work('m-9', 'r1', '深海档案（海外译名）', '悬疑', [1, 3])]]
      ]),
      clock: env.clock
    });

    expect(sourceReport(report, M1)).toMatchObject({ recordsInserted: 1, linked: 1 });
    expect(recordOf(env, M1, 'm-9')).toMatchObject({ status: 'linked', link_evidence: 'trusted_cross_source_map', content_id: contentId });
    expect(env.db.count('content_items')).toBe(1);
    expect(env.db.selectOne('SELECT title, category FROM content_items')?.title).toBe('深海档案');
    expect(env.db.selectOne('SELECT COUNT(*) AS n FROM content_episodes WHERE content_id = ?', contentId)?.n).toBe(3);
    expect(env.db.selectOne('SELECT COUNT(*) AS n FROM source_episode_links')?.n).toBe(4);
    expect(env.db.selectOne('SELECT episode_number FROM content_episodes WHERE content_id = ? ORDER BY episode_number DESC LIMIT 1', contentId)?.episode_number).toBe(3);
  });

  it('refuses to merge on a mapping whose evidence_ref is blank', async () => {
    const env = await freshEnv([{ id: M1, channelId: 'drama' }]);
    seedContent(env.db, { id: 'pre_1', channelId: 'drama', title: SAME_TITLE, category: '战神', shareable: 0 }, NOW);
    insert(env.db, 'trusted_work_mappings', { provider_id: M1, source_item_id: 'm-9', content_id: 'pre_1', evidence_ref: '   ', created_at: NOW });

    await runIngestCycle({ db: env.DB, adapters: adaptersFor([[M1, [work('m-9', 'r1', SAME_TITLE, '战神', [1])]]]), clock: env.clock });

    expect(recordOf(env, M1, 'm-9')).toMatchObject({ status: 'linked', link_evidence: 'new_work' });
    expect(String(recordOf(env, M1, 'm-9')?.content_id)).not.toBe('pre_1');
    expect(env.db.count('content_items')).toBe(2);
  });

  it('quarantines evidence that contradicts the configured channel instead of mis-merging', async () => {
    const env = await freshEnv([{ id: M1, channelId: 'movie' }]);
    seedContent(env.db, { id: 'pre_1', channelId: 'drama', title: '深海档案', category: '悬疑', shareable: 0 }, NOW);
    insert(env.db, 'trusted_work_mappings', { provider_id: M1, source_item_id: 'm-9', content_id: 'pre_1', evidence_ref: 'ops-历史误配待核', created_at: NOW });
    const adapters = adaptersFor([[M1, [work('m-9', 'r1', '深海档案', '院线', [1])]]]);

    await runUntilQuarantined(env, adapters, M1, 'm-9');

    expect(recordOf(env, M1, 'm-9')).toMatchObject({ status: 'rejected', error_code: 'LINK_AMBIGUOUS', content_id: null, link_evidence: null });
    expect(env.db.count('content_items')).toBe(1);
    expect(env.db.selectOne('SELECT COUNT(*) AS n FROM source_episode_links')?.n).toBe(0);
  });

  it('prefers same-source identity over a cross-source mapping once the work is known', async () => {
    const env = await freshEnv([{ id: S1, channelId: 'drama' }]);
    seedContent(env.db, { id: 'pre_1', channelId: 'drama', title: '旧港往事', category: '古装', shareable: 0 }, NOW);
    insert(env.db, 'trusted_work_mappings', { provider_id: S1, source_item_id: 's-1', content_id: 'pre_1', evidence_ref: 'ops-授权映射', created_at: NOW });

    await runIngestCycle({ db: env.DB, adapters: adaptersFor([[S1, [work('s-1', 'r1', '旧港往事', '古装', [1, 2])]]]), clock: env.clock });
    expect(recordOf(env, S1, 's-1')).toMatchObject({ link_evidence: 'trusted_cross_source_map', content_id: 'pre_1' });

    await runIngestCycle({ db: env.DB, adapters: adaptersFor([[S1, [work('s-1', 'r2', '旧港往事·精修', '古装', [1, 2, 3])]]]), clock: env.clock });

    expect(recordOf(env, S1, 's-1')).toMatchObject({ source_revision: 'r2', link_evidence: 'same_source_id', content_id: 'pre_1' });
    expect(env.db.count('content_items')).toBe(1);
    expect(env.db.selectOne('SELECT COUNT(*) AS n FROM content_episodes WHERE content_id = ?', 'pre_1')?.n).toBe(3);
  });

  it('keeps source episode links idempotent across repeated wakes', async () => {
    const env = await freshEnv([{ id: S1, channelId: 'drama' }]);
    const adapters = adaptersFor([[S1, [work('s-1', 'r1', '雪线救援', '人文', [1, 2])]]]);

    await runIngestCycle({ db: env.DB, adapters, clock: env.clock });
    const links = env.db.selectAll('SELECT source_record_id, source_episode_id, episode_id FROM source_episode_links ORDER BY source_episode_id');
    const episodeStamp = env.db.selectOne('SELECT MAX(updated_at) AS stamp FROM content_episodes')?.stamp;

    env.clock.advance(43200);
    await runIngestCycle({ db: env.DB, adapters, clock: env.clock });

    expect(env.db.selectAll('SELECT source_record_id, source_episode_id, episode_id FROM source_episode_links ORDER BY source_episode_id')).toEqual(links);
    expect(env.db.count('source_records')).toBe(1);
    expect(env.db.count('content_episodes')).toBe(2);
    expect(env.db.selectOne('SELECT MAX(updated_at) AS stamp FROM content_episodes')?.stamp).toBe(episodeStamp);
    expect(recordOf(env, S1, 's-1')?.updated_at).toBe(NOW);
  });
});
