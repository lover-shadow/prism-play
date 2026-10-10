import { describe, it, expect } from 'vitest';
import {
  MediaCacheManager, buildCacheKey
} from '../../src/player/media-cache-manager';
import {
  MediaPrefetchScheduler, PRIORITY_CURRENT_GAP,
  PRIORITY_NEXT_EPISODE, PRIORITY_PREDICTIVE_TOP10
} from '../../src/player/media-prefetch-scheduler';
import {
  formatBytes, isValidQuotaMiB, canDownloadOverNetwork
} from '../../src/player/media-cache-policy';

describe('W4 视频媒体缓存管理器 (MediaCacheManager)', () => {
  it('正确校验配额档位与网络权限', () => {
    expect(isValidQuotaMiB(256)).toBe(true);
    expect(isValidQuotaMiB(512)).toBe(true);
    expect(isValidQuotaMiB(3072)).toBe(true);
    expect(isValidQuotaMiB(100)).toBe(false);

    expect(canDownloadOverNetwork('wifi_only', true)).toBe(true);
    expect(canDownloadOverNetwork('wifi_only', false)).toBe(false);
    expect(canDownloadOverNetwork('all_networks', false)).toBe(true);
    expect(canDownloadOverNetwork('disabled', true)).toBe(false);

    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(1024 * 512)).toBe('512.0 KB');
    expect(formatBytes(1024 * 1024 * 10)).toBe('10.0 MB');
  });

  it('M-8 铁律：私密资源严禁落盘', async () => {
    const manager = new MediaCacheManager({ quotaMiB: 256 });
    const key = buildCacheKey({ workId: 'priv_1', episodeNumber: 1, uri: 'https://cdn/p1.ts' });
    const data = new Uint8Array([1, 2, 3, 4]);

    const accepted = await manager.put(key, data, {
      workId: 'priv_1', episodeNumber: 1, isPrivate: true
    });
    expect(accepted).toBe(false);
    expect(await manager.get(key)).toBeNull();
    expect(manager.getStats().usedBytes).toBe(0);
  });

  it('低磁盘安全保护：处于磁盘空间紧张时拒绝写入', async () => {
    const manager = new MediaCacheManager({ quotaMiB: 256 });
    manager.setDiskLow(true);
    const key = buildCacheKey({ workId: 'pub_1', episodeNumber: 1, uri: 'https://cdn/1.ts' });
    const accepted = await manager.put(key, new Uint8Array([1, 2]), {
      workId: 'pub_1', episodeNumber: 1, isPrivate: false
    });
    expect(accepted).toBe(false);
    expect(await manager.get(key)).toBeNull();
  });

  it('LRU 淘汰：超出配额时自动淘汰最旧条目', async () => {
    // 实例化一个极小配额（模拟 1 MiB，手动注入 quotaBytes = 10 字节）
    const manager = new MediaCacheManager({ quotaMiB: 256 });
    (manager as any).quotaBytes = 10;

    const k1 = 'work:1:seg1';
    const k2 = 'work:1:seg2';
    const k3 = 'work:1:seg3';

    await manager.put(k1, new Uint8Array(4), { workId: 'w', episodeNumber: 1 });
    await new Promise((r) => setTimeout(r, 5));
    await manager.put(k2, new Uint8Array(4), { workId: 'w', episodeNumber: 1 });

    expect(manager.has(k1)).toBe(true);
    expect(manager.has(k2)).toBe(true);
    expect(manager.getStats().usedBytes).toBe(8);

    // 访问 k1，使 k1 的 accessedAt 新于 k2
    await manager.get(k1);
    await new Promise((r) => setTimeout(r, 5));

    // 写入 k3（4 字节），总大小 8+4=12 > 10，此时最老的 k2 应被淘汰
    const ok = await manager.put(k3, new Uint8Array(4), { workId: 'w', episodeNumber: 1 });
    expect(ok).toBe(true);
    expect(manager.has(k2)).toBe(false); // k2 被淘汰
    expect(manager.has(k1)).toBe(true); // k1 保留
    expect(manager.has(k3)).toBe(true); // k3 成功写入
  });

  it('Pin 保护机制：被 pin 保护的条目不可被淘汰', async () => {
    const manager = new MediaCacheManager({ quotaMiB: 256 });
    (manager as any).quotaBytes = 10;

    const k1 = 'work:1:seg1';
    const k2 = 'work:1:seg2';

    await manager.put(k1, new Uint8Array(6), { workId: 'w', episodeNumber: 1 });
    manager.pin(k1);

    // 尝试写入 6 字节的 k2，k1 已被 pin，无法淘汰，空间不足写入失败
    const ok = await manager.put(k2, new Uint8Array(6), { workId: 'w', episodeNumber: 1 });
    expect(ok).toBe(false);
    expect(manager.has(k1)).toBe(true);
    expect(manager.has(k2)).toBe(false);

    // unpin 后再次写入，k1 可以被淘汰
    manager.unpin(k1);
    const ok2 = await manager.put(k2, new Uint8Array(6), { workId: 'w', episodeNumber: 1 });
    expect(ok2).toBe(true);
    expect(manager.has(k1)).toBe(false);
    expect(manager.has(k2)).toBe(true);
  });

  it('清空缓存：clear() 仅清理未 pin 条目', async () => {
    const manager = new MediaCacheManager();
    await manager.put('k1', new Uint8Array(5), { workId: 'w', episodeNumber: 1 });
    await manager.put('k2', new Uint8Array(5), { workId: 'w', episodeNumber: 1 });
    manager.pin('k1');

    await manager.clear();
    expect(manager.has('k1')).toBe(true);
    expect(manager.has('k2')).toBe(false);
  });
});

describe('W4 分级预取调度器 (MediaPrefetchScheduler)', () => {
  it('当并发占满时，按优先级从高到低出队调度', async () => {
    const scheduler = new MediaPrefetchScheduler({ policy: 'wifi_only', isWifi: true });
    const executed: string[] = [];

    let releaseBlockers!: () => void;
    const blockerPromise = new Promise<void>((r) => { releaseBlockers = r; });

    scheduler.enqueue({
      id: 'blocker_1', workId: 'b1', episodeNumber: 1,
      priority: PRIORITY_CURRENT_GAP,
      run: () => blockerPromise
    });
    scheduler.enqueue({
      id: 'blocker_2', workId: 'b2', episodeNumber: 1,
      priority: PRIORITY_CURRENT_GAP,
      run: () => blockerPromise
    });

    scheduler.enqueue({
      id: 'task_low', workId: 'w1', episodeNumber: 1,
      priority: PRIORITY_PREDICTIVE_TOP10,
      run: async () => { executed.push('low'); }
    });
    scheduler.enqueue({
      id: 'task_high', workId: 'w1', episodeNumber: 2,
      priority: PRIORITY_NEXT_EPISODE,
      run: async () => { executed.push('high'); }
    });
    scheduler.enqueue({
      id: 'task_critical', workId: 'w1', episodeNumber: 1,
      priority: PRIORITY_CURRENT_GAP,
      run: async () => { executed.push('critical'); }
    });

    expect(scheduler.getStats().activeCount).toBe(2);
    expect(scheduler.getStats().queueLength).toBe(3);

    releaseBlockers();
    await new Promise((r) => setTimeout(r, 40));

    expect(executed[0]).toBe('critical');
    expect(executed[1]).toBe('high');
    expect(executed[2]).toBe('low');
  });

  it('网络从 Wi-Fi 变为蜂窝时自动取消主动预取', async () => {
    const scheduler = new MediaPrefetchScheduler({ policy: 'wifi_only', isWifi: true });
    let cancelled = false;

    scheduler.enqueue({
      id: 'next_ep', workId: 'w1', episodeNumber: 2,
      priority: PRIORITY_NEXT_EPISODE,
      run: async (signal) => {
        await new Promise((resolve) => {
          signal.addEventListener('abort', () => { cancelled = true; resolve(null); });
        });
      }
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(scheduler.getStats().activeCount).toBe(1);

    // 切换到非 Wi-Fi
    scheduler.setNetworkState(false);
    expect(cancelled).toBe(true);
    expect(scheduler.getStats().activeCount).toBe(0);
  });

  it('播放发生缓冲拥塞时，主动预取任务自动让路挂起', async () => {
    const scheduler = new MediaPrefetchScheduler({ policy: 'wifi_only', isWifi: true });
    let cancelled = false;

    scheduler.enqueue({
      id: 'next_ep_buffer_test', workId: 'w1', episodeNumber: 2,
      priority: PRIORITY_NEXT_EPISODE,
      run: async (signal) => {
        await new Promise((resolve) => {
          signal.addEventListener('abort', () => { cancelled = true; resolve(null); });
        });
      }
    });

    await new Promise((r) => setTimeout(r, 10));
    expect(scheduler.getStats().activeCount).toBe(1);

    // 标记播放缓冲中
    scheduler.setPlaybackBuffering(true);
    expect(cancelled).toBe(true);
    expect(scheduler.getStats().activeCount).toBe(0);
  });
});
