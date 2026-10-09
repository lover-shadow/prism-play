/**
 * 统一"原始标题事实"缓存（W1 · 计划 §4.1）：`/api/titles/{id}` 的单一事实源。
 *
 * 为什么存在：详情（宿主的 TitleDetail）与线路清单（播放器的 TitleManifest）读取的是同一条云端
 * 响应，但过去各有取数路径——宿主每次全量网络、清单另有磁盘缓存且 TTL 误用 `generatedAt`——
 * 同一部剧打开一次可能发两次网络，暖切也照样重复请求。本模块把两者收敛到同一次读取。
 *
 * 三条纪律（与计划缓存契约逐条对应）：
 * 1. 单飞合并：同一 workId 的在途请求只有一个，所有调用方共享同一 Promise；
 * 2. TTL 只认 `cachedAt`（本地获取时间）；`generatedAt` 是上游事实时间，仅作展示与诊断，不参与过期判定；
 * 3. 私密零落盘：落盘前按载荷判定（`isPrivateSubject` 唯一口径）+ `assertWritable` 闸门双保险，
 *    且旧形态/不可判定载荷一概不落盘；内存缓存照常服务本进程，进程一死即散。
 *
 * 消费语义分离：`loadDetail` 失败抛出（宿主落错误卡）；`loadManifest` 任何失败/不支持都返回 null
 * （播放器静默回退代理链，不落错误卡）——与两个既有消费点的行为逐条对齐。
 */
import type { TitleDetail, TitleManifest } from '../../../edge/src/types/api';
import type { CacheDisk } from '../storage/public-cache';
import { assertWritable } from '../storage/storage-domains';
import { adaptTitleDetail } from './title-detail';
import { ApiError } from './client';
import { parseTitleManifest } from '../../player/title-manifest-parse';
import { createTitleFactsDisk } from './title-facts-disk';

/** 内存 20 部（计划 §4.1 初拟值）；磁盘 24 部，与旧清单缓存上限保持兼容。 */
export const TITLE_FACTS_MEMORY_LIMIT = 20;
export const TITLE_FACTS_DISK_LIMIT = 24;
/** 公开标题本地窗口 6h（计划 §4.1 第 4 条：保持兼容，勿另造不一致的窗口）。 */
export const TITLE_FACTS_TTL_SECONDS = 6 * 3_600;

export interface TitleFactEntry {
  /** 原始网络响应（新形态或旧形态）；无 raw 能力的直通模式为 null，该条目不落盘。 */
  raw: unknown | null;
  /** 适配后的详情（对象引用；`LOCAL_EPISODE_IDS` 标记随引用保留）。 */
  detail: TitleDetail | null;
  /** 清单解析结果；null 既可能是"已解析出无清单"（旧形态），也可能是"尚未尝试"（看 manifestLoaded）。 */
  manifest: TitleManifest | null;
  /** true = 清单已尝试解析（raw 解析或直通获取完毕）；false = 直通详情已就绪但清单尚未尝试。 */
  manifestLoaded: boolean;
  /** 本地获取时间（UNIX 秒）——TTL 的唯一判据。 */
  cachedAt: number;
  /** 上游事实生成时间（响应内 `generatedAt`，缺失为 0）——仅展示与诊断。 */
  generatedAt: number;
}

export interface TitleFactsDeps {
  /** 原始响应获取（首选，真实客户端为 `titleRaw`）：一条响应同时服务详情与清单。 */
  fetchRaw?(workId: string, signal?: AbortSignal): Promise<unknown>;
  /** 适配后详情获取（兜底）：仅内存引用缓存，不落盘、清单暂不可达。 */
  fetchDetail?(workId: string, signal?: AbortSignal): Promise<TitleDetail>;
  /** 清单原始获取直通（旧式注入，如 `api.titleManifest`）：返回值仍过 `parseTitleManifest`。 */
  fetchManifest?(workId: string): Promise<unknown>;
  /** 显式 null = 只要内存缓存（Web 构建与单测）；不传 = 按需解析原生缓存盘。 */
  disk?: CacheDisk | null;
  nowSeconds?(): number;
  memoryLimit?: number;
  diskLimit?: number;
  ttlSeconds?: number;
}

/** `loadDetail` 的返回：契约保证 `detail` 可用（null 仅是尚未组装完成的内部中间态）。 */
export interface ResolvedTitleFact extends TitleFactEntry { detail: TitleDetail }

export interface TitleFactsStore {
  /** 详情事实：命中缓存（内存/磁盘）不发网络；失败抛出（调用方落错误卡），失败绝不缓存。 */
  loadDetail(workId: string, options?: { force?: boolean; signal?: AbortSignal }): Promise<ResolvedTitleFact>;
  /** 线路清单事实：可达则返回；任何失败/不支持都返回 null（调用方回退代理链，不落错误卡）。 */
  loadManifest(workId: string, options?: { force?: boolean }): Promise<TitleManifest | null>;
  /** 只读内存中最新清单，绝不触发网络（投屏跟随连播用）。 */
  cachedManifest(workId: string): TitleManifest | null;
  /** 只读内存条目（诊断与测试）。 */
  peek(workId: string): TitleFactEntry | null;
  /** 上游事实变化（revision/撤片）时使单条失效（W3 接 revision 渠道的锚点）。 */
  invalidate(workId: string): void;
  size(): number;
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** raw → 详情；形状不符抛与 `PrismApiClient.title` 同款的 UNEXPECTED_RESPONSE。 */
function adaptDetailOrThrow(raw: unknown, workId: string): TitleDetail {
  try { return adaptTitleDetail(raw, workId); }
  catch { throw new ApiError('UNEXPECTED_RESPONSE', 200, '服务端返回了无法识别的剧集详情'); }
}

function entryOfRaw(raw: unknown, workId: string, cachedAt: number): TitleFactEntry {
  return {
    raw,
    detail: adaptDetailOrThrow(raw, workId),
    manifest: parseTitleManifest(raw),
    manifestLoaded: true,
    cachedAt,
    generatedAt: record(raw) && Number.isFinite(raw.generatedAt) ? (raw.generatedAt as number) : 0
  };
}

/** 落盘判定：只有"形状可判定的新形态载荷"允许写盘；旧形态与缺字段只进内存。 */
function writableSubjectOf(raw: unknown, workId: string): { contentId: string; isPrivate: boolean; channelId: string } | null {
  if (!record(raw)) return null;
  const { isPrivate, channelId } = raw;
  if (typeof isPrivate !== 'boolean' || typeof channelId !== 'string') return null;
  return { contentId: workId, isPrivate, channelId };
}

export function createTitleFactsStore(deps: TitleFactsDeps): TitleFactsStore {
  const memoryLimit = deps.memoryLimit ?? TITLE_FACTS_MEMORY_LIMIT;
  const ttl = deps.ttlSeconds ?? TITLE_FACTS_TTL_SECONDS;
  const now = deps.nowSeconds ?? ((): number => Math.floor(Date.now() / 1000));
  const memory = new Map<string, TitleFactEntry>();
  const pending = new Map<string, Promise<TitleFactEntry>>();
  const disk = createTitleFactsDisk({ disk: deps.disk, diskLimit: deps.diskLimit ?? TITLE_FACTS_DISK_LIMIT });

  /** 内存新鲜条目（TTL 只认 cachedAt）。 */
  function fresh(workId: string): TitleFactEntry | null {
    const hit = memory.get(workId);
    return hit !== undefined && now() - hit.cachedAt < ttl ? hit : null;
  }

  function remember(workId: string, entry: TitleFactEntry): TitleFactEntry {
    memory.delete(workId); // 重插保持 LRU 最近性
    memory.set(workId, entry);
    while (memory.size > memoryLimit) {
      const oldest = memory.keys().next();
      if (oldest.done === true) break;
      memory.delete(oldest.value);
    }
    return entry;
  }

  /** 落盘：直通模式（无 raw）不写；形状不可判定不写；私密由闸门静默拦下。 */
  async function persist(workId: string, entry: TitleFactEntry): Promise<void> {
    if (entry.raw === null) return;
    const subject = writableSubjectOf(entry.raw, workId);
    if (subject === null) return;
    try { assertWritable('public-cache.title-facts', subject); } catch { return; } // 闸门：私密静默不写
    await disk.write(workId, { raw: entry.raw, cachedAt: entry.cachedAt, generatedAt: entry.generatedAt });
  }

  /** 磁盘恢复（不触网）：miss/过期/适配失败一律当作"没有"，绝不让半信半疑的数据进缓存。 */
  async function restore(workId: string): Promise<TitleFactEntry | null> {
    const stored = await disk.read(workId);
    if (stored === null || now() - stored.cachedAt >= ttl) return null;
    try { return entryOfRaw(stored.raw, workId, stored.cachedAt); } catch { return null; }
  }

  /** 本地（内存→磁盘）就绪条目；force 时跳过。 */
  async function ensureLocal(workId: string, force: boolean): Promise<TitleFactEntry | null> {
    if (force) return null;
    const hit = fresh(workId);
    if (hit !== null) return hit;
    const restored = await restore(workId);
    return restored === null ? null : remember(workId, restored);
  }

  /** 网络获取并组装条目（fetchRaw 优先，fetchDetail 兜底）；失败不缓存、原样抛出。 */
  async function fetchEntry(workId: string, signal?: AbortSignal): Promise<TitleFactEntry> {
    const cachedAt = now();
    if (deps.fetchRaw !== undefined) return entryOfRaw(await deps.fetchRaw(workId, signal), workId, cachedAt);
    if (deps.fetchDetail !== undefined) {
      const detail = await deps.fetchDetail(workId, signal);
      return { raw: null, detail, manifest: null, manifestLoaded: false, cachedAt, generatedAt: 0 };
    }
    throw new ApiError('UNEXPECTED_RESPONSE', 0, '标题事实源未配置');
  }

  /** 登记单飞任务：并发调用共享同一 Promise；错误传播给等待者且不写缓存。 */
  function startFetch(workId: string, signal?: AbortSignal): Promise<TitleFactEntry> {
    const task = (async () => {
      const entry = await fetchEntry(workId, signal);
      remember(workId, entry);
      await persist(workId, entry);
      return entry;
    })();
    pending.set(workId, task);
    void task.catch(() => undefined).finally(() => { if (pending.get(workId) === task) pending.delete(workId); });
    return task;
  }

  /** 清单直通获取（静默失败）：成功无论解析结果都标记 manifestLoaded（结果是确定的）。 */
  async function fetchManifestInto(workId: string, base: TitleFactEntry | null): Promise<TitleManifest | null> {
    if (deps.fetchManifest === undefined) return base?.manifest ?? null;
    try {
      const parsed = parseTitleManifest(await deps.fetchManifest(workId));
      remember(workId, {
        raw: base?.raw ?? null, detail: base?.detail ?? null, manifest: parsed, manifestLoaded: true,
        cachedAt: base?.cachedAt ?? now(), generatedAt: base?.generatedAt ?? 0
      });
      return parsed;
    } catch { return null; }
  }

  async function loadDetail(workId: string, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<ResolvedTitleFact> {
    if (options.force !== true) {
      const local = await ensureLocal(workId, false);
      // 只有 detail 已就绪的条目才算命中：清单直通建立的条目（detail=null）必须重新取详情。
      if (local !== null && local.detail !== null) return local as ResolvedTitleFact;
      const inflight = pending.get(workId);
      if (inflight !== undefined) return (await inflight) as ResolvedTitleFact;
    }
    return (await startFetch(workId, options.signal)) as ResolvedTitleFact;
  }

  async function loadManifest(workId: string, options: { force?: boolean } = {}): Promise<TitleManifest | null> {
    const local = await ensureLocal(workId, options.force === true);
    // raw 在（已解析完毕）或 manifest 已尝试过：直接给出确定结果。
    if (local !== null && (local.raw !== null || local.manifestLoaded)) return local.manifest;
    // 详情在途：共享其获取结果。
    const inflight = pending.get(workId);
    if (inflight !== undefined) {
      const entry = await inflight.catch(() => null);
      if (entry === null) return null;
      if (entry.raw !== null) return entry.manifest;
      return await fetchManifestInto(workId, entry);
    }
    // 独立获取：fetchRaw 与详情共用同一条单飞通道（静默失败）；否则走清单直通。
    if (deps.fetchRaw !== undefined) {
      try { return (await startFetch(workId)).manifest; } catch { return null; }
    }
    if (deps.fetchManifest !== undefined) return await fetchManifestInto(workId, local);
    return null;
  }

  return {
    loadDetail,
    loadManifest,
    cachedManifest: (workId) => memory.get(workId)?.manifest ?? null,
    peek: (workId) => memory.get(workId) ?? null,
    invalidate: (workId) => void memory.delete(workId),
    size: () => memory.size
  };
}
