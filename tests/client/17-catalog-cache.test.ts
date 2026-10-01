// @vitest-environment jsdom
/**
 * Builder-Catalog 验收：`src/core/catalog-cache.ts`（SPEC §7 公开目录缓存服务；AC-01 快照先显 / AC-18 同修订原子
 * 替换、增量游标、断网保留旧版、海报落域 / AC-02-5 私密零留痕；API-SPEC §一.2、§八 的 409/410 线协议义务）。
 * 落盘一律用真实 `PublicCache + MemoryCacheDisk`，只以 Proxy 记录调用序列：私密闸门、修订守卫与容量 LRU 一刻也没被
 * 替换掉，"绕过公开缓存域"在这套用例里不可能成立。网络侧用真 `PrismApiClient` + 脚本化 fetch，查询串与错误码都按真实
 * 线协议走一遍；断网用 fetch 抛错表达（客户端据此产出 NETWORK_ERROR），而不是伪造响应体。
 */
import { afterEach, describe, expect, it } from 'vitest';import type { CatalogChangesResponse, CatalogResponse, ChannelItem, ChannelsResponse, ContentItem } from '../../edge/src/types/api';
import { ApiError, PrismApiClient } from '../../src/core/api/client';
import { createCatalogCacheService, type SyncOutcome } from '../../src/core/catalog-cache';
import { MemoryCacheDisk, PublicCache } from '../../src/core/storage/public-cache';

const EDGE = 'https://play.prismos.org', POSTER = `${EDGE}/proxy/img/`, KILO = 1024;
const LIMIT = 50; // CHANGES_DEFAULT_LIMIT：增量 limit 口径来自 edge/constants，不在客户端重打数字。
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]);
const UNKNOWN_MAGIC = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
type Handler = (url: URL) => Response | Promise<Response>;
const query = (url: URL, name: string): string => url.searchParams.get(name) ?? '';
const content = (id: string, channelId: string, over: Partial<ContentItem> = {}): ContentItem =>
  ({ id, channelId, title: `剧目${id}`, category: channelId === 'movie' ? '科幻' : '都市', isPrivate: channelId === 'private', coverUrl: `${POSTER}${id}`, coverVersion: 'v1', ...over } as ContentItem);
const topologyOf = (version: number, ids: string[] = ['drama', 'movie']): ChannelsResponse =>
  ({ version, channels: ids.map((id, index) => ({ id, name: `频道${id}`, order: index + 1, requiresTier: [], categories: ['都市'] } as ChannelItem)) });
/** 每页一条：与注入的 `pageSize: 1` 对齐，便于逐页逐频道断言序列；`fat` 用来撑爆目录配额。 */
const catPage = (channelId: string, ids: string[], page: number, total: number, revision: number, fat = false): CatalogResponse =>
  ({ items: ids.map((id) => content(`${channelId}_${id}`, channelId, fat ? { synopsis: '记录'.repeat(4000) } : {})), page, pageSize: 1, total, revision });
const upsert = (contentId: string, channelId: string, at = 1): CatalogChangesResponse['changes'][number] => ({ revision: at, contentId, operation: 'upsert', item: content(contentId, channelId) });
const tombstone = (contentId: string, at = 1): CatalogChangesResponse['changes'][number] => ({ revision: at, contentId, operation: 'delete' });
const changesOf = (nextRevision: number, entries: CatalogChangesResponse['changes'], hasMore = false): CatalogChangesResponse => ({ changes: entries, nextRevision, hasMore });
const ok = (body: unknown): Response => ({ ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response);
const fail = (code: string, status: number, message: string): Response => ({ ok: false, status, text: async () => JSON.stringify({ success: false, code, message }) } as unknown as Response);
const image = (bytes: Uint8Array, status = 200): Response => ({ ok: status === 200, status, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } as unknown as Response);
const down: Handler = () => { throw new Error('设备已离线'); }; // fetch 抛错 → 客户端转成 ApiError('NETWORK_ERROR')
const catalogRoute = (groups: Record<string, string[]>, revision: number, fat = false): Handler => (url) => {
  const channelId = query(url, 'channel'), page = Number(query(url, 'page')), ids = groups[channelId] ?? [];
  return ok(catPage(channelId, ids.slice(page - 1, page), page, ids.length, revision, fat));
};
/** 云端拓扑偶带【个人探索】节点：公开域必须整块剔除，本层因此连一次目录请求都不该发给它。 */
const fullSync = (revision: number, fat = false, drama: string[] = ['a', 'b']): Record<string, Handler> => ({ '/api/channels': () => ok(topologyOf(revision, ['drama', 'movie', 'private'])),
  '/api/catalog': catalogRoute({ drama, movie: ['m1'], private: ['x'] }, revision, fat) });
const flush = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)); };
/** 只记录序列、不改行为：每个写请求仍由真域的私密闸门与修订守卫裁定。 */
const spyCache = (real: PublicCache, calls: string[]): PublicCache => new Proxy(real, {
  get(target: PublicCache, property: string | symbol): unknown {
    const value = Reflect.get(target, property) as unknown;
    if (typeof value !== 'function' || typeof property !== 'string') return value;
    return (...args: unknown[]): unknown => {
      calls.push(`${property}:${typeof args[0] === 'string' ? args[0] : ''}`);
      return (value as (...inner: unknown[]) => unknown).apply(target, args);
    };
  }
});
/** 磁盘上先有一份完整公开快照，供"二次启动先显快照"的用例读取。 */
async function seedSnapshot(disk: MemoryCacheDisk, revision = 7): Promise<void> {
  const warm = new PublicCache(disk);
  await warm.putChannels(topologyOf(revision));
  warm.stagePage('drama', catPage('drama', ['a'], 1, 2, revision)); warm.stagePage('drama', catPage('drama', ['b'], 2, 2, revision));
  warm.stagePage('movie', catPage('movie', ['m1'], 1, 1, revision)); expect((await warm.commitSnapshot()).accepted).toBe(true);
}
/** 只在持久化批量上注入失败，用来观察"同步中断保留旧版"。 */
class FlakyDisk extends MemoryCacheDisk { failing = false;
  override async writeBatch(writes: Array<{ key: string; bytes: Uint8Array }>, removes: string[]): Promise<void> {
    if (this.failing) throw new Error('磁盘空间不足'); await super.writeBatch(writes, removes);
  }
}
function harness(routes: Record<string, Handler> = {}, options: { disk?: MemoryCacheDisk; poster?: Handler; cache?: PublicCache } = {}) {
  const disk = options.disk ?? new MemoryCacheDisk(), real = options.cache ?? new PublicCache(disk);
  const calls: string[] = [], seen: string[] = [], posterFetches: string[] = [], outcomes: SyncOutcome[] = [];
  const client = new PrismApiClient({ baseUrl: EDGE, fetchImpl: async (input: string) => {
    const url = new URL(input, EDGE);
    seen.push(`${url.pathname}${url.search}`);
    const handler = routes[url.pathname];
    return handler === undefined ? down(url) : await handler(url);
  } });
  const service = createCatalogCacheService({ client, cache: spyCache(real, calls), pageSize: 1, nowSeconds: () => 1_700_000_000,
    fetchImpl: async (url: string) => { posterFetches.push(url); return options.poster === undefined ? image(PNG) : await options.poster(new URL(url, EDGE)); } });
  service.onSynced((outcome) => outcomes.push(outcome));
  const commits = () => calls.filter((call) => call === 'commitSnapshot:'), staged = (channelId?: string) => calls.filter((call) => channelId === undefined ? call.startsWith('stagePage') : call === `stagePage:${channelId}`);
  return { service, cache: real, disk, calls, seen, outcomes, posterFetches, commits, staged };
}
const blobUrls: string[] = [];
afterEach(() => { blobUrls.length = 0; for (const name of ['createObjectURL', 'revokeObjectURL']) Object.defineProperty(URL, name, { configurable: true, writable: true, value: undefined }); });
const blobPatch = (): void => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: (blob: Blob) => { blobUrls.push(`blob:prism/${blob.size}`); return blobUrls[blobUrls.length - 1] as string; } });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: () => undefined });
};
describe('bootstrap：快照先显与首屏链路（AC-01）', () => {
  it('已有公开快照时首屏读快照，增量结果由 onSynced 在后台送达', async () => {
    const disk = new MemoryCacheDisk(); await seedSnapshot(disk);
    let settle: (response: Response) => void = () => undefined;
    const h = harness({ '/api/catalog/changes': () => new Promise<Response>((resolve) => { settle = resolve; }) }, { disk });
    expect(await h.service.bootstrap()).toEqual({ hadSnapshot: true, outcome: null });
    const firstScreen = await h.service.api.catalog({ channel: 'drama', page: 1, pageSize: 1 });
    expect(firstScreen).toMatchObject({ page: 1, pageSize: 1, total: 2, revision: 7 });
    expect(firstScreen.items.map((entry) => entry.id)).toEqual(['drama_a']);
    expect((await h.service.api.channels()).channels.map((entry) => entry.id)).toEqual(['drama', 'movie']);
    expect(h.outcomes).toHaveLength(0); // 网络一个字节都没回来，首屏已经能渲染：这就是"先显、后台同步"
    settle(ok(changesOf(11, [upsert('drama_c', 'drama', 11)]))); await flush();
    expect(h.outcomes).toEqual([{ appliedEntries: 4, revision: 11, full: false, offline: false }]);
    expect(h.cache.getItem('drama_c')).not.toBeNull();
  });
  it('无快照的冷启动走全量重同步：只 commit 一次，私密频道节点与条目一律不留痕', async () => {
    const h = harness(fullSync(9));
    const boot = await h.service.bootstrap();
    expect(boot.hadSnapshot).toBe(false);
    expect(boot.outcome).toMatchObject({ appliedEntries: 3, revision: 9, full: true, offline: false });
    expect(h.service.snapshotState()).toEqual({ revision: 9, items: 3, channels: 2, partial: false });
    expect(h.commits()).toHaveLength(1);
    expect(h.staged()).toEqual(['stagePage:drama', 'stagePage:drama', 'stagePage:movie']);
    expect(h.seen).toEqual(['/api/channels', '/api/catalog?channel=drama&page=1&pageSize=1', '/api/catalog?channel=drama&page=2&pageSize=1&revision=9', '/api/catalog?channel=movie&page=1&pageSize=1&revision=9']);
    expect(h.cache.getItem('private_x')).toBeNull();
    expect(h.seen.some((url) => url.includes('channel=private'))).toBe(false);
    const reopened = new PublicCache(h.disk); await reopened.hydrate();
    expect((reopened.getChannels() as ChannelsResponse).channels.map((entry) => entry.id)).toEqual(['drama', 'movie']);
  });
});
describe('resyncFull：同修订原子替换（AC-18）', () => {
  it('中途某页失败：不 commit、旧快照修订不变、offline 与原因如实回报，残骸还不卡下一轮', async () => {
    const disk = new MemoryCacheDisk(); await seedSnapshot(disk);
    let dropMovie = true;
    const h = harness({ '/api/channels': () => ok(topologyOf(12)),
      '/api/catalog': (url) => (query(url, 'channel') === 'movie' && dropMovie ? down(url) : catalogRoute({ drama: ['a', 'b'], movie: ['m1'] }, 12)(url)) }, { disk });
    expect(await h.service.hydrate()).toBe(true);
    const outcome = await h.service.resyncFull();
    expect(outcome).toMatchObject({ full: true, offline: true, revision: 7, appliedEntries: 0 });
    expect(outcome.reason).toContain('NETWORK_ERROR');
    expect(h.commits()).toHaveLength(0);
    expect(h.service.snapshotState()).toMatchObject({ revision: 7, items: 3 });
    dropMovie = false;
    expect(await h.service.resyncFull()).toMatchObject({ full: true, offline: false, revision: 12 }); // mixed-revision 残骸自愈
    expect(h.commits()).toHaveLength(1);
  });
  it('两次不同修订的页面不会混进同一快照：作废的单元从未提交，重试轮才落地', async () => {
    let revision = 5;
    const h = harness({ '/api/channels': () => ok(topologyOf(5)), '/api/catalog': (url) => {
      const channelId = query(url, 'channel'), page = Number(query(url, 'page'));
      if (channelId === 'movie') revision = 6; // 边缘在两频道之间发布了新修订
      return ok(catPage(channelId, (channelId === 'drama' ? ['a', 'b'] : ['m1']).slice(page - 1, page), page, channelId === 'drama' ? 2 : 1, revision));
    } });
    expect(await h.service.resyncFull()).toMatchObject({ revision: 6, full: true, offline: false, appliedEntries: 3 });
    expect(h.service.snapshotState()).toMatchObject({ revision: 6, items: 3, channels: 2 });
    expect(h.commits()).toHaveLength(1);
    expect(h.staged('drama')).toHaveLength(5); // 首轮 2 页 + 重试轮 2 页 + mixed-revision 拒收后重投 1 页
  });
  it('私密条目喂进闸门：缓存字节与台账零变化，且不抛成崩溃', async () => {
    const h = harness({ '/api/channels': () => ok(topologyOf(6)), '/api/catalog': catalogRoute({ private: ['x'] }, 6) });
    const before = h.cache.bytesUsed();
    const outcome = await h.service.resyncFull('private');
    expect(outcome).toMatchObject({ full: true, offline: false, appliedEntries: 0, revision: 0 });
    expect(outcome.reason).toContain('个人探索内容不入公开缓存');
    expect(h.cache.bytesUsed()).toEqual(before);
    expect(h.cache.getItem('private_x')).toBeNull();
    expect(h.commits()).toHaveLength(0);
  });
  it('磁盘批量写入失败保留上一份快照；并发调用并入同一个落盘单元', async () => {
    const disk = new FlakyDisk(); await seedSnapshot(disk);
    const h = harness(fullSync(9, false, ['a']), { disk });
    await h.service.hydrate();
    disk.failing = true;
    const outcome = await h.service.resyncFull();
    expect(outcome.reason).toContain('磁盘空间不足');
    expect(outcome.offline).toBe(false);
    expect(h.service.snapshotState()?.revision).toBe(7);
    disk.failing = false;
    expect((await h.service.resyncFull()).revision).toBe(9);
    const merged = harness(fullSync(5, false, ['a']));
    const [first, second] = await Promise.all([merged.service.resyncFull(), merged.service.syncIncremental()]);
    expect(second).toEqual(first);
    expect(merged.seen.filter((url) => url.startsWith('/api/catalog/changes'))).toHaveLength(0);
  });
});
describe('syncIncremental：游标、墓碑与 410/409 回退（API-SPEC §八）', () => {
  it('游标只按服务端 nextRevision 逐批续读、绝不本地加一；重放不改数据且墓碑连带删海报', async () => {
    const disk = new MemoryCacheDisk(); await seedSnapshot(disk);
    blobPatch();
    let batch = 0;
    const h = harness({ '/api/catalog/changes': () => ok(batch++ === 0
      ? changesOf(11, [upsert('drama_c', 'drama', 8), upsert('drama_d', 'drama', 11)], true) : changesOf(12, [tombstone('drama_a', 12)])) }, { disk });
    await h.service.hydrate();
    await h.service.posterUrlFor(content('drama_a', 'drama'));
    expect(h.cache.hasPoster('drama_a', 'v1')).toBe(true);
    expect(await h.service.syncIncremental()).toEqual({ appliedEntries: 4, revision: 12, full: false, offline: false });
    expect(h.seen).toEqual([`/api/catalog/changes?after=7&limit=${LIMIT}`, `/api/catalog/changes?after=11&limit=${LIMIT}`]);
    expect(h.cache.getItem('drama_a')).toBeNull();
    expect(h.cache.hasPoster('drama_a', 'v1')).toBe(false); // 撤片墓碑同时清海报
    expect(await h.service.syncIncremental()).toMatchObject({ revision: 12 }); // 无新变更：游标原地不动
    expect(h.cache.list().length).toBe(4);
  });
  it('410 游标过期与 409 修订冲突都自动回退全量重同步，失效游标从未写进域', async () => {
    for (const [code, status] of [['CATALOG_CURSOR_EXPIRED', 410], ['CATALOG_REVISION_CONFLICT', 409]] as const) {
      const disk = new MemoryCacheDisk(); await seedSnapshot(disk);
      const h = harness({ '/api/catalog/changes': () => fail(code, status, '游标或修订已失效'),
        '/api/channels': () => ok(topologyOf(20)), '/api/catalog': catalogRoute({ drama: ['a'], movie: ['m1'] }, 20) }, { disk });
      await h.service.hydrate();
      expect(await h.service.syncIncremental()).toMatchObject({ full: true, revision: 20, offline: false });
      expect(h.seen.map((url) => url.split('?')[0])).toEqual(['/api/catalog/changes', '/api/channels', '/api/catalog', '/api/catalog']);
      expect(h.calls.filter((call) => call.startsWith('applyChanges'))).toHaveLength(0);
    }
  });
  it('断网增量保留旧快照并可读回报、绝不清盘，失败轮同样通知订阅方', async () => {
    const disk = new MemoryCacheDisk(); await seedSnapshot(disk);
    const h = harness({}, { disk });
    await h.service.hydrate();
    expect(await h.service.syncIncremental()).toMatchObject({ full: false, offline: true, revision: 7, appliedEntries: 0 });
    expect(h.service.snapshotState()).toMatchObject({ revision: 7, items: 3 });
    expect(h.commits()).toHaveLength(0);
    expect(h.outcomes[0]).toMatchObject({ offline: true });
  });
});
describe('api 读面：网络优先、快照兜底、两者皆无则抛出原错误', () => {
  it('在线目录落进域内：完整单页频道即成快照，半截分页绝不顶掉整频道', async () => {
    const whole = harness({ '/api/catalog': catalogRoute({ drama: ['a'] }, 7) });
    expect(await whole.service.api.catalog({ channel: 'drama', page: 1, pageSize: 1 })).toMatchObject({ total: 1, revision: 7 });
    expect(whole.service.snapshotState()).toMatchObject({ revision: 7, items: 1 });
    const partial = harness({ '/api/catalog': catalogRoute({ drama: ['a', 'b'] }, 7) });
    expect((await partial.service.api.catalog({ channel: 'drama', page: 1, pageSize: 1 })).total).toBe(2);
    expect(partial.service.snapshotState()).toBeNull(); // 只有第 1 页：域的 incomplete-pages 拒收，半截快照不落地
  });
  it('断网首屏从缓存条目按契约分页；空目录必须有真实来源，未覆盖频道一律抛错', async () => {
    const disk = new MemoryCacheDisk(); await seedSnapshot(disk);
    const h = harness({}, { disk });
    await h.service.hydrate();
    const second = await h.service.api.catalog({ channel: 'drama', page: 2, pageSize: 1 });
    expect(second).toMatchObject({ page: 2, pageSize: 1, total: 2, revision: 7 }); expect(second.items.map((entry) => entry.id)).toEqual(['drama_b']);
    expect((await h.service.api.catalog({ channel: 'drama', page: 1, pageSize: 20 })).pageSize).toBe(20); // 回落分页按调用方口径，而不是服务默认值
    expect((await h.service.api.catalog({ channel: 'drama', category: '科幻', page: 1, pageSize: 1 })).items).toEqual([]);
    expect((await h.service.api.catalog({ channel: 'movie', page: 2, pageSize: 1 })).items).toEqual([]);
    await expect(h.service.api.catalog({ channel: 'anime', page: 1, pageSize: 20 })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });
  it('503 落回快照而 404 与"两者皆无"原样抛错；翻页撞 409 时丢游标重取一次', async () => {
    const disk = new MemoryCacheDisk(); await seedSnapshot(disk);
    const degraded = harness({ '/api/catalog': () => fail('SERVICE_UNAVAILABLE', 503, '目录暂不可用') }, { disk });
    await degraded.service.hydrate();
    expect((await degraded.service.api.catalog({ channel: 'drama', page: 1, pageSize: 1 })).total).toBe(2);
    const gone = harness({ '/api/catalog': () => fail('NOT_FOUND', 404, '资源不存在') }, { disk });
    await gone.service.hydrate();
    await expect(gone.service.api.catalog({ channel: 'drama', page: 1, pageSize: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const empty = harness(); // 断网且无快照：错误原样抛出，由视图渲染 offline 态，而不是返回空 items
    await expect(empty.service.api.catalog({ channel: 'drama', page: 1, pageSize: 20 })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(empty.service.api.channels()).rejects.toBeInstanceOf(ApiError);
    let hits = 0;
    const drifted = harness({ '/api/catalog': () => { hits += 1; return hits === 1 ? fail('CATALOG_REVISION_CONFLICT', 409, '修订已变') : ok(catPage('drama', ['b'], 2, 2, 8)); } });
    expect(await drifted.service.api.catalog({ channel: 'drama', page: 2, pageSize: 1, revision: 7 })).toMatchObject({ page: 2, revision: 8 });
    expect(drifted.seen).toEqual(['/api/catalog?channel=drama&page=2&pageSize=1&revision=7', '/api/catalog?channel=drama&page=2&pageSize=1']);
  });
});
describe('posterUrlFor：受控代理形态与海报落域（AC-18、上游域名零暴露）', () => {
  it('缺失、上游域名或非图片代理形态一律 null 且绝不发请求', async () => {
    const h = harness();
    expect(await h.service.posterUrlFor(content('drama_a', 'drama', { coverUrl: undefined }))).toBeNull();
    expect(await h.service.posterUrlFor(content('drama_b', 'drama', { coverUrl: 'https://upstream-cdn.example/x.jpg' }))).toBeNull();
    expect(await h.service.posterUrlFor(content('drama_c', 'drama', { coverUrl: `${EDGE}/proxy/media/drama_c` }))).toBeNull();
    expect(await h.service.posterUrlFor(content('drama_d', 'drama', { coverUrl: `${EDGE}/proxy/img/a/b` }))).toBeNull();
    expect(h.posterFetches).toEqual([]);
  });
  it('字节落进公开缓存域并换成本地地址；命中域内字节后不再抓取', async () => {
    blobPatch();
    const h = harness();
    expect(await h.service.posterUrlFor(content('drama_a', 'drama'))).toBe(`blob:prism/${PNG.byteLength}`);
    expect(h.cache.hasPoster('drama_a', 'v1')).toBe(true);
    expect(h.cache.bytesUsed().posters).toBe(PNG.byteLength);
    expect(await h.service.posterUrlFor(content('drama_a', 'drama', { coverUrl: '/proxy/img/drama_a' }))).toBe(`blob:prism/${PNG.byteLength}`);
    expect(h.posterFetches).toEqual([`${POSTER}drama_a`]); // 第二次读的是域内字节（含相对形态）：网络一次都没碰
    expect(blobUrls).toHaveLength(2);
  });
  it('私密闸门拒绝、非 200、嗅不出类型与抓取抛错都交回同源代理地址且不落字节', async () => {
    blobPatch();
    const priv = harness();
    expect(await priv.service.posterUrlFor(content('priv_1', 'private', { isPrivate: true }))).toBe(`${POSTER}priv_1`);
    expect(priv.cache.bytesUsed()).toEqual({ catalog: 0, posters: 0 }); // 私密海报连一条元信息都没进公开域
    expect(priv.service.snapshotState()).toBeNull();
    const refused = harness({}, { poster: () => image(UNKNOWN_MAGIC, 503) });
    expect(await refused.service.posterUrlFor(content('drama_a', 'drama'))).toBe(`${POSTER}drama_a`);
    expect(refused.cache.bytesUsed()).toEqual({ catalog: 0, posters: 0 });
    const sniffless = harness({}, { poster: () => image(UNKNOWN_MAGIC) });
    expect(await sniffless.service.posterUrlFor(content('drama_b', 'drama', { coverVersion: undefined }))).toBe(`${POSTER}drama_b`);
    expect(sniffless.cache.hasPoster('drama_b', 'v0')).toBe(true); // 落盘仍按缺省版本键，只是宿主无 Blob 能力
    expect(await harness({}, { poster: down }).service.posterUrlFor(content('drama_c', 'drama'))).toBe(`${POSTER}drama_c`);
  });
});
describe('onSynced：可拆除、不无界增长、订阅方异常不外溢', () => {
  it('监听器摘除后彻底静默，注册数触顶即判定为泄漏并拒绝', async () => {
    const h = harness(fullSync(5, false, ['a']));
    await h.service.resyncFull();
    expect(h.outcomes).toHaveLength(1);
    const leavers = Array.from({ length: 7 }, () => h.service.onSynced(() => undefined));
    expect(() => h.service.onSynced(() => undefined)).toThrow(/同步订阅者已达上限/);
    leavers.forEach((leave) => leave());
    await h.service.resyncFull();
    expect(h.outcomes).toHaveLength(2);
  });
  it('订阅方抛错不污染落盘结果，容量淘汰如实标 partial', async () => {
    const tiny = new PublicCache(new MemoryCacheDisk(), () => 1, 40 * KILO, 128 * KILO);
    const h = harness(fullSync(5, true, ['a', 'b', 'c', 'd']), { cache: tiny });
    h.service.onSynced(() => { throw new Error('订阅方自己崩了'); });
    expect(await h.service.resyncFull()).toMatchObject({ revision: 5, offline: false });
    expect(h.service.snapshotState()).toMatchObject({ revision: 5, partial: true });
    expect(h.cache.bytesUsed().catalog).toBeLessThanOrEqual(40 * KILO);
  });
});
