/**
 * The single storage façade (SPEC §6.1 / ARCHITECTURE §3.6 / Master ruling M-8).
 *
 * Other modules import storage from here and never reach into a domain file: the four domains differ
 * exactly in what may hit disk, what Android may back up and what must be unrecallable when the process
 * ends, so the boundary has to be one import away from the reviewer, not four.
 *
 * Preferences (theme, poster mode) are deliberately absent: `src/core/state/theme.ts` owns them, they
 * are neither credentials nor cache, they survive 【清理缓存】, and they share the history domain's
 * backup-included policy (M-8 落点 五.1).
 */

import { createCredentialStore, type CredentialStore } from './credentials';
import { createHistoryStore, type HistoryStore, type SqliteLike } from './history-store';
import { createPublicCache, MemoryCacheDisk, type CacheDisk, type PublicCache } from './public-cache';
import { createPrivateVault, type PrivateVault } from './private-vault';
import {
  CATALOG_CACHE_LIMIT_BYTES,
  CLEARED_BY_CLEAR_CACHE,
  DOMAIN_BACKUP_POLICY,
  DOMAIN_DESCRIPTION,
  HISTORY_MAX_ROWS,
  POSTER_CACHE_LIMIT_BYTES,
  STORAGE_DOMAINS,
  type StorageDomain
} from './storage-domains';

export interface StorageDomains {
  credentials: CredentialStore;
  history: HistoryStore;
  cache: PublicCache;
  privateVault: PrivateVault;
}

export interface StorageDomainDependencies {
  /** Injected so the LRU, the clear scope and the write gate are testable without a device. */
  sqlite: SqliteLike;
  /** Defaults to the in-memory reference adapter; Android passes the Filesystem/SQLite adapter. */
  disk?: CacheDisk;
  nowSeconds?: () => number;
}

export function createStorageDomains(deps: StorageDomainDependencies): StorageDomains {
  const now = deps.nowSeconds ?? ((): number => Math.floor(Date.now() / 1000));
  return {
    credentials: createCredentialStore(),
    history: createHistoryStore({ sqlite: deps.sqlite, nowSeconds: now }),
    cache: createPublicCache(deps.disk ?? new MemoryCacheDisk(), now),
    privateVault: createPrivateVault()
  };
}

const DOMAIN_CARRIER: Readonly<Record<StorageDomain, string>> = {
  credentials: 'Android Keystore 加密存储（Web 构建降级为浏览器存储并如实标记）',
  history: '端侧 SQLite prism_local.db -> local_watch_history',
  'public-cache': '本地文件系统 cache/posters 与目录快照分块',
  'private-volatile': '进程内存 Map，无任何文件与数据库句柄'
};

/** `128 MiB` / `20 MiB` rendered from the frozen constants, never re-typed by a view. */
export function formatQuotaBytes(bytes: number): string {
  const mibibytes = bytes / (1024 * 1024);
  const value = Number.isInteger(mibibytes) ? mibibytes : mibibytes.toFixed(1);
  return `${value} MiB`;
}

const DOMAIN_QUOTA: Readonly<Record<StorageDomain, string>> = {
  credentials: '单记录覆盖：仅 Ed25519 JWT 与 deviceId 两条凭证',
  history: `最多 ${HISTORY_MAX_ROWS} 部剧，按 updated_at 降序 LRU 淘汰`,
  'public-cache': `海报 ${formatQuotaBytes(POSTER_CACHE_LIMIT_BYTES)} / 目录 ${formatQuotaBytes(CATALOG_CACHE_LIMIT_BYTES)}，各自 LRU 淘汰`,
  'private-volatile': '不设磁盘配额：随进程结束或关闭开关即刻置空'
};

export interface DomainDescriptor {
  domain: StorageDomain;
  carrier: string;
  quota: string;
  description: string;
  backupPolicy: 'include' | 'exclude';
  /** The Android string the native `dataExtractionRules.xml` must agree with, value by value. */
  backupNotice: string;
  clearedByClearCache: boolean;
}

const BACKUP_NOTICE: Readonly<Record<StorageDomain, string>> = {
  credentials: '严禁进入备份：Keystore 密文跨机不可解密，备份等于换机后授权失效',
  history: '纳入备份白名单：换机可无感延续追剧断点（M-8）',
  'public-cache': '严禁进入备份：可联网重建，备份纯属浪费用户云配额',
  'private-volatile': '无磁盘文件可备份：应用可控磁盘零留痕'
};

/** Drives the settings screen's storage panel; strings only, so no view re-derives a number or a rule. */
export function describeDomains(): DomainDescriptor[] {
  const cleared: readonly string[] = CLEARED_BY_CLEAR_CACHE;
  return STORAGE_DOMAINS.map((domain) => ({
    domain,
    carrier: DOMAIN_CARRIER[domain],
    quota: DOMAIN_QUOTA[domain],
    description: DOMAIN_DESCRIPTION[domain],
    backupPolicy: DOMAIN_BACKUP_POLICY[domain],
    backupNotice: BACKUP_NOTICE[domain],
    clearedByClearCache: cleared.includes(domain)
  }));
}

export * from './credentials';
export * from './history-store';
export * from './public-cache';
export * from './private-vault';
export {
  assertWritable,
  CATALOG_CACHE_LIMIT_BYTES,
  CLEARED_BY_CLEAR_CACHE,
  createVolatileStore,
  DOMAIN_BACKUP_POLICY,
  DOMAIN_DESCRIPTION,
  HISTORY_MAX_ROWS,
  isPrivateSubject,
  POSTER_CACHE_LIMIT_BYTES,
  PRESERVED_BY_CLEAR_CACHE,
  PrivateWriteBlockedError,
  STORAGE_DOMAINS
} from './storage-domains';
export type { StorageDomain, VolatileStore, WatchHistoryRow, WriteGuardSubject } from './storage-domains';
