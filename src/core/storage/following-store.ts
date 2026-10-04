/** Public user intent in the history safety domain; never inferred from player progress.
 * Shared prism_local.db connection is owned/closed by the storage host, not this store.
 * No LRU: clearing history/cache and the history's 500-row eviction cannot delete intent.
 */
import { HISTORY_DATABASE, type SqliteLike } from './history-store';
import { assertWritable, type WriteGuardSubject } from './storage-domains';

export const FOLLOWING_TABLE = 'local_following';
export const LOCAL_FOLLOWING_DDL = `CREATE TABLE IF NOT EXISTS ${FOLLOWING_TABLE} (
    content_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    cover_url TEXT,
    created_at INTEGER NOT NULL
)`;
export interface FollowingInput extends WriteGuardSubject {
  contentId: string;
  title: string;
  coverUrl?: string | null;
}
export interface FollowingRow {
  content_id: string;
  title: string;
  cover_url: string | null;
  created_at: number;
}
export interface FollowingStore {
  init(): Promise<void>;
  /** Resolves the committed state; rejects on any persistence failure. */
  toggle(input: FollowingInput): Promise<boolean>;
  list(): Promise<FollowingRow[]>;
  remove(contentId: string): Promise<void>;
}
export function createFollowingStore(deps: { sqlite: SqliteLike; nowSeconds?: () => number }): FollowingStore {
  const { sqlite } = deps;
  const database = HISTORY_DATABASE;
  const now = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  let initializing: Promise<void> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  // Run idempotent DDL for each operation: the history host may close/reopen this shared handle.
  async function init(): Promise<void> {
    if (initializing !== null) return initializing;
    initializing = (async () => {
      if (!(await sqlite.isConnected(database))) await sqlite.open(database);
      await sqlite.executeSet(database, [{ statement: LOCAL_FOLLOWING_DDL, values: [] }], true);
    })();
    try { await initializing; } finally { initializing = null; }
  }
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const next = queue.then(action);
    queue = next.catch(() => undefined);
    return next;
  }
  function idOf(id: string): string {
    if (typeof id !== 'string' || id.trim() === '') throw new Error('收藏 content_id 为必填主键');
    return id.trim();
  }
  async function remove(contentId: string): Promise<void> {
    await sqlite.executeSet(database, [{ statement: `DELETE FROM ${FOLLOWING_TABLE} WHERE content_id = ?`, values: [contentId] }], true);
  }
  return {
    init: () => serial(init),
    async toggle(input): Promise<boolean> {
      assertWritable(FOLLOWING_TABLE, input);
      const id = idOf(input.contentId);
      if (typeof input.title !== 'string' || input.title.trim() === '') throw new Error('收藏 title 为必填列');
      const title = input.title.trim(), cover = input.coverUrl ?? null, createdAt = now();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error('收藏 created_at 须为 Unix 整数秒');
      if (cover !== null && typeof cover !== 'string') throw new Error('收藏 cover_url 须为字符串或 null');
      return serial(async () => {
        await init();
        const rows = await sqlite.queryResult(database, `SELECT content_id FROM ${FOLLOWING_TABLE} WHERE content_id = ?`, [id]);
        if (rows.length > 0) { await remove(id); return false; }
        await sqlite.executeSet(database, [{ statement: `INSERT INTO ${FOLLOWING_TABLE} (content_id, title, cover_url, created_at) VALUES (?, ?, ?, ?)`, values: [id, title, cover, createdAt] }], true);
        return true;
      });
    },
    list: () => serial(async () => {
      await init();
      return sqlite.queryResult<FollowingRow & Record<string, unknown>>(database,
        `SELECT content_id, title, cover_url, created_at FROM ${FOLLOWING_TABLE} ORDER BY created_at DESC, content_id ASC`, []);
    }),
    remove: (contentId) => serial(async () => { const id = idOf(contentId); await init(); await remove(id); })
  };
}
