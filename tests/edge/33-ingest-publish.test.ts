import { describe, expect, it } from 'vitest';
import { createInMemoryAdapter, type ProviderAdapter, type ProviderWork } from '../../edge/src/ingest/adapter';
import { runIngestCycle } from '../../edge/src/ingest/cron';
import {
  IngestPublishError,
  publish,
  publishToPrivateCatalog,
  unpublish,
  unpublishFromPrivateCatalog
} from '../../edge/src/ingest/publish';
import { readSourceRecord } from '../../edge/src/ingest/repository';
import { IngestTransitionError, publishLinkedRecord } from '../../edge/src/ingest/state-machine';
import { insert, seedProvider, seedStandardChannels } from '../support/seed';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';

const NOW = TEST_BASE_TIME_SECONDS;
const PROVIDER = 'provider_s1';

function work(sourceItemId: string, title = '深夜便利店'): ProviderWork {
  return {
    sourceItemId,
    sourceRevision: 'r1',
    title,
    category: '都市',
    episodes: [{ sourceEpisodeId: `${sourceItemId}-e1`, episodeNumber: 1, durationSeconds: 140 }]
  };
}

async function freshEnv(channelId = 'drama', providerId = PROVIDER): Promise<PrismTestEnv> {
  const env = await createTestEnv();
  seedStandardChannels(env.db);
  seedProvider(env.db, { id: providerId, channelId }, NOW);
  insert(env.db, 'ingest_sources', { provider_id: providerId, enabled: 1, cursor: null, last_success_at: null, updated_at: NOW });
  await runIngestCycle({
    db: env.DB,
    adapters: new Map([[providerId, createInMemoryAdapter(providerId, [{ items: [work('s-1'), work('s-2', '海岸线以西')], nextCursor: null }])]]),
    clock: env.clock
  });
  return env;
}

function linkedContentId(env: PrismTestEnv, sourceItemId = 's-1'): string {
  return String(env.db.selectOne('SELECT content_id FROM source_records WHERE source_item_id = ?', sourceItemId)?.content_id);
}

async function linkedRecord(env: PrismTestEnv, sourceItemId = 's-1') {
  const record = await readSourceRecord(env.DB, PROVIDER, sourceItemId, 'r1');
  if (record === null) throw new Error(`record for ${sourceItemId} was never stored`);
  return record;
}

function changeRows(env: PrismTestEnv): Record<string, unknown>[] {
  return env.db.selectAll('SELECT revision, content_id, operation, changed_at FROM public_catalog_changes ORDER BY revision');
}

function contentRow(env: PrismTestEnv, contentId: string): Record<string, unknown> | undefined {
  return env.db.selectOne('SELECT * FROM content_items WHERE id = ?', contentId);
}

describe('F-14 atomic publish and unpublish (AC-17 / AC-02)', () => {
  it('leaves ingested work unpublished: no catalogue row is derived straight from a source record', async () => {
    const env = await freshEnv();

    expect(env.db.count('source_records')).toBe(2);
    expect(env.db.count('content_items')).toBe(2);
    expect(env.db.count('public_catalog_changes')).toBe(0);
    expect(env.db.selectOne('SELECT COUNT(*) AS n FROM content_items WHERE enabled = 1')?.n).toBe(0);
    expect(env.db.selectOne('SELECT COUNT(*) AS n FROM content_items WHERE first_published_at IS NOT NULL')?.n).toBe(0);
  });

  it('publishes in one unit: enabled flag, first publication stamp and the upsert revision', async () => {
    const env = await freshEnv();
    const contentId = linkedContentId(env);

    const revision = await publish(env.DB, contentId, NOW + 60);

    expect(revision).toBe(1);
    expect(contentRow(env, contentId)).toMatchObject({ enabled: 1, first_published_at: NOW + 60 });
    expect(changeRows(env)).toEqual([{ revision: 1, content_id: contentId, operation: 'upsert', changed_at: NOW + 60 }]);

    const republished = await publish(env.DB, contentId, NOW + 120);

    expect(republished).toBe(2);
    expect(contentRow(env, contentId)?.first_published_at).toBe(NOW + 60);
    expect(changeRows(env)).toHaveLength(2);
  });

  it('unpublishes in the same shape with a delete tombstone and keeps the first publication stamp', async () => {
    const env = await freshEnv();
    const contentId = linkedContentId(env);
    await publish(env.DB, contentId, NOW + 60);

    const revision = await unpublish(env.DB, contentId, NOW + 600);

    expect(revision).toBe(2);
    expect(contentRow(env, contentId)).toMatchObject({ enabled: 0, first_published_at: NOW + 60 });
    expect(changeRows(env)[1]).toEqual({ revision: 2, content_id: contentId, operation: 'delete', changed_at: NOW + 600 });
  });

  it('rolls a failed publish back: no catalogue flip and no surviving change row', async () => {
    const env = await freshEnv();
    const contentId = linkedContentId(env);
    await publish(env.DB, contentId, NOW + 60);

    await expect(publish(env.DB, 'w_provider_s1-ghost', NOW + 90)).rejects.toBeInstanceOf(IngestPublishError);
    await expect(unpublish(env.DB, 'w_provider_s1-ghost', NOW + 90)).rejects.toMatchObject({ code: 'CONTENT_NOT_FOUND' });

    expect(changeRows(env)).toHaveLength(1);
    expect(env.db.selectOne('SELECT COUNT(*) AS n FROM public_catalog_changes WHERE content_id = ?', 'w_provider_s1-ghost')?.n).toBe(0);
    expect(contentRow(env, contentId)).toMatchObject({ enabled: 1 });
    expect(env.db.count('content_items')).toBe(2);
  });

  it('refuses to publish 个人探索 work into the public change log and only flips its visibility', async () => {
    const env = await freshEnv('private', 'provider_p1');
    const contentId = linkedContentId(env);
    expect(contentRow(env, contentId)).toMatchObject({ channel_id: 'private', is_private: 1, shareable: 0, enabled: 0 });

    await expect(publish(env.DB, contentId, NOW + 60)).rejects.toMatchObject({ code: 'PRIVATE_CONTENT' });
    await expect(unpublish(env.DB, contentId, NOW + 60)).rejects.toMatchObject({ code: 'PRIVATE_CONTENT' });
    expect(env.db.count('public_catalog_changes')).toBe(0);

    await publishToPrivateCatalog(env.DB, contentId, NOW + 90);
    expect(contentRow(env, contentId)).toMatchObject({ enabled: 1, first_published_at: null });
    expect(env.db.count('public_catalog_changes')).toBe(0);
    await expect(publishToPrivateCatalog(env.DB, 'w_provider_s1-none', NOW + 90)).rejects.toBeInstanceOf(IngestPublishError);

    await unpublishFromPrivateCatalog(env.DB, contentId, NOW + 120);
    expect(contentRow(env, contentId)?.enabled).toBe(0);
    expect(env.db.count('public_catalog_changes')).toBe(0);
  });

  it('publishes a linked record through the state machine and emits exactly one public event', async () => {
    const env = await freshEnv();
    const record = await linkedRecord(env);
    expect(record.status).toBe('linked');

    const published = await publishLinkedRecord(env.DB, record, NOW + 42);

    expect(published.revision).toBe(1);
    expect(changeRows(env)).toEqual([
      { revision: 1, content_id: String(record.content_id), operation: 'upsert', changed_at: NOW + 42 }
    ]);
    const afterPublish = await readSourceRecord(env.DB, PROVIDER, 's-1', 'r1');
    expect(afterPublish?.status).toBe('published');
    expect(afterPublish?.content_id).toBe(record.content_id);
  });

  it('publishes a private record without touching the public log', async () => {
    const env = await freshEnv('private', 'provider_p1');
    const record = await readSourceRecord(env.DB, 'provider_p1', 's-1', 'r1');
    if (record === null) throw new Error('private work was never stored');

    const published = await publishLinkedRecord(env.DB, record, NOW + 42);

    expect(published.revision).toBeNull();
    expect(env.db.count('public_catalog_changes')).toBe(0);
    expect(contentRow(env, String(record.content_id))?.enabled).toBe(1);
    expect((await readSourceRecord(env.DB, 'provider_p1', 's-1', 'r1'))?.status).toBe('published');
  });

  it('refuses to publish a record that has not been linked', async () => {
    const env = await createTestEnv();
    seedStandardChannels(env.db);
    seedProvider(env.db, { id: PROVIDER, channelId: 'drama' }, NOW);
    insert(env.db, 'ingest_sources', { provider_id: PROVIDER, enabled: 1, cursor: null, last_success_at: null, updated_at: NOW });
    const unusable: ProviderWork = {
      sourceItemId: 's-9',
      sourceRevision: 'r1',
      title: '残缺样本',
      category: '都市',
      episodes: [{ sourceEpisodeId: 's-9-e0', episodeNumber: 0 }]
    };
    const adapters: Map<string, ProviderAdapter> = new Map([
      [PROVIDER, createInMemoryAdapter(PROVIDER, [{ items: [unusable], nextCursor: null }])]
    ]);
    await runIngestCycle({ db: env.DB, adapters, clock: env.clock });
    const retrying = await readSourceRecord(env.DB, PROVIDER, 's-9', 'r1');
    if (retrying === null) throw new Error('retry record was never stored');
    expect(retrying.status).toBe('retry');

    await expect(publishLinkedRecord(env.DB, retrying, NOW + 10)).rejects.toBeInstanceOf(IngestTransitionError);
    expect(env.db.count('public_catalog_changes')).toBe(0);
    expect(env.db.count('content_items')).toBe(0);
  });
});
