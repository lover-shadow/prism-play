/**
 * 搜索视图（SPEC §7 / AC-16 / M-5：本期只有词法检索，界面也不得假装有别的能力）。
 *
 * 输入即防抖补全（≤10 条并标明命中类型），回车或点击才发整词检索，结果按 `matchType` 分组且每组都显示
 * 命中理由；`q > 80` 先在本地按契约拒绝（VALIDATION_ERROR / 400），既不截断也不发请求，服务端真返回 400
 * 时同样落到这条文案。输入法组合期间（compositionstart…compositionend）绝不发查询，否则拼音未上屏就乱搜。
 * 热词只由调用方注入，未注入就承认「暂无本地热词」，绝不凭空编造。
 *
 * 合规边界：本视图不写任何存储（无搜索历史落盘，AC-18 的私密零记录因此无从被违反）；结果只渲染公开条目
 * （`isPrivateSubject` 再挡一道），且从不把 `channelId` 写进 DOM——【个人探索】这个字不该出现在这里。
 * 共享 DOM / 五态基元来自 `history-view`（§10 单文件 ≤300 行的取舍）。
 */
import type { ContentItem, MatchType, SearchResponse, SearchSuggestionType, SuggestionsResponse } from '../../edge/src/types/api';
import { MATCH_TYPES } from '../../edge/src/types/api';
import { ApiError } from '../core/api/client';
import { isPrivateSubject } from '../core/storage/storage-domains';
import { attempt, band, button, coverInto, errorCopy, glyphInto, isNetworkError, make, readyBand, stateBand } from './history-view';
import './views.css';

export interface SearchApi {
  search(input: { q: string; channel?: string; tag?: string; page?: number; pageSize?: number }): Promise<SearchResponse>;
  suggestions(q: string): Promise<SuggestionsResponse>;
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
  /** 零结果与「返回视界」的去处：由宿主切到【大视界】对应频道/标签。 */
  onBrowse?: (target: BrowseTarget) => void;
  debounceMs?: number;
}
export interface SearchView {
  mount(): Promise<void>;
  /** 供宿主键盘快捷键聚焦输入框。 */
  focus(): void;
  destroy(): void;
}

const MAX_QUERY_LENGTH = 80;
const SUGGESTION_LIMIT = 10;
const NETWORK_COPY = '网络不可用：词法检索需联网，点播同样需联网；本机只留有公开目录与海报。';
const TOO_LONG_COPY = `查询词超过 ${MAX_QUERY_LENGTH} 字：按契约以 VALIDATION_ERROR（400）拒绝，未截断、未发送请求。`;
const IDLE_COPY = '输入剧名、别名、拼音首字母或关键词即可开始检索；本期为词法检索。';
/** 命中类型 → 界面理由文案（与闭集 enum 同构：新增类型会在编译期被要求补齐）。 */
const MATCH_LABEL: Readonly<Record<MatchType, string>> = {
  exact: '剧名精确命中', alias: '别名命中', pinyin: '拼音首字母或全拼命中', fuzzy: '模糊或纠错命中', related: '题材同类命中'
};
const SUGGESTION_LABEL: Readonly<Record<SearchSuggestionType, string>> = {
  title: '剧名', alias: '别名', pinyin: '拼音', category: '分类', correction: '纠错建议'
};

export function createSearchView(deps: SearchViewDeps): SearchView {
  const debounceMs = deps.debounceMs ?? 250;
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
  input.type = 'search';
  input.dataset.el = 'search-input';
  input.placeholder = '剧名 / 别名 / 拼音首字母';
  input.setAttribute('aria-label', '搜索关键词');
  input.setAttribute('autocomplete', 'off');
  glyphInto(heading, 'search', 20);
  const head = make('div', 'pv-head');
  head.append(heading, button('返回视界', () => void deps.onBrowse?.({}), { icon: 'arrowLeft', cls: 'pv-btn-ghost' }));
  form.append(input, button('搜索', () => void runSearch(), { icon: 'search', cls: 'pv-btn-primary', el: 'search-submit' }));
  deps.root.classList.add('pv-view', 'srch-view');
  deps.root.append(head, form, quick.wrap, suggest.wrap, results.wrap);
  suggest.wrap.hidden = true;

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
    stateBand(suggest, 'loading', '正在获取词法补全…');
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
      make('p', 'pv-state pv-state-empty', '没有找到匹配的公开剧目：可换个写法（别名、拼音首字母），或去【大视界】按频道与标签浏览。'),
      button('去【大视界】浏览', () => void deps.onBrowse?.({}), { icon: 'compass', cls: 'pv-btn-ghost', el: 'browse-fallback' })
    ];
    const words = hotWords();
    if (words.length > 0) nodes.push(make('p', 'pv-hint', '也可以试试这些公开热词或标签：'), wordChips('zero-word', words));
    results.body.replaceChildren(...nodes);
  }
  async function runSearch(): Promise<void> {
    if (disposed || composing) return;
    clearTimer();
    const query = currentQuery();
    const rejection = rejectLocalQuery(query);
    if (rejection !== null) {
      deps.root.dataset.state = 'disabled';
      return stateBand(results, 'disabled', rejection);
    }
    const ticket = ++generation;
    deps.root.dataset.state = 'loading';
    stateBand(results, 'loading', '正在检索公开目录…');
    const result = await attempt(() => deps.api.search({ q: query }));
    if (disposed || ticket !== generation) return;
    if (!result.ok) {
      const network = isNetworkError(result.error);
      const message = result.error instanceof ApiError && result.error.code === 'VALIDATION_ERROR' ? TOO_LONG_COPY : errorCopy(result.error, NETWORK_COPY);
      deps.root.dataset.state = network ? 'disabled' : 'error';
      return stateBand(results, network ? 'disabled' : 'error', message);
    }
    deps.root.dataset.state = 'ready';
    paintGroups(result.value.items.filter((entry) => !isPrivateSubject(entry.item)));
  }
  function onInput(): void {
    if (composing) return;
    const query = currentQuery();
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
      deps.root.dataset.state = 'empty';
      stateBand(results, 'empty', IDLE_COPY);
    },
    focus(): void { input.focus(); },
    destroy(): void {
      disposed = true;
      clearTimer();
      deps.root.replaceChildren();
      deps.root.classList.remove('pv-view', 'srch-view');
    }
  };
}
