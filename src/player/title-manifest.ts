/**
 * 剧集清单（§2.2 `/api/titles/{workId}`）的惰性拉取与两级缓存（SPEC-APP-REFACTOR A-7.2）。
 *
 * 架构定案：视频流不再经云端 `/proxy/media/` 转发（打爆 Workers 配额且上游会封 Cloudflare IP），
 * 上游地址在打开剧目时才拿到，所以"清单"是播放地址的唯一入口，也是私密性最敏感的一份数据。三条纪律：
 *
 * 1. **私密清单永不落盘**。落盘动作只发生在 `persist()` 这一处，它在任何 I/O 之前依次过
 *    `isPrivateSubject()`（读载荷，不信调用方自述）与 `assertWritable()`（存储闸门，同一口径的第二把锁）；
 *    私密剧目仍会进**内存**缓存——本进程内的播放与切线要靠它，进程一死即散，AC-02-2 的"开启状态严禁持久化"
 *    与 AGENTS.md 的"私密零落盘"到此都是可证的，而不是靠调用方自觉。
 * 2. **旧云端不白屏**。Track 2 尚未切换的域名下 `/api/titles/{id}` 回来的仍是旧 `TitleDetail`，
 *    `parseTitleManifest` 认不下它便返回 null，调用方（播放器）据此退回 `/api/episodes/{id}/playback` 代理链。
 * 3. **一次打开只拉一次**。内存命中 + 并发去重（同一 workId 的在途请求共享同一个 Promise），
 *    切集不再回网络；清单过期（TTL）或 `force` 才重新拉。
 *
 * 落盘键位于公开缓存域的 `cache/` 命名空间内，因此【清理缓存】与备份排除规则天然覆盖它，
 * 本模块不自建第二个存储入口（`src/core/storage/**` 属别的施工包，这里只消费其既有接口与闸门）。
 */
import type { PlaybackLine, TitleManifest } from '../../edge/src/types/api';
import { logger } from '../core/diagnostics';
import { createCacheDisk } from '../core/native/platform-adapters';
import type { CacheDisk } from '../core/storage/public-cache';
import { assertWritable, isPrivateSubject } from '../core/storage/storage-domains';

/** 清单文件与索引的命名空间前缀：`cache/` 之内才谈得上被【清理缓存】枚举到。 */
export const TITLE_MANIFEST_KEY_PREFIX = 'cache/titles/';
export const TITLE_MANIFEST_INDEX_KEY = `${TITLE_MANIFEST_KEY_PREFIX}index.json`;
/** 内存与磁盘各自的条数上限：清单是"打开过才留"的热数据，不是全库镜像。 */
export const TITLE_MANIFEST_MEMORY_LIMIT = 12;
export const TITLE_MANIFEST_DISK_LIMIT = 24;
/** 上游线路会轮换，清单再省请求也不能当永久事实；六小时后视为过期。 */
export const TITLE_MANIFEST_TTL_SECONDS = 6 * 3_600;
/** 平台侧 HLS 清单的声明口径，与 `art-engine.ts` 的 `customType.m3u8` 分流一致。 */
export const HLS_MIME_TYPE = 'application/vnd.m3u8+playlist';
export const MP4_MIME_TYPE = 'video/mp4';

/** 播放器与投屏共用的一只门：只有 `titleManifest` 在场时才谈直连，缺席即回退代理。 */
export interface TitleManifestSource {
  titleManifest?(workId: string): Promise<TitleManifest>;
}

export interface TitleManifestStoreDeps {
  api: TitleManifestSource;
  /** 显式传 null = 只要内存缓存（Web 构建与单测）；不传 = 按需解析原生缓存盘。 */
  disk?: CacheDisk | null;
  nowSeconds?: () => number;
  memoryLimit?: number;
  diskLimit?: number;
  ttlSeconds?: number;
}

export interface TitleManifestStore {
  /** null 表示"本机拿不到剧集清单"——调用方必须据此回退，而不是当作空集数。 */
  load(workId: string, options?: { force?: boolean }): Promise<TitleManifest | null>;
  linesFor(workId: string, episodeNumber: number): Promise<PlaybackLine[]>;
  /** 只读已缓存的那份，绝不触发网络：投屏跟随连播时用得起。 */
  cached(workId: string): TitleManifest | null;
  size(): number;
}

interface CachedManifest { manifest: TitleManifest; at: number }

const isSafeKeyPart = (value: string): boolean =>
  typeof value === 'string' && value.length > 0 && value.length <= 120 && /^[A-Za-z0-9._-]+$/.test(value) && !value.startsWith('.') && !value.includes('..');

/**
 * 形状校验而不是类型断言：磁盘上的文件与云端返回都可能来自旧版本，认不下就整体当作"没有清单"，
 * 绝不半信半疑地把半份线路交给播放器——那会让回退链永远走不到。
 */
export function parseTitleManifest(value: unknown): TitleManifest | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.workId !== 'string' || raw.workId === '') return null;
  if (typeof raw.title !== 'string') return null;
  if (raw.isPrivate !== true && raw.isPrivate !== false) return null;
  if (!Array.isArray(raw.episodes)) return null;
  const episodes: TitleManifest['episodes'] = [];
  for (const entry of raw.episodes) {
    if (entry === null || typeof entry !== 'object') return null;
    const episode = entry as Record<string, unknown>;
    if (!Number.isInteger(episode.episodeNumber) || (episode.episodeNumber as number) < 1) return null;
    if (!Array.isArray(episode.lines)) return null;
    const lines: PlaybackLine[] = [];
    for (const candidate of episode.lines) {
      if (candidate === null || typeof candidate !== 'object') return null;
      const line = candidate as Record<string, unknown>;
      if (typeof line.providerId !== 'string' || line.providerId === '') return null;
      if (line.mediaUrl !== undefined && (typeof line.mediaUrl !== 'string' || !/^https?:\/\//i.test(line.mediaUrl))) return null;
      if ('native' in line) {
        const native = line.native as Record<string, unknown> | null;
        if (line.providerId !== 'provider_s1' || !native || typeof native !== 'object' || Array.isArray(native) ||
          Object.keys(native).length !== 2 || Object.keys(native).some((key) => key !== 'kind' && key !== 'videoId') ||
          native.kind !== 's1-cenc' || typeof native.videoId !== 'string' || !/^\d{1,32}$/.test(native.videoId)) return null;
        lines.push({ providerId: line.providerId, ...(line.mediaUrl === undefined ? {} : { mediaUrl: line.mediaUrl as string }),
          native: { kind: 's1-cenc', videoId: native.videoId } });
      } else {
        if (typeof line.mediaUrl !== 'string') return null;
        lines.push({ providerId: line.providerId, mediaUrl: line.mediaUrl });
      }
    }
    episodes.push({
      episodeNumber: episode.episodeNumber as number,
      title: typeof episode.title === 'string' ? episode.title : undefined,
      durationSeconds: Number.isFinite(episode.durationSeconds) ? (episode.durationSeconds as number) : undefined,
      lines
    });
  }
  return {
    workId: raw.workId,
    title: raw.title,
    channelId: typeof raw.channelId === 'string' ? (raw.channelId as TitleManifest['channelId']) : 'drama',
    isPrivate: raw.isPrivate === true,
    episodes,
    generatedAt: Number.isFinite(raw.generatedAt) ? (raw.generatedAt as number) : 0
  };
}

/** 私密判定只读载荷本身：清单若自称公开却挂在 private 频道，仍按私密处置（`isPrivateSubject` 唯一口径）。 */
export function isPrivateManifest(manifest: TitleManifest): boolean {
  return isPrivateSubject({ isPrivate: manifest.isPrivate, channelId: manifest.channelId, contentId: manifest.workId });
}

/** 上游地址没有独立的 MIME 字段，只有后缀可依据；非 mp4 一律按 HLS 清单解析（与分享页同一口径）。 */
export function mimeTypeOfMediaUrl(url: string): string {
  const path = url.split('#')[0].split('?')[0].toLowerCase();
  return path.endsWith('.mp4') || path.endsWith('.m4v') ? MP4_MIME_TYPE : HLS_MIME_TYPE;
}

function manifestKey(workId: string): string {
  return `${TITLE_MANIFEST_KEY_PREFIX}${workId}.json`;
}

export function createTitleManifestStore(deps: TitleManifestStoreDeps): TitleManifestStore {
  const memoryLimit = deps.memoryLimit ?? TITLE_MANIFEST_MEMORY_LIMIT;
  const diskLimit = deps.diskLimit ?? TITLE_MANIFEST_DISK_LIMIT;
  const ttl = deps.ttlSeconds ?? TITLE_MANIFEST_TTL_SECONDS;
  const now = deps.nowSeconds ?? ((): number => Math.floor(Date.now() / 1000));
  const memory = new Map<string, CachedManifest>();
  const pending = new Map<string, Promise<TitleManifest | null>>();
  /** `undefined` = 尚未解析原生缓存盘，`null` = 本机没有缓存盘（Web 构建），其余即那只盘。 */
  let disk: CacheDisk | null | undefined = deps.disk;
  let diskProbe: Promise<CacheDisk | null> | null = null;

  async function resolveDisk(): Promise<CacheDisk | null> {
    if (disk !== undefined) return disk;
    diskProbe ??= createCacheDisk();
    try {
      disk = await diskProbe;
    } catch (error) {
      logger.warn('manifest', '剧集清单缓存盘不可用，本轮只用内存缓存', error);
      disk = null;
    }
    return disk;
  }

  /** 内存永远先写；私密清单到此为止，落盘动作在下面，且被同一道闸门再次拦住。 */
  function remember(workId: string, manifest: TitleManifest): void {
    memory.set(workId, { manifest, at: now() });
    while (memory.size > memoryLimit) {
      const oldest = memory.keys().next();
      if (oldest.done === true) break;
      memory.delete(oldest.value);
    }
  }

  /**
   * 私密内容在此拦下，一次 I/O 都不发生；公开内容连索引一起写，索引是唯一的驱逐依据，
   * 于是"清单文件"永远不会变成【清理缓存】 enumerate 不出来的孤儿。
   */
  async function persist(workId: string, manifest: TitleManifest): Promise<void> {
    if (isPrivateManifest(manifest)) return;
    const live = await resolveDisk();
    if (live === null) return;
    try {
      assertWritable('public-cache.title-manifest', { contentId: manifest.workId, channelId: manifest.channelId, isPrivate: manifest.isPrivate });
      const entry: CachedManifest = { manifest, at: now() };
      const index = await readIndex(live);
      index[workId] = entry.at;
      const doomed = Object.entries(index)
        .sort((a, b) => b[1] - a[1])
        .slice(Math.max(0, diskLimit - 1))
        .map(([key]) => key);
      for (const key of doomed) delete index[key];
      await live.writeBatch(
        [{ key: manifestKey(workId), bytes: encode(entry) }, { key: TITLE_MANIFEST_INDEX_KEY, bytes: encode(index) }],
        doomed.map(manifestKey)
      );
    } catch (error) {
      // 落盘失败不影响播放：清单已在内存里，下一次打开重新拉一次就是。
      logger.warn('manifest', `剧集清单未能写入公开缓存域：${workId}`, error);
    }
  }

  async function readIndex(live: CacheDisk): Promise<Record<string, number>> {
    try {
      const parsed = decode<{ [key: string]: number }>(await live.read(TITLE_MANIFEST_INDEX_KEY));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const index: Record<string, number> = {};
      for (const [key, value] of Object.entries(parsed)) if (typeof value === 'number' && isSafeKeyPart(key)) index[key] = value;
      return index;
    } catch {
      return {};
    }
  }

  async function readFromDisk(workId: string): Promise<TitleManifest | null> {
    if (!isSafeKeyPart(workId)) return null;
    const live = await resolveDisk();
    if (live === null) return null;
    try {
      const entry = decode<CachedManifest>(await live.read(manifestKey(workId)));
      // 落盘那份被旧版本或被绕过闸门写进来时，读回这一道仍然拦得住：私密清单不在本机可读。
      if (entry === null || typeof entry.at !== 'number') return null;
      const manifest = parseTitleManifest(entry.manifest);
      return manifest === null || isPrivateManifest(manifest) ? null : manifest;
    } catch (error) {
      logger.warn('manifest', `剧集清单缓存读取失败：${workId}`, error);
      return null;
    }
  }

  async function fetch(workId: string): Promise<TitleManifest | null> {
    if (typeof deps.api.titleManifest !== 'function') return null;
    try {
      const manifest = parseTitleManifest(await deps.api.titleManifest(workId));
      if (manifest === null) return null;
      remember(workId, manifest);
      await persist(workId, manifest);
      return manifest;
    } catch (error) {
      // 私密剧目 404 与断网共用同一条降级：回退代理链，界面不因为清单缺席而白屏。
      logger.warn('manifest', `剧集清单拉取失败，退回代理播放：${workId}`, error);
      return null;
    }
  }

  async function load(workId: string, options: { force?: boolean } = {}): Promise<TitleManifest | null> {
    const hit = memory.get(workId);
    if (!options.force && hit !== undefined && now() - hit.at < ttl) return hit.manifest;
    const inFlight = pending.get(workId);
    if (inFlight !== undefined && !options.force) return await inFlight;
    // 去重必须在任何 await 之前登记：磁盘读也在任务体里，否则两次并发打开会各拉一次网络。
    const task = (async () => {
      if (!options.force && hit === undefined) {
        const restored = await readFromDisk(workId);
        if (restored !== null && now() - restored.generatedAt < ttl) {
          memory.set(workId, { manifest: restored, at: restored.generatedAt });
          return restored;
        }
      }
      return await fetch(workId);
    })();
    pending.set(workId, task);
    try {
      return await task;
    } finally {
      if (pending.get(workId) === task) pending.delete(workId);
    }
  }

  return {
    load,
    linesFor: async (workId, episodeNumber) =>
      (await load(workId))?.episodes.find((entry) => entry.episodeNumber === episodeNumber)?.lines ?? [],
    cached: (workId) => memory.get(workId)?.manifest ?? null,
    size: () => memory.size
  };
}

/* ==================== 进程内唯一一份清单缓存 ==================== */

/**
 * 投屏面板拿不到 `PrismApiClient`（它由 `player-detail` 就地构造），却要复用播放器已经拉到的那份清单，
 * 于是这里交出"当前生效的那只 store"。安装点在播放器创建时（组合根无需改动），Web 构建退化为纯内存。
 * 单例只有一条纪律：它必须是私密性判定与缓存上限都收敛过的那一只，禁止第二处 `new` 出平行副本。
 */
let activeStore: TitleManifestStore | null = null;

export function installTitleManifestStore(store: TitleManifestStore): TitleManifestStore {
  activeStore = store;
  return store;
}

export function activeTitleManifestStore(): TitleManifestStore | null {
  return activeStore;
}

/* ==================== 编解码（与公开缓存域同一套字节口径） ==================== */

const encoder = new TextEncoder();
const encode = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
function decode<T>(bytes: Uint8Array | null): T | null {
  if (bytes === null) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return null; // 撕坏的文件降级为"没有清单"，绝不在起播路径上抛错（AC-01 同款纪律）。
  }
}
