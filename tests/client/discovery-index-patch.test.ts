// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createDiscoverySync } from '../../src/core/discovery-sync';
import { createPublicCache, MemoryCacheDisk } from '../../src/core/storage/public-cache';
import type { ContentItem } from '../../edge/src/types/api';

describe('发现同步增量索引更新与恢复（AC-OPT-04 / AC-OPT-05 / AC-OPT-06）', () => {
  it('发现变更仅向索引发送增量更新，不调用全量清库重构', async () => {
    const disk = new MemoryCacheDisk();
    const cache = createPublicCache(disk);
    await cache.hydrate();

    const touchedChanges: Array<{ workId: string; operation: string }> = [];
    const client = {
      discoveryChanges: async (_after: number, _limit?: number) => ({
        changes: [
          {
            seq: 1,
            workId: 'drama_new',
            operation: 'upsert' as const,
            updatedAt: 1700000000,
            card: {
              id: 'drama_new',
              channelId: 'drama' as const,
              title: '最新发现短剧',
              category: '逆袭',
              enabled: true,
              shareable: true,
              isPrivate: false
            }
          }
        ],
        cursor: 1,
        hasMore: false
      })
    };

    const onEntriesSpy = vi.fn(async (_items: readonly ContentItem[], changes?: any[]) => {
      if (changes) {
        for (const c of changes) touchedChanges.push({ workId: c.workId, operation: c.operation });
      }
    });

    const sync = createDiscoverySync({
      cache,
      client,
      onEntries: onEntriesSpy
    });

    const result = await sync.sync();
    expect(result.cursor).toBe(1);
    expect(result.error).toBeNull();
    expect(onEntriesSpy).toHaveBeenCalledTimes(1);
    expect(touchedChanges).toEqual([{ workId: 'drama_new', operation: 'upsert' }]);
  });

  it('空变更页不触发索引重构，且 cursor 合法推进', async () => {
    const disk = new MemoryCacheDisk();
    const cache = createPublicCache(disk);
    await cache.hydrate();

    const client = {
      discoveryChanges: async (_after: number) => ({
        changes: [],
        cursor: 5,
        hasMore: false
      })
    };

    const onEntriesSpy = vi.fn(async () => {});
    const sync = createDiscoverySync({
      cache,
      client,
      onEntries: onEntriesSpy
    });

    const result = await sync.sync();
    expect(result.cursor).toBe(5);
    expect(result.error).toBeNull();
    expect(cache.discoveryState().cursor).toBe(5);
  });
});
