/**
 * 统一事实缓存的磁盘 I/O 层（W1 · `title-facts` 的伴生模块，仅为 §10 单文件红线拆分）。
 *
 * 只负责：v2 条目的读写形状校验、索引维护与 LRU 淘汰、磁盘可用性探测。
 * 不引入适配逻辑（详情/清单的适配在 `title-facts.ts`），也不做隐私判定（写前提级已判）。
 * 磁盘不可用（Web 构建、探测失败）时全部安全降级为 no-op，绝不影响起播路径。
 */
import { logger } from '../diagnostics';
import { createCacheDisk } from '../native/platform-adapters';
import type { CacheDisk } from '../storage/public-cache';
import { TITLE_MANIFEST_INDEX_KEY, TITLE_MANIFEST_KEY_PREFIX } from '../../player/title-manifest';

export interface StoredFact { raw: unknown; cachedAt: number; generatedAt: number }

export interface TitleFactsDiskPort {
  /** null = 本机没有缓存盘或条目缺失/形状不符（v1 旧条目与损坏文件一律当作 miss）。 */
  read(workId: string): Promise<StoredFact | null>;
  write(workId: string, fact: StoredFact): Promise<void>;
}

const isSafeKeyPart = (value: string): boolean =>
  typeof value === 'string' && value.length > 0 && value.length <= 120 && /^[A-Za-z0-9._-]+$/.test(value) && !value.startsWith('.') && !value.includes('..');
const factKey = (workId: string): string => `${TITLE_MANIFEST_KEY_PREFIX}${workId}.json`;
const encoder = new TextEncoder();
const encode = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
function decode<T>(bytes: Uint8Array | null): T | null {
  if (bytes === null) return null;
  try { return JSON.parse(new TextDecoder().decode(bytes)) as T; } catch { return null; }
}

/** v2 形状校验：`{ v: 2, raw, cachedAt }`；旧 v1（只存解析后清单）不肯认，交新写入自然替换。 */
function parseStored(value: unknown): StoredFact | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.v !== 2) return null;
  if (typeof raw.cachedAt !== 'number' || !Number.isFinite(raw.cachedAt)) return null;
  if (!('raw' in raw)) return null;
  return { raw: raw.raw, cachedAt: raw.cachedAt, generatedAt: typeof raw.generatedAt === 'number' && Number.isFinite(raw.generatedAt) ? raw.generatedAt : 0 };
}

export function createTitleFactsDisk(deps: { disk?: CacheDisk | null; diskLimit: number }): TitleFactsDiskPort {
  /** `undefined` = 尚未解析原生缓存盘，`null` = 本机没有缓存盘（Web 构建），其余即那只盘。 */
  let disk: CacheDisk | null | undefined = deps.disk;
  let probe: Promise<CacheDisk | null> | null = null;

  async function resolve(): Promise<CacheDisk | null> {
    if (disk !== undefined) return disk;
    probe ??= createCacheDisk();
    try { disk = await probe; } catch (error) { logger.warn('facts', '事实缓存盘不可用，本轮只用内存缓存', error); disk = null; }
    return disk;
  }

  async function readIndex(live: CacheDisk): Promise<Record<string, number>> {
    try {
      const parsed = decode<{ [key: string]: number }>(await live.read(TITLE_MANIFEST_INDEX_KEY));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      const index: Record<string, number> = {};
      for (const [key, value] of Object.entries(parsed)) if (typeof value === 'number' && isSafeKeyPart(key)) index[key] = value;
      return index;
    } catch { return {}; }
  }

  return {
    async read(workId) {
      if (!isSafeKeyPart(workId)) return null;
      const live = await resolve();
      if (live === null) return null;
      try {
        const stored = parseStored(decode<unknown>(await live.read(factKey(workId))));
        return stored;
      } catch (error) {
        logger.warn('facts', `事实缓存读取失败：${workId}`, error);
        return null;
      }
    },
    async write(workId, fact) {
      const live = await resolve();
      if (live === null) return;
      try {
        const index = await readIndex(live);
        index[workId] = fact.cachedAt;
        const doomed = Object.entries(index).sort((a, b) => b[1] - a[1]).slice(Math.max(0, deps.diskLimit - 1)).map(([key]) => key);
        for (const key of doomed) delete index[key];
        const stored: StoredEntryWire = { v: 2, raw: fact.raw, cachedAt: fact.cachedAt, generatedAt: fact.generatedAt };
        await live.writeBatch(
          [{ key: factKey(workId), bytes: encode(stored) }, { key: TITLE_MANIFEST_INDEX_KEY, bytes: encode(index) }],
          doomed.map(factKey)
        );
      } catch (error) {
        // 落盘失败不影响播放：条目已在内存里，下一次打开重新拉一次就是。
        logger.warn('facts', `事实缓存未能写入公开缓存域：${workId}`, error);
      }
    }
  };
}

interface StoredEntryWire { v: 2; raw: unknown; cachedAt: number; generatedAt: number }
