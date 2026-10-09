// @vitest-environment jsdom
/**
 * W1 统一事实缓存（`core/api/title-facts`）：单飞合并 / TTL 只认 cachedAt / 私密零落盘 /
 * raw 一条响应双适配（详情 + 清单）。固定 nowSeconds 与内存盘夹具，不起真实网络与真实时钟。
 */
import { describe, expect, it } from 'vitest';
import { createTitleFactsStore, TITLE_FACTS_TTL_SECONDS } from '../../src/core/api/title-facts';
import { MemoryCacheDisk, type CacheWrite } from '../../src/core/storage/public-cache';

/** 新形态原始响应（与云端 `titleAssetResponse` 同形状：顶层 workId/isPrivate 与 item 必须一致）。 */
function rawOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  const workId = typeof over.workId === 'string' ? over.workId : 'w1';
  const isPrivate = over.isPrivate === true;
  return {
    workId, title: '甲剧', channelId: 'drama', isPrivate,
    generatedAt: 1_780_000_000,
    item: { id: workId, channelId: 'drama', title: '甲剧', category: '都市', isPrivate },
    episodes: [{ episodeNumber: 1, title: '第1集', durationSeconds: 100, lines: [{ providerId: 'provider_m1', mediaUrl: 'https://up.example/e1.m3u8' }] }],
    ...over
  };
}

/** 记录写入键的内存盘包装：验证"私密不落盘"与"公开已落盘"用。 */
function spyDisk(): { disk: MemoryCacheDisk; writes: string[] } {
  const inner = new MemoryCacheDisk();
  const writes: string[] = [];
  const disk = {
    read: (key: string) => inner.read(key),
    list: (prefix: string) => inner.list(prefix),
    writeBatch: async (batch: CacheWrite[], removes: string[]) => { for (const entry of batch) writes.push(entry.key); await inner.writeBatch(batch, removes); }
  } as unknown as MemoryCacheDisk;
  return { disk, writes };
}

describe('W1 统一事实缓存', () => {
  it('单飞合并：并发两次 loadDetail 只发一次网络，两个调用者拿到同一条目引用', async () => {
    let calls = 0;
    const store = createTitleFactsStore({ fetchRaw: async () => { calls += 1; return rawOf(); }, disk: null });
    const [a, b] = await Promise.all([store.loadDetail('w1'), store.loadDetail('w1')]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(a.detail.item.title).toBe('甲剧');
    expect(a.manifest?.episodes[0].lines).toHaveLength(1); // 一条 raw 双适配：清单同源可得
  });

  it('TTL 只认 cachedAt：generatedAt 很旧也在窗口内命中，cachedAt 超窗才重拉', async () => {
    let now = 1_800_000_000;
    let calls = 0;
    const store = createTitleFactsStore({
      fetchRaw: async () => { calls += 1; return rawOf({ generatedAt: 1_600_000_000 }); },
      disk: null, nowSeconds: () => now
    });
    await store.loadDetail('w1');
    now += TITLE_FACTS_TTL_SECONDS - 1;
    await store.loadDetail('w1');
    expect(calls).toBe(1); // 上游事实时间旧，但本地获取还在窗口内：不得误判过期
    now += 2;
    await store.loadDetail('w1');
    expect(calls).toBe(2);
  });

  it('失败不缓存：网络抛错后下一次仍重新发起，且不落任何盘', async () => {
    let fail = true;
    const { disk, writes } = spyDisk();
    const store = createTitleFactsStore({ fetchRaw: async () => { if (fail) throw new Error('offline'); return rawOf(); }, disk });
    await expect(store.loadDetail('w1')).rejects.toThrow('offline');
    expect(writes).toHaveLength(0);
    fail = false;
    const entry = await store.loadDetail('w1');
    expect(entry.detail.item.title).toBe('甲剧');
  });

  it('公开载荷落盘、新进程可恢复免网络；私密载荷零落盘（闸门静默拦下）', async () => {
    const { disk, writes } = spyDisk();
    const first = createTitleFactsStore({ fetchRaw: async () => rawOf(), disk });
    await first.loadDetail('w1');
    expect(writes.some((key) => key.includes('w1'))).toBe(true);

    let netCalls = 0;
    const second = createTitleFactsStore({ fetchRaw: async () => { netCalls += 1; return rawOf(); }, disk });
    const restored = await second.loadDetail('w1');
    expect(netCalls).toBe(0);
    expect(restored.detail.item.title).toBe('甲剧');
    expect(restored.manifest?.episodes[0].lines).toHaveLength(1);

    const { disk: privDisk, writes: privWrites } = spyDisk();
    const priv = createTitleFactsStore({
      fetchRaw: async () => rawOf({ isPrivate: true, item: { id: 'w1', channelId: 'drama', title: '甲剧', category: '都市', isPrivate: true } }),
      disk: privDisk
    });
    const privEntry = await priv.loadDetail('w1');
    expect(privEntry.detail.item.title).toBe('甲剧'); // 内存照常服务
    expect(privWrites).toHaveLength(0);               // 磁盘一个字节都不许写
  });

  it('loadManifest：raw 在场时零额外网络；直通模式静默失败返回 null', async () => {
    let rawCalls = 0, manifestCalls = 0;
    const store = createTitleFactsStore({
      fetchRaw: async () => { rawCalls += 1; return rawOf(); },
      fetchManifest: async () => { manifestCalls += 1; return rawOf(); },
      disk: null
    });
    const manifest = await store.loadManifest('w1');
    expect(manifest?.workId).toBe('w1');
    expect(rawCalls).toBe(1);
    expect(manifestCalls).toBe(0); // 有 raw 能力时清单直通永不启用

    const direct = createTitleFactsStore({ fetchManifest: async () => { manifestCalls += 1; return rawOf({ workId: 'w2' }); }, disk: null });
    expect((await direct.loadManifest('w2'))?.workId).toBe('w2');
    expect(manifestCalls).toBe(1);

    const down = createTitleFactsStore({ fetchManifest: async () => { throw new Error('offline'); }, disk: null });
    expect(await down.loadManifest('w3')).toBeNull(); // 静默：回退代理链，不落错误卡
  });

  it('内存 LRU：超过 20 部淘汰最旧，旧 workId 重新触发网络', async () => {
    const calls: string[] = [];
    const store = createTitleFactsStore({
      fetchRaw: async (id) => { calls.push(id); return rawOf({ workId: id, item: { id, channelId: 'drama', title: '甲剧', category: '都市', isPrivate: false } }); },
      disk: null
    });
    for (let index = 1; index <= 21; index += 1) await store.loadDetail(`w${index}`);
    expect(store.size()).toBeLessThanOrEqual(20);
    await store.loadDetail('w1'); // 最旧，已被 LRU 淘汰
    expect(calls.filter((id) => id === 'w1')).toHaveLength(2);
    await store.loadDetail('w21'); // 最近，仍在内存
    expect(calls.filter((id) => id === 'w21')).toHaveLength(1);
  });
});
