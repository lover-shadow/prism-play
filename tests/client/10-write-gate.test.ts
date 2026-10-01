// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import type { CatalogChangesResponse, CatalogResponse, ContentItem } from '../../edge/src/types/api';
import type { DatabaseSync } from 'node:sqlite';
import { createCredentialStore } from '../../src/core/storage/credentials';
import { createHistoryStore, HISTORY_TABLE, type SqliteLike, type WatchProgressInput } from '../../src/core/storage/history-store';
import { createPrivateVault } from '../../src/core/storage/private-vault';
import { createStorageDomains, describeDomains } from '../../src/core/storage/index';
import { MemoryCacheDisk, PublicCache } from '../../src/core/storage/public-cache';
import { createWebFallbackBridge, installNativeBridge } from '../../src/core/native/bridge';
import { assertWritable, PrivateWriteBlockedError } from '../../src/core/storage/storage-domains';

/** `node:sqlite` is rewritten to a bare `sqlite` name by vite-node, so the builtin comes in via require. */
const requireFromHere = createRequire(import.meta.url);
const openDatabase = (): DatabaseSync => {
  const loaded = requireFromHere('node:sqlite') as { DatabaseSync: typeof DatabaseSync };
  return new loaded.DatabaseSync(':memory:');
};

function trackingSqlite(): { sqlite: SqliteLike; sets: number; count: () => number } {
  const db = openDatabase();
  let sets = 0;
  return {
    get sets() {
      return sets;
    },
    count: () => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${HISTORY_TABLE}`).all()[0] as { n: number }).n),
    sqlite: {
      isConnected: async () => true,
      open: async () => undefined,
      close: async () => undefined,
      executeSet: async (_database, statements, transaction) => {
        sets += 1;
        if (transaction) db.exec('BEGIN');
        try {
          for (const statement of statements) db.prepare(statement.statement).run(...statement.values);
          if (transaction) db.exec('COMMIT');
        } catch (error) {
          if (transaction) db.exec('ROLLBACK');
          throw error;
        }
      },
      queryResult: async (_database, statement, values) => db.prepare(statement).all(...values) as never
    }
  };
}

const PRIVATE_ID = 'private_secret_1';

function contentItem(id: string, channelId: 'drama' | 'private', isPrivate: boolean): ContentItem {
  return { id, channelId, title: isPrivate ? '个人探索剧目' : '公开剧目', category: '都市', isPrivate, coverVersion: 'v1' };
}

const publicPage: CatalogResponse = { items: [contentItem('drama_a', 'drama', false)], page: 1, pageSize: 1, total: 1, revision: 7 };
const privatePage: CatalogResponse = { items: [contentItem(PRIVATE_ID, 'private', true)], page: 1, pageSize: 1, total: 1, revision: 7 };

function privateChanges(nextRevision: number): CatalogChangesResponse {
  return { changes: [{ revision: nextRevision, contentId: PRIVATE_ID, operation: 'upsert', item: contentItem(PRIVATE_ID, 'private', true) }], nextRevision, hasMore: false };
}

function watchInput(overrides: Partial<WatchProgressInput> = {}): WatchProgressInput {
  return {
    contentId: 'drama_a',
    title: '公开剧目',
    coverUrl: null,
    lastEpisodeId: 11,
    lastEpisodeNumber: 1,
    positionSeconds: 30,
    durationSeconds: 300,
    totalEpisodes: 24,
    updatedAt: 1_780_000_000,
    ...overrides
  };
}

async function committedCache(): Promise<PublicCache> {
  const cache = new PublicCache(new MemoryCacheDisk());
  cache.stagePage('drama', publicPage);
  await cache.commitSnapshot();
  return cache;
}

afterEach(() => installNativeBridge(createWebFallbackBridge(), 'web-fallback'));

describe('写入闸门 blocks every persistence path (AC-02-5)', () => {
  it('refuses a private breakpoint before SQLite is touched, leaving the table untouched', async () => {
    const tracked = trackingSqlite();
    const store = createHistoryStore({ sqlite: tracked.sqlite });
    await store.upsertWatch(watchInput());
    const setsBefore = tracked.sets;
    const rowsBefore = tracked.count();

    const blocked = store.upsertWatch(watchInput({ contentId: PRIVATE_ID, isPrivate: true }));
    await expect(blocked).rejects.toBeInstanceOf(PrivateWriteBlockedError);
    await expect(blocked).rejects.toThrow(/个人探索内容禁止落盘/);
    expect(tracked.sets).toBe(setsBefore);
    expect(tracked.count()).toBe(rowsBefore);
  });

  it('derives privacy from the channel, not from the payload claim', async () => {
    const tracked = trackingSqlite();
    const store = createHistoryStore({ sqlite: tracked.sqlite });
    await store.init();
    const setsAfterSchema = tracked.sets;
    await expect(store.upsertWatch(watchInput({ contentId: PRIVATE_ID, isPrivate: false, channelId: 'private' }))).rejects.toBeInstanceOf(
      PrivateWriteBlockedError
    );
    expect(tracked.sets).toBe(setsAfterSchema);
    expect(tracked.count()).toBe(0);
  });

  it('still accepts the public write afterwards, so a refusal does not poison the store', async () => {
    const tracked = trackingSqlite();
    const store = createHistoryStore({ sqlite: tracked.sqlite });
    await expect(store.upsertWatch(watchInput({ contentId: PRIVATE_ID, channelId: 'private' }))).rejects.toBeInstanceOf(PrivateWriteBlockedError);
    const row = await store.upsertWatch(watchInput());
    expect(row.content_id).toBe('drama_a');
    expect(tracked.count()).toBe(1);
  });

  it('reports the blocked content id on the error for the audit line, without a reason that leaks', async () => {
    const tracked = trackingSqlite();
    const store = createHistoryStore({ sqlite: tracked.sqlite });
    let blocked: unknown;
    try {
      await store.upsertWatch(watchInput({ contentId: PRIVATE_ID, isPrivate: true }));
    } catch (caught) {
      blocked = caught;
    }
    expect(blocked).toBeInstanceOf(PrivateWriteBlockedError);
    expect((blocked as PrivateWriteBlockedError).contentId).toBe(PRIVATE_ID);
    expect((blocked as PrivateWriteBlockedError).message).toContain(HISTORY_TABLE);
  });

  it('refuses a private catalog page and keeps the last complete snapshot', async () => {
    const cache = await committedCache();
    expect(() => cache.stagePage('private', privatePage)).toThrow(PrivateWriteBlockedError);
    expect(cache.snapshotRevision()).toBe(7);
    expect(cache.getItem(PRIVATE_ID)).toBeNull();
    expect(cache.list()).toHaveLength(1);
  });

  it('refuses a private change batch without moving the incremental cursor', async () => {
    const cache = await committedCache();
    await expect(cache.applyChanges(privateChanges(9))).rejects.toBeInstanceOf(PrivateWriteBlockedError);
    expect(cache.snapshotRevision()).toBe(7);
    expect(cache.getItem('drama_a')).not.toBeNull();
  });

  it('refuses a private poster and writes nothing to the disk namespace', async () => {
    const disk = new MemoryCacheDisk();
    const cache = new PublicCache(disk);
    await expect(cache.putPoster(PRIVATE_ID, 'v1', new Uint8Array([1, 2, 3]), { contentId: PRIVATE_ID, isPrivate: true })).rejects.toBeInstanceOf(
      PrivateWriteBlockedError
    );
    await expect(cache.putPoster(PRIVATE_ID, 'v1', new Uint8Array([1, 2, 3]), { contentId: PRIVATE_ID, channelId: 'private' })).rejects.toBeInstanceOf(
      PrivateWriteBlockedError
    );
    expect(await disk.list('cache/')).toHaveLength(0);
  });

  it('refuses to let private-derived material into the credential domain', async () => {
    installNativeBridge({ ...createWebFallbackBridge(), isKeystoreBacked: async () => true }, 'native');
    const credentials = createCredentialStore();
    await expect(
      credentials.write('deviceId', 'GY-TEST0000', { contentId: PRIVATE_ID, isPrivate: true })
    ).rejects.toBeInstanceOf(PrivateWriteBlockedError);
    expect(await credentials.readAll()).toEqual({ token: null, deviceId: null });
  });
});

describe('the vault is the only legal home for private material', () => {
  it('accepts a private breakpoint in RAM while history stays physically empty', async () => {
    const tracked = trackingSqlite();
    const store = createHistoryStore({ sqlite: tracked.sqlite });
    const vault = createPrivateVault();
    await expect(store.upsertWatch(watchInput({ contentId: PRIVATE_ID, isPrivate: true }))).rejects.toBeInstanceOf(PrivateWriteBlockedError);

    vault.putBreakpoint({
      content_id: PRIVATE_ID,
      title: '个人探索剧目',
      cover_url: null,
      last_episode_id: 11,
      last_episode_number: 1,
      position_seconds: 30,
      duration_seconds: 300,
      total_episodes: null,
      updated_at: 1_780_000_000
    });
    expect(vault.getBreakpoint(PRIVATE_ID)?.position_seconds).toBe(30);
    expect(await store.getWatch(PRIVATE_ID)).toBeNull();
    expect(tracked.count()).toBe(0);
  });

  it('shares the gate predicate with the vault so the rule has one definition', () => {
    expect(() => assertWritable('unit', { contentId: PRIVATE_ID, isPrivate: true })).toThrow(PrivateWriteBlockedError);
    expect(() => assertWritable('unit', { contentId: 'drama_a' })).not.toThrow();
  });
});

describe('storage façade (index.ts)', () => {
  it('wires exactly the four domains and describes quota plus backup policy', async () => {
    const tracked = trackingSqlite();
    const domains = createStorageDomains({ sqlite: tracked.sqlite, disk: new MemoryCacheDisk() });
    expect(Object.keys(domains).sort()).toEqual(['cache', 'credentials', 'history', 'privateVault']);

    const descriptors = describeDomains();
    expect(descriptors.map((entry) => entry.domain)).toEqual(['credentials', 'history', 'public-cache', 'private-volatile']);
    expect(descriptors.map((entry) => entry.backupPolicy)).toEqual(['exclude', 'include', 'exclude', 'exclude']);
    expect(descriptors.find((entry) => entry.domain === 'history')?.quota).toContain('500');
    expect(descriptors.find((entry) => entry.domain === 'public-cache')?.quota).toContain('128 MiB');
    expect(descriptors.find((entry) => entry.domain === 'public-cache')?.quota).toContain('20 MiB');
    expect(descriptors.filter((entry) => entry.clearedByClearCache).map((entry) => entry.domain)).toEqual(['public-cache']);

    const report = await domains.cache.clearCache();
    expect(report.preservedDomains).toEqual(['credentials', 'history']);
  });
});
