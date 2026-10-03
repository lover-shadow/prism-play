/**
 * 公开目录缓存服务（SPEC §7 末行；AC-01 / AC-02-5 / AC-18；API-SPEC §一.2、§八）。
 *
 * 职责只有一条：把「网络 → 公开缓存域 → 首屏」串成链，并把失败如实说成人话。视图只经 `api` 读（快照先显），
 * 落盘只经 `PublicCache` 的闸门、公开闭集与修订守卫——本文件不设第二份存储，也不自行判定"是不是私密"：判定
 * 咽喉点在 `storage-domains.ts`。`resyncFull` 只有在同一修订把各频道各页全部 stagePage 成功后才 commitSnapshot；
 * `syncIncremental` 只按服务端 `nextRevision` 推进游标（绝不本地加一）。任一环节失败都不提交、不清盘，旧快照
 * 继续可读。海报字节与配额 LRU 全在公开缓存域内（ARCHITECTURE §2.1 禁止本层另立 Blob 台账），本服务只把域内
 * 字节换成可显示地址。模块顶层零 I/O、零定时器、零全局注册，jsdom 可安全 import。
 */

import type { CatalogChange, CatalogResponse, ChannelItem, ChannelsResponse, ContentItem } from '../../edge/src/types/api';
import { CATALOG_DEFAULT_PAGE_SIZE, CHANGES_DEFAULT_LIMIT, CHANGES_MAX_LIMIT } from '../../edge/src/core/constants';
import { ApiError, type PrismApiClient } from './api/client';
import type { CacheReceipt, PublicCache } from './storage/public-cache';
import type { SnapshotFeed } from './storage/search-index';
import { PrivateWriteBlockedError } from './storage/storage-domains';
import type { HomeApi } from '../views/home-view';

export interface SnapshotState { revision: number; items: number; channels: number; partial: boolean }
export interface SyncOutcome { appliedEntries: number; revision: number; full: boolean; offline: boolean; reason?: string }

export interface CatalogCacheService {
  api: HomeApi;
  hydrate(): Promise<boolean>;
  snapshotState(): SnapshotState | null;
  resyncFull(channelId?: string): Promise<SyncOutcome>;
  syncIncremental(): Promise<SyncOutcome>;
  bootstrap(): Promise<{ hadSnapshot: boolean; outcome: SyncOutcome | null }>;
  posterUrlFor(item: ContentItem): Promise<string | null>;
  onSynced(listener: (outcome: SyncOutcome) => void): () => void;
}

export interface CatalogCacheDeps {
  client: PrismApiClient;
  cache: PublicCache;
  /** 时钟归公开缓存域与 HTTP 缓存层（`PUBLIC_POSTER_MAX_AGE_SECONDS`）：本层不另立时间台账，故不消费它。 */
  nowSeconds?: () => number;
  pageSize?: number;
  /** 海报字节抓取；与 JSON 契约客户端分属两条通道，测试各自注入。 */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** §A-6.2 数据流：快照/增量批次落地后交给端侧检索索引；索引自己的失败由索引记账，不改落盘结论。 */
  onSnapshotEntries?: (feed: SnapshotFeed) => void;
}

type CatalogQuery = Parameters<HomeApi['catalog']>[0];
/** 缺封面指纹时的落盘键位；真实指纹一到即自然分键，不会覆盖这份。 */
const ABSENT_COVER_VERSION = 'v0';
/** 订阅方只有主宿主与主视图：达上限还来注册即判定为泄漏，拒绝而不是无界增长。 */
const SYNC_LISTENER_MAX = 8;
/** 单轮兜底：目录 400 页、增量 10 页 × CHANGES_MAX_LIMIT；超出如实回报而不是空转。 */
const RESYNC_MAX_PAGES = 400;
const CHANGE_PAGES_PER_RUN = 10;
const PROXY_IMAGE_PREFIX = '/proxy/img/'; // SPEC §5、API-SPEC §六 的受控图片代理形态；不是它就等于上游地址。

const REJECT_MESSAGE: Readonly<Record<NonNullable<CacheReceipt['reason']>, string>> = {
  'stale-revision': '云端目录修订旧于本地快照，按幂等处理并保留旧快照', 'mixed-revision': '同一快照单元混进了两个修订，整单元作废，旧快照保持不变',
  'incomplete-pages': '频道分页不完整（缺页或 total 与实际不符），拒绝替换快照', 'not-newer': '增量游标不新于本地快照，重放未改动任何数据',
  'channel-mismatch': '页面条目与声明频道不一致，本次未落盘'
};
const describeReject = (reason?: CacheReceipt['reason']): string => reason === undefined ? '公开缓存域拒绝了本次落盘' : `${REJECT_MESSAGE[reason]}（${reason}）`;
const isCursorFailure = (error: unknown): boolean => error instanceof ApiError && (error.code === 'CATALOG_CURSOR_EXPIRED' || error.code === 'CATALOG_REVISION_CONFLICT');
/** 可续期的离线态只有断网与 503：其余错误必须原样让视图落 error 态，不得被快照掩盖。 */
const isUnavailable = (error: unknown): boolean => error instanceof ApiError && (error.code === 'NETWORK_ERROR' || error.code === 'SERVICE_UNAVAILABLE');
const channelIds = (topology: ChannelsResponse | null): string[] => (topology?.channels ?? []).map((channel) => channel.id);

/** 断网与 503 记为离线态；闸门拒绝是私密零留痕（AC-02-5）；其余按契约错误码逐条如实转述。 */
function outcomeForError(error: unknown, at: number, full: boolean): SyncOutcome {
  const base = { appliedEntries: 0, revision: at, full, offline: false };
  if (error instanceof PrivateWriteBlockedError) return { ...base, reason: `个人探索内容不入公开缓存：${error.message}` };
  if (!(error instanceof ApiError)) return { ...base, reason: `本地缓存写入未成功：${String(error)}` };
  return isUnavailable(error) ? { ...base, offline: true, reason: `离线沿用本地公开快照（${error.code}）：${error.message}` } : { ...base, reason: `${error.code}：${error.message}` };
}

/** 边缘只会用请求自己的 origin 拼 `/proxy/img/{handle}`（serialize.ts）：形态即准入判据。 */
function proxyImageOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const origin = typeof location === 'undefined' ? '' : location.origin;
  let target: URL;
  try { target = new URL(raw.trim(), origin === '' || origin === 'null' ? undefined : origin); } catch { return null; } // 拼不出基准：宁可不显示，绝不猜上游。
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return null;
  if (!target.pathname.startsWith(PROXY_IMAGE_PREFIX)) return null;
  const handle = target.pathname.slice(PROXY_IMAGE_PREFIX.length);
  return handle === '' || handle.includes('/') || handle.includes('..') ? null : raw.trim();
}

/** 域内只存字节不存 MIME 旁注，故换成地址时嗅探文件头；嗅不出就交回代理地址，而不是伪造一个类型。 */
const mimeOf = (b: Uint8Array): string | null =>
  b[0] === 0x89 ? 'image/png' : b[0] === 0xff && b[1] === 0xd8 ? 'image/jpeg' : b[0] === 0x47 ? 'image/gif'
    : b[0] === 0x52 && b[1] === 0x49 ? 'image/webp' : b[0] === 0x42 && b[1] === 0x4d ? 'image/bmp' : null;
/** Blob 地址的生命周期归调用方（视图换页即 revoke）：本层不登记，免得开出第二个图片台账。 */
const objectUrlFor = (bytes: Uint8Array): string | null => {
  const mime = mimeOf(bytes);
  return mime === null || typeof URL.createObjectURL !== 'function' ? null : URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }));
};

export function createCatalogCacheService(deps: CatalogCacheDeps): CatalogCacheService {
  const { client, cache } = deps;
  const pageSize = deps.pageSize ?? CATALOG_DEFAULT_PAGE_SIZE;
  const fetchImpl = deps.fetchImpl ?? ((url: string, init?: RequestInit): Promise<Response> => fetch(url, init));
  const listeners = new Set<(outcome: SyncOutcome) => void>();
  let running: Promise<SyncOutcome> | null = null;
  const revision = (): number => cache.snapshotRevision();
  /** 订阅方崩了不该拖累落盘结果与其他订阅者：通知逐个吞掉异常。 */
  const emit = (outcome: SyncOutcome): void => {
    for (const listener of [...listeners]) { try { listener(outcome); } catch { /* 订阅方的异常归订阅方。 */ } }
  };
  /** 检索索引只是快照的又一个读者：它抛错同样不许回头污染落盘结论（异常由索引自己记进 status()）。 */
  const feedIndex = (at: number, changes?: readonly CatalogChange[]): void => { try { deps.onSnapshotEntries?.({ items: changes === undefined ? cache.list() : [], ...(changes === undefined ? {} : { changes }), revision: at }); } catch { /* 索引侧自行记账。 */ } };
  const shape = (response: CatalogResponse, query: CatalogQuery): CatalogResponse =>
    ({ ...response, page: response.page || query.page || 1, pageSize: response.pageSize || query.pageSize || pageSize });

  /** 逐页拉取一个频道：首页定修订，后续页把同一修订当游标钉住（API-SPEC §一.2），漂移即 409 重来。
   * mixed-revision 的拒收顺带清掉了陈旧暂存单元，撞到它就重投一次——那是上一轮残骸而非本次真冲突。 */
  async function pullChannel(channelId: string, pin?: number): Promise<number> {
    let page = 1, cursor = pin, expected = 1;
    while (page <= expected && page <= RESYNC_MAX_PAGES) {
      const query: CatalogQuery = { channel: channelId, page, pageSize, ...(cursor === undefined ? {} : { revision: cursor }) };
      const response = shape(await client.catalog(query), query);
      if (cursor !== undefined && response.revision !== cursor) throw new ApiError('CATALOG_REVISION_CONFLICT', 409, '频道分页期间公开目录修订发生了变化');
      cursor = response.revision;
      let receipt = cache.stagePage(channelId, response);
      if (receipt.reason === 'mixed-revision') receipt = cache.stagePage(channelId, response);
      if (!receipt.accepted) throw new ApiError('UNEXPECTED_RESPONSE', 200, describeReject(receipt.reason));
      expected = Math.max(expected, Math.max(1, Math.ceil(response.total / Math.max(1, response.pageSize))));
      page += 1;
    }
    if (page > RESYNC_MAX_PAGES) throw new ApiError('UNEXPECTED_RESPONSE', 200, `目录分页超出单轮上限 ${RESYNC_MAX_PAGES} 页`);
    return cursor ?? revision();
  }

  /** 频道闭集取自云端拓扑并原样交给域的公开闭集闸门；拓扑拉不到才退回本地快照，两者都没有就抛出原错误。 */
  const pullPublicTargets = async (): Promise<string[]> => {
    await cache.putChannels(await client.channels());
    return channelIds(cache.getChannels());
  };

  async function fullResync(attempt: number, channelId?: string): Promise<SyncOutcome> {
    let targets: string[];
    try { targets = channelId !== undefined ? [channelId] : await pullPublicTargets(); } catch (error) {
      targets = channelIds(cache.getChannels());
      if (targets.length === 0) return outcomeForError(error, revision(), true);
    }
    try {
      let pin: number | undefined;
      for (const target of targets) pin = await pullChannel(target, pin);
      const receipt = await cache.commitSnapshot();
      if (receipt.accepted) feedIndex(receipt.revision);
      return { appliedEntries: receipt.accepted ? receipt.appliedEntries : 0, revision: receipt.revision, full: true, offline: false, ...(receipt.accepted ? {} : { reason: describeReject(receipt.reason) }) };
    } catch (error) {
      return (attempt === 0 && isCursorFailure(error)) ? await fullResync(1, channelId) : outcomeForError(error, revision(), true);
    }
  }

  async function incrementalResync(): Promise<SyncOutcome> {
    try {
      if (revision() <= 0) return await fullResync(0);
      let after = revision(), appliedEntries = 0, drained = 0;
      for (let batch = 0; batch < CHANGE_PAGES_PER_RUN; batch += 1) {
        const response = await client.changes(after, CHANGES_DEFAULT_LIMIT);
        const receipt = await cache.applyChanges(response);
        if (!receipt.accepted && receipt.reason !== 'not-newer') return { appliedEntries: 0, revision: receipt.revision, full: false, offline: false, reason: describeReject(receipt.reason) };
        if (receipt.accepted) { appliedEntries = receipt.appliedEntries; feedIndex(receipt.revision, response.changes); }
        after = response.nextRevision;
        drained += response.changes.length;
        if (!response.hasMore || drained >= CHANGE_PAGES_PER_RUN * CHANGES_MAX_LIMIT) break;
      }
      return { appliedEntries, revision: after, full: false, offline: false };
    } catch (error) {
      return isCursorFailure(error) ? await fullResync(1) : outcomeForError(error, revision(), false);
    }
  }

  /** 同一时刻只允许一个落盘单元：并发调用并入进行中的运行，两个暂存单元绝不会互相污染修订。 */
  function runExclusive(task: () => Promise<SyncOutcome>): Promise<SyncOutcome> {
    if (running !== null) return running;
    const settled = task().catch((error: unknown) => outcomeForError(error, revision(), false))
      .then((outcome) => { running = null; emit(outcome); return outcome; });
    running = settled;
    return settled;
  }

  /** 在线单页只暂存，能否成快照由域判定：单页绝不允许顶掉同频道其余页（AC-18 incomplete-pages）。
   * 域内还没有任何快照（revision 0）时也允许提交，因为那时没有可被顶掉的旧数据。 */
  async function cacheOnlinePage(query: CatalogQuery, response: CatalogResponse): Promise<void> {
    if (running !== null) return;
    try {
      const receipt = cache.stagePage(query.channel, response);
      if (receipt.accepted && (revision() === 0 || revision() === receipt.revision) && (await cache.commitSnapshot()).accepted) feedIndex(revision());
    } catch { /* 数据已到手：落盘被闸门或磁盘拒绝，都不该让已经成功的首屏渲染失败。 */ }
  }

  /** 断网回落的"空目录"必须有真实来源：本地有该频道条目，或修订号 > 0 且域内快照声明过该频道。
   * 分页口径按调用方给的 page/pageSize 切，与在线契约一致（AC-18）。 */
  const catalogFromSnapshot = (query: CatalogQuery, error: unknown): CatalogResponse => {
    const items = cache.list(query.channel);
    if (revision() <= 0 || (items.length === 0 && !channelIds(cache.getChannels()).includes(query.channel))) throw error;
    const page = query.page ?? 1, size = query.pageSize ?? pageSize;
    const visible = items.filter((item) => query.category === undefined || item.category === query.category);
    return { items: visible.slice((page - 1) * size, page * size), page, pageSize: size, total: visible.length, revision: revision() };
  };

  const api: HomeApi = {
    async channels(): Promise<ChannelsResponse> {
      try {
        const topology = await client.channels();
        if (running === null) await cache.putChannels(topology); // 闭集与闸门由域裁定，本层只转手。
        return topology;
      } catch (error) {
        const stored = cache.getChannels();
        if (!isUnavailable(error) || stored === null) throw error; // 无快照可退：原错误交视图落 offline/error 态。
        return stored;
      }
    },
    async catalog(query): Promise<CatalogResponse> {
      const request: CatalogQuery = { ...query, page: query.page ?? 1, pageSize: query.pageSize ?? pageSize };
      try {
        let response: CatalogResponse;
        try {
          response = shape(await client.catalog(request), request);
        } catch (error) { // 翻页撞上 409/410：丢掉陈旧游标重取一次（API-SPEC §一.2），其余交给回落判定。
          if (!isCursorFailure(error) || request.revision === undefined) throw error;
          response = shape(await client.catalog({ ...request, revision: undefined }), request);
        }
        await cacheOnlinePage(request, response);
        return response;
      } catch (error) {
        if (!isUnavailable(error)) throw error; // 私密/未知/参数错误一律原样上抛（AC-02-3）。
        return catalogFromSnapshot(request, error);
      }
    }
  };

  async function posterUrlFor(item: ContentItem): Promise<string | null> {
    const url = proxyImageOf(item.coverUrl);
    if (url === null) return null;
    const version = item.coverVersion ?? ABSENT_COVER_VERSION;
    const cached = await cache.getPoster(item.id, version);
    if (cached !== null && cached.byteLength > 0) return objectUrlFor(cached) ?? url;
    let bytes: Uint8Array | null = null;
    try {
      const response = await fetchImpl(url, { headers: { Accept: 'image/*' } });
      bytes = response.ok ? new Uint8Array(await response.arrayBuffer()) : null;
    } catch { return url; }
    if (bytes === null || bytes.byteLength === 0) return url;
    try { await cache.putPoster(item.id, version, bytes, { contentId: item.id, channelId: item.channelId, isPrivate: item.isPrivate }); } catch { return url; }
    return objectUrlFor(bytes) ?? url;
  }

  async function hydrate(): Promise<boolean> {
    await cache.hydrate();
    return snapshotState() !== null;
  }

  function snapshotState(): SnapshotState | null {
    const items = cache.list().length, channels = channelIds(cache.getChannels()).length;
    if (revision() === 0 && items === 0 && channels === 0) return null;
    return { revision: revision(), items, channels, partial: cache.snapshotIsPartial() };
  }

  function onSynced(listener: (outcome: SyncOutcome) => void): () => void {
    if (!listeners.has(listener) && listeners.size >= SYNC_LISTENER_MAX) throw new Error(`同步订阅者已达上限 ${SYNC_LISTENER_MAX}：存在未摘除的监听器`);
    listeners.add(listener);
    return () => void listeners.delete(listener);
  }

  async function loadSeedBundle(): Promise<SyncOutcome | null> {
    for (const url of ['./seed/catalog-bundle.json', '/seed/catalog-bundle.json']) {
      try {
        const res = await fetchImpl(url); if (!res.ok) continue;
        const b = (await res.json()) as { revision: number; version?: number; channels: ChannelsResponse | ChannelItem[]; items: ContentItem[] };
        if (b?.items?.length) {
          const channels: ChannelsResponse = Array.isArray(b.channels) ? { version: b.version ?? b.revision, channels: b.channels } : b.channels;
          const r = await cache.importBundle({ revision: b.revision, channels, items: b.items });
          if (r.accepted) { feedIndex(r.revision); return { appliedEntries: r.appliedEntries, revision: r.revision, full: true, offline: false }; }
        }
      } catch { /* 下一个备用地址 */ }
    }
    return null;
  }

  /** 快照先显（AC-01）：有快照或种子包时 bootstrap 秒级完成，增量结果经 onSynced 在后台送达。 */
  async function bootstrap(): Promise<{ hadSnapshot: boolean; outcome: SyncOutcome | null }> {
    if (await hydrate()) {
      void runExclusive(incrementalResync);
      return { hadSnapshot: true, outcome: null };
    }
    const seed = await loadSeedBundle();
    if (seed !== null) {
      void runExclusive(incrementalResync);
      return { hadSnapshot: true, outcome: seed };
    }
    return { hadSnapshot: false, outcome: await runExclusive(() => fullResync(0)) };
  }

  return { api, hydrate, snapshotState, bootstrap, posterUrlFor, onSynced,
    resyncFull: (channelId?: string) => runExclusive(() => fullResync(0, channelId)),
    syncIncremental: () => runExclusive(incrementalResync) };
}
