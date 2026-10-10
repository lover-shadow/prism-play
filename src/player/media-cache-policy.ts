/**
 * W4: 视频缓存策略、配额与网络环境判定规则 (SPEC §4.4 / §4.5)。
 */

export const MEDIA_CACHE_QUOTA_LEVELS_MIB = [256, 512, 1024, 2048, 3072] as const;
export type MediaCacheQuotaMiB = (typeof MEDIA_CACHE_QUOTA_LEVELS_MIB)[number];

export const DEFAULT_MEDIA_CACHE_QUOTA_MIB: MediaCacheQuotaMiB = 512;
export const MIN_DISK_FREE_SAFETY_MIB = 512;
export const MAX_PREFETCH_CONCURRENCY = 2;

export type MediaNetworkPolicy = 'wifi_only' | 'all_networks' | 'disabled';

export interface MediaCacheConfig {
  networkPolicy: MediaNetworkPolicy;
  quotaMiB: MediaCacheQuotaMiB;
}

export interface MediaCacheStats {
  usedBytes: number;
  quotaBytes: number;
  itemCount: number;
  pinnedBytes: number;
  networkPolicy: MediaNetworkPolicy;
  isDiskLow: boolean;
}

export function mibToBytes(mib: number): number {
  return mib * 1024 * 1024;
}

export function bytesToMib(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 100) / 100;
}

export function isValidQuotaMiB(value: number): value is MediaCacheQuotaMiB {
  return MEDIA_CACHE_QUOTA_LEVELS_MIB.includes(value as MediaCacheQuotaMiB);
}

export function canDownloadOverNetwork(policy: MediaNetworkPolicy, isWifi: boolean): boolean {
  if (policy === 'disabled') return false;
  if (policy === 'all_networks') return true;
  return isWifi;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
