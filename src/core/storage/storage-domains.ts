/**
 * The four client-side storage domains (SPEC §6.1 / ARCHITECTURE §3.6, Master ruling M-8).
 *
 * Every byte the app persists must be attributable to exactly one domain, because the domains differ
 * in the only ways that matter here: what may hit disk, what Android may back up, and what must be
 * unrecallable the moment the process ends. Module code must not open its own storage.
 */

export const STORAGE_DOMAINS = ['credentials', 'history', 'public-cache', 'private-volatile'] as const;
export type StorageDomain = (typeof STORAGE_DOMAINS)[number];

/** SPEC §6.1 quotas and eviction ceilings — one number each, no per-module copies. */
export const HISTORY_MAX_ROWS = 500;
export const POSTER_CACHE_LIMIT_BYTES = 128 * 1024 * 1024;
export const CATALOG_CACHE_LIMIT_BYTES = 20 * 1024 * 1024;

/** Backup policy per domain, mirrored by `dataExtractionRules.xml` on the native side. */
export const DOMAIN_BACKUP_POLICY: Readonly<Record<StorageDomain, 'include' | 'exclude'>> = {
  credentials: 'exclude',
  history: 'include',
  'public-cache': 'exclude',
  'private-volatile': 'exclude'
};

export const DOMAIN_DESCRIPTION: Readonly<Record<StorageDomain, string>> = {
  credentials: 'Ed25519 凭证与设备标识：Keystore 加密，绝不入备份',
  history: '追剧断点与历史：端侧 SQLite，纳入备份白名单，可一键清空',
  'public-cache': '公开目录快照与缩略海报：LRU 可重建，排除在备份外',
  'private-volatile': '个人探索：仅进程内存，退出即焚'
};

/** Column set of `prism_local.db`.`local_watch_history` (SPEC §6.1 authoritative DDL). */
export interface WatchHistoryRow {
  content_id: string;
  title: string;
  cover_url: string | null;
  last_episode_id: number;
  last_episode_number: number;
  position_seconds: number;
  duration_seconds: number;
  total_episodes: number | null;
  updated_at: number;
}

export interface WriteGuardSubject {
  isPrivate?: boolean;
  channelId?: string;
  contentId?: string;
}

/** A refusal that must never be caught and ignored: it is the AC-02 zero-disk boundary. */
export class PrivateWriteBlockedError extends Error {
  readonly contentId: string;

  constructor(operation: string, contentId: string) {
    super(`个人探索内容禁止落盘：${operation} 被存储拦截器拒绝 (content=${contentId})`);
    this.name = 'PrivateWriteBlockedError';
    this.contentId = contentId;
  }
}

export function isPrivateSubject(subject: WriteGuardSubject): boolean {
  return subject.isPrivate === true || subject.channelId === 'private';
}

/**
 * The one gate every persistence path must pass through. Privacy is derived from the channel/id, not
 * from a caller's honesty: a payload that claims `isPrivate: false` while filed under `private` is
 * still blocked, because the server-side D1 equation is the authority on what private means.
 */
export function assertWritable(operation: string, subject: WriteGuardSubject): void {
  if (isPrivateSubject(subject)) {
    throw new PrivateWriteBlockedError(operation, subject.contentId ?? '未知内容');
  }
}

/** Session identity and the private opt-in live in RAM only; nothing here may be serialized. */
export interface VolatileStore<T> {
  set(key: string, value: T): void;
  get(key: string): T | undefined;
  delete(key: string): void;
  clear(): void;
  size(): number;
  keys(): string[];
}

export function createVolatileStore<T>(): VolatileStore<T> {
  const memory = new Map<string, T>();
  return {
    set: (key, value) => void memory.set(key, value),
    get: (key) => memory.get(key),
    delete: (key) => void memory.delete(key),
    clear: () => memory.clear(),
    size: () => memory.size,
    keys: () => [...memory.keys()]
  };
}

/** Cache keys are namespaced by domain so a "clear cache" action can never reach another domain. */
export const CLEARED_BY_CLEAR_CACHE = ['public-cache'] as const;
export const PRESERVED_BY_CLEAR_CACHE = ['credentials', 'history'] as const;
