/**
 * 搜索 Overlay：200ms 补全、输入法保护、80 字契约拒绝；热词仅由宿主注入。
 * 整词检索并行读取本机与联网首屏，各自20条分页；按内容ID合并，线上刷新元数据。
 * 状态与请求绑定查询代次；仅渲染公开条目，检索记录仅在内存，DOM不暴露频道ID。
 */
import type { ContentItem, MatchType, SearchResponse, SearchSuggestionType, SuggestionsResponse } from '../../edge/src/types/api';
import { MATCH_TYPES } from '../../edge/src/types/api';
import { ApiError } from '../core/api/client';
import { applySearchPage, createSearchPoll, type SearchInput, type SearchSource } from './search-poll';
import { attempt, band, button, coverInto, errorCopy, glyphInto, isNetworkError, make, readyBand, stateBand } from './history-view';
import { createRankingsRail } from './rankings-rail';
import { createSearchHistoryBand, createSearchHistoryLedger } from './search-history';
import './views.css';
import { groupSeries } from '../core/series'; import { createSeriesCard } from './series-card';
export interface SearchApi {
  search(input: SearchInput): Promise<SearchResponse>;
  suggestions(q: string): Promise<SuggestionsResponse>;
  localFirst?: boolean;
  searchOnline?(input: SearchInput): Promise<SearchResponse>;
}
export interface BrowseTarget {
  channel?: string;
  tag?: string;
}
export interface SearchViewDeps {
  api: SearchApi;
  root: HTMLElement;
  onOpenTitle(contentId: string, item?: ContentItem): void;
  hotWords?: string[];
  onBrowse?: (target: BrowseTarget) => void;
  localItems?: () => readonly ContentItem[];
  onClose?: () => void;
  debounceMs?: number;
}
export interface SearchView {
  mount(): Promise<void>;
  focus(): void;
  destroy(): void;
}
const MAX_QUERY_LENGTH = 80;
const SUGGESTION_LIMIT = 10;
const NETWORK_COPY = '网络不可用：词法检索需联网，点播同样需联网；本机只留有公开目录与海报。';
const TOO_LONG_COPY = `查询词超过 ${MAX_QUERY_LENGTH} 字：按契约以 VALIDATION_ERROR（400）拒绝，未截断、未发送请求。`;
const IDLE_COPY = '输入剧名、别名、拼音首字母或关键词即可开始检索；本期为词法检索。';
/** A-6：端侧索引命中失败是"本机目录里没有"，不是"检索失败"，两者文案必须分开。 */
const LOCAL_ZERO_COPY = '本机公开目录未命中：可换个写法（别名、拼音首字母），或回【精选】按频道与标签浏览。';
const PAGE_SIZE = 20;
type Source = SearchSource;
type Session = { ticket: number; query: string; sources: Source[] };
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
  let session: Session | null = null;
  const poll = createSearchPoll();
  const moreButton = button('加载更多', () => { if (session !== null) void loadPages(session); }, { el: 'search-more' });
  let mode: 'recommendations' | 'candidates' | 'results' = 'recommendations';
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
  head.append(heading, deps.onClose === undefined
    ? button('返回视界', () => void deps.onBrowse?.({}), { icon: 'arrowLeft', cls: 'pv-btn-ghost' })
    : button('关闭', () => deps.onClose?.(), { icon: 'close', cls: 'pv-btn-ghost', el: 'search-close' }));
  form.append(input, button('搜索', () => void runSearch(), { icon: 'search', cls: 'pv-btn-primary', el: 'search-submit' }));
  deps.root.classList.add('pv-view', 'srch-view');
  deps.root.append(head, form, suggest.wrap, results.wrap, quick.wrap, historyBand.wrap);
  suggest.wrap.hidden = results.wrap.hidden = true;
  results.wrap.tabIndex = -1;
  let rail: ReturnType<typeof createRankingsRail> | null = null;
  if (deps.localItems !== undefined) {
    const railHost = make('div', 'srch-rail-host');
    railHost.dataset.el = 'rank-host';
    deps.root.append(railHost);
    rail = createRankingsRail({ root: railHost, items: deps.localItems, onOpenTitle: deps.onOpenTitle });
    railHost.hidden = true;
  }
  function syncRail(next = mode): void {
    mode = next;
    quick.wrap.hidden = historyBand.wrap.hidden = mode !== 'recommendations';
    suggest.wrap.hidden = mode !== 'candidates';
    results.wrap.hidden = mode !== 'results';
    if (rail !== null && mode === 'recommendations') rail.refresh();
    const railHost = deps.root.querySelector<HTMLElement>('[data-el="rank-host"]');
    if (railHost !== null) railHost.hidden = mode !== 'recommendations';
  }
  const currentQuery = (): string => input.value.trim();
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
  function scheduleSuggestions(query: string): void {
    clearTimer();
    if (query === '') return hideSuggest(IDLE_COPY, 'empty');
    syncRail('candidates');
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
    const ticket = generation;
    if (disposed || mode !== 'candidates' || query !== currentQuery()) return;
    const result = await attempt(() => deps.api.suggestions(query));
    if (disposed || ticket !== generation || mode !== 'candidates' || query !== currentQuery()) return;
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
    const card = make('button', 'srch-result-card');
    const poster = make('span', 'srch-result-poster');
    card.type = 'button';
    card.dataset.el = 'result-card';
    card.dataset.contentId = item.id;
    card.setAttribute('aria-label', `${item.title}：${reason}`);
    coverInto(poster, item.coverUrl, item.title, 'image', 16);
    card.append(poster, make('span', 'srch-result-title', item.title), make('span', 'pv-meta', `${item.category} · ${reason}`));
    card.addEventListener('click', () => deps.onOpenTitle(item.id, item));
    return card;
  }
  function paintResults(active: Session): void {
    const focusedMore = document.activeElement === moreButton || document.activeElement === results.wrap;
    const merged = new Map<string, { entry: SearchResponse['items'][number]; local: boolean }>();
    for (const source of active.sources) {
      for (const entry of source.items) merged.set(entry.item.id, { entry, local: !source.online && deps.api.localFirst === true });
    }
    const groups: Node[] = [];
    const series = groupSeries([...merged.values()].map(({ entry }) => entry.item));
    const groupType = (group: typeof series[number]): MatchType => MATCH_TYPES.find((type) => group.items.some((item) => merged.get(item.id)?.entry.matchType === type)) ?? 'related';
    for (const type of MATCH_TYPES) {
      const selected = series.filter((group) => groupType(group) === type);
      const bucket = selected.flatMap((group) => group.items.map((item) => merged.get(item.id)!));
      if (bucket.length === 0) continue;
      const grid = make('div', 'srch-results-grid');
      grid.append(...selected.map((group) => createSeriesCard(group, (item) => {
        const local = merged.get(item.id)?.local, query = active.query.toLocaleLowerCase();
        const reason = type !== 'fuzzy' || !local ? MATCH_LABEL[type]
          : item.title.toLocaleLowerCase().includes(query) ? '剧名关键词命中'
          : item.synopsis?.toLocaleLowerCase().includes(query) ? '简介关键词命中' : '本机模糊命中';
        return resultCard(item, reason);
      }, deps.onOpenTitle)));
      const group = make('section', 'srch-group');
      group.dataset.matchType = type;
      group.append(make('h4', 'pv-band-note', `${type === 'fuzzy' && bucket.every((hit) => hit.local) ? '本机关键词或模糊命中' : MATCH_LABEL[type]}（${bucket.length}）`), grid);
      groups.push(group);
    }
    const busy = active.sources.some((source) => source.busy || source.pending);
    const failed = active.sources.find((source) => source.error !== '');
    const state = merged.size > 0 ? 'ready' : busy ? 'loading' : failed ? 'error' : 'empty';
    deps.root.dataset.state = results.wrap.dataset.state = state;
    const status = make('div', 'srch-status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    for (const source of active.sources) {
      const local = !source.online && deps.api.localFirst === true;
      const text = source.pending ? '联网发现仍在持续；已成功结果保留，可稍后重试继续。'
        : source.busy ? (local ? '正在检索本机公开目录…' : '联网补充中…')
        : source.error ? `${local ? '本机检索' : '联网补充'}失败：${source.error}；已成功结果保留。`
        : source.done && source.items.length === 0 ? (local ? LOCAL_ZERO_COPY : '联网目录未命中：可换个写法，或回【精选】浏览。') : '';
      if (text !== '') status.append(make('p', source.error ? 'pv-state pv-state-error' : 'pv-hint', text));
    }
    groups.push(status);
    if (merged.size === 0 && !busy) groups.push(button('回【精选】浏览', () => void deps.onBrowse?.({}), { icon: 'compass', cls: 'pv-btn-ghost', el: 'browse-fallback' }), wordChips('zero-word', hotWords()));
    const hasMore = active.sources.some((source) => source.more);
    moreButton.disabled = active.sources.some((source) => source.busy);
    moreButton.textContent = busy ? '正在加载…' : failed ? '重试 / 加载更多' : '加载更多';
    if (hasMore) groups.push(moreButton);
    results.body.replaceChildren(...groups);
    if (focusedMore) (hasMore && !busy ? moreButton : results.wrap).focus();
  }
  async function loadPages(active: Session, only?: Source): Promise<void> {
    if (disposed || active.ticket !== generation || (only ? only.busy : active.sources.some((source) => source.busy))) return;
    const pending = only ? [only] : active.sources.filter((source) => source.more);
    if (!only) for (const source of pending) source.polls = 0;
    for (const source of pending) { source.busy = true; source.error = ''; }
    paintResults(active);
    await Promise.all(pending.map(async (source) => {
      const input: SearchInput = { q: active.query, page: source.page, pageSize: PAGE_SIZE,
        ...(source.discoveryPage === undefined ? {} : { discoveryPage: source.discoveryPage }) };
      const result = await attempt(() => source.online ? deps.api.searchOnline!(input) : deps.api.search(input));
      if (disposed || active.ticket !== generation || active.query !== currentQuery()) return;
      source.busy = false;
      if (result.ok) {
        applySearchPage(source, result.value);
        poll.schedule(source, result.value, () => void loadPages(active, source));
      } else {
        source.error = result.error instanceof ApiError && result.error.code === 'VALIDATION_ERROR' ? TOO_LONG_COPY : errorCopy(result.error, NETWORK_COPY);
      }
      paintResults(active);
    }));
  }
  async function runSearch(): Promise<void> {
    if (disposed || composing) return;
    clearTimer(); poll.cancel();
    const ticket = ++generation;
    syncRail('results');
    const query = currentQuery();
    const rejection = rejectLocalQuery(query);
    if (rejection !== null) {
      deps.root.dataset.state = 'disabled';
      return stateBand(results, 'disabled', rejection);
    }
    historyLedger.note(query);
    historyBand.paint();
    const source = (online: boolean): Source => ({ online, page: 1, more: true, busy: false, done: false, error: '', items: [] });
    session = { ticket, query, sources: [source(false), ...(deps.api.searchOnline === undefined ? [] : [source(true)])] };
    await loadPages(session);
  }
  function onInput(): void {
    if (composing) return;
    const query = currentQuery();
    ++generation;
    clearTimer(); poll.cancel();
    syncRail(query === '' ? 'recommendations' : 'candidates');
    if (query === '') {
      hideSuggest(IDLE_COPY, 'empty');
      paintQuick();
      deps.root.dataset.state = 'empty';
      return stateBand(results, 'empty', IDLE_COPY);
    }
    scheduleSuggestions(query);
  }
  input.addEventListener('compositionstart', () => { composing = true; ++generation; clearTimer(); poll.cancel(); session = null; });
  input.addEventListener('compositionend', () => { composing = false; onInput(); });
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
      session = null;
      clearTimer(); poll.cancel();
      rail?.destroy();
      historyBand.destroy();
      deps.root.replaceChildren();
      deps.root.classList.remove('pv-view', 'srch-view');
    }
  };
}
