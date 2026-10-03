/**
 * 搜索视图（SPEC §7 / AC-16 / M-5 + SPEC-APP-REFACTOR A-3：全屏 Overlay 的内容主体）。
 *
 * 输入即防抖补全（**200ms**，≤10 条并标明命中类型），回车或点击才发整词检索，结果按 `matchType` 分组且
 * 每组都显示命中理由；`q > 80` 先在本地按契约拒绝（VALIDATION_ERROR / 400），既不截断也不发请求，服务端真
 * 返回 400 时同样落到这条文案。输入法组合期间（compositionstart…compositionend）绝不发查询，否则拼音未
 * 上屏就乱搜。热词只由调用方注入，未注入就承认「暂无本地热词」，绝不凭空编造。
 *
 * A-3 定案：搜索不再是底部 Tab，而是首页搜索条拉起的全屏 Overlay。Overlay 自上而下＝输入框 → 本次会话检索
 * 记录 → 端侧榜单专区（`rankings-rail.ts`，零网络）→ 补全 → 结果。榜单只读注入的本地快照，断网也出得来。
 *
 * A-6 定案：数据源换成端侧 SQLite FTS5——本视图不知道也不该知道数据来自哪张表，它只认 `api`。注入的门面把
 * `localFirst` 置真，本机命中与本机没命中才不会被说成"需联网"；`searchOnline` 存在时才给「联网补充检索」
 * 那颗按钮，且必须由用户点下去才发请求。没接索引的宿主（Web 构建）拿到的还是原样的云端门面，一条文案都不必改。
 *
 * 合规边界：本视图不写任何存储——检索记录只住内存（`search-history.ts`，冷启动即清空），结果只渲染公开条目
 * （`isPrivateSubject` 再挡一道），且从不把 `channelId` 写进 DOM——【个人探索】这个字不该出现在这里。
 * 共享 DOM / 五态基元来自 `history-view`（§10 单文件 ≤300 行的取舍）。
 */
import type { ContentItem, MatchType, SearchResponse, SearchSuggestionType, SuggestionsResponse } from '../../edge/src/types/api';
import { MATCH_TYPES } from '../../edge/src/types/api';
import { ApiError } from '../core/api/client';
import { isPrivateSubject } from '../core/storage/storage-domains';
import { attempt, band, button, coverInto, errorCopy, glyphInto, isNetworkError, make, readyBand, stateBand } from './history-view';
import { createRankingsRail } from './rankings-rail';
import { createSearchHistoryBand, createSearchHistoryLedger } from './search-history';
import './views.css';

export interface SearchApi {
  search(input: { q: string; channel?: string; tag?: string; page?: number; pageSize?: number }): Promise<SearchResponse>;
  suggestions(q: string): Promise<SuggestionsResponse>;
  /** A-6：端侧 FTS5 门面把这里置 true——视图据此不再宣称"检索需联网"，零结果也只提示可联网补充。 */
  localFirst?: boolean;
  /** 显式「联网补充检索」的真实落点：宿主没接云端就不渲染这颗按钮，不留假开关。 */
  searchOnline?(input: { q: string; channel?: string; tag?: string; page?: number; pageSize?: number }): Promise<SearchResponse>;
}
export interface BrowseTarget {
  channel?: string;
  tag?: string;
}
export interface SearchViewDeps {
  api: SearchApi;
  root: HTMLElement;
  onOpenTitle(contentId: string): void;
  /** 本地公开热词：只接受调用方注入，本视图不生成、不缓存、不落盘。 */
  hotWords?: string[];
  /** 零结果与「返回视界」的去处：由宿主切到【精选】对应频道/标签。 */
  onBrowse?: (target: BrowseTarget) => void;
  /** 端侧榜单数据源（本机公开快照）；未注入即整块榜单区不渲染，不做空壳榜单。 */
  localItems?: () => readonly ContentItem[];
  /** Overlay 的关闭动作：未注入（仍当普通视图用）时保留「返回视界」口径。 */
  onClose?: () => void;
  debounceMs?: number;
}
export interface SearchView {
  mount(): Promise<void>;
  /** 供宿主键盘快捷键与 Overlay 打开动画聚焦输入框。 */
  focus(): void;
  destroy(): void;
}

const MAX_QUERY_LENGTH = 80;
const SUGGESTION_LIMIT = 10;
const NETWORK_COPY = '网络不可用：词法检索需联网，点播同样需联网；本机只留有公开目录与海报。';
const TOO_LONG_COPY = `查询词超过 ${MAX_QUERY_LENGTH} 字：按契约以 VALIDATION_ERROR（400）拒绝，未截断、未发送请求。`;
const IDLE_COPY = '输入剧名、别名、拼音首字母或关键词即可开始检索；本期为词法检索。';
/** A-6：端侧索引命中失败是"本机目录里没有"，不是"检索失败"，两者文案必须分开。 */
const LOCAL_ZERO_COPY = '本机公开目录未命中：可换个写法（别名、拼音首字母），或回【精选】按频道与标签浏览。联网补充需手动点击，本机不会自动发出请求。';
/** 命中类型 → 界面理由文案（与闭集 enum 同构：新增类型会在编译期被要求补齐）。 */
const MATCH_LABEL: Readonly<Record<MatchType, string>> = {
  exact: '剧名精确命中', alias: '别名命中', pinyin: '拼音首字母或全拼命中', fuzzy: '模糊或纠错命中', related: '题材同类命中'
};
const SUGGESTION_LABEL: Readonly<Record<SearchSuggestionType, string>> = {
  title: '剧名', alias: '别名', pinyin: '拼音', category: '分类', correction: '纠错建议'
};

export function createSearchView(deps: SearchViewDeps): SearchView {
  const debounceMs = deps.debounceMs ?? 200;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let composing = false;
  let disposed = false;
  let generation = 0;
  const quick = band('猜你想搜', 'search-hot', '本地公开热词，只来自调用方注入');
  const suggest = band('补全建议', 'search-suggest');
  const results = band('搜索结果', 'search-results');
  const heading = make('h2', 'pv-head-title', '搜索');
  const input = make('input', 'pv-input');
  const form = make('form', 'pv-field');
  const historyLedger = createSearchHistoryLedger();
  const historyBand = createSearchHistoryBand(historyLedger, (word) => {
    input.value = word;
    void runSearch();
  });
  input.type = 'search';
  input.dataset.el = 'search-input';
  input.placeholder = '剧名 / 别名 / 拼音首字母';
  input.setAttribute('aria-label', '搜索关键词');
  input.setAttribute('autocomplete', 'off');
  glyphInto(heading, 'search', 20);
  const head = make('div', 'pv-head');
  // Overlay 形态给「关闭」，普通视图形态保留「返回视界」：两种宿主都不留无处可去的死屏。
  head.append(heading, deps.onClose === undefined
    ? button('返回视界', () => void deps.onBrowse?.({}), { icon: 'arrowLeft', cls: 'pv-btn-ghost' })
    : button('关闭', () => deps.onClose?.(), { icon: 'close', cls: 'pv-btn-ghost', el: 'search-close' }));
  form.append(input, button('搜索', () => void runSearch(), { icon: 'search', cls: 'pv-btn-primary', el: 'search-submit' }));
  deps.root.classList.add('pv-view', 'srch-view');
  deps.root.append(head, form, quick.wrap, historyBand.wrap, suggest.wrap, results.wrap);
  suggest.wrap.hidden = true;

  // 榜单区：有本地快照读面才存在（AC-A3-3 断网可用就建立在这块完全不联网的前提上）。
  let rail: ReturnType<typeof createRankingsRail> | null = null;
  if (deps.localItems !== undefined) {
    const railHost = make('div', 'srch-rail-host');
    railHost.dataset.el = 'rank-host';
    deps.root.insertBefore(railHost, suggest.wrap);
    rail = createRankingsRail({ root: railHost, items: deps.localItems, onOpenTitle: (contentId) => deps.onOpenTitle(contentId) });
    railHost.hidden = true;
  }
  /** 空输入时把榜单区亮出来（Overlay 默认态 = 记录 + 三榜），一旦有词就让位给补全与结果。 */
  function syncRail(): void {
    if (rail !== null) rail.refresh();
    const railHost = deps.root.querySelector<HTMLElement>('[data-el="rank-host"]');
    if (railHost !== null) railHost.hidden = currentQuery() !== '';
  }

  const currentQuery = (): string => input.value.trim();
  /** 空白词只承认「还没输入」；超长词按契约本地拒绝——两者都不发请求，也都不截断输入。 */
  function rejectLocalQuery(query: string): string | null {
    if (query.length === 0) return '请输入剧名、别名或拼音首字母后再检索（未发送任何请求）。';
    return query.length > MAX_QUERY_LENGTH ? TOO_LONG_COPY : null;
  }
  function wordChips(dataEl: string, words: string[]): HTMLElement {
    const chips = make('div', 'pv-chip-row');
    chips.append(...words.map((word) => button(word, () => { input.value = word; void runSearch(); }, { cls: 'pv-chip', el: dataEl })));
    return chips;
  }
  function hotWords(): string[] {
    return (deps.hotWords ?? []).map((word) => word.trim()).filter((word) => word !== '').slice(0, SUGGESTION_LIMIT);
  }
  function paintQuick(): void {
    const words = hotWords();
    if (words.length === 0) return stateBand(quick, 'empty', '暂无本地公开热词：可直接输入关键词检索。');
    readyBand(quick, [wordChips('hot-word', words), make('p', 'pv-hint', IDLE_COPY)]);
  }
  function clearTimer(): void {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  }
  function showSuggest(): void {
    suggest.wrap.hidden = false;
    if (!deps.root.contains(suggest.wrap)) quick.wrap.after(suggest.wrap);
  }
  function scheduleSuggestions(query: string): void {
    clearTimer();
    if (query === '') return hideSuggest(IDLE_COPY, 'empty');
    showSuggest();
    if (query.length > MAX_QUERY_LENGTH) return stateBand(suggest, 'error', TOO_LONG_COPY);
    stateBand(suggest, 'loading', deps.api.localFirst === true ? '正在本机目录中补全…' : '正在获取词法补全…');
    timer = setTimeout(() => {
      timer = null;
      void paintSuggestions(query);
    }, debounceMs);
  }
  function hideSuggest(text: string, state: 'empty' | 'error' | 'disabled'): void {
    suggest.wrap.hidden = true;
    stateBand(suggest, state, text);
  }
  async function paintSuggestions(query: string): Promise<void> {
    if (disposed || query !== currentQuery()) return;
    const result = await attempt(() => deps.api.suggestions(query));
    if (disposed || query !== currentQuery()) return;
    if (!result.ok) return stateBand(suggest, isNetworkError(result.error) ? 'disabled' : 'error', errorCopy(result.error, NETWORK_COPY));
    const entries = result.value.suggestions.slice(0, SUGGESTION_LIMIT);
    if (entries.length === 0) return stateBand(suggest, 'empty', '没有匹配的补全项，可直接回车整词检索。');
    const list = make('div', 'srch-suggest');
    list.append(...entries.map((entry) => {
      const item = button(entry.text, () => { input.value = entry.text; void runSearch(); }, { cls: 'srch-suggest-item', el: 'suggest-item' });
      item.dataset.suggestType = entry.type;
      item.append(make('span', 'pv-badge', SUGGESTION_LABEL[entry.type]));
      return item;
    }));
    readyBand(suggest, [list, make('p', 'pv-hint', `最多显示 ${SUGGESTION_LIMIT} 条公开词法补全。`)]);
  }
  function resultCard(item: ContentItem, reason: string): HTMLElement {
    const card = make('button', 'pv-rail-card');
    const poster = make('span', 'pv-rail-poster');
    card.type = 'button';
    card.dataset.el = 'result-card';
    card.dataset.contentId = item.id;
    card.setAttribute('aria-label', `${item.title}：${reason}`);
    coverInto(poster, item.coverUrl, item.title, 'image', 16);
    card.append(poster, make('span', 'pv-rail-label', item.title), make('span', 'pv-meta', `${item.category} · ${reason}`));
    card.addEventListener('click', () => deps.onOpenTitle(item.id));
    return card;
  }
  /** 按 matchType 分组；同名异剧各自保留（绝不按标题去重，AC-16 末条）。 */
  function paintGroups(items: SearchResponse['items']): void {
    const groups: Node[] = [];
    for (const type of MATCH_TYPES) {
      const bucket = items.filter((entry) => entry.matchType === type);
      if (bucket.length === 0) continue;
      const row = make('div', 'pv-rail');
      row.append(...bucket.map((entry) => resultCard(entry.item, MATCH_LABEL[entry.matchType])));
      const group = make('section', 'srch-group');
      group.dataset.matchType = type;
      group.append(make('h4', 'pv-band-note', `${MATCH_LABEL[type]}（${bucket.length}）`), row);
      groups.push(group);
    }
    if (groups.length === 0) return paintZeroResult();
    readyBand(results, groups);
  }
  function paintZeroResult(): void {
    results.wrap.dataset.state = 'empty';
    deps.root.dataset.state = 'empty';
    const nodes: Node[] = [
      make('p', 'pv-state pv-state-empty', deps.api.localFirst === true ? LOCAL_ZERO_COPY : '没有找到匹配的公开剧目：可换个写法（别名、拼音首字母），或回【精选】按频道与标签浏览。'),
      button('回【精选】浏览', () => void deps.onBrowse?.({}), { icon: 'compass', cls: 'pv-btn-ghost', el: 'browse-fallback' })
    ];
    // 联网补充只在宿主真的接了云端时才出现，且由用户点下去才发请求（A-6：本地未命中默认不发请求）。
    if (deps.api.localFirst === true && deps.api.searchOnline !== undefined) {
      nodes.push(button('联网补充检索', () => void runSearch(true), { icon: 'signal', cls: 'pv-btn-ghost', el: 'search-online' }));
    }
    const words = hotWords();
    if (words.length > 0) nodes.push(make('p', 'pv-hint', '也可以试试这些公开热词或标签：'), wordChips('zero-word', words));
    results.body.replaceChildren(...nodes);
  }
  /** 本机索引与显式联网补充共用同一条落图路径：错误口径与私密剔除因此只写一次。 */
  async function finishSearch(ticket: number, task: () => Promise<SearchResponse>): Promise<void> {
    const result = await attempt(task);
    if (disposed || ticket !== generation) return;
    syncRail();
    if (!result.ok) {
      const network = isNetworkError(result.error);
      const message = result.error instanceof ApiError && result.error.code === 'VALIDATION_ERROR' ? TOO_LONG_COPY : errorCopy(result.error, NETWORK_COPY);
      deps.root.dataset.state = network ? 'disabled' : 'error';
      return stateBand(results, network ? 'disabled' : 'error', message);
    }
    deps.root.dataset.state = 'ready';
    paintGroups(result.value.items.filter((entry) => !isPrivateSubject(entry.item)));
  }
  async function runSearch(online = false): Promise<void> {
    if (disposed || composing) return;
    clearTimer();
    const query = currentQuery();
    const rejection = rejectLocalQuery(query);
    if (rejection !== null) {
      deps.root.dataset.state = 'disabled';
      syncRail();
      return stateBand(results, 'disabled', rejection);
    }
    const task = (): Promise<SearchResponse> => online === true && deps.api.searchOnline !== undefined
      ? deps.api.searchOnline({ q: query })
      : deps.api.search({ q: query });
    const ticket = ++generation;
    // 只有真的发出去的检索才进本次会话记录：本地拒绝的词一个都不记。
    historyLedger.note(query);
    historyBand.paint();
    deps.root.dataset.state = 'loading';
    stateBand(results, 'loading', online === true ? '正在向云端目录补充检索…' : deps.api.localFirst === true ? '正在检索本机公开目录…' : '正在检索公开目录…');
    await finishSearch(ticket, task);
  }
  function onInput(): void {
    if (composing) return;
    const query = currentQuery();
    syncRail();
    if (query === '') {
      hideSuggest(IDLE_COPY, 'empty');
      paintQuick();
      deps.root.dataset.state = 'empty';
      return stateBand(results, 'empty', IDLE_COPY);
    }
    scheduleSuggestions(query);
  }
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; scheduleSuggestions(currentQuery()); });
  input.addEventListener('input', onInput);
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void runSearch(); } });
  form.addEventListener('submit', (event) => { event.preventDefault(); void runSearch(); });

  return {
    async mount(): Promise<void> {
      paintQuick();
      historyBand.paint();
      deps.root.dataset.state = 'empty';
      stateBand(results, 'empty', IDLE_COPY);
      syncRail();
    },
    focus(): void { input.focus(); },
    destroy(): void {
      disposed = true;
      clearTimer();
      rail?.destroy();
      historyBand.destroy();
      deps.root.replaceChildren();
      deps.root.classList.remove('pv-view', 'srch-view');
    }
  };
}
