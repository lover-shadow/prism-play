/**
 * 原生存储接口适配（SPEC §6.1 / §10），不新增绕过域层写入闸门的入口。
 * 顶层零插件注册、零 I/O；插件在工厂内按需 import，供 Web/jsdom 安全加载。
 */

import { Capacitor } from '@capacitor/core';
import { logger } from '../diagnostics';
import type { CacheDisk, CacheWrite } from '../storage/public-cache';
import type { PreferenceStore } from '../state/theme';
import type { SqliteLike, SqliteStatement, SqliteValue } from '../storage/history-store';

/** 平台判定唯一口径：原生宿主走插件，其余一律退回 Web 语义并如实报告能力缺席。 */
export function isNativeHost(platform: () => boolean = (): boolean => Capacitor.isNativePlatform()): boolean {
  return platform() === true;
}

// ------------------------------------------------------------------ 偏好域（Domain 2 的偏好半边）

/** 偏好整文件进入备份白名单 (M-8)：只接受 prism.*，键名原样透传，不容凭证混入。 */
export const PREFERENCE_KEY_PREFIX = 'prism.';

export interface PreferencesLike {
  get(options: { key: string }): Promise<{ value: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
}

export interface PreferenceStoreDeps { prefs?: PreferencesLike; platform?: () => boolean; storage?: Pick<Storage, 'getItem' | 'setItem'> }

type PreferenceBacking = { read(key: string): Promise<string | null>; write(key: string, value: string): Promise<void> };

async function resolvePreferenceBacking(deps: PreferenceStoreDeps): Promise<PreferenceBacking> {
  const prefs = deps.prefs ?? (isNativeHost(deps.platform) ? (await import('@capacitor/preferences')).Preferences : null);
  if (prefs !== null) {
    // PluginCall 只收发包装对象，裸值出不了原生边界，拆盒只发生在这一处。
    return { read: async (key) => (await prefs.get({ key })).value ?? null, write: async (key, value) => { await prefs.set({ key, value }); } };
  }
  const storage = deps.storage ?? window.localStorage;
  return { read: async (key) => storage.getItem(key), write: async (key, value) => { storage.setItem(key, value); } };
}

export function createPreferenceStore(deps: PreferenceStoreDeps = {}): PreferenceStore {
  let pending: Promise<PreferenceBacking> | null = null;
  const backing = async (): Promise<PreferenceBacking> => {
    if (pending === null) {
      // 解析失败不缓存：一次插件加载失败不该永久毒化偏好域。
      pending = resolvePreferenceBacking(deps).catch((reason: unknown) => {
        pending = null;
        throw reason;
      });
    }
    return await pending;
  };
  const keyOrThrow = (key: string): string => {
    const valid = typeof key === 'string' && key.startsWith(PREFERENCE_KEY_PREFIX) && key.length > PREFERENCE_KEY_PREFIX.length && !key.includes('\u0000');
    if (!valid) throw new Error(`偏好域仅接受 ${PREFERENCE_KEY_PREFIX}* 键名，收到不合法的存储键`);
    return key;
  };
  return {
    get: async (key) => await (await backing()).read(keyOrThrow(key)),
    set: async (key, value) => {
      // localStorage 会把任何对象静默成 "[object Object]"，读回时既不是合法偏好也不报错，等于无声丢失设置。
      if (typeof value !== 'string') throw new Error('偏好值只能是字符串：非字符串写入会读回不可解析的序列化残骸');
      await (await backing()).write(keyOrThrow(key), value);
    }
  };
}

// ------------------------------------------------------------------ 公开缓存域（Domain 3 的文件半）

/** `Directory.Cache` 的线上取值：原生侧据此选 getCacheDir()。刻意不在顶层 import 插件，故留字面量。 */
const CACHE_DIRECTORY = 'CACHE';
const CACHE_NAMESPACE = 'cache/';
const SEPARATOR = '/';
const SEGMENT_MAX = 200;

export interface FilesystemLike {
  readFile(options: { path: string; directory?: string }): Promise<{ data: string | Blob }>;
  writeFile(options: { path: string; data: string | Blob; directory?: string; recursive?: boolean }): Promise<unknown>;
  deleteFile(options: { path: string; directory?: string }): Promise<unknown>;
  readdir(options: { path: string; directory?: string }): Promise<{ files: Array<{ name: string; type: string; size?: number }> }>;
  rename(options: { from: string; to: string; directory?: string }): Promise<unknown>;
}

export interface CacheDiskDeps { fs?: FilesystemLike; platform?: () => boolean }

const invalidKey = (key: string, reason: string): Error => new Error(`缓存键越界已被拒绝：${reason} (${key === '' ? '空键' : key})`);

function namespacedPath(key: string): string {
  if (typeof key !== 'string' || key === '') throw invalidKey(String(key), '为空');
  if (key.includes('\u0000') || key.includes('\\') || key.includes(':')) throw invalidKey(key, '含非法分隔符');
  if (!key.startsWith(CACHE_NAMESPACE)) throw invalidKey(key, '不在 cache/ 命名空间内');
  if (key.includes('//') || key.includes('/..') || key.endsWith('..')) throw invalidKey(key, '绝对路径或回溯段');
  return key.slice(CACHE_NAMESPACE.length);
}

/**
 * 键里含云端下发的内容 id，属于不可信输入：越界一律抛错而不是"清洗后继续"，
 * 本层永远拼不出 `Directory.Cache` 之外的路径。点前缀段被 writeBatch 用作暂存区，键名不得占用。
 */
function cachePathOf(key: string): string {
  const relative = namespacedPath(key);
  if (relative === '' || key.endsWith(SEPARATOR)) throw invalidKey(key, '不是一个文件键');
  for (const segment of relative.split(SEPARATOR)) {
    if (segment.startsWith('.') || segment.length > SEGMENT_MAX) throw invalidKey(key, '点段或超长段');
  }
  return relative;
}

/** 列举前缀可以停在半个段上（`cache/catalog/r`），因此只下探到最后一个完整目录，再按字符串前缀过滤。 */
function directoryForPrefix(prefix: string): string {
  const relative = namespacedPath(prefix);
  const dir = relative.slice(0, relative.lastIndexOf(SEPARATOR) + 1);
  if (dir !== '' && dir.slice(0, -1).split(SEPARATOR).some((segment) => segment.startsWith('.'))) throw invalidKey(prefix, '暂存区不参与列举');
  return dir;
}

const directoryOf = (path: string): string => path.slice(0, path.lastIndexOf(SEPARATOR) + 1);
const baseNameOf = (path: string): string => path.slice(path.lastIndexOf(SEPARATOR) + 1);
const BASE64_CHUNK = 8192;

/** 海报是二进制：Filesystem 不带 encoding 时按 base64 收发，分块拼接避免超出实参展开上限。 */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let start = 0; start < bytes.length; start += BASE64_CHUNK) binary += String.fromCharCode(...Array.from(bytes.subarray(start, start + BASE64_CHUNK)));
  return btoa(binary);
}

function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** 宿主用异常表达"文件不存在"，接口要的是 null；其余 I/O 错误继续上抛，不得当成缺失静默降级。 */
function isMissing(reason: unknown): boolean {
  const code = (reason as { code?: unknown } | null)?.code;
  const text = reason instanceof Error ? reason.message : String(reason);
  return code === 'ENOENT' || /does not exist|no such file|ENOENT/i.test(text);
}

export async function createCacheDisk(deps: CacheDiskDeps = {}): Promise<CacheDisk | null> {
  if (!isNativeHost(deps.platform)) return null;
  let fs: FilesystemLike;
  try {
    fs = deps.fs ?? (await import('@capacitor/filesystem')).Filesystem;
  } catch (err) {
    console.warn('Filesystem plugin unavailable, falling back to MemoryCacheDisk', err);
    return null;
  }
  const at = (path: string): { path: string; directory: string } => ({ path, directory: CACHE_DIRECTORY });

  async function collect(dir: string, found: Array<{ key: string; bytes: number }>): Promise<void> {
    let entries;
    try {
      entries = (await fs.readdir(at(dir))).files;
    } catch (reason) { if (!isMissing(reason)) throw reason; return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const path = `${dir}${entry.name}`;
      if (entry.type === 'directory') await collect(`${path}${SEPARATOR}`, found);
      else found.push({ key: `${CACHE_NAMESPACE}${path}`, bytes: entry.size ?? 0 });
    }
  }

  return {
    async read(key: string): Promise<Uint8Array | null> {
      const path = cachePathOf(key);
      let data: string | Blob;
      try {
        data = (await fs.readFile(at(path))).data;
      } catch (reason) { if (isMissing(reason)) return null; throw reason; }
      if (typeof data !== 'string') throw new Error('缓存域按 base64 读取二进制，宿主返回了非字符串载荷');
      return fromBase64(data);
    },

    /** 同目录暂存 -> 删除 -> 改名；暂存失败不触碰旧键，删除先于可见写入。 */
    async writeBatch(writes: CacheWrite[], removes: string[]): Promise<void> {
      const targets = writes.map((write) => ({ path: cachePathOf(write.key), bytes: write.bytes }));
      const doomed = removes.map(cachePathOf);
      const staged: string[] = [];
      try {
        for (const [index, target] of targets.entries()) {
          const tmp = `${directoryOf(target.path)}.${baseNameOf(target.path)}.t${index}`;
          await fs.writeFile({ ...at(tmp), data: toBase64(target.bytes), recursive: true });
          staged.push(tmp);
        }
        for (const path of doomed) {
          try { await fs.deleteFile(at(path)); } catch (reason) { if (!isMissing(reason)) throw reason; }
        }
        for (const [index, tmp] of staged.entries()) await fs.rename({ from: tmp, to: targets[index].path, directory: CACHE_DIRECTORY });
      } catch (reason) {
        for (const tmp of staged) {
          try { await fs.deleteFile(at(tmp)); } catch { /* 残留片段不进入 list，且会被下一次同名暂存覆盖 */ }
        }
        throw reason;
      }
    },

    async list(prefix: string): Promise<Array<{ key: string; bytes: number }>> {
      const found: Array<{ key: string; bytes: number }> = [];
      await collect(directoryForPrefix(prefix), found);
      return found.filter((entry) => entry.key.startsWith(prefix));
    }
  };
}

// ------------------------------------------------------------------ 追剧历史域（Domain 2 的 SQLite 半边）

const SQLITE_UNAVAILABLE = '本机无端侧 SQLite：追剧历史需 Android 宿主';

/** 备份白名单收录了 prism_local.db：加密会让换机恢复出来的库不可解密，那等于自毁历史 (M-8)。 */
const SQLITE_MODE = 'no-encryption';
const SQLITE_VERSION = 1;

export interface SqliteConnectionLike {
  open(): Promise<void>;
  close(): Promise<void>;
  executeSet(set: Array<{ statement?: string; values?: SqliteValue[] }>, transaction?: boolean): Promise<unknown>;
  query(statement: string, values?: SqliteValue[]): Promise<{ values?: unknown[] }>;
}

export interface SqliteDriverLike {
  isConnection(database: string, readonly: boolean): Promise<{ result?: boolean }>;
  createConnection(database: string, encrypted: boolean, mode: string, version: number, readonly: boolean): Promise<SqliteConnectionLike>;
  retrieveConnection(database: string, readonly: boolean): Promise<SqliteConnectionLike>;
}

export interface HistorySqliteDeps { driver?: SqliteDriverLike; platform?: () => boolean }

function unavailableSqlite(): SqliteLike {
  const refuse = async (): Promise<never> => { throw new Error(SQLITE_UNAVAILABLE); };
  return {
    isConnected: async () => false,
    open: refuse,
    executeSet: refuse,
    queryResult: refuse,
    // 从未打开过的库谈不上关闭：冷启动退出路径不该因为一句"没有 SQLite"而抛错。
    close: async () => undefined
  };
}

function nativeSqlite(driver: SqliteDriverLike): SqliteLike {
  const handles = new Map<string, SqliteConnectionLike>();
  const pending = new Map<string, Promise<SqliteConnectionLike>>();
  // 手里的句柄就是最权威的连接状态，不必再问一次原生桥；探测只在冷启动发生。
  async function probed(database: string): Promise<boolean> {
    return handles.has(database) || (await driver.isConnection(database, false)).result === true;
  }
  // 连接按库名缓存：插件句柄是有状态的，而 `SqliteLike` 是无状态的库名寻址，这层映射只在这里做一次。
  async function attach(database: string): Promise<SqliteConnectionLike> {
    const held = handles.get(database);
    if (held !== undefined) return held;
    const flight = pending.get(database);
    if (flight !== undefined) return await flight;
    const attaching = (async () => {
      let stage = 'create';
      try {
        const connection = (await probed(database))
          ? await driver.retrieveConnection(database, false)
          : await driver.createConnection(database, false, SQLITE_MODE, SQLITE_VERSION, false);
        stage = 'open';
        await connection.open();
        handles.set(database, connection);
        return connection;
      } catch (error) {
        logger.error('history', `${stage} failed`, error);
        throw error;
      }
    })();
    pending.set(database, attaching);
    try { return await attaching; } finally { pending.delete(database); }
  }
  return {
    isConnected: probed,
    open: async (database) => { await attach(database); },
    close: async (database) => {
      const held = handles.get(database);
      handles.delete(database);
      if (held !== undefined) await held.close();
    },
    // 域层固定以 transaction: true 下发整段（建表语句也走 executeSet），位置参数原样透传。
    executeSet: async (database, set: SqliteStatement[], transaction) => { await (await attach(database)).executeSet(set, transaction); },
    queryResult: async <T extends Record<string, unknown>>(database: string, statement: string, values: SqliteValue[]): Promise<T[]> =>
      ((await (await attach(database)).query(statement, values)).values ?? []) as T[]
  };
}

export async function createHistorySqlite(deps: HistorySqliteDeps = {}): Promise<SqliteLike> {
  if (!isNativeHost(deps.platform)) return unavailableSqlite();
  if (deps.driver !== undefined) return nativeSqlite(deps.driver);
  try {
    // v7 的库名寻址在 `SQLiteConnection` 包装对象上；裸插件实例只收 options 对象，两者不可混用。
    const { CapacitorSQLite, SQLiteConnection } = await import('@capacitor-community/sqlite');
    return nativeSqlite(new SQLiteConnection(CapacitorSQLite));
  } catch (err) {
    console.warn('CapacitorSQLite unavailable, falling back to unavailableSqlite', err);
    return unavailableSqlite();
  }
}
