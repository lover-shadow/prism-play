// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createCacheDisk, createHistorySqlite, createPreferenceStore, isNativeHost, PREFERENCE_KEY_PREFIX,
  type FilesystemLike, type PreferencesLike, type SqliteConnectionLike, type SqliteDriverLike
} from '../../src/core/native/platform-adapters';
import type { CacheDisk, CacheWrite } from '../../src/core/storage/public-cache';
import { createHistoryStore, HISTORY_DATABASE, LOCAL_WATCH_HISTORY_DDL, type SqliteValue } from '../../src/core/storage/history-store';
import { readThemePreference, writeThemePreference } from '../../src/core/state/theme';

type PathOptions = { path: string; directory?: string };
type FileEntry = { name: string; type: string; size: number };

const enc = new TextEncoder();
const dec = new TextDecoder();
const write = (key: string, text: string): CacheWrite => ({ key, bytes: enc.encode(text) });const only = (ops: string[], verb: string): number[] => ops.map((op, index) => ({ op, index })).filter((entry) => entry.op.startsWith(verb)).map((entry) => entry.index);

/** 只记运算与路径：断言适配层的调用形状，而不是插件实现。 */
class FakeFs implements FilesystemLike {
  readonly files = new Map<string, string>();
  readonly ops: string[] = [];
  breakAfter: number | null = null;
  readFails = false;
  private writes = 0;

  async readFile(options: PathOptions): Promise<{ data: string }> {
    this.ops.push(`read:${options.directory}:${options.path}`);
    if (this.readFails) throw new Error('磁盘离线');
    const data = this.files.get(options.path);
    if (data === undefined) throw new Error('File does not exist.');
    return { data };
  }

  async writeFile(options: PathOptions & { data: string; recursive?: boolean }): Promise<void> {
    this.ops.push(`write:${options.directory}:${options.path}`);
    if (options.path.includes('/') && options.recursive !== true) throw new Error('Folder does not exist.');
    this.writes += 1;
    if (this.breakAfter !== null && this.writes > this.breakAfter) throw new Error('磁盘空间不足');
    this.files.set(options.path, options.data);
  }

  async deleteFile(options: PathOptions): Promise<void> {
    this.ops.push(`delete:${options.directory}:${options.path}`);
    if (!this.files.delete(options.path)) throw new Error('File does not exist.');
  }

  async rename(options: { from: string; to: string; directory?: string }): Promise<void> {
    this.ops.push(`rename:${options.directory}:${options.from}->${options.to}`);
    const data = this.files.get(options.from);
    if (data === undefined) throw new Error('File does not exist.');
    this.files.delete(options.from);
    this.files.set(options.to, data);
  }

  /** 目录树由路径推导，size 报字节数，与 Filesystem 7 的 FileInfo 同形。 */
  async readdir(options: PathOptions): Promise<{ files: FileEntry[] }> {
    this.ops.push(`list:${options.directory}:${options.path}`);
    const found = new Map<string, FileEntry>();
    for (const [path, data] of this.files) {
      const rest = path.startsWith(options.path) ? path.slice(options.path.length) : '';
      if (rest === '') continue;
      const cut = rest.indexOf('/');
      const name = cut === -1 ? rest : rest.slice(0, cut);
      found.set(name, cut === -1 ? { name, type: 'file', size: atob(data).length } : { name, type: 'directory', size: 0 });
    }
    if (found.size === 0) throw new Error('Folder does not exist.');
    return { files: [...found.values()] };
  }
}

class FakePrefs implements PreferencesLike {
  readonly calls: string[] = [];
  readonly data = new Map<string, string>();

  async get(options: { key: string }): Promise<{ value: string | null }> {
    this.calls.push('get');
    return { value: this.data.get(options.key) ?? null };
  }

  async set(options: { key: string; value: string }): Promise<void> {
    this.calls.push('set');
    this.data.set(options.key, options.value);
  }

  /** 备份白名单锁死默认 group：一旦被调用，data_extraction_rules.xml 的 sharedpref 条目即失效。 */
  async configure(options: { group: string }): Promise<void> {
    this.calls.push(`configure:${options.group}`);
  }
}

class FakeDriver implements SqliteDriverLike {
  readonly calls: string[] = [];
  readonly sets: Array<Array<{ statement?: string; values?: SqliteValue[] }>> = [];
  readonly transactions: Array<boolean | undefined> = [];
  readonly queries: string[] = [];
  rows: Record<string, unknown>[] = [];
  connected = false;
  creations = 0;

  private readonly conn: SqliteConnectionLike = {
    open: async () => void this.calls.push('open'),
    close: async () => { this.calls.push('close'); this.connected = false; },
    executeSet: async (set, transaction) => { this.sets.push(set); this.transactions.push(transaction); },
    query: async (statement, values) => {
      this.queries.push(`${statement}|${JSON.stringify(values ?? [])}`);
      return { values: this.rows };
    }
  };

  async isConnection(database: string, readonlyMode: boolean): Promise<{ result?: boolean }> {
    this.calls.push(`isConnection:${database}:${readonlyMode}`);
    return { result: this.connected };
  }

  async createConnection(database: string, encrypted: boolean, mode: string, version: number, readonlyMode: boolean): Promise<SqliteConnectionLike> {
    this.calls.push(`create:${database}:${encrypted}:${mode}:${version}:${readonlyMode}`);
    this.creations += 1;
    this.connected = true;
    return this.conn;
  }

  async retrieveConnection(database: string, readonlyMode: boolean): Promise<SqliteConnectionLike> {
    this.calls.push(`retrieve:${database}:${readonlyMode}`);
    return this.conn;
  }
}

async function nativeDisk(fs: FakeFs): Promise<CacheDisk> {
  const disk = await createCacheDisk({ fs, platform: () => true });
  if (disk === null) throw new Error('原生宿主下必须给出文件承载');
  return disk;
}

describe('平台判定与偏好域', () => {
  beforeEach(() => window.localStorage.clear());

  it('浏览器里不是原生宿主，注入的判定函数优先', () => {
    expect(isNativeHost()).toBe(false);
    expect(isNativeHost(() => true)).toBe(true);
  });

  it('Web 落到 localStorage，键名原样透传且前缀稳定', async () => {
    const store = createPreferenceStore();
    await store.set('prism.theme', 'dark');
    expect(window.localStorage.getItem(`${PREFERENCE_KEY_PREFIX}theme`)).toBe('dark');
    expect(await store.get('prism.posterMode')).toBeNull();
    await writeThemePreference(store, 'light');
    expect(await readThemePreference(store)).toBe('light');
    expect(window.localStorage.getItem('prism.theme')).toBe('light');
  });

  it('拒绝越界键名与非字符串值，不静默写坏偏好', async () => {
    const store = createPreferenceStore();
    await expect(store.set('jwt', 'eyJhbGci')).rejects.toThrow(/偏好域/);
    await expect(store.get('deviceId')).rejects.toThrow(/偏好域/);
    await expect(store.set(PREFERENCE_KEY_PREFIX, 'dark')).rejects.toThrow(/偏好域/);
    await expect(store.set('prism.theme', { mode: 'dark' } as unknown as string)).rejects.toThrow(/字符串/);
    expect(window.localStorage.length).toBe(0);
  });

  it('承载层报错如实上抛，不降级成"没有偏好"', async () => {
    const broken = { getItem: (): string => { throw new Error('配额已满'); }, setItem: (): void => { throw new Error('配额已满'); } };
    const store = createPreferenceStore({ storage: broken });
    await expect(store.get('prism.theme')).rejects.toThrow('配额已满');
    await expect(store.set('prism.theme', 'dark')).rejects.toThrow('配额已满');
  });

  it('原生宿主只调用 get/set，绝不 configure', async () => {
    const prefs = new FakePrefs();
    const store = createPreferenceStore({ prefs, platform: () => true });
    await store.set('prism.keepScreenOn', 'true');
    expect(await store.get('prism.keepScreenOn')).toBe('true');
    expect(await store.get('prism.callAutoPause')).toBeNull();
    expect(prefs.calls).toEqual(['set', 'get', 'get']);
    expect([...prefs.data.keys()]).toEqual(['prism.keepScreenOn']);
  });
});

describe('公开缓存域文件承载', () => {
  it('Web 返回 null，由组合根退回内存盘', async () => {
    expect(await createCacheDisk()).toBeNull();
    expect(await createCacheDisk({ platform: () => false })).toBeNull();
  });

  it('键映射到 Directory.Cache 下的相对路径，二进制原样往返', async () => {
    const fs = new FakeFs();
    const disk = await nativeDisk(fs);
    const blob = new Uint8Array(20000);
    for (let index = 0; index < blob.length; index += 1) blob[index] = index % 256;
    await disk.writeBatch([{ key: 'cache/posters/drama_1@v1', bytes: blob }], []);
    expect(fs.ops).toEqual(['write:CACHE:posters/.drama_1@v1.t0', 'rename:CACHE:posters/.drama_1@v1.t0->posters/drama_1@v1']);
    expect(fs.files.has('posters/drama_1@v1')).toBe(true);
    expect(await disk.read('cache/posters/drama_1@v1')).toEqual(blob);
  });

  it('拒绝任何越出缓存根目录的键，而不是清洗后继续写', async () => {
    const disk = await nativeDisk(new FakeFs());
    const escaping = ['cache/../evil', 'cache/posters/../../evil', '../evil', '/abs/x', 'cache\\posters\\a', 'cache/posters/a\u0000b', 'C:/evil', 'evil/posters/a', 'cache/./x', 'cache/posters/.hidden', 'cache/', 'cache', ''];
    for (const key of escaping) {
      await expect(disk.writeBatch([{ key, bytes: new Uint8Array([1]) }], [])).rejects.toThrow(/越界|为空/);
      await expect(disk.read(key)).rejects.toThrow(/越界|为空/);
    }
    await expect(disk.list('../')).rejects.toThrow(/越界/);
    await disk.writeBatch([write('cache/posters/a..b@v1', 'ok')], []);
    expect(dec.decode(await disk.read('cache/posters/a..b@v1') ?? new Uint8Array())).toBe('ok');
  });

  it('删除先于可见写入，暂存失败则整批不落盘', async () => {
    const fs = new FakeFs();
    const disk = await nativeDisk(fs);
    await disk.writeBatch([write('cache/catalog/r1/c0.json', 'old')], []);
    fs.breakAfter = 1;
    await expect(disk.writeBatch([write('cache/catalog/r2/c0.json', 'new'), write('cache/catalog/r2/c1.json', 'newer')], ['cache/catalog/r1/c0.json', 'cache/catalog/meta.json'])).rejects.toThrow('磁盘空间不足');
    expect(fs.files.has('catalog/r1/c0.json')).toBe(true);
    expect(fs.files.has('catalog/r2/c0.json')).toBe(false);
    expect(only(fs.ops, 'delete:CACHE:catalog/r1')).toEqual([]);
    expect([...fs.files.keys()].filter((path) => path.split('/').some((segment) => segment.startsWith('.')))).toEqual([]);
    fs.breakAfter = null;
    const mark = fs.ops.length;
    await disk.writeBatch([write('cache/catalog/r2/c0.json', 'new')], ['cache/catalog/r1/c0.json', 'cache/catalog/meta.json']);
    const tail = fs.ops.slice(mark);
    expect(Math.max(...only(tail, 'delete:'))).toBeLessThan(Math.min(...only(tail, 'rename:')));
    expect(fs.files.has('catalog/r2/c0.json')).toBe(true);
  });

  it('list 只返回前缀内的键，分块目录与海报互不串台', async () => {
    const disk = await nativeDisk(new FakeFs());
    await disk.writeBatch([write('cache/catalog/r3/c0.json', 'a'), write('cache/catalog/r3/c1.json', 'bb'), write('cache/catalog/meta.json', 'm'), write('cache/posters/drama_1@v1', 'ppp')], []);
    const keys = async (prefix: string): Promise<string[]> => (await disk.list(prefix)).map((entry) => entry.key).sort();
    expect(await keys('cache/catalog/r')).toEqual(['cache/catalog/r3/c0.json', 'cache/catalog/r3/c1.json']);
    expect(await keys('cache/posters/')).toEqual(['cache/posters/drama_1@v1']);
    expect(await keys('cache/')).toEqual(['cache/catalog/meta.json', 'cache/catalog/r3/c0.json', 'cache/catalog/r3/c1.json', 'cache/posters/drama_1@v1']);
    expect(await disk.list('cache/posters/')).toEqual([{ key: 'cache/posters/drama_1@v1', bytes: 3 }]);
  });

  it('读取缺失返回 null，真实 I/O 故障继续上抛', async () => {
    const fs = new FakeFs();
    const disk = await nativeDisk(fs);
    expect(await disk.read('cache/posters/missing@v1')).toBeNull();
    await disk.writeBatch([write('cache/posters/drama_1@v1', 'ppp')], []);
    expect(await disk.list('cache/')).toHaveLength(1);
    fs.readFails = true;
    await expect(disk.read('cache/posters/drama_1@v1')).rejects.toThrow('磁盘离线');
  });
});

describe('追剧历史域 SQLite 承载', () => {
  it('Web 是能力缺席而非空历史：连接为假，读写如实拒绝，组合根据此禁用【追剧】', async () => {
    const sqlite = await createHistorySqlite();
    expect(await sqlite.isConnected(HISTORY_DATABASE)).toBe(false);
    await expect(sqlite.open(HISTORY_DATABASE)).rejects.toThrow('本机无端侧 SQLite：追剧历史需 Android 宿主');
    await expect(sqlite.executeSet(HISTORY_DATABASE, [], true)).rejects.toThrow(/Android/);
    await expect(sqlite.queryResult(HISTORY_DATABASE, 'SELECT 1', [])).rejects.toThrow(/Android/);
    await expect(sqlite.close(HISTORY_DATABASE)).resolves.toBeUndefined();
    await expect(createHistoryStore({ sqlite }).init()).rejects.toThrow(/Android/);
  });

  it('原生宿主按库名建连接、复用句柄，事务与位置参数原样下传', async () => {
    const driver = new FakeDriver();
    const sqlite = await createHistorySqlite({ driver, platform: () => true });
    await sqlite.open(HISTORY_DATABASE);
    expect(driver.calls).toEqual([`isConnection:${HISTORY_DATABASE}:false`, `create:${HISTORY_DATABASE}:false:no-encryption:1:false`, 'open']);
    expect(await sqlite.isConnected(HISTORY_DATABASE)).toBe(true);
    await sqlite.executeSet(HISTORY_DATABASE, [{ statement: 'INSERT INTO t VALUES (?)', values: [1] }], true);
    await sqlite.executeSet(HISTORY_DATABASE, [{ statement: 'DELETE FROM t', values: [] }], true);
    expect(driver.creations).toBe(1);
    expect(driver.transactions).toEqual([true, true]);
    driver.rows = [{ total: 2 }];
    expect(await sqlite.queryResult(HISTORY_DATABASE, 'SELECT COUNT(*) AS total', [7])).toEqual([{ total: 2 }]);
    expect(driver.queries).toEqual(['SELECT COUNT(*) AS total|[7]']);
    await sqlite.close(HISTORY_DATABASE);
    expect(driver.calls).toContain('close');
  });

  it('已有连接走 retrieve，域层经适配层跑通建表与断点写入', async () => {
    const shared = new FakeDriver();
    shared.connected = true;
    await (await createHistorySqlite({ driver: shared, platform: () => true })).open(HISTORY_DATABASE);
    expect(shared.calls).toEqual([`isConnection:${HISTORY_DATABASE}:false`, `retrieve:${HISTORY_DATABASE}:false`, 'open']);
    expect(shared.creations).toBe(0);
    const driver = new FakeDriver();
    const sqlite = await createHistorySqlite({ driver, platform: () => true });
    await createHistoryStore({ sqlite, nowSeconds: () => 1767225600 }).upsertWatch({ contentId: 'drama_1', title: '长夜将尽', lastEpisodeId: 3, lastEpisodeNumber: 3, positionSeconds: 120, durationSeconds: 300 });
    expect(driver.sets[0][0].statement).toBe(LOCAL_WATCH_HISTORY_DDL);
    expect(driver.sets[1][0].values?.[0]).toBe('drama_1');
    expect(driver.transactions).toEqual([true, true]);
  });
});
