/**
 * 【追剧】主 Tab（SPEC §7 / AC-03 / AC-18 / Master 决策 M-8）。
 *
 * 四条带自上而下：正在追（秒级断点 + 一键续播）→ 同类好剧（`api.related` 召回、与历史去重、永不含私密）
 * → 往期完播。缓存管理归「我的」，本页不读写缓存。
 * 用户收藏意图通过可选 following 注入，与自动断点独立；清空历史绝不删除收藏。
 * 首屏正在追最多两张，展开区域独立滚动，不让长历史挤走推荐。
 *
 */
import { icon, type IconName, type IconSize } from '../components/icons';
import { coverInto } from '../components/poster-cover';
export { coverInto } from '../components/poster-cover';
import { ApiError } from '../core/api/client';
import type { ContentItem, DeviceTier, RelatedResponse } from '../../edge/src/types/api';
import { isPrivateSubject, type StorageDomain, type WatchHistoryRow } from '../core/storage/storage-domains';
import type { FollowingRow, FollowingStore } from '../core/storage/following-store';
import { isFinished as finishedByHistoryDomain } from '../core/storage/history-store';
import { formatBeijingDate } from '../core/time-format';
import type { MergeReport } from '../core/user-sync';
import './views.css';
import './history.css';

export type ViewState = 'loading' | 'empty' | 'error' | 'ready' | 'disabled';
export interface Band { wrap: HTMLElement; head: HTMLElement; body: HTMLElement; }
export type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown };
export function make<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function glyphInto(node: HTMLElement, name: IconName, size: IconSize): void { node.innerHTML = icon(name, { size }); }
export function button(label: string, onClick: () => void, opts: { icon?: IconName; cls?: string; el?: string; size?: IconSize } = {}): HTMLButtonElement {
  const node = make('button', `pv-btn ${opts.cls ?? ''}`.trim());
  node.type = 'button';
  if (opts.el !== undefined) node.dataset.el = opts.el;
  if (opts.icon !== undefined) glyphInto(node, opts.icon, opts.size ?? 16);
  node.append(make('span', 'pv-btn-label', label));
  node.addEventListener('click', onClick);
  return node;
}
/** 卡片整体可点，卡内按钮自理：一次手势只触发一次回调。 */
export function tap(node: HTMLElement, action: () => void): void {
  node.addEventListener('click', (event) => { if ((event.target as Element).closest('button') === null) action(); });
}
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}
export async function attempt<T>(run: () => Promise<T>): Promise<Attempt<T>> {
  try { return { ok: true, value: await run() }; } catch (error) { return { ok: false, error }; }
}
export function isNetworkError(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'NETWORK_ERROR';
}
/** 网络失败一律换成调用方的「需联网」口径；其余透传契约文案，不改写也不吞掉。 */
export function errorCopy(error: unknown, networkCopy: string): string {
  if (isNetworkError(error)) return networkCopy;
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? `操作失败：${error.message}` : '操作失败，请稍后重试';
}
export function band(title: string, dataEl: string, note?: string): Band {
  const wrap = make('section', 'pv-band');
  const head = make('div', 'pv-band-head');
  const body = make('div', 'pv-band-body');
  wrap.dataset.el = dataEl;
  head.append(make('h3', 'pv-band-title', title));
  if (note !== undefined) head.append(make('span', 'pv-band-note', note));
  wrap.append(head, body);
  return { wrap, head, body };
}
export function stateBand(target: Band, state: ViewState, text: string): void {
  target.wrap.dataset.state = state;
  target.body.replaceChildren(make('p', `pv-state pv-state-${state}`, text));
}
export function readyBand(target: Band, nodes: Node[]): void {
  target.wrap.dataset.state = 'ready';
  target.body.replaceChildren(...nodes);
}
export function rowLine(dataEl: string, title: string, hint: string, actions: Node[]): HTMLElement {
  const line = make('div', 'pv-row');
  const text = make('div', 'pv-row-text');
  const slot = make('div', 'pv-row-actions');
  text.append(make('div', 'pv-card-title', title), make('div', 'pv-hint', hint));
  slot.append(...actions);
  line.dataset.el = dataEl;
  line.append(text, slot);
  return line;
}

export interface HistoryReader {
  /** false = 端侧 SQLite 尚未就绪：整视图进入 disabled，不渲染空壳卡。 */
  available?(): Promise<boolean>;
  list(): Promise<WatchHistoryRow[]>;
  clear(): Promise<void>;
}
export interface CacheMeasurement { usedBytes: number; limitBytes: number; }
export interface ClearCacheOutcome {
  clearedBytes: number;
  /** 实现方必须如实回报本次真正清空的域；越界即被本视图拒绝并按 error 显示。 */
  domains: StorageDomain[];
}
export interface CacheUsage { measure(): Promise<CacheMeasurement>; clearPublicCache(): Promise<ClearCacheOutcome>; }
export interface CredentialGrant { tier: DeviceTier; /** Unix 秒；-1 = 永久（仅 S 档）。 */ expiresAt: number; }
/** 只读授权状态；`clearGrant` 存在只为让「清缓存绝不碰凭证」可被测试证伪。 */
export interface CredentialWriter { readGrant(): Promise<CredentialGrant | null>; clearGrant(): Promise<void>; }
export interface HistoryApi { related(contentId: string): Promise<RelatedResponse>; }
export interface HistoryViewDeps {
  api: HistoryApi; history: HistoryReader; cache?: CacheUsage; credentials: CredentialWriter;
  following?: Pick<FollowingStore, 'list' | 'remove'>;
  onOpenTitle(contentId: string, item?: ContentItem): void; onResume(row: WatchHistoryRow): void; root: HTMLElement;
  /** 注入时钟（Unix 秒），使秒级断点与相对时间文案可测。 */ now?(): number;
  /** AC-30 拉取口（§1.9.4 接口 B）：进入本 Tab 即静默合并云端断点；缺席时视图纯本地照常工作。 */ pullRemote?(): Promise<MergeReport | null>;
}
export interface HistoryView { mount(): Promise<void>; reload(): Promise<void>; destroy(): void; }

const RELATED_SEED_LIMIT = 2;
const RELATED_RAIL_LIMIT = 12;
const NETWORK_COPY = '网络不可用：公开快照与海报仍可浏览，点播需联网后重新解析取流地址。';
const OFFLINE_COPY = '点播需联网：本机缓存只加速公开目录与海报浏览，不替代联网取流。';
const FIRST_SCREEN_LIMIT = 2;

/** 秒级断点的 `mm:ss` / `h:mm:ss` 呈现口径由本视图钉住（`40-history-view` 有逐字断言），不与合作包的组件级格式化器共用。 */
function formatClock(totalSeconds: number): string {
  const value = Math.max(0, Math.floor(totalSeconds));
  const pad = (n: number): string => String(n).padStart(2, '0');
  const hours = Math.floor(value / 3600);
  return hours > 0 ? `${hours}:${pad(Math.floor((value % 3600) / 60))}:${pad(value % 60)}` : `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}
function formatWatchedAt(unixSeconds: number, nowSeconds: number): string {
  const days = Math.floor((nowSeconds - unixSeconds) / 86400);
  if (days >= 30) return formatBeijingDate(unixSeconds);
  return days < 1 ? '今天' : days === 1 ? '昨天' : `${days} 天前`;
}
/** 完播判定：已到末集，且断点距片尾的秒窗复用历史域权威实现（同一常量、同一口径，不在此处复制）。 */
function isFinished(row: WatchHistoryRow): boolean {
  const lastEpisode = row.total_episodes !== null && row.last_episode_number >= row.total_episodes;
  return lastEpisode && finishedByHistoryDomain(row);
}

export function createHistoryView(deps: HistoryViewDeps): HistoryView {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  let disposed = false, expanded = false;
  let saved: FollowingRow[] = [];
  // 骨架在构造期建好：reload 可能先于 mount。
  const resume = band('正在追', 'band-resume', '收藏与自动秒级断点'), related = band('同类好剧', 'band-related', '依你看过的公开剧目召回');
  const finished = band('往期完播', 'band-finished');
  const grantNote = make('p', 'pv-note', '授权状态待读取。'), offlineNote = make('p', 'pv-note', OFFLINE_COPY);
  grantNote.dataset.el = 'grant-note'; offlineNote.dataset.el = 'offline-note';
  const heading = make('h2', 'pv-head-title', '正在追与历史');
  glyphInto(heading, 'history', 20);
  const head = make('div', 'pv-head');
  head.append(heading, button('清空历史', () => void clearHistory(), { icon: 'trash', cls: 'pv-btn-ghost', el: 'clear-history' }));
  deps.root.classList.add('pv-view', 'hist-view');
  deps.root.append(head, resume.wrap, related.wrap, finished.wrap, grantNote, offlineNote);

  async function removeFollowing(id: string): Promise<void> {
    if (disposed || !deps.following) return;
    const result = await attempt(() => deps.following!.remove(id));
    if (disposed) return;
    if (!result.ok) { stateBand(resume, 'error', errorCopy(result.error, NETWORK_COPY)); return; }
    await reload();
  }
  function followingCard(row: FollowingRow): HTMLElement {
    const card = rowLine('following-card', row.title, '已收藏 · 尚无观看断点', [
      button('详情', () => deps.onOpenTitle(row.content_id), { icon: 'chevronRight' }),
      button('取消追剧', () => void removeFollowing(row.content_id), { icon: 'trash', el: 'remove-following' })
    ]);
    card.dataset.contentId = row.content_id;
    tap(card, () => deps.onOpenTitle(row.content_id));
    return card;
  }
  function paintWatching(rows: WatchHistoryRow[]): void {
    const watching = rows.filter(row => !isFinished(row));
    const ids = new Set(rows.map(row => row.content_id));
    const cards = [...watching.map(resumeCard), ...saved.filter(row => !ids.has(row.content_id)).map(followingCard)];
    resume.body.classList.toggle('hist-expanded', expanded);
    if (cards.length === 0) return stateBand(resume, 'empty', '还没有在追的剧，去大视界挑一部就能自动记住断点。');
    const visible = expanded ? cards : cards.slice(0, FIRST_SCREEN_LIMIT);
    if (cards.length > FIRST_SCREEN_LIMIT) visible.push(button(expanded ? '收起' : `展开全部（${cards.length}）`, () => {
      expanded = !expanded; paintWatching(rows);
    }, { el: 'expand-watching' }));
    readyBand(resume, visible);
  }

  function resumeCard(row: WatchHistoryRow): HTMLElement {
    const card = make('div', 'pv-card'), thumb = make('div', 'pv-card-thumb'), body = make('div', 'pv-card-body');
    const track = make('div', 'pv-progress'), fill = make('div', 'pv-progress-fill');
    const remaining = Math.max(0, Math.round(row.duration_seconds - row.position_seconds));
    const percent = row.duration_seconds > 0 ? Math.min(100, Math.max(0, (row.position_seconds / row.duration_seconds) * 100)) : 0;
    card.dataset.el = 'resume-card'; card.dataset.contentId = row.content_id;
    fill.style.width = `${percent.toFixed(1)}%`; track.append(fill);
    coverInto(thumb, row.cover_url, row.title, 'play', 20);
    body.append(
      make('div', 'pv-card-title', row.title),
      make('div', 'pv-meta', `第 ${row.last_episode_number} 集 · 看到 ${formatClock(row.position_seconds)} / ${formatClock(row.duration_seconds)}`),
      make('div', 'pv-hint', `剩余 ${remaining} 秒 · ${formatWatchedAt(row.updated_at, now())}观看`),
      track
    );
    card.append(thumb, body, button('续播', () => deps.onResume(row), { icon: 'play', cls: 'pv-btn-primary', el: 'resume-button' }));
    if (saved.some(item => item.content_id === row.content_id)) card.append(button('取消追剧', () => void removeFollowing(row.content_id), { icon: 'trash', el: 'remove-following' }));
    tap(card, () => deps.onResume(row));
    return card;
  }

  function railCard(item: ContentItem): HTMLElement {
    const card = make('button', 'pv-rail-card');
    const poster = make('span', 'pv-rail-poster');
    card.type = 'button'; card.dataset.el = 'related-card'; card.dataset.contentId = item.id;
    coverInto(poster, item.coverUrl, item.title, 'image', 16);
    card.append(poster, make('span', 'pv-rail-label', item.title), make('span', 'pv-meta', item.category));
    card.addEventListener('click', () => deps.onOpenTitle(item.id, item));
    return card;
  }

  async function paintRelated(rows: WatchHistoryRow[]): Promise<void> {
    if (disposed) return;
    if (rows.length === 0) return stateBand(related, 'empty', '看完第一部剧后，这里会出现同类好剧。');
    stateBand(related, 'loading', '正在召回同类好剧…');
    const seen = new Set(rows.map((row) => row.content_id));
    const items: ContentItem[] = [];
    let failures = 0;
    const seeds = rows.slice(0, RELATED_SEED_LIMIT).map((row) => row.content_id);
    const results = await Promise.all(seeds.map((seed) => attempt(() => deps.api.related(seed))));
    for (const result of results) {
      if (!result.ok) { failures += 1; continue; }
      for (const item of result.value.items) {
        if (isPrivateSubject(item) || seen.has(item.id)) continue;
        seen.add(item.id);
        items.push(item);
      }
      if (items.length >= RELATED_RAIL_LIMIT) break;
    }
    if (items.length === 0) return stateBand(related, failures > 0 ? 'error' : 'empty', failures > 0 ? NETWORK_COPY : '同类题材暂时没有可推荐的公开剧目。');
    const rail = make('div', 'pv-rail');
    rail.dataset.el = 'related-rail';
    rail.append(...items.slice(0, RELATED_RAIL_LIMIT).map((item) => railCard(item)));
    readyBand(related, [rail]);
  }

  /** AC-30 静默合并：不阻塞本地视图；合并口径归 user-sync。 */
  async function pullQuietly(): Promise<void> {
    const result = deps.pullRemote === undefined ? null : await attempt(deps.pullRemote);
    if (disposed || result === null || !result.ok || result.value === null || result.value.merged === 0) return;
    paintWatching(result.value.rows);
  }

  async function reload(): Promise<void> {
    if (disposed) return;
    deps.root.dataset.state = 'loading';
    stateBand(resume, 'loading', '正在读取本机追剧记录…'); stateBand(finished, 'loading', '正在整理往期完播…');
    if (deps.history.available !== undefined && !(await deps.history.available())) {
      deps.root.dataset.state = 'disabled';
      stateBand(resume, 'disabled', '本机历史库尚未就绪，追剧记录暂时不可用。');
      stateBand(finished, 'disabled', '本机历史库尚未就绪。');
      return stateBand(related, 'disabled', '无历史记录时不启动同类召回。');
    }
    const [history, grant, following] = await Promise.all([attempt(() => deps.history.list()), attempt(() => deps.credentials.readGrant()),
      attempt(() => deps.following?.list() ?? Promise.resolve([]))]);
    if (disposed) return;
    if (!history.ok) {
      deps.root.dataset.state = 'error';
      stateBand(resume, 'error', errorCopy(history.error, NETWORK_COPY));
      offlineNote.textContent = isNetworkError(history.error) ? NETWORK_COPY : OFFLINE_COPY;
      return;
    }
    const rows = history.value, completed = rows.filter(isFinished);
    saved = following.ok ? following.value : [];
    deps.root.dataset.state = !following.ok ? 'error' : rows.length + saved.length === 0 ? 'empty' : 'ready';
    if (!following.ok) stateBand(resume, 'error', errorCopy(following.error, NETWORK_COPY));
    else paintWatching(rows);
    if (completed.length === 0) stateBand(finished, 'empty', '看完的剧会归档到这里。');
    else readyBand(finished, completed.map((row) => rowLine('finished-row', row.title, `已看完全集（第 ${row.last_episode_number} 集）· ${formatWatchedAt(row.updated_at, now())}`, [
      button('重温', () => deps.onResume({ ...row, position_seconds: 0 }), { icon: 'refresh', cls: 'pv-btn-ghost' }),
      button('详情', () => deps.onOpenTitle(row.content_id), { icon: 'chevronRight', cls: 'pv-btn-ghost' })
    ])));
    grantNote.textContent = !grant.ok ? `授权状态暂时无法读取：${errorCopy(grant.error, NETWORK_COPY)}`
      : grant.value === null ? '本机暂无授权凭证记录：公开目录可浏览，点播需联网核销后取流。'
        : '本机授权凭证可离线验证，但断网时点播仍需联网重新取流。';
    await paintRelated(rows); if (following.ok) void pullQuietly();
  }

  async function clearHistory(): Promise<void> {
    if (disposed) return;
    stateBand(finished, 'loading', '正在清空本机历史…');
    const result = await attempt(() => deps.history.clear());
    if (disposed) return;
    if (!result.ok) { stateBand(finished, 'error', errorCopy(result.error, NETWORK_COPY)); return; }
    await reload();
  }

  /** `mount` 与 `reload` 同径：Shell 只在首次进入调 mount，之后每次进入调 reload，两条路都必须带上静默拉取。 */
  return { mount: reload, reload, destroy(): void { disposed = true; deps.root.replaceChildren(); deps.root.classList.remove('pv-view', 'hist-view'); } };
}
