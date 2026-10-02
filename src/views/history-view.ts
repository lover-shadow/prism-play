/**
 * 【追剧】主 Tab（SPEC §7 / AC-03 / AC-18 / Master 决策 M-8）。
 *
 * 四条带自上而下：正在追（秒级断点 + 一键续播）→ 同类好剧（`api.related` 召回、与历史去重、永不含私密）
 * → 往期完播 → 公开缓存行（used/limit 字节 + 清理缓存）。清理只允许命中 `public-cache` 域，
 * `PRESERVED_BY_CLEAR_CACHE` 的凭证与历史域必须原样存活：实现方越界即显示 error，绝不假装成功。
 * 本视图不写任何存储域，历史 / 缓存 / 凭证实现全部由集成时注入（见下方窄接口）。
 *
 * §10 限定单文件 ≤300 行，而本工作包只允许这三个 `.ts` 视图文件，所以「共享视图基元」（无业务语义的
 * DOM / 格式化 / 五态工具）就近落在此处供另两个视图复用；新增 `src/views/dom.ts` 后整节迁出即可。
 */
import { icon, type IconName, type IconSize } from '../components/icons';
import { ApiError } from '../core/api/client';
import type { ContentItem, DeviceTier, RelatedResponse } from '../../edge/src/types/api';
import { CLEARED_BY_CLEAR_CACHE, POSTER_CACHE_LIMIT_BYTES, PRESERVED_BY_CLEAR_CACHE, isPrivateSubject, type StorageDomain, type WatchHistoryRow } from '../core/storage/storage-domains';
import './views.css';

/* ==================== 共享视图基元（三视图复用） ==================== */
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
/** 封面只接受同源代理相对路径或 https，其它 scheme 退化为图标（顺带杜绝外部站源域名入 DOM）。 */
export function coverInto(node: HTMLElement, url: string | null | undefined, alt: string, fallback: IconName, size: IconSize): void {
  const usable = typeof url === 'string' && (url.startsWith('/') || url.startsWith('https://')) ? url : null;
  if (usable === null) return glyphInto(node, fallback, size);
  const img = make('img');
  img.src = usable; img.alt = alt; img.loading = 'lazy';
  node.append(img);
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

/* ==================== 追剧视图 ==================== */
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
  api: HistoryApi; history: HistoryReader; cache: CacheUsage; credentials: CredentialWriter;
  onOpenTitle(contentId: string): void; onResume(row: WatchHistoryRow): void; root: HTMLElement;
  /** 注入时钟（Unix 秒），使秒级断点与相对时间文案可测。 */ now?(): number;
}
export interface HistoryView { mount(): Promise<void>; reload(): Promise<void>; destroy(): void; }

const FINISH_TOLERANCE_SECONDS = 5;
const RELATED_SEED_LIMIT = 2;
const RELATED_RAIL_LIMIT = 12;
const NETWORK_COPY = '网络不可用：公开快照与海报仍可浏览，点播需联网后重新解析取流地址。';
const OFFLINE_COPY = '点播需联网：本机缓存只加速公开目录与海报浏览，不替代联网取流。';
const DOMAIN_LABEL: Readonly<Record<StorageDomain, string>> = {
  credentials: '授权凭证', history: '追剧历史', 'public-cache': '公开缓存', 'private-volatile': '个人探索内存'
};
const PRESERVED_LABELS = PRESERVED_BY_CLEAR_CACHE.map((domain) => DOMAIN_LABEL[domain]).join('、');

function formatClock(totalSeconds: number): string {
  const value = Math.max(0, Math.floor(totalSeconds));
  const pad = (n: number): string => String(n).padStart(2, '0');
  const hours = Math.floor(value / 3600);
  return hours > 0 ? `${hours}:${pad(Math.floor((value % 3600) / 60))}:${pad(value % 60)}` : `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}
function formatWatchedAt(unixSeconds: number, nowSeconds: number): string {
  const days = Math.floor((nowSeconds - unixSeconds) / 86400);
  if (days < 1) return '今天';
  if (days === 1) return '昨天';
  return days < 30 ? `${days} 天前` : new Date(unixSeconds * 1000).toLocaleDateString('zh-CN');
}
/** 完播判定：已到末集且断点距片尾 ≤5 秒（契约只有秒级断点，没有服务端完播标记）。 */
function isFinished(row: WatchHistoryRow): boolean {
  const lastEpisode = row.total_episodes !== null && row.last_episode_number >= row.total_episodes;
  const nearEnd = row.duration_seconds > 0 && row.position_seconds >= row.duration_seconds - FINISH_TOLERANCE_SECONDS;
  return lastEpisode && nearEnd;
}

export function createHistoryView(deps: HistoryViewDeps): HistoryView {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  let disposed = false;
  // 骨架在构造期建好：`reload()` 可能先于 `mount()` 被调用，视图在生命周期内独占 root。
  const resume = band('正在追', 'band-resume', '自动记录秒级进度');
  const related = band('同类好剧', 'band-related', '依你看过的公开剧目召回');
  const finished = band('往期完播', 'band-finished');
  const cache = band('本地公开缓存', 'band-cache');
  const grantNote = make('p', 'pv-note', '授权状态待读取。');
  const offlineNote = make('p', 'pv-note', OFFLINE_COPY);
  const heading = make('h2', 'pv-head-title', '正在追与历史');
  grantNote.dataset.el = 'grant-note';
  offlineNote.dataset.el = 'offline-note';
  glyphInto(heading, 'history', 20);
  const head = make('div', 'pv-head');
  head.append(heading, button('清空历史', () => void clearHistory(), { icon: 'trash', cls: 'pv-btn-ghost', el: 'clear-history' }));
  deps.root.classList.add('pv-view', 'hist-view');
  deps.root.append(head, resume.wrap, related.wrap, finished.wrap, cache.wrap, grantNote, offlineNote);

  async function paintCache(clearedBytes?: number): Promise<void> {
    if (disposed) return;
    stateBand(cache, 'loading', '正在统计公开缓存占用…');
    const result = await attempt(() => deps.cache.measure());
    if (disposed) return;
    if (!result.ok) return stateBand(cache, 'error', errorCopy(result.error, NETWORK_COPY));
    const hint = `已用 ${formatBytes(result.value.usedBytes)}（${result.value.usedBytes} 字节）/ 上限 ${formatBytes(result.value.limitBytes)}（${result.value.limitBytes} 字节），海报配额 ${formatBytes(POSTER_CACHE_LIMIT_BYTES)}`;
    const line = rowLine('cache-metric', '公开目录与海报缓存', hint, [button('清理缓存', () => void clearPublicCache(), { icon: 'trash', cls: 'pv-btn-ghost', el: 'clear-cache' })]);
    line.dataset.usedBytes = String(result.value.usedBytes); line.dataset.limitBytes = String(result.value.limitBytes);
    const nodes: Node[] = [line];
    if (clearedBytes !== undefined) nodes.push(make('p', 'pv-state pv-state-ready', `已清理 ${formatBytes(clearedBytes)}（仅公开缓存域）；${PRESERVED_LABELS} 不受影响。`));
    readyBand(cache, nodes);
  }
  async function clearPublicCache(): Promise<void> {
    if (disposed) return;
    stateBand(cache, 'loading', '正在清理公开缓存…');
    const result = await attempt(() => deps.cache.clearPublicCache());
    if (disposed) return;
    if (!result.ok) return stateBand(cache, 'error', errorCopy(result.error, NETWORK_COPY));
    const overreach = result.value.domains.filter((domain) => !(CLEARED_BY_CLEAR_CACHE as readonly string[]).includes(domain));
    if (overreach.length > 0) return stateBand(cache, 'error', `清理越界：${overreach.map((domain) => DOMAIN_LABEL[domain]).join('、')} 是必须保留域（${PRESERVED_LABELS}），已拒绝显示为成功。`);
    await paintCache(result.value.clearedBytes);
  }

  function resumeCard(row: WatchHistoryRow): HTMLElement {
    const card = make('div', 'pv-card');
    const thumb = make('div', 'pv-card-thumb');
    const body = make('div', 'pv-card-body');
    const track = make('div', 'pv-progress');
    const fill = make('div', 'pv-progress-fill');
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
    tap(card, () => deps.onResume(row));
    return card;
  }

  function railCard(item: ContentItem): HTMLElement {
    const card = make('button', 'pv-rail-card');
    const poster = make('span', 'pv-rail-poster');
    card.type = 'button'; card.dataset.el = 'related-card'; card.dataset.contentId = item.id;
    coverInto(poster, item.coverUrl, item.title, 'image', 16);
    card.append(poster, make('span', 'pv-rail-label', item.title), make('span', 'pv-meta', item.category));
    card.addEventListener('click', () => deps.onOpenTitle(item.id));
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

  async function reload(): Promise<void> {
    if (disposed) return;
    deps.root.dataset.state = 'loading';
    stateBand(resume, 'loading', '正在读取本机追剧记录…');
    stateBand(finished, 'loading', '正在整理往期完播…');
    if (deps.history.available !== undefined && !(await deps.history.available())) {
      deps.root.dataset.state = 'disabled';
      stateBand(resume, 'disabled', '本机历史库尚未就绪，追剧记录暂时不可用。');
      stateBand(finished, 'disabled', '本机历史库尚未就绪。');
      await paintCache();
      return stateBand(related, 'disabled', '无历史记录时不启动同类召回。');
    }
    const [history, grant] = await Promise.all([attempt(() => deps.history.list()), attempt(() => deps.credentials.readGrant()), paintCache()]);
    if (disposed) return;
    if (!history.ok) {
      deps.root.dataset.state = 'error';
      stateBand(resume, 'error', errorCopy(history.error, NETWORK_COPY));
      offlineNote.textContent = isNetworkError(history.error) ? NETWORK_COPY : OFFLINE_COPY;
      return;
    }
    const rows = history.value, watching = rows.filter((row) => !isFinished(row)), completed = rows.filter(isFinished);
    deps.root.dataset.state = rows.length === 0 ? 'empty' : 'ready';
    if (watching.length === 0) stateBand(resume, 'empty', '还没有在追的剧，去大视界挑一部就能自动记住断点。');
    else readyBand(resume, watching.map((row) => resumeCard(row)));
    if (completed.length === 0) stateBand(finished, 'empty', '看完的剧会归档到这里。');
    else readyBand(finished, completed.map((row) => rowLine('finished-row', row.title, `已看完全集（第 ${row.last_episode_number} 集）· ${formatWatchedAt(row.updated_at, now())}`, [
      button('重温', () => deps.onResume({ ...row, position_seconds: 0 }), { icon: 'refresh', cls: 'pv-btn-ghost' }),
      button('详情', () => deps.onOpenTitle(row.content_id), { icon: 'chevronRight', cls: 'pv-btn-ghost' })
    ])));
    grantNote.textContent = !grant.ok ? `授权状态暂时无法读取：${errorCopy(grant.error, NETWORK_COPY)}`
      : grant.value === null ? '本机暂无授权凭证记录：公开目录可浏览，点播需联网核销后取流。'
        : '本机授权凭证可离线验证，但断网时点播仍需联网重新取流。';
    await paintRelated(rows);
  }

  async function clearHistory(): Promise<void> {
    if (disposed) return;
    stateBand(finished, 'loading', '正在清空本机历史…');
    const result = await attempt(() => deps.history.clear());
    if (!result.ok) stateBand(finished, 'error', errorCopy(result.error, NETWORK_COPY));
    await reload();
  }

  return {
    async mount(): Promise<void> { await reload(); },
    reload,
    destroy(): void { disposed = true; deps.root.replaceChildren(); deps.root.classList.remove('pv-view', 'hist-view'); }
  };
}
