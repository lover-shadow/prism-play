import type { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Row = Record<string, unknown>;
type Bindable = string | number | bigint | null | Uint8Array;
type Statement = ReturnType<DatabaseSync['prepare']>;
type D1MetaFull = D1Result<unknown>['meta'];

/**
 * vite-node rewrites any `node:sqlite` specifier it sees (static or dynamic) into a bare package
 * named `sqlite`, because its builtin list predates the module. `createRequire` is not part of
 * vite-node's module graph, so the builtin is loaded through it instead.
 */
const requireFromHere = createRequire(import.meta.url);

function loadDatabaseSync(): typeof DatabaseSync {
  const loaded = requireFromHere('node:sqlite') as { DatabaseSync: typeof DatabaseSync };
  return loaded.DatabaseSync;
}

function toBindable(value: unknown): Bindable {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
  if (value instanceof Uint8Array) return value;
  throw new Error(`SqliteD1: unsupported bind value of type ${typeof value}`);
}

function bindables(values: unknown[]): Bindable[] {
  return values.map(toBindable);
}

function plainObject(row: Row | undefined): Row | undefined {
  return row ? { ...row } : undefined;
}

function plainRows(rows: Row[]): Row[] {
  return rows.map((row) => ({ ...row }));
}

function metaOf(changes: number | bigint, lastInsertRowid: number | bigint): D1MetaFull {
  const written = Number(changes);
  return {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: written,
    last_row_id: Number(lastInsertRowid),
    changed_db: written > 0,
    changes: written
  };
}

/** Mirrors D1's lazily-bound statement handle: `prepare()` then `bind()` yields a new handle. */
export class SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sqlText: string,
    private readonly values: unknown[] = []
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sqlText, values);
  }

  private statement(): Statement {
    return this.db.prepare(this.sqlText);
  }

  async all<T = Row>(): Promise<D1Result<T>> {
    return {
      results: plainRows(this.statement().all(...bindables(this.values))) as T[],
      success: true,
      meta: metaOf(0, 0)
    };
  }

  async run<T = Row>(): Promise<D1Result<T>> {
    const outcome = this.statement().run(...bindables(this.values));
    return { results: [], success: true, meta: metaOf(outcome.changes, outcome.lastInsertRowid) };
  }

  async first<T = Row>(colName?: string): Promise<T | null> {
    const row = plainObject(this.statement().get(...bindables(this.values)));
    if (row === undefined) return null;
    return (colName === undefined ? row : row[colName]) as T;
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const rows = plainRows(this.statement().all(...bindables(this.values)));
    if (rows.length === 0) return [];
    const keys = Object.keys(rows[0]);
    const values = rows.map((row) => keys.map((key) => row[key]));
    if (options?.columnNames) return [keys, ...values] as unknown as T[];
    return values as unknown as T[];
  }
}

/**
 * In-memory D1 stand-in for the Stage 1 suite.
 * `batch()` is the atomicity primitive the coupon redeem path depends on, so it runs inside
 * `BEGIN IMMEDIATE` and rolls the whole unit back when any statement fails.
 */
export class SqliteD1 {
  private inTransaction = false;

  constructor(readonly handle: DatabaseSync) {}

  prepare(query: string): SqliteStatement {
    return new SqliteStatement(this.handle, query);
  }

  async exec(query: string): Promise<D1ExecResult> {
    this.handle.exec(query);
    return { count: 1, duration: 0 };
  }

  async batch<T = unknown>(statements: SqliteStatement[]): Promise<D1Result<T>[]> {
    if (this.inTransaction) {
      throw new Error('SqliteD1: nested batch() is rejected, mirroring D1 semantics');
    }
    this.inTransaction = true;
    this.handle.exec('BEGIN IMMEDIATE');
    try {
      const results: D1Result<T>[] = [];
      for (const statement of statements) {
        results.push(await statement.run<T>());
      }
      this.handle.exec('COMMIT');
      return results;
    } catch (error) {
      this.handle.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  /** Escape hatch for assertions that read stored rows without going through a route. */
  selectAll(sql: string, ...values: unknown[]): Row[] {
    return plainRows(this.handle.prepare(sql).all(...bindables(values)));
  }

  selectOne(sql: string, ...values: unknown[]): Row | undefined {
    return plainObject(this.handle.prepare(sql).get(...bindables(values)));
  }

  execute(sql: string, ...values: unknown[]): number {
    return Number(this.handle.prepare(sql).run(...bindables(values)).changes);
  }

  count(table: string): number {
    const row = this.selectOne(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number(row?.n ?? 0);
  }
}

/** Cast the stand-in into the Worker binding type; only used by the test harness. */
export function asD1(db: SqliteD1): D1Database {
  return db as unknown as D1Database;
}

/**
 * Applies every authoritative migration in filename order so tests can never drift from the
 * production DDL. Only reading 0001 would leave incremental migrations (0002 onward) absent from
 * the test database, which is how a CHECK or FK constraint silently stops being covered.
 */
export function createInMemoryD1(): SqliteD1 {
  const Database = loadDatabaseSync();
  const handle = new Database(':memory:', { enableForeignKeyConstraints: true });
  handle.exec('PRAGMA foreign_keys = ON');
  const migrationsDir = fileURLToPath(new URL('../../edge/migrations/', import.meta.url));
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  if (files.length === 0 || files[0] !== '0001_initial_schema.sql') {
    throw new Error(`迁移序列必须从 0001_initial_schema.sql 起始，实际: ${files.join(', ')}`);
  }
  for (const name of files) {
    handle.exec(readFileSync(new URL(name, new URL('../../edge/migrations/', import.meta.url)), 'utf8'));
  }
  return new SqliteD1(handle);
}
