/**
 * W4: 视频媒体流式缓存管理器与 LRU 配额控制 (SPEC §4.4)。
 * 严守 M-8 铁律：私密资源（isPrivate）永不落盘。
 */

import {
  DEFAULT_MEDIA_CACHE_QUOTA_MIB, mibToBytes, type MediaCacheQuotaMiB,
  type MediaCacheConfig, type MediaCacheStats, type MediaNetworkPolicy
} from './media-cache-policy';

export interface CacheKeyParams {
  workId: string;
  edition?: string;
  episodeNumber: number;
  lineIndex?: number;
  uri: string;
  byteRange?: string;
}

export interface MediaCacheEntryMeta {
  workId: string;
  episodeNumber: number;
  lineIndex?: number;
  isPrivate?: boolean;
  contentType?: string;
}

export interface StoredEntry {
  key: string;
  meta: MediaCacheEntryMeta;
  byteLength: number;
  accessedAt: number;
  accessOrder: number;
  createdAt: number;
  data: Uint8Array;
}

export function buildCacheKey(p: CacheKeyParams): string {
  const ed = p.edition ?? 'std';
  const li = p.lineIndex ?? 0;
  const br = p.byteRange ?? 'all';
  return `${p.workId}:${ed}:${p.episodeNumber}:${li}:${br}:${p.uri}`;
}

export interface MediaCacheStorageDriver {
  write(key: string, data: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryCacheDriver implements MediaCacheStorageDriver {
  private readonly store = new Map<string, Uint8Array>();

  async write(key: string, data: Uint8Array): Promise<void> {
    this.store.set(key, data);
  }

  async read(key: string): Promise<Uint8Array | null> {
    return this.store.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

export class MediaCacheManager {
  private quotaBytes: number;
  private networkPolicy: MediaNetworkPolicy;
  private readonly entries = new Map<string, StoredEntry>();
  private readonly pinCounts = new Map<string, number>();
  private readonly driver: MediaCacheStorageDriver;
  private diskLow = false;
  private accessCounter = 0;

  constructor(
    config?: Partial<MediaCacheConfig>,
    driver?: MediaCacheStorageDriver
  ) {
    this.quotaBytes = mibToBytes(config?.quotaMiB ?? DEFAULT_MEDIA_CACHE_QUOTA_MIB);
    this.networkPolicy = config?.networkPolicy ?? 'wifi_only';
    this.driver = driver ?? new MemoryCacheDriver();
  }

  setNetworkPolicy(policy: MediaNetworkPolicy): void {
    this.networkPolicy = policy;
  }

  getNetworkPolicy(): MediaNetworkPolicy {
    return this.networkPolicy;
  }

  setDiskLow(isLow: boolean): void {
    this.diskLow = isLow;
  }

  async setQuotaMiB(quotaMiB: MediaCacheQuotaMiB): Promise<void> {
    this.quotaBytes = mibToBytes(quotaMiB);
    await this.evictIfNecessary(0);
  }

  pin(key: string): void {
    const count = this.pinCounts.get(key) ?? 0;
    this.pinCounts.set(key, count + 1);
  }

  unpin(key: string): void {
    const count = this.pinCounts.get(key) ?? 0;
    if (count <= 1) this.pinCounts.delete(key);
    else this.pinCounts.set(key, count - 1);
  }

  isPinned(key: string): boolean {
    return (this.pinCounts.get(key) ?? 0) > 0;
  }

  async get(key: string): Promise<Uint8Array | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    entry.accessedAt = Date.now();
    entry.accessOrder = ++this.accessCounter;
    return this.driver.read(key);
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  async put(key: string, data: Uint8Array, meta: MediaCacheEntryMeta): Promise<boolean> {
    // M-8 铁律：私密内容永不落盘
    if (meta.isPrivate) return false;
    if (this.diskLow) return false;
    if (data.byteLength > this.quotaBytes) return false;

    await this.evictIfNecessary(data.byteLength);

    const currentUsed = this.calculateUsedBytes();
    if (currentUsed + data.byteLength > this.quotaBytes) {
      return false;
    }

    await this.driver.write(key, data);
    const now = Date.now();
    this.entries.set(key, {
      key,
      meta,
      byteLength: data.byteLength,
      accessedAt: now,
      accessOrder: ++this.accessCounter,
      createdAt: now,
      data
    });
    return true;
  }

  async clear(): Promise<void> {
    const keysToDelete: string[] = [];
    for (const [key] of this.entries) {
      if (!this.isPinned(key)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      this.entries.delete(key);
      await this.driver.delete(key);
    }
  }

  getStats(): MediaCacheStats {
    let usedBytes = 0;
    let pinnedBytes = 0;
    for (const [key, entry] of this.entries) {
      usedBytes += entry.byteLength;
      if (this.isPinned(key)) pinnedBytes += entry.byteLength;
    }
    return {
      usedBytes,
      quotaBytes: this.quotaBytes,
      itemCount: this.entries.size,
      pinnedBytes,
      networkPolicy: this.networkPolicy,
      isDiskLow: this.diskLow
    };
  }

  private calculateUsedBytes(): number {
    let sum = 0;
    for (const entry of this.entries.values()) sum += entry.byteLength;
    return sum;
  }

  private async evictIfNecessary(neededBytes: number): Promise<void> {
    let currentUsed = this.calculateUsedBytes();
    if (currentUsed + neededBytes <= this.quotaBytes) return;

    // 按 accessOrder 升序排列（最老的在前）
    const evictable = Array.from(this.entries.values())
      .filter((e) => !this.isPinned(e.key))
      .sort((a, b) => a.accessOrder - b.accessOrder);

    for (const entry of evictable) {
      if (currentUsed + neededBytes <= this.quotaBytes) break;
      this.entries.delete(entry.key);
      await this.driver.delete(entry.key);
      currentUsed -= entry.byteLength;
    }
  }
}
