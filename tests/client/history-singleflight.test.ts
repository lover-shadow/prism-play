// @vitest-environment jsdom
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { logger } from '../../src/core/diagnostics';
import { createHistorySqlite, type SqliteConnectionLike, type SqliteDriverLike } from '../../src/core/native/platform-adapters';
import {
  createHistoryStore, HISTORY_DATABASE, LOCAL_WATCH_HISTORY_DDL,
  type SqliteLike, type WatchProgressInput
} from '../../src/core/storage/history-store';

const requireFromHere = createRequire(import.meta.url);
const watchInput = (): WatchProgressInput => ({
  contentId: 'pub_1', title: '测试剧目', lastEpisodeId: 901, lastEpisodeNumber: 1,
  positionSeconds: 121, durationSeconds: 600, updatedAt: 1_780_000_001
});

function createFakeSqlite() {
  // vite-node 的 builtin 列表不含 node:sqlite，沿用 createRequire 加载真实内存库。
  const { DatabaseSync: Database } = requireFromHere('node:sqlite') as { DatabaseSync: typeof DatabaseSync };
  const db = new Database(':memory:');
  const sets: string[][] = [];
  let connected = false;
  const sqlite: SqliteLike = {
    isConnected: async () => connected,
    open: async () => { connected = true; },
    close: async () => { db.close(); connected = false; },
    executeSet: async (_database, set, transaction) => {
      sets.push(set.map((item) => item.statement));
      if (transaction) db.exec('BEGIN');
      try {
        for (const item of set) db.prepare(item.statement).run(...item.values);
        if (transaction) db.exec('COMMIT');
      } catch (error) {
        if (transaction) db.exec('ROLLBACK');
        throw error;
      }
    },
    queryResult: async (_database, statement, values) =>
      db.prepare(statement).all(...values).map((row) => ({ ...row })) as never
  };
  return { sqlite, sets };
}

function createFakeDriver() {
  let connected = false;
  const connection: SqliteConnectionLike = {
    open: async () => undefined,
    close: async () => { connected = false; },
    executeSet: async () => undefined,
    query: async () => ({ values: [] })
  };
  const fake: { driver: SqliteDriverLike; creations: number } = {
    creations: 0,
    driver: {
      isConnection: async () => ({ result: connected }),
      createConnection: async () => {
        fake.creations += 1;
        connected = true;
        return connection;
      },
      retrieveConnection: async () => connection
    }
  };
  return fake;
}

describe('history init singleflight', () => {
  it('upsert 事务失败保留异常，后续写入无需重建 schema 且可成功', async () => {
    const fake = createFakeSqlite();
    const history = createHistoryStore({ sqlite: fake.sqlite });
    await history.init();
    const execute = fake.sqlite.executeSet;
    const error = new Error('transaction failed');
    fake.sqlite.executeSet = async () => { throw error; };
    await expect(history.upsertWatch(watchInput())).rejects.toBe(error);
    expect(logger.latestError()).toMatchObject({ tag: 'history', message: 'upsert failed', detail: error.stack });
    fake.sqlite.executeSet = execute;
    await history.upsertWatch(watchInput());
    expect(await history.count()).toBe(1);
    expect(fake.sets.filter((set) => set[0] === LOCAL_WATCH_HISTORY_DDL)).toHaveLength(1);
    await history.close();
  });

  it.each(['open', 'schema'] as const)('并发 init/read/write 共享初始化，%s 失败后重试', async (stage) => {
    const fake = createFakeSqlite();
    const error = new Error(`${stage} failed`);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let attempts = 0;
    if (stage === 'open') {
      const original = fake.sqlite.open;
      fake.sqlite.open = async (database) => {
        attempts += 1;
        if (attempts === 1) { await gate; throw error; }
        await original(database);
      };
    } else {
      const original = fake.sqlite.executeSet;
      fake.sqlite.executeSet = async (...args) => {
        if (args[1][0].statement === LOCAL_WATCH_HISTORY_DDL) {
          attempts += 1;
          if (attempts === 1) { await gate; throw error; }
        }
        await original(...args);
      };
    }
    const history = createHistoryStore({ sqlite: fake.sqlite });
    const work = [history.init(), history.listRecent(), history.upsertWatch(watchInput())];
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(attempts).toBe(1);
    const outcomes = Promise.allSettled(work);
    release();
    expect(await outcomes).toEqual(Array.from({ length: 3 }, () => ({ status: 'rejected', reason: error })));
    expect(logger.latestError()).toMatchObject({ tag: 'history', message: `${stage} failed`, detail: error.stack });
    await Promise.all([history.init(), history.listRecent(), history.upsertWatch(watchInput())]);
    expect(attempts).toBe(2);
    expect(fake.sets.filter((set) => set[0] === LOCAL_WATCH_HISTORY_DDL)).toHaveLength(1);
    expect(await history.count()).toBe(1);
    await history.close();
  });
});

describe('native SQLite attach singleflight', () => {
  it('同库 open/execute/query 在 open 挂起期间共享 attach，其他库不被阻塞', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = createFakeDriver();
    let opens = 0;
    fake.driver.createConnection = async () => {
      fake.creations += 1;
      return {
        open: async () => { opens += 1; await gate; },
        close: async () => undefined,
        executeSet: async () => undefined,
        query: async () => ({ values: [] })
      };
    };
    const sqlite = await createHistorySqlite({ driver: fake.driver, platform: () => true });
    const work = [
      sqlite.open(HISTORY_DATABASE), sqlite.executeSet(HISTORY_DATABASE, [], true),
      sqlite.queryResult(HISTORY_DATABASE, 'SELECT 1', []), sqlite.open('other.db')
    ];
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.creations).toBe(2);
    expect(opens).toBe(2);
    release();
    await Promise.all(work);
  });

  it.each(['create', 'open'] as const)('attach %s 失败保留原异常且下次可重试', async (stage) => {
    const { driver } = createFakeDriver();
    const error = new Error(`${stage} failed`);
    const original = driver.createConnection.bind(driver);
    let failed = false;
    driver.createConnection = async (...args) => {
      if (stage === 'create' && !failed) { failed = true; throw error; }
      const connection = await original(...args);
      const open = connection.open.bind(connection);
      connection.open = async () => {
        if (stage === 'open' && !failed) { failed = true; throw error; }
        await open();
      };
      return connection;
    };
    const sqlite = await createHistorySqlite({ driver, platform: () => true });
    const outcomes = await Promise.allSettled([sqlite.open(HISTORY_DATABASE), sqlite.open(HISTORY_DATABASE)]);
    expect(outcomes).toEqual([{ status: 'rejected', reason: error }, { status: 'rejected', reason: error }]);
    expect(logger.latestError()).toMatchObject({ tag: 'history', message: `${stage} failed`, detail: error.stack });
    await expect(sqlite.open(HISTORY_DATABASE)).resolves.toBeUndefined();
  });
});
