/**
 * 公开缓存域的私有基元：命名空间、键形态、JSON 编解码与 LRU 台账。
 *
 * 从 `public-cache.ts` 抽出是 SPEC §10「单文件 ≤ 300 行」的直接后果，不是分层偏好：域对外的唯一入口仍然是
 * `PublicCache`，本文件的键前缀属于该域的内部形态，域外一律禁止自行拼接路径字符串（否则【清理缓存】的枚举范围
 * 与备份排除规则会各自漂移）。
 */

import type { ContentItem } from '../../../edge/src/types/api';
import { assertWritable } from './storage-domains';

export const CACHE_KEY_NAMESPACE = 'cache/';
export const CATALOG_META_KEY = `${CACHE_KEY_NAMESPACE}catalog/meta.json`;
export const CATALOG_REVISION_PREFIX = `${CACHE_KEY_NAMESPACE}catalog/r`;
export const POSTER_PREFIX = `${CACHE_KEY_NAMESPACE}posters/`;
/**
 * 频道拓扑独立于目录修订：它不参与条目级 LRU（体量由契约的频道闭集界定），但仍在 `cache/` 命名空间内，
 * 因此【清理缓存】与备份排除规则天然覆盖它（SPEC §6.1 第三行的"公开频道配置"落点）。
 */
export const CHANNELS_KEY = `${CACHE_KEY_NAMESPACE}channels.json`;

/** Persisted chunk size, deliberately independent of the server page size so re-persisting is trivial. */
export const CATALOG_CHUNK_ITEMS = 100;

const encoder = new TextEncoder();
export const jsonBytes = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
export const decodeJson = <T>(bytes: Uint8Array | null): T | null => {
  if (bytes === null) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null; // A torn file degrades to "no snapshot", never to a crash at cold start (AC-01).
  }
};
export const chunkKey = (revision: number, index: number): string => `${CATALOG_REVISION_PREFIX}${revision}/c${index}.json`;
export const posterKey = (contentId: string, coverVersion: string): string => `${POSTER_PREFIX}${contentId}@${coverVersion}`;

/** AC-02-5: privacy is read off the payload, so a private item cannot be cached even by accident. */
export function guardItem(operation: string, item: ContentItem): void {
  assertWritable(operation, { contentId: item.id, channelId: item.channelId, isPrivate: item.isPrivate });
}

/** Running byte total with a touch clock, keyed by whatever the caller treats as the LRU unit. */
export class Ledger {
  private readonly entries = new Map<string, { bytes: number; touched: number }>();
  private clock = 0;
  bytes = 0;
  constructor(private readonly cap: number) {}
  reset(): void { this.entries.clear(); this.bytes = 0 }
  put(key: string, bytes: number): void {
    this.bytes += bytes - (this.entries.get(key)?.bytes ?? 0);
    this.entries.set(key, { bytes, touched: (this.clock += 1) });
  }
  hit(key: string): void { const entry = this.entries.get(key); if (entry !== undefined) entry.touched = (this.clock += 1); }
  forget(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
  has(key: string): boolean { return this.entries.has(key) }
  keys(): string[] { return [...this.entries.keys()] }
  get overCapacity(): boolean { return this.bytes > this.cap }
  oldest(): string | undefined {
    let best: { key: string; touched: number } | undefined;
    for (const [key, entry] of this.entries) if (best === undefined || entry.touched < best.touched) best = { key, touched: entry.touched };
    return best?.key;
  }
}
