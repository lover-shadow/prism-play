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
import { normalizeQuery, SEARCH_RESULT_LIMIT, type SearchHit, type SearchIndex } from './search-index';
import type { ContentItem, SearchResponse, SearchResult, SearchSuggestion, SuggestionsResponse } from '../../../edge/src/types/api';
import type { SearchApi } from '../../views/search-view';
import {
  CATALOG_CACHE_LIMIT_BYTES,
  CLEARED_BY_CLEAR_CACHE,
  DOMAIN_BACKUP_POLICY,
  DOMAIN_DESCRIPTION,
  HISTORY_MAX_ROWS,
  isPrivateSubject,
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
  'public-cache': '本地文件系统 cache/posters、目录快照分块与端侧检索库 prism_search.db',
  'private-volatile': '进程内存 Map，无任何文件与数据库句柄'
};

/** `512 MiB` / `20 MiB` rendered from the frozen constants, never re-typed by a view. */
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
export * from './search-index';
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

export interface LocalSearchApiDeps {
  index: SearchIndex;
  /** 公开快照读面（宿主已剔私密）：索引只是候选源，条目内容与"是否还存在"一律以它为准。 */
  localItems: () => readonly ContentItem[];
  /** 端侧索引不可用（Web 宿主没有 SQLite）时的云端回落；本地可用时一次请求都不发（§A-6.4）。 */
  remote?: SearchApi;
}

/**
 * A-6 的接线点：把「端侧 FTS5 索引 + 公开快照读面」组装成视图可以直接消费的 `SearchApi`。
 * 视图的状态机、防抖与分组逻辑一字不改，只换数据源；`localFirst` 是能力声明而不是装饰——视图据此把
 * "检索需联网"的措辞换成本机口径，并把「联网补充」降级成一颗必须由用户点下去的按钮：默认零请求。
 */
export function createLocalSearchApi(deps: LocalSearchApiDeps): SearchApi {
  const { index, localItems, remote } = deps;

  /** 索引行可能比快照旧：条目已下架就当场丢弃，界面永远不该出现一张点开播不了的结果卡。 */
  interface LocalMatch { result: SearchResult; hit: SearchHit }
  async function resolved(query: string, limit: number): Promise<LocalMatch[]> {
    const hits = await index.search(query, limit);
    const items = new Map(localItems().map((item) => [item.id, item]));
    const found: LocalMatch[] = [];
    for (const hit of hits) {
      const item = items.get(hit.contentId);
      if (item === undefined || isPrivateSubject(item)) continue;
      found.push({ result: { item, matchType: hit.matchType }, hit });
    }
    return found;
  }

  /** 回落只在"这台机器根本没有可用索引"时发生；有索引而没命中就是没命中，不该拿网络去猜第二次。 */
  function fallBack(): boolean {
    if (remote === undefined) return false;
    const status = index.status();
    return !status.available || status.docs === 0;
  }

  return {
    localFirst: true,
    async search(input): Promise<SearchResponse> {
      const found = await resolved(normalizeQuery(input.q), input.pageSize ?? SEARCH_RESULT_LIMIT);
      if (fallBack()) return await remote?.search(input) ?? { items: [], page: 1 };
      return { items: found.map((entry) => entry.result), page: input.page ?? 1 };
    },
    async searchOnline(input): Promise<SearchResponse> {
      if (remote === undefined) return { items: [], page: input.page ?? 1 };
      return await remote.search(input);
    },
    async suggestions(q): Promise<SuggestionsResponse> {
      const query = normalizeQuery(q);
      const found = await resolved(query, 10);
      if (fallBack()) return await remote?.suggestions(q) ?? { query: q, suggestions: [] };
      const suggestions: SearchSuggestion[] = [];
      const seen = new Set<string>();
      const push = (text: string, type: SearchSuggestion['type'], contentId?: string): void => {
        const word = text.trim();
        if (word === '' || word.length > 80 || suggestions.length >= 10 || seen.has(`${type}:${word}`)) return;
        seen.add(`${type}:${word}`);
        suggestions.push({ text: word, type, ...(contentId === undefined ? {} : { contentId }) });
      };
      // 首字母候选只跟着真正的拼音命中走：拉丁剧名自己就是词，再给一条"首字母"纯属重复噪声。
      const byInitials = query.replace(/\s+/g, '').length >= 2;
      for (const entry of found) {
        push(entry.result.item.title, 'title', entry.result.item.id);
        if (byInitials && entry.hit.matchType === 'pinyin') push(entry.hit.initials, 'pinyin', entry.result.item.id);
        push(entry.result.item.category, 'category');
      }
      return { query, suggestions };
    }
  };
}
