/**
 * Domain 2 — 追剧与历史域 (SPEC §6.1 row 2 + the authoritative DDL; ARCHITECTURE §3.6.2; M-8).
 *
 * One table, `prism_local.db`.`local_watch_history`, holding public title resume points. It is the
 * only domain that Android may back up (换机可接着看), which is exactly why 【清空历史】 is scoped to
 * this table and nothing else — it must not quietly take the licence or the preferences with it.
 *
 * The SQLite surface is injected as the smallest possible `SqliteLike` slice so the LRU, the clear
 * scope and the write gate are unit-testable without a device; the Capacitor plugin adapter is the
 * lead's wiring file and maps `executeSet` to `executeSet(..., { transaction: true })` (DDL calls may
 * be routed through `createTable`, which is why schema statements travel in the same set).
 */

import { assertWritable, HISTORY_MAX_ROWS, type WatchHistoryRow, type WriteGuardSubject } from './storage-domains';

export const HISTORY_DATABASE = 'prism_local.db';
export const HISTORY_TABLE = 'local_watch_history';

/** Copied verbatim from SPEC §6.1 — this string is the contract, not a paraphrase of it. */
export const LOCAL_WATCH_HISTORY_DDL = `CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
    content_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    cover_url TEXT,
    last_episode_id INTEGER NOT NULL,
    last_episode_number INTEGER NOT NULL,
    position_seconds INTEGER NOT NULL,
    duration_seconds INTEGER NOT NULL,
    total_episodes INTEGER,
    updated_at INTEGER NOT NULL
)`;
export const LOCAL_WATCH_HISTORY_INDEX_DDL = `CREATE INDEX IF NOT EXISTS idx_watch_history_time ON ${HISTORY_TABLE}(updated_at DESC)`;

/** A resume point counts as finished inside this tail window (seconds); see the note below the class. */
export const FINISH_TOLERANCE_SECONDS = 5;

export type SqliteValue = string | number | null;
export interface SqliteStatement {
  statement: string;
  values: SqliteValue[];
}

/** The whole SQLite contract this domain needs. Nothing in here imports a Capacitor type. */
export interface SqliteLike {
  isConnected(database: string): Promise<boolean>;
  open(database: string): Promise<void>;
  close(database: string): Promise<void>;
  executeSet(database: string, set: SqliteStatement[], transaction: boolean): Promise<void>;
  queryResult<T extends Record<string, unknown>>(database: string, statement: string, values: SqliteValue[]): Promise<T[]>;
}

/** camelCase on the caller side, snake_case at the DDL boundary — the mapping lives in one place. */
export interface WatchProgressInput extends WriteGuardSubject {
  contentId: string;
  title: string;
  coverUrl?: string | null;
  lastEpisodeId: number;
  lastEpisodeNumber: number;
  positionSeconds: number;
  durationSeconds: number;
  totalEpisodes?: number | null;
  /** Unix seconds per the DDL comment; injected in tests so the LRU ordering is deterministic. */
  updatedAt?: number;
}

export class WatchHistoryShapeError extends Error {
  constructor(reason: string) {
    super(`观看历史写入被拒绝：${reason}`);
    this.name = 'WatchHistoryShapeError';
  }
}

const COLUMNS =
  'content_id, title, cover_url, last_episode_id, last_episode_number, position_seconds, duration_seconds, total_episodes, updated_at';

const UPSERT_SQL = `INSERT OR REPLACE INTO ${HISTORY_TABLE} (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
/** Keeps the newest `HISTORY_MAX_ROWS` by `updated_at` DESC; `content_id` breaks ties deterministically. */
const EVICT_SQL = `DELETE FROM ${HISTORY_TABLE} WHERE content_id NOT IN (
  SELECT content_id FROM ${HISTORY_TABLE} ORDER BY updated_at DESC, content_id ASC LIMIT ?)`;
const SELECT_BY_ID_SQL = `SELECT ${COLUMNS} FROM ${HISTORY_TABLE} WHERE content_id = ?`;
const SELECT_RECENT_SQL = `SELECT ${COLUMNS} FROM ${HISTORY_TABLE} ORDER BY updated_at DESC, content_id ASC LIMIT ?`;
const SELECT_FINISHED_SQL = `SELECT ${COLUMNS} FROM ${HISTORY_TABLE} WHERE duration_seconds > 0
  AND position_seconds >= duration_seconds - ? ORDER BY updated_at DESC, content_id ASC LIMIT ?`;
const COUNT_SQL = `SELECT COUNT(*) AS total FROM ${HISTORY_TABLE}`;
const CLEAR_SQL = `DELETE FROM ${HISTORY_TABLE}`;

const wholeSeconds = (value: number, field: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new WatchHistoryShapeError(`${field} 须为有限数值`);
  const rounded = Math.max(0, Math.floor(value));
  if (rounded > Number.MAX_SAFE_INTEGER) throw new WatchHistoryShapeError(`${field} 超出可安全表示的整数范围`);
  return rounded;
};

const positiveInt = (value: number, field: string): number => {
  const rounded = wholeSeconds(value, field);
  if (rounded < 1) throw new WatchHistoryShapeError(`${field} 须为正整数`);
  return rounded;
};

/**
 * Rows persist as integers: the golden resume card has to render "看到 12 分 34 秒" without ever
 * inventing a sub-second value, so fractional player time is truncated here and nowhere else.
 */
export function toWatchHistoryRow(input: WatchProgressInput, nowSeconds: number): WatchHistoryRow {
  if (typeof input.contentId !== 'string' || input.contentId.trim() === '') {
    throw new WatchHistoryShapeError('content_id 为必填主键');
  }
  if (typeof input.title !== 'string' || input.title.trim() === '') {
    throw new WatchHistoryShapeError('title 为必填列，断点卡不得渲染空剧名');
  }
  const durationSeconds = wholeSeconds(input.durationSeconds, 'duration_seconds');
  const rawPosition = wholeSeconds(input.positionSeconds, 'position_seconds');
  // A known duration clamps the resume point so a corrupted row cannot seek past the end; an unknown
  // duration (0) keeps the position instead of erasing it, because 0 would silently lose the breakpoint.
  const positionSeconds = durationSeconds > 0 ? Math.min(rawPosition, durationSeconds) : rawPosition;
  const total = input.totalEpisodes;
  return {
    content_id: input.contentId.trim(),
    title: input.title.trim(),
    cover_url: input.coverUrl === undefined || input.coverUrl === '' ? null : input.coverUrl,
    last_episode_id: positiveInt(input.lastEpisodeId, 'last_episode_id'),
    last_episode_number: positiveInt(input.lastEpisodeNumber, 'last_episode_number'),
    position_seconds: positionSeconds,
    duration_seconds: durationSeconds,
    total_episodes: total === undefined || total === null ? null : positiveInt(total, 'total_episodes'),
    updated_at: input.updatedAt === undefined ? wholeSeconds(nowSeconds, 'updated_at') : wholeSeconds(input.updatedAt, 'updated_at')
  };
}

export function rowValues(row: WatchHistoryRow): SqliteValue[] {
  return [
    row.content_id,
    row.title,
    row.cover_url,
    row.last_episode_id,
    row.last_episode_number,
    row.position_seconds,
    row.duration_seconds,
    row.total_episodes,
    row.updated_at
  ];
}

/** Seconds to seek to. Clamped to the episode tail so a corrupt row cannot seek past its own end. */
export function resumePositionOf(row: WatchHistoryRow): number {
  const position = Math.max(0, Math.floor(row.position_seconds));
  const duration = Math.max(0, Math.floor(row.duration_seconds));
  return duration > 0 ? Math.min(position, duration) : position;
}

export function isFinished(row: WatchHistoryRow): boolean {
  return row.duration_seconds > 0 && row.position_seconds >= row.duration_seconds - FINISH_TOLERANCE_SECONDS;
}

export interface HistoryClearReport {
  table: string;
  removedRows: number;
  /** The M-8 boundary: clearing history must be provably unable to touch the other three domains. */
  reachedDomains: readonly ['history'];
  preservedDomains: readonly ['credentials', 'public-cache', 'private-volatile'];
}

export interface HistoryStore {
  init(): Promise<void>;
  upsertWatch(input: WatchProgressInput): Promise<WatchHistoryRow>;
  getWatch(contentId: string): Promise<WatchHistoryRow | null>;
  listRecent(limit?: number): Promise<WatchHistoryRow[]>;
  listFinished(limit?: number): Promise<WatchHistoryRow[]>;
  resumePosition(row: WatchHistoryRow): number;
  count(): Promise<number>;
  clearHistory(): Promise<HistoryClearReport>;
  close(): Promise<void>;
}

/** Row-shaped DB output; anything the DDL cannot explain is dropped rather than rendered. */
type DbRow = Partial<Record<keyof WatchHistoryRow, unknown>>;

function rowFromDb(raw: DbRow | undefined): WatchHistoryRow | null {
  if (raw === undefined) return null;
  const { content_id: id, title, last_episode_id: episodeId, last_episode_number: episodeNumber } = raw;
  if (typeof id !== 'string' || id === '' || typeof title !== 'string') return null;
  if (typeof episodeId !== 'number' || typeof episodeNumber !== 'number') return null;
  if (typeof raw.position_seconds !== 'number' || typeof raw.duration_seconds !== 'number') return null;
  if (typeof raw.updated_at !== 'number') return null;
  return {
    content_id: id,
    title,
    cover_url: typeof raw.cover_url === 'string' ? raw.cover_url : null,
    last_episode_id: episodeId,
    last_episode_number: episodeNumber,
    position_seconds: wholeSeconds(raw.position_seconds, 'position_seconds'),
    duration_seconds: wholeSeconds(raw.duration_seconds, 'duration_seconds'),
    total_episodes: typeof raw.total_episodes === 'number' && raw.total_episodes > 0 ? Math.floor(raw.total_episodes) : null,
    updated_at: Math.floor(raw.updated_at)
  };
}

const clampLimit = (limit: number | undefined): number => {
  if (limit === undefined) return HISTORY_MAX_ROWS;
  const value = Math.floor(limit);
  return Number.isFinite(value) && value > 0 ? Math.min(value, HISTORY_MAX_ROWS) : HISTORY_MAX_ROWS;
};

export function createHistoryStore(deps: { sqlite: SqliteLike; nowSeconds?: () => number }): HistoryStore {
  const { sqlite } = deps;
  const database = HISTORY_DATABASE;
  const now = deps.nowSeconds ?? ((): number => Math.floor(Date.now() / 1000));
  let ready = false;

  async function ensureReady(): Promise<void> {
    if (ready) return;
    if (!(await sqlite.isConnected(database))) await sqlite.open(database);
    await sqlite.executeSet(database, [{ statement: LOCAL_WATCH_HISTORY_DDL, values: [] }, { statement: LOCAL_WATCH_HISTORY_INDEX_DDL, values: [] }], true);
    ready = true;
  }

  async function select(sql: string, values: SqliteValue[]): Promise<WatchHistoryRow[]> {
    await ensureReady();
    const rows = await sqlite.queryResult<DbRow>(database, sql, values);
    return rows.map(rowFromDb).filter((row): row is WatchHistoryRow => row !== null);
  }

  /** Kept as a closure, not a method, so `clearHistory` cannot depend on how the store is destructured. */
  async function countRows(): Promise<number> {
    await ensureReady();
    const rows = await sqlite.queryResult<{ total?: number }>(database, COUNT_SQL, []);
    return typeof rows[0]?.total === 'number' ? Math.floor(rows[0].total) : 0;
  }

  return {
    init: ensureReady,

    /**
     * Gate first, then one transaction holding both the write and the 500-row eviction — a blocked
     * write therefore cannot leave a half-applied row, and an accepted one cannot leave 501 rows.
     */
    async upsertWatch(input: WatchProgressInput): Promise<WatchHistoryRow> {
      assertWritable(HISTORY_TABLE, input);
      const row = toWatchHistoryRow(input, now());
      await ensureReady();
      await sqlite.executeSet(
        database,
        [
          { statement: UPSERT_SQL, values: rowValues(row) },
          { statement: EVICT_SQL, values: [HISTORY_MAX_ROWS] }
        ],
        true
      );
      return row;
    },

    async getWatch(contentId: string): Promise<WatchHistoryRow | null> {
      const rows = await select(SELECT_BY_ID_SQL, [contentId]);
      return rows[0] ?? null;
    },

    listRecent: (limit?: number) => select(SELECT_RECENT_SQL, [clampLimit(limit)]),
    listFinished: (limit?: number) => select(SELECT_FINISHED_SQL, [FINISH_TOLERANCE_SECONDS, clampLimit(limit)]),
    resumePosition: resumePositionOf,

    count: countRows,

    /** Scoped to this table by a literal statement; no other domain is reachable from here. */
    async clearHistory(): Promise<HistoryClearReport> {
      const removedRows = await countRows();
      await sqlite.executeSet(database, [{ statement: CLEAR_SQL, values: [] }], true);
      return { table: HISTORY_TABLE, removedRows, reachedDomains: ['history'] as const, preservedDomains: ['credentials', 'public-cache', 'private-volatile'] as const };
    },

    /** Reopening is allowed: `ready` drops so a cold start re-runs the idempotent schema set. */
    async close(): Promise<void> {
      await sqlite.close(database);
      ready = false;
    }
  };
}

/**
 * Judgement call recorded for the gate report: `listFinished` treats the last
 * `FINISH_TOLERANCE_SECONDS` as "已看完" because a player almost never reports an exact `duration`
 * (seek-to-end and container tail rounding). Rows with `duration_seconds = 0` (unknown length) are
 * never counted as finished, so an unparseable source cannot clear a title the user has not seen.
 */
