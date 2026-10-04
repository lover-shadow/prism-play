/**
 * 端云同步（SPEC §1.9）：字段映射集中于此，仅播放器离场与切后台触发，无轮询。
 * 待发队列写入沿用 assertWritable 私密闸门；窄 transport 使用同源 JWT 与 keepalive。
 * 云端不回传集 ID、剧名或封面：跨端集数由 player-host.episodeFor 识别，陌生剧目不虚构卡片。
 */
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { flushLineTelemetry } from './native/telemetry';
import { logger } from './diagnostics';
import type { SyncHistoryRow, TitleDetail, UserSyncHistoryInput, UserSyncPreferences, UserSyncRequest, UserSyncStateResponse } from '../../edge/src/types/api';
import type { FetchLike } from './api/client';
import type { PreferenceStore } from './state/theme';
import type { HistoryStore, WatchProgressInput } from './storage/history-store';
import type { PrivateVault } from './storage/private-vault';
import { assertWritable, isPrivateSubject, PrivateWriteBlockedError, type WatchHistoryRow, type WriteGuardSubject } from './storage/storage-domains';

export const USER_SYNC_PATH = '/api/user/sync';
/** 待发队列落在偏好域（`prism.` 前缀强制，与历史域同为备份白名单），键名即契约，换机续传靠它对账。 */
export const PENDING_QUEUE_KEY = 'prism.sync.pending';
/** 队列按剧目幂等覆盖，条数收敛在服务端 300s / 20 次的 POST 窗口内（`edge/src/core/constants.ts`）。 */
const PENDING_QUEUE_LIMIT = 12;
const REFUSED = '个人探索的断点不会离开本机：未落待发队列，也未向云端发出任何请求。', REPLAY = '离场同步未能送达（挂起时网络常被系统掐断）：已存入待发队列，下次启动自动补传。';

/* ==================== §1.9.2 字段映射唯一权威 ==================== */

/** 播放器与进度回调交给中枢的"刚离开的断点"，字段名走本地口径（`last_episode_number` 仍在本地侧）。 */
export interface ExitReport {
  contentId: string; episodeId: number; episodeNumber: number;
  positionSeconds: number; durationSeconds: number; isPrivate?: boolean; channelId?: string;
}

/** 本地秒是浮点，线上是整数：非有限值一律收敛到 0，绝不把 NaN 送进云端换一枚 400。 */
const whole = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);

/**
 * `last_episode_number → episodeNumber` 的改名只在这一处发生。云端 CHECK 要求集号为 ≥1 的整数，
 * 命名不了那集的断点（内核尚未定位到集）降级为"只交画像"，否则队列里会留下一条永远发不出去的毒载荷。
 */
export function wireHistoryOf(report: ExitReport): UserSyncHistoryInput | null {
  if (!Number.isInteger(report.episodeNumber) || report.episodeNumber < 1) return null;
  return { contentId: report.contentId, episodeNumber: report.episodeNumber, positionSeconds: whole(report.positionSeconds), durationSeconds: whole(report.durationSeconds) };
}

/**
 * 单端点提交：`history` 允许为 null（仅切后台、未在播放），`preferences` 恒在——400 不该来自本地偷懒。
 * 只保留有限且非负的打分（打分本身不取整，半衰期权重的小数是有效信息），`totalPlays` 按云端要求取整。
 */
export function wireRequest(history: UserSyncHistoryInput | null, preferences: UserSyncPreferences): UserSyncRequest {
  const genres: Record<string, number> = {};
  for (const [name, score] of Object.entries(preferences.genres)) if (Number.isFinite(score) && score >= 0) genres[name] = score;
  return { history, preferences: { genres, totalPlays: whole(preferences.totalPlays) } };
}

/** 播放宿主 `state()` 快照 ⇄ 离场断点：`detail` 供集数与私密出处，秒数取自内核当前值。 */
export function exitReportOf(detail: TitleDetail, state: { episodeId: number | null; positionSeconds: number; durationSeconds: number }): ExitReport {
  const episodeNumber = detail.episodes.find((entry) => entry.episodeId === state.episodeId)?.episodeNumber ?? 0;
  return { contentId: detail.item.id, episodeId: state.episodeId ?? 0, episodeNumber, positionSeconds: state.positionSeconds, durationSeconds: state.durationSeconds, isPrivate: detail.item.isPrivate === true, channelId: detail.item.channelId };
}

/** 本机断点行 + 进度上下文 ⇄ 离场断点（节点 ② 用的是它，而不是回头再问播放器）。 */
export function exitReportOfProgress(row: WatchHistoryRow, context: WriteGuardSubject): ExitReport {
  return { contentId: row.content_id, episodeId: row.last_episode_id, episodeNumber: row.last_episode_number, positionSeconds: row.position_seconds, durationSeconds: row.duration_seconds, isPrivate: context.isPrivate === true, channelId: context.channelId };
}

/**
 * 云端行 ⇄ 本地写入形状：`episodeNumber → last_episode_number`、`updatedAt → updated_at`。剧名/封面/集 ID
 * 只沿用本机已有行（云端不回传，凭空造卡就是虚假 UI）；私密出处由 `provenance` 供给，由 `upsertWatch` 闸门裁定。
 */
export function localInputOf(entry: SyncHistoryRow, mine: WatchHistoryRow, provenance: WriteGuardSubject = {}): WatchProgressInput {
  return {
    contentId: entry.contentId, title: mine.title, coverUrl: mine.cover_url, totalEpisodes: mine.total_episodes,
    lastEpisodeId: mine.last_episode_id, lastEpisodeNumber: entry.episodeNumber, updatedAt: entry.updatedAt,
    positionSeconds: entry.positionSeconds, durationSeconds: entry.durationSeconds,
    isPrivate: provenance.isPrivate === true, channelId: provenance.channelId
  };
}

/* ==================== 待发队列与响应形状 ==================== */

export interface PendingEntry { key: string; payload: UserSyncRequest; queuedAt: number }

const entryKey = (report: ExitReport | null): string => (report === null ? 'preferences' : report.contentId);

function isPendingEntry(value: unknown): value is PendingEntry {
  const entry = value as PendingEntry | undefined;
  return entry !== undefined && typeof entry.key === 'string' && typeof entry.payload === 'object' && entry.payload !== null;
}

/** 只承认 `UserSyncStateResponse` 的真实形状；不符一律按"云端没有数据"处理，绝不半信半疑地合并。 */
function parseState(text: string): UserSyncStateResponse | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  const state = parsed as Partial<UserSyncStateResponse> | null;
  if (state === null || typeof state !== 'object' || !Array.isArray(state.history)) return null;
  const rows = state.history.filter((row): row is SyncHistoryRow => typeof row?.contentId === 'string' && typeof row?.updatedAt === 'number');
  return { success: true, history: rows, preferences: state.preferences ?? null };
}

/* ==================== 中枢 ==================== */

export interface MergeReport {
  merged: number;            // 写入本机的条数：`updatedAt` 较新者生效，本机更新的一律不被覆盖
  unresolved: string[];      // 云端有、本机无元信息（或被闸门拒绝）的剧目：如实回报，不虚构历史卡
  rows: WatchHistoryRow[];   // 合并后的完整历史，视图直接呈现，不必再读一次库
}

export interface UserSyncDeps {
  // token：凭证域读出的 JWT，与 `client.setAuthorization()` 同源；null = 访客设备，纯本地运行。
  token: string | null;
  history: HistoryStore; privateVault: PrivateVault; prefs: PreferenceStore;
  baseUrl?: string; fetchImpl?: FetchLike; nowSeconds?: () => number;
  // categoryOf：分类标签的唯一合法来源（公开快照），缺失即不计入画像，绝不虚构分类。
  categoryOf?(contentId: string): string | null;
  // provenanceOf：私密性出处同样取自公开快照，本模块不自建第二套判定。
  provenanceOf?(contentId: string): WriteGuardSubject;
  preferencesOf?(): Promise<UserSyncPreferences> | UserSyncPreferences;  // WP6 打分模型注入位，缺席则按本地历史如实计数
  onNotice?(message: string): void;  // 闸门拒绝、落盘失败、请求被掐断都必须出声（AGENTS.md 禁止虚假 UI）
  replayOnStart?: boolean;       // 冷启动是否立即补传，默认 true
  isNativePlatform?(): boolean;  // 原生宿主判定，默认 `Capacitor.isNativePlatform()`：Web 构建下挂起监听退化为 no-op
}

export interface UserSyncService {
  onProgress(row: WatchHistoryRow, context: WriteGuardSubject): void;  // 落库路由（公开→历史域 / 私密→内存域）＋节点②载荷同源
  reportExit(report: ExitReport | null): Promise<boolean>;
  replayPending(): Promise<number>;
  pull(): Promise<MergeReport | null>;
  preferences(): UserSyncPreferences | null;  // 交还给推荐引擎的跨端偏好画像（§1.9.4 接口 B）
  lastBreakpoint(): ExitReport | null;
  observeBackground(onBackground: () => void): Promise<() => void>;  // 节点 ② 订阅口，非原生宿主为 no-op
  setToken(token: string | null): void;
  dispose(): void;
}

export function createUserSync(deps: UserSyncDeps): UserSyncService {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const now = deps.nowSeconds ?? ((): number => Math.floor(Date.now() / 1000));
  const target = `${(deps.baseUrl ?? '').replace(/\/$/, '')}${USER_SYNC_PATH}`;
  let token = deps.token;
  let disposed = false;
  let last: ExitReport | null = null;
  let remote: UserSyncPreferences | null = null;
  let releaseBackground: (() => void) | null = null;
  // 任何拉取都必须排在补传之后（§3.1）：反过来会让云端旧值盖住上一次没发出去的新断点。
  let drain: Promise<unknown> = Promise.resolve();

  const listHistory = async (): Promise<WatchHistoryRow[]> => { try { return await deps.history.listRecent(); } catch { return []; } }; // 库未就绪按"本机无历史"，不为此崩掉上报/拉取
  const headers = (extra?: Record<string, string>): Record<string, string> => {
    const built: Record<string, string> = { Accept: 'application/json', ...extra };
    if (token !== null) built.Authorization = `Bearer ${token}`;
    return built;
  };

  async function readQueue(): Promise<PendingEntry[]> {
    try {
      const raw = await deps.prefs.get(PENDING_QUEUE_KEY);
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(isPendingEntry) : [];
    } catch { return []; }
  }
  /** 队列是"先落盘再发"的那一半，写不进去必须出声：否则下次启动什么都没有，而用户以为同步成功了。 */
  async function writeQueue(entries: PendingEntry[]): Promise<void> {
    try { await deps.prefs.set(PENDING_QUEUE_KEY, JSON.stringify(entries)); } catch (error) {
      deps.onNotice?.(`待发队列未能落盘：${error instanceof Error ? error.message : '偏好域写入失败'}`);
    }
  }
  /** 同一剧目只留最新一条：补传旧断点会盖掉新进度，幂等窗口也因此被白白浪费。 */
  async function enqueue(key: string, payload: UserSyncRequest): Promise<void> {
    const kept = (await readQueue()).filter((entry) => entry.key !== key);
    await writeQueue([...kept.slice(Math.max(0, kept.length - PENDING_QUEUE_LIMIT + 1)), { key, payload, queuedAt: now() }]);
  }
  async function dequeue(key: string): Promise<void> {
    await writeQueue((await readQueue()).filter((entry) => entry.key !== key));
  }

  /** 本地偏好画像的默认口径：看过的部数 + 各分类出现次数，逐条可追溯，零虚构打分。 */
  async function localPreferences(): Promise<UserSyncPreferences> {
    if (deps.preferencesOf !== undefined) return await deps.preferencesOf();
    const genres: Record<string, number> = {};
    let totalPlays = 0;
    for (const row of await listHistory()) {
      totalPlays += 1;
      const category = deps.categoryOf?.(row.content_id) ?? null;
      if (category !== null && category.length >= 2) genres[category] = (genres[category] ?? 0) + 1;
    }
    return { genres, totalPlays };
  }

  /** `true` 只代表服务端应答成功；请求被冻结掐断或断网时按 §3.1 留队列并出声，不假装送达。 */
  async function post(payload: UserSyncRequest): Promise<boolean> {
    if (token === null) return false;
    try {
      // §3.1 硬要求：`keepalive` 让请求脱离页面生命周期，Android 冻结渲染进程时才可能跑完。
      const response = await fetchImpl(target, { method: 'POST', keepalive: true, headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(payload) });
      return response.ok;
    } catch { deps.onNotice?.(REPLAY); return false; }
  }

  async function reportExit(report: ExitReport | null): Promise<boolean> {
    void flushLineTelemetry(); if (disposed || token === null) return false; // A-8 搭车点：两个离场节点都汇聚到这里，队列空时它是纯 no-op
    const subject: WriteGuardSubject = { contentId: report?.contentId, isPrivate: report?.isPrivate, channelId: report?.channelId };
    try { assertWritable('user-sync.pending', subject); } catch (error) {
      // 闸门拒了就不落盘、更不发请求：私密断点的"零上报"到这一步才是可证的。
      deps.onNotice?.(error instanceof PrivateWriteBlockedError ? REFUSED : `待发队列写入失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    last = report ?? last;
    const payload = wireRequest(report === null ? null : wireHistoryOf(report), await localPreferences());
    const key = entryKey(report);
    await enqueue(key, payload);
    const delivered = await post(payload);
    if (delivered) await dequeue(key);
    return delivered;
  }

  async function replayPending(): Promise<number> {
    if (disposed || token === null) return 0;
    let resent = 0;
    for (const entry of await readQueue()) {
      if (!(await post(entry.payload))) break;  // 一次失败就把剩下的留给下次，别堵住用户切回前台的窗口
      await dequeue(entry.key);
      resent += 1;
    }
    return resent;
  }

  async function pull(): Promise<MergeReport | null> {
    if (disposed || token === null) return null;
    await drain;
    let state: UserSyncStateResponse | null = null;
    try {
      const response = await fetchImpl(target, { method: 'GET', headers: headers() });
      if (response.ok) state = parseState(await response.text());
    } catch { return null; }
    if (state === null) return null;
    if (state.preferences !== null) remote = state.preferences;
    const index = new Map((await listHistory()).map((row) => [row.content_id, row]));
    let merged = 0; const unresolved: string[] = [];
    for (const entry of state.history) {
      const mine = index.get(entry.contentId);
      // 本机没记过的剧目没有剧名/封面/集 ID 可写：硬做卡片就是虚构内容，只登记不合并。
      if (mine === undefined) { unresolved.push(entry.contentId); continue; }
      // 本机较新（或同刻）一律跳过：合并只取较新者，绝不盲覆盖。
      if (entry.updatedAt <= mine.updated_at) continue;
      try {
        await deps.history.upsertWatch(localInputOf(entry, mine, deps.provenanceOf?.(entry.contentId) ?? {}));
        merged += 1;
      } catch (error) {
        logger.error('history', 'upsert failed', error);
        unresolved.push(entry.contentId);
      }
    }
    return { merged, unresolved, rows: await listHistory() };
  }

  /** 节点 ②：与 `back-button.ts` 同款守卫——非原生宿主根本不注册，Web 构建零请求、零异常。A-8 的 flush 不在这里重复挂点（两个节点都汇聚到 `reportExit`）。 */
  async function observeBackground(onBackground: () => void): Promise<() => void> {
    if ((deps.isNativePlatform ?? ((): boolean => Capacitor.isNativePlatform()))() !== true) return () => undefined;
    try {
      const handle = await App.addListener('appStateChange', (event) => { if (event.isActive === false) onBackground(); });
      releaseBackground = () => void handle.remove();
    } catch { return () => undefined; }
    return () => { if (releaseBackground !== null) releaseBackground(); releaseBackground = null; };
  }

  const service: UserSyncService = {
    /** 落库路由的唯一咽喉点（M-8 第四域）：私密断点进内存域，公开断点过闸门进历史域。 */
    onProgress(row: WatchHistoryRow, context: WriteGuardSubject): void {
      if (isPrivateSubject(context)) {
        deps.privateVault.putBreakpoint(row);
        return;
      }
      const input: WatchProgressInput = {
        contentId: row.content_id, title: row.title, coverUrl: row.cover_url, updatedAt: row.updated_at,
        lastEpisodeId: row.last_episode_id, lastEpisodeNumber: row.last_episode_number, totalEpisodes: row.total_episodes,
        // 出处原样透传，不改口称"公开"：闸门判定为私密就物理拒写，调用方的说法不作数。
        isPrivate: context.isPrivate === true, channelId: context.channelId,
        positionSeconds: row.position_seconds, durationSeconds: row.duration_seconds
      };
      void deps.history.upsertWatch(input).catch((error: unknown) => {
        logger.error('history', 'upsert failed', error);
        deps.onNotice?.('历史写入失败，请查看诊断');
      });
      last = exitReportOfProgress(row, context);
    },
    reportExit, replayPending, pull, observeBackground,
    preferences: () => remote,
    lastBreakpoint: () => last,
    setToken(next: string | null) { token = next; },
    dispose() {
      disposed = true;
      if (releaseBackground !== null) releaseBackground();
      releaseBackground = null;
    }
  };

  if (deps.replayOnStart !== false) drain = replayPending();
  return service;
}
