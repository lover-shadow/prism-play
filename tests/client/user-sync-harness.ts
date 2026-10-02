/**
 * WP7 端云同步测试的共享替身（AC-30 的 `54-user-sync` / `55-user-sync-exits` 两套用例共用）。
 * 与 `player-harness.ts` 同一条纪律：测试替身只允许一份真相，禁止为了减行数把它复制进两个文件。
 *
 * 关键点：历史存储不是"假写入"——`upsertWatch` 仍调用生产的 `assertWritable()` 与
 * `toWatchHistoryRow()`，所以"私密断点被闸门拦截"在单测里证的是真闸门，而不是一句自述。
 */
import type { PreferenceStore } from '../../src/core/state/theme';
import { toWatchHistoryRow, type HistoryStore, type WatchProgressInput } from '../../src/core/storage/history-store';
import { assertWritable, type WatchHistoryRow } from '../../src/core/storage/storage-domains';
import { createUserSync, type ExitReport, type UserSyncDeps } from '../../src/core/user-sync';
import { createPrivateVault } from '../../src/core/storage/private-vault';

export const NOW = 1_780_000_000;
export const TOKEN = 'eyJhbGciOiJPdFAifQ.eyJzdWIiOiJHWS0xMTIyMzMzNCJ9.sigsigsigsig';
export const SYNC_URL = 'https://play.prismos.org/api/user/sync';

export const row = (over: Partial<WatchHistoryRow> = {}): WatchHistoryRow => ({
  content_id: 'c1', title: '凤逆天下', cover_url: null, last_episode_id: 12, last_episode_number: 12,
  position_seconds: 145, duration_seconds: 300, total_episodes: 30, updated_at: 1000, ...over
});

export const breakpoint = (over: Partial<ExitReport> = {}): ExitReport => ({
  contentId: 'c1', episodeId: 12, episodeNumber: 12, positionSeconds: 145.7, durationSeconds: 300,
  isPrivate: false, channelId: 'drama', ...over
});

/** 偏好域替身：仍强制 `prism.` 前缀（备份白名单按前缀收录），并把每次写入记进 ops 以证时序。 */
export class MemoryPrefs implements PreferenceStore {
  readonly ops: string[];
  private readonly files = new Map<string, string>();
  constructor(ops: string[] = []) { this.ops = ops; }
  async get(key: string): Promise<string | null> { return this.files.get(key) ?? null; }
  async set(key: string, value: string): Promise<void> {
    if (!key.startsWith('prism.')) throw new Error('偏好域仅接受 prism.* 键名');
    this.files.set(key, value);
    this.ops.push('queue');
  }
  snapshot(key: string): string | null { return this.files.get(key) ?? null; }
  keys(): string[] { return [...this.files.keys()]; }
  seed(key: string, value: string): void { this.files.set(key, value); }
}

/** 内存版历史域：写入走生产同款闸门与行归一化，私密出处一旦被拦就会抛。 */
export function fakeHistory(seed: WatchHistoryRow[] = []): HistoryStore & { rows: Map<string, WatchHistoryRow> } {
  const rows = new Map(seed.map((entry) => [entry.content_id, entry]));
  return {
    rows,
    init: async () => undefined,
    async upsertWatch(input: WatchProgressInput): Promise<WatchHistoryRow> {
      assertWritable('local_watch_history', input);
      const written = toWatchHistoryRow(input, NOW);
      rows.set(written.content_id, written);
      return written;
    },
    getWatch: async (contentId: string) => rows.get(contentId) ?? null,
    listRecent: async () => [...rows.values()].sort((left, right) => right.updated_at - left.updated_at),
    listFinished: async () => [],
    resumePosition: (entry: WatchHistoryRow) => entry.position_seconds,
    count: async () => rows.size,
    clearHistory: async () => ({ table: 'local_watch_history', removedRows: rows.size, reachedDomains: ['history'] as const, preservedDomains: ['credentials', 'public-cache', 'private-volatile'] as const }),
    close: async () => undefined
  };
}

export interface Call { url: string; method: string; keepalive?: boolean; body: string | null; authorization: string | null }

export interface ServerOptions { calls: Call[]; ops: string[]; state?: unknown; failPost?: boolean; failGet?: boolean; status?: number }

/** 裸 fetch 替身：把 `RequestInit` 原样记下来，好让 `keepalive` 与队列时序可被逐字钉住。 */
export function server(options: Partial<ServerOptions> = {}): (input: string, init?: RequestInit) => Promise<Response> {
  const state = options.state ?? { success: true, history: [], preferences: null };
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    const calls = options.calls ?? [];
    const ops = options.ops ?? [];
    calls.push({ url: input, method, keepalive: init?.keepalive, body: typeof init?.body === 'string' ? init.body : null, authorization: new Headers(init?.headers).get('authorization') });
    ops.push(method === 'POST' ? 'post' : 'get');
    // 挂起时 WebView 被冻结：请求抛错而不是返回错误码，这才是 §3.1 说的"发不出去是常态"。
    if (method === 'POST' && options.failPost === true) throw new TypeError('fetch failed');
    if (method === 'GET' && options.failGet === true) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(state), { status: options.status ?? 200, headers: { 'Content-Type': 'application/json' } });
  };
}

export interface ServerFailure { failPost?: boolean; failGet?: boolean }

export interface Harness {
  sync: ReturnType<typeof createUserSync>; calls: Call[]; ops: string[]; notices: string[]; prefs: MemoryPrefs; history: HistoryStore & { rows: Map<string, WatchHistoryRow> };
}

export function harness(seed: WatchHistoryRow[] = [], state?: unknown, over: Partial<UserSyncDeps> & ServerFailure = {}): Harness {
  const calls: Call[] = [];
  const ops: string[] = [];
  const notices: string[] = [];
  const prefs = new MemoryPrefs(ops);
  const history = fakeHistory(seed);
  const { failPost, failGet, ...rest } = over;
  const sync = createUserSync({
    token: TOKEN, history, privateVault: createPrivateVault(), prefs,
    baseUrl: 'https://play.prismos.org', fetchImpl: server({ calls, ops, state, failPost, failGet }),
    nowSeconds: () => NOW, onNotice: (message) => notices.push(message),
    categoryOf: (contentId) => (contentId === 'c1' ? '都市' : '古装'),
    ...rest
  });
  return { sync, calls, ops, notices, prefs, history };
}

export const posted = (calls: Call[]): Call[] => calls.filter((call) => call.method === 'POST');
export const queuedOf = (prefs: MemoryPrefs, key: string): Array<{ key: string; payload: { history: { positionSeconds?: number; episodeNumber?: number } | null } }> =>
  JSON.parse(prefs.snapshot(key) ?? '[]') as Array<{ key: string; payload: { history: { positionSeconds?: number; episodeNumber?: number } | null } }>;
export const bodyOf = (call: Call | undefined): Record<string, unknown> => JSON.parse(call?.body ?? '{}') as Record<string, unknown>;
export const settle = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)); await Promise.resolve(); };
