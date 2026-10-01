// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import {
  createHistoryStore,
  FINISH_TOLERANCE_SECONDS,
  HISTORY_DATABASE,
  HISTORY_TABLE,
  LOCAL_WATCH_HISTORY_DDL,
  LOCAL_WATCH_HISTORY_INDEX_DDL,
  resumePositionOf,
  type SqliteLike,
  type WatchProgressInput
} from '../../src/core/storage/history-store';
import type { WatchHistoryRow } from '../../src/core/storage/storage-domains';
import { HISTORY_MAX_ROWS } from '../../src/core/storage/storage-domains';

/**
 * vite-node rewrites any `node:sqlite` specifier into a bare `sqlite` name (its builtin list predates
 * the module), so the builtin is loaded through `createRequire` — same technique the edge suite uses.
 */
const requireFromHere = createRequire(import.meta.url);
const openDatabase = (): DatabaseSync => {
  const loaded = requireFromHere('node:sqlite') as { DatabaseSync: typeof DatabaseSync };
  return new loaded.DatabaseSync(':memory:');
};

interface FakeSqlite {
  sqlite: SqliteLike;
  /** One entry per `executeSet` call: how many statements travelled in it and whether it was a transaction. */
  sets: Array<{ statements: string[]; transaction: boolean }>;
  queries: string[];
  openCalls: number;
  exec(sql: string): void;
  rows<T>(sql: string): T[];
}

function createFakeSqlite(db: DatabaseSync = openDatabase()): FakeSqlite {
  const fake: FakeSqlite = {
    sets: [],
    queries: [],
    openCalls: 0,
    exec: (sql) => void db.exec(sql),
    rows: <T>(sql: string) => db.prepare(sql).all().map((row) => ({ ...row }) as T),
    sqlite: {
      isConnected: async () => fake.openCalls > 0,
      open: async () => void (fake.openCalls += 1),
      close: async () => void (fake.openCalls = 0),
      executeSet: async (database, set, transaction) => {
        expect(database).toBe(HISTORY_DATABASE);
        fake.sets.push({ statements: set.map((item) => item.statement), transaction });
        if (transaction) db.exec('BEGIN');
        try {
          for (const item of set) db.prepare(item.statement).run(...item.values);
          if (transaction) db.exec('COMMIT');
        } catch (error) {
          if (transaction) db.exec('ROLLBACK');
          throw error;
        }
      },
      queryResult: async (_database, statement, values) => {
        fake.queries.push(statement);
        return db.prepare(statement).all(...values).map((row) => ({ ...row })) as never;
      }
    }
  };
  return fake;
}

const BASE_TIME = 1_780_000_000;

function watchInput(index: number, overrides: Partial<WatchProgressInput> = {}): WatchProgressInput {
  return {
    contentId: `pub_${index}`,
    title: `测试剧目 ${index}`,
    coverUrl: `https://play.prismos.org/proxy/cover/pub_${index}`,
    lastEpisodeId: 900 + index,
    lastEpisodeNumber: index,
    positionSeconds: 120 + index,
    durationSeconds: 600,
    totalEpisodes: 30,
    updatedAt: BASE_TIME + index,
    ...overrides
  };
}

function historyCount(fake: FakeSqlite): number {
  const rows = fake.rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${HISTORY_TABLE}`);
  return Number(rows[0]?.n ?? 0);
}

/**
 * Repo-root file reader used by the "文档即契约" assertions. Vitest is launched from the repository
 * root, but walking upwards keeps the check honest when it is run from a subdirectory or via an IDE.
 */
function repoText(relative: string): string {
  let directory = process.cwd();
  for (let step = 0; step < 5; step += 1) {
    const candidate = resolve(directory, relative);
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    const parent = resolve(directory, '..');
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`找不到仓库文件：${relative}`);
}

describe('local_watch_history DDL is the SPEC §6.1 contract, verbatim', () => {
  const specColumns = (block: string): string[] =>
    [...block.matchAll(/^\s{4}([a-z_]+)\s+(?:TEXT|INTEGER)/gm)].map((match) => match[1]);

  it('declares the same columns, in the same order, as the authoritative SQL block', () => {
    const spec = repoText('docs/04-spec/SPEC-v2.0.md');
    const sqlBlock = spec.split('```sql')[1]?.split('```')[0] ?? '';
    const tableBody = sqlBlock.slice(sqlBlock.indexOf('('), sqlBlock.indexOf(');'));
    expect(specColumns(tableBody)).toEqual([
      'content_id',
      'title',
      'cover_url',
      'last_episode_id',
      'last_episode_number',
      'position_seconds',
      'duration_seconds',
      'total_episodes',
      'updated_at'
    ]);
    expect(specColumns(LOCAL_WATCH_HISTORY_DDL.slice(LOCAL_WATCH_HISTORY_DDL.indexOf('(')))).toEqual(specColumns(tableBody));
    expect(LOCAL_WATCH_HISTORY_DDL).toContain('content_id TEXT PRIMARY KEY');
    expect(LOCAL_WATCH_HISTORY_INDEX_DDL).toContain('idx_watch_history_time');
    expect(LOCAL_WATCH_HISTORY_INDEX_DDL).toContain(`${HISTORY_TABLE}(updated_at DESC)`);
  });

  it('creates the table and the index on a real SQLite handle', async () => {
    const fake = createFakeSqlite();
    await createHistoryStore({ sqlite: fake.sqlite }).init();
    const names = fake.rows<{ name: string }>('SELECT name FROM sqlite_master').map((row) => row.name);
    expect(names).toContain(HISTORY_TABLE);
    expect(names).toContain('idx_watch_history_time');
    expect(fake.openCalls).toBe(1);
  });
});

describe('upsertWatch and resume reads', () => {
  it('round-trips a resume row whose seconds are integers, so the golden card can show them', async () => {
    const fake = createFakeSqlite();
    const store = createHistoryStore({ sqlite: fake.sqlite });
    const written = await store.upsertWatch(watchInput(3, { positionSeconds: 42 }));
    expect(Number.isInteger(written.position_seconds)).toBe(true);
    const read = await store.getWatch('pub_3');
    expect(read).not.toBeNull();
    expect(read?.title).toBe('测试剧目 3');
    expect(read?.position_seconds).toBe(42);
    expect(read?.duration_seconds).toBe(600);
    expect(store.resumePosition(written)).toBe(42);
    expect(fake.sets.at(-1)?.statements[0]).toContain('INSERT OR REPLACE');
  });

  it('truncates fractional player time and clamps a position past the episode tail', async () => {
    const fake = createFakeSqlite();
    const store = createHistoryStore({ sqlite: fake.sqlite });
    const row = await store.upsertWatch(watchInput(1, { positionSeconds: 99.7 }));
    expect(row.position_seconds).toBe(99);
    const overflow = await store.upsertWatch(watchInput(2, { positionSeconds: 9_999 }));
    expect(overflow.position_seconds).toBe(600);
    expect(resumePositionOf(overflow)).toBe(600);
  });

  it('replaces the same content id instead of duplicating it, and re-orders by updated_at', async () => {
    const fake = createFakeSqlite();
    const store = createHistoryStore({ sqlite: fake.sqlite });
    await store.upsertWatch(watchInput(1, { updatedAt: BASE_TIME }));
    await store.upsertWatch(watchInput(2, { updatedAt: BASE_TIME + 10 }));
    await store.upsertWatch(watchInput(1, { updatedAt: BASE_TIME + 20, positionSeconds: 300 }));
    expect(await store.count()).toBe(2);
    const recent = await store.listRecent();
    expect(recent.map((row) => row.content_id)).toEqual(['pub_1', 'pub_2']);
    expect((recent[0] as WatchHistoryRow).position_seconds).toBe(300);
  });

  it('keeps an unknown-duration breakpoint at 0 seconds total rather than erasing the position', async () => {
    const fake = createFakeSqlite();
    const store = createHistoryStore({ sqlite: fake.sqlite });
    const row = await store.upsertWatch(watchInput(4, { durationSeconds: 0, positionSeconds: 240 }));
    expect(row.duration_seconds).toBe(0);
    expect(row.position_seconds).toBe(240);
    expect(resumePositionOf(row)).toBe(240);
  });

  it('refuses rows the DDL cannot represent instead of writing garbage', async () => {
    const fake = createFakeSqlite();
    const store = createHistoryStore({ sqlite: fake.sqlite });
    await expect(store.upsertWatch(watchInput(1, { title: '   ' }))).rejects.toThrow(/title/);
    await expect(store.upsertWatch(watchInput(1, { contentId: '' }))).rejects.toThrow(/content_id/);
    await expect(store.upsertWatch(watchInput(1, { positionSeconds: Number.NaN }))).rejects.toThrow(/position_seconds/);
    await expect(store.upsertWatch(watchInput(1, { lastEpisodeId: 0 }))).rejects.toThrow(/last_episode_id/);
    // Rejected shapes never reach SQLite at all, so they cannot half-write a row either.
    expect(fake.sets).toHaveLength(0);
  });

  it('returns null for a content id that was never watched', async () => {
    const store = createHistoryStore({ sqlite: createFakeSqlite().sqlite });
    expect(await store.getWatch('missing')).toBeNull();
  });
});

describe('500-row LRU enforced on write', () => {
  it('evicts the oldest row by updated_at DESC and never the newest, in one transaction', async () => {
    const fake = createFakeSqlite();
    const store = createHistoryStore({ sqlite: fake.sqlite });
    for (let index = 1; index <= HISTORY_MAX_ROWS; index += 1) await store.upsertWatch(watchInput(index));
    expect(await store.count()).toBe(HISTORY_MAX_ROWS);

    const freshest = watchInput(HISTORY_MAX_ROWS + 1, { updatedAt: BASE_TIME + HISTORY_MAX_ROWS + 5 });
    await store.upsertWatch(freshest);

    expect(await store.count()).toBe(HISTORY_MAX_ROWS);
    expect(await store.getWatch(freshest.contentId)).not.toBeNull();
    expect(await store.getWatch('pub_1')).toBeNull();
    expect(await store.getWatch(`pub_${HISTORY_MAX_ROWS}`)).not.toBeNull();

    const eviction = fake.sets.at(-1);
    expect(eviction?.transaction).toBe(true);
    expect(eviction?.statements).toHaveLength(2);
    expect(eviction?.statements[1]).toContain('ORDER BY updated_at DESC');
    expect(eviction?.statements[1]).toContain('DELETE');
  });

  it('stays at the ceiling when a write refreshes an existing row instead of adding one', async () => {
    const fake = createFakeSqlite();
    const store = createHistoryStore({ sqlite: fake.sqlite });
    for (let index = 1; index <= 3; index += 1) await store.upsertWatch(watchInput(index, { updatedAt: BASE_TIME + index }));
    await store.upsertWatch(watchInput(2, { updatedAt: BASE_TIME + 99 }));
    expect(historyCount(fake)).toBe(3);
    expect((await store.listRecent(2)).map((row) => row.content_id)).toEqual(['pub_2', 'pub_3']);
  });

  it('clamps the requested list size to the ceiling and orders finished titles by tail tolerance', async () => {
    const fake = createFakeSqlite();
    const store = createHistoryStore({ sqlite: fake.sqlite });
    await store.upsertWatch(watchInput(1, { positionSeconds: 600, updatedAt: BASE_TIME + 5 }));
    await store.upsertWatch(watchInput(2, { positionSeconds: 600 - FINISH_TOLERANCE_SECONDS, updatedAt: BASE_TIME + 6 }));
    await store.upsertWatch(watchInput(3, { positionSeconds: 590, updatedAt: BASE_TIME + 7 }));
    expect((await store.listRecent(10_000)).length).toBe(3);
    const finished = await store.listFinished();
    expect(finished.map((row) => row.content_id).sort()).toEqual(['pub_1', 'pub_2']);
    expect(await store.listRecent(2)).toHaveLength(2);
  });
});

describe('clearHistory scope (M-8)', () => {
  it('deletes only local_watch_history and leaves every other table in the same database alone', async () => {
    const fake = createFakeSqlite();
    const store = createHistoryStore({ sqlite: fake.sqlite });
    fake.exec('CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    fake.exec("INSERT INTO preferences VALUES ('prism.theme', 'dark')");
    await store.upsertWatch(watchInput(1));
    await store.upsertWatch(watchInput(2));

    const report = await store.clearHistory();

    expect(report.table).toBe(HISTORY_TABLE);
    expect(report.removedRows).toBe(2);
    expect(historyCount(fake)).toBe(0);
    expect(fake.rows<{ value: string }>('SELECT value FROM preferences')[0]?.value).toBe('dark');
    expect(report.reachedDomains).toEqual(['history']);
    expect(report.preservedDomains).toEqual(['credentials', 'public-cache', 'private-volatile']);
    expect(fake.sets.at(-1)?.statements).toEqual([`DELETE FROM ${HISTORY_TABLE}`]);
  });

  it('is safe to call when the table is still empty', async () => {
    const store = createHistoryStore({ sqlite: createFakeSqlite().sqlite });
    expect((await store.clearHistory()).removedRows).toBe(0);
  });
});
