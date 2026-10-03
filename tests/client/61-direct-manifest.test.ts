// @vitest-environment jsdom
/**
 * A-7.2 剧集清单的拉取、缓存与私密零落盘（SPEC-APP-REFACTOR §2.2 / A-7）。
 *
 * 钉四件事，都是这份数据离开云端之后唯一可能出事的地方：
 *   • `PrismApiClient.titleManifest` 走的仍是 `/api/titles/{id}`，并带上私密会话凭据（没有它私密清单必 404）；
 *   • 旧云端返回 `TitleDetail` 时 `parseTitleManifest` 认不下，整体降级为"没有清单"→ 播放器退回代理链；
 *   • 公开清单落进公开缓存域（【清理缓存】与备份排除规则天然覆盖），私密清单**连一次 I/O 都没有**；
 *   • 一次打开只拉一次（内存命中 + 并发去重），切集不回网络。
 * 缓存盘用生产同款 `MemoryCacheDisk`，闸门是生产同款 `assertWritable`——私密零落盘证的是真闸门，不是自述。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TitleDetail, TitleManifest } from '../../edge/src/types/api';
import { PrismApiClient } from '../../src/core/api/client';
import { MemoryCacheDisk } from '../../src/core/storage/public-cache';
import {
  TITLE_MANIFEST_INDEX_KEY, TITLE_MANIFEST_KEY_PREFIX, TITLE_MANIFEST_MEMORY_LIMIT,
  createTitleManifestStore, installTitleManifestStore, activeTitleManifestStore, isPrivateManifest,
  mimeTypeOfMediaUrl, parseTitleManifest
} from '../../src/player/title-manifest';

const EDGE = 'https://edge.test';
const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });

const manifestOf = (over: Partial<TitleManifest> = {}): TitleManifest => ({
  workId: 'w1',
  title: '凤逆天下',
  channelId: 'drama',
  isPrivate: false,
  episodes: [
    { episodeNumber: 1, lines: [{ providerId: 'provider_s1', mediaUrl: 'https://cdn.invalid/first.m3u8' }] },
    {
      episodeNumber: 2,
      durationSeconds: 130,
      lines: [
        { providerId: 'provider_s1', mediaUrl: 'https://cdn.invalid/a.m3u8' },
        { providerId: 'provider_m1', mediaUrl: 'https://cdn.invalid/b.m3u8' },
        { providerId: 'provider_m2', mediaUrl: 'https://cdn.invalid/c.m3u8' },
        { providerId: 'provider_m3', mediaUrl: 'https://cdn.invalid/d.m3u8' }
      ]
    }
  ],
  generatedAt: 1_780_000_000,
  ...over
});

/** 旧云端（`/api/titles/{id}` 仍返回 `TitleDetail`）的一份真实形状。 */
const legacyDetail = (): TitleDetail => ({
  item: { id: 'w1', channelId: 'drama', title: '凤逆天下', category: '都市', isPrivate: false },
  episodes: [{ episodeId: 11, episodeNumber: 1, durationSeconds: 100 }]
});

describe('A-7.2 客户端：剧集清单是播放地址的唯一入口', () => {
  it('AC-A7-2 路径与私密会话头都在，私密清单才可能拿到 200', async () => {
    const seen: Array<{ url: string; session: string | null }> = [];
    const client = new PrismApiClient({
      baseUrl: EDGE,
      fetchImpl: async (input, init) => {
        seen.push({ url: input, session: new Headers(init?.headers).get('x-private-session') });
        return json(manifestOf());
      }
    });
    client.bindSessionHolder({ read: () => 'sess-token', write: () => undefined });
    const manifest = await client.titleManifest('中文 id');
    expect(manifest.workId).toBe('w1');
    expect(decodeURIComponent(seen[0].url)).toBe(`${EDGE}/api/titles/中文 id`);
    expect(seen[0].session).toBe('sess-token');
  });

  it('AC-A7-2 404 就是 404：私密与未知共用同一条降级，不猜任何元信息', async () => {
    const client = new PrismApiClient({ baseUrl: EDGE, fetchImpl: async () => new Response('{"success":false,"code":"NOT_FOUND","message":"内容不存在"}', { status: 404 }) });
    await expect(client.titleManifest('w1')).rejects.toMatchObject({ treatedAsMissing: true });
  });
});

describe('A-7.2 清单形状校验：认不下就整份作废', () => {
  it('AC-A7-2 旧 TitleDetail 形态不被当作清单——否则回退链永远走不到', () => {
    expect(parseTitleManifest(legacyDetail())).toBeNull();
    expect(parseTitleManifest(null)).toBeNull();
    expect(parseTitleManifest([])).toBeNull();
    expect(parseTitleManifest(manifestOf({ episodes: [{ episodeNumber: 0, lines: [] }] }))).toBeNull();
    // 非 http(s) 的地址进不了播放栈：javascript: 与相对路径都在此拦掉。
    expect(parseTitleManifest(manifestOf({ episodes: [{ episodeNumber: 1, lines: [{ providerId: 'provider_s1', mediaUrl: 'javascript:alert(1)' }] }] }))).toBeNull();
    expect(parseTitleManifest(manifestOf({ episodes: [{ episodeNumber: 1, lines: [{ providerId: 'provider_s1', mediaUrl: '/proxy/media/h1' }] }] }))).toBeNull();
    expect(parseTitleManifest(manifestOf())?.episodes[1].lines).toHaveLength(4);
  });

  it('AC-A7-1 MIME 按后缀分流，带查询串的签名地址也认得出来', () => {
    expect(mimeTypeOfMediaUrl('https://cdn.invalid/a.m3u8?sig=1')).toBe('application/vnd.m3u8+playlist');
    expect(mimeTypeOfMediaUrl('https://cdn.invalid/a.mp4#t=1')).toBe('video/mp4');
    expect(mimeTypeOfMediaUrl('https://cdn.invalid/segment')).toBe('application/vnd.m3u8+playlist');
  });
});

describe('A-7.2 两级缓存：内存优先、公开落盘、私密零 I/O', () => {
  beforeEach(() => { installTitleManifestStore(createTitleManifestStore({ api: {}, disk: null })); });

  const store = (routes: Record<string, TitleManifest | TitleDetail>, over: { disk?: MemoryCacheDisk; now?: () => number } = {}) => {
    const hits: string[] = [];
    const api = { titleManifest: async (workId: string) => { hits.push(workId); return routes[workId] as TitleManifest; } };
    return { store: createTitleManifestStore({ api, disk: over.disk ?? null, nowSeconds: over.now ?? (() => 1_780_000_600) }), hits };
  };

  it('AC-A7-2 同一 workId 只拉一次：内存命中与并发去重共用同一个在途请求', async () => {
    const { store: shelf, hits } = store({ w1: manifestOf() });
    const [first, second] = await Promise.all([shelf.load('w1'), shelf.load('w1')]);
    expect(first?.title).toBe('凤逆天下');
    expect(second?.workId).toBe('w1');
    expect(hits).toEqual(['w1']);
    await shelf.load('w1');
    expect(hits).toEqual(['w1']);
    expect(shelf.cached('w1')?.episodes).toHaveLength(2);
  });

  it('AC-A7-2 清单缺席（旧云端 / 无 titleManifest / 网络失败）一律降级为 null，调用方据此回退', async () => {
    const legacy = store({ w1: legacyDetail() });
    expect(await legacy.store.load('w1')).toBeNull();
    expect(await createTitleManifestStore({ api: {}, disk: null }).load('w2')).toBeNull();
    const down = createTitleManifestStore({ api: { titleManifest: async () => { throw new Error('offline'); } }, disk: null });
    expect(await down.load('w3')).toBeNull();
    expect(await down.linesFor('w3', 1)).toEqual([]);
  });

  it('AC-A7-2 linesFor 按集数取线路，缺失集数为空数组而不是抛错', async () => {
    const { store: shelf } = store({ w1: manifestOf() });
    expect(await shelf.linesFor('w1', 2)).toHaveLength(4);
    expect(await shelf.linesFor('w1', 99)).toEqual([]);
  });

  it('AC-A7-2 公开清单落进公开缓存域，键在 cache/ 命名空间内且有索引', async () => {
    const disk = new MemoryCacheDisk();
    const { store: shelf } = store({ w1: manifestOf() }, { disk });
    await shelf.load('w1');
    const keys = (await disk.list(TITLE_MANIFEST_KEY_PREFIX)).map((entry) => entry.key);
    expect(keys).toContain(`${TITLE_MANIFEST_KEY_PREFIX}w1.json`);
    expect(keys).toContain(TITLE_MANIFEST_INDEX_KEY);
    // 换一只 store（= 冷启动重开进程）：同一张盘读回同一份清单，不再打网络。
    const cold = store({ w1: manifestOf() }, { disk });
    expect(cold.store.cached('w1')).toBeNull();
    expect((await cold.store.load('w1'))?.episodes).toHaveLength(2);
    expect(cold.hits).toEqual([]);
  });

  it('AC-02 / A-7.2 私密清单一次 I/O 都没有：盘上永远是空的，内存里照常用', async () => {
    const disk = new MemoryCacheDisk();
    const writes: string[][] = [];
    const spy = new MemoryCacheDisk();
    const original = spy.writeBatch.bind(spy);
    spy.writeBatch = async (writes_, removes) => { writes.push(writes_.map((entry) => entry.key)); return original(writes_, removes); };
    const { store: shelf } = store({ p1: manifestOf({ workId: 'p1', isPrivate: true, channelId: 'private' }) }, { disk: spy });
    const manifest = await shelf.load('p1');
    expect(manifest).not.toBeNull();
    expect(isPrivateManifest(manifest!)).toBe(true);
    expect(writes).toEqual([]);
    expect((await disk.list(TITLE_MANIFEST_KEY_PREFIX))).toEqual([]);
    expect(await shelf.linesFor('p1', 1)).toHaveLength(1);
  });

  it('AC-02 挂在 private 频道却自称公开的清单仍按私密处置：判定读载荷，不信调用方', async () => {
    const spy = new MemoryCacheDisk();
    let touched = 0;
    spy.writeBatch = async (writes, removes) => { touched += 1; return MemoryCacheDisk.prototype.writeBatch.call(spy, writes, removes); };
    const { store: shelf } = store({ p2: manifestOf({ workId: 'p2', isPrivate: false, channelId: 'private' }) }, { disk: spy });
    await shelf.load('p2');
    expect(touched).toBe(0);
    expect(isPrivateManifest(shelf.cached('p2')!)).toBe(true);
  });

  it('AC-A7-2 内存有上限：LRU 按插入序收敛，清单不是全库镜像', async () => {
    const routes: Record<string, TitleManifest> = {};
    for (let index = 1; index <= TITLE_MANIFEST_MEMORY_LIMIT + 3; index += 1) routes[`w${index}`] = manifestOf({ workId: `w${index}` });
    const { store: shelf } = store(routes);
    for (const workId of Object.keys(routes)) await shelf.load(workId);
    expect(shelf.size()).toBeLessThanOrEqual(TITLE_MANIFEST_MEMORY_LIMIT);
    expect(shelf.cached('w1')).toBeNull();
  });

  it('AC-A7-2 过期即重拉：六小时之内的第二次打开不花钱', async () => {
    let now = 1_780_000_600;
    const { store: shelf, hits } = store({ w1: manifestOf() }, { now: () => now });
    await shelf.load('w1');
    now += 60;
    await shelf.load('w1');
    expect(hits).toEqual(['w1']);
    now += 6 * 3_600;
    await shelf.load('w1');
    expect(hits).toEqual(['w1', 'w1']);
  });

  it('A-7.5 投屏够不到 api 客户端，只能复用播放器装好的那一只 store', () => {
    const shelf = createTitleManifestStore({ api: {}, disk: null });
    expect(installTitleManifestStore(shelf)).toBe(shelf);
    expect(activeTitleManifestStore()).toBe(shelf);
  });

  it('缓存盘写失败不咬播放：内存那份照旧可用', async () => {
    const broken = new MemoryCacheDisk();
    broken.writeBatch = async () => { throw new Error('磁盘空间不足'); };
    const { store: shelf } = store({ w1: manifestOf() }, { disk: broken });
    expect((await shelf.load('w1'))?.episodes).toHaveLength(2);
    expect(shelf.cached('w1')?.workId).toBe('w1');
  });
});
