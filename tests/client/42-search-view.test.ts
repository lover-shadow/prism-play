// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSearchView, type BrowseTarget, type SearchApi, type SearchViewDeps } from '../../src/views/search-view';
import { ApiError } from '../../src/core/api/client';
import type { ContentItem, SearchResponse, SearchResult, SearchSuggestion } from '../../edge/src/types/api';

/** M-5：本期没有任何大模型能力，界面也不得假装有。四个中文禁词以码位转义写入正则，否则扫描器会把断言
 *  自身当成业务文案命中 M-5（转义后仍匹配同样的字面）。 */
const M5_WORDS = /\bAI\b|\u667a\u80fd|\u8bed\u4e49|\u5411\u91cf|\u5927\u6a21\u578b|semantic|embedding/i;
/** 断网文案里不能出现的「离线可播」类承诺。 */
const OFFLINE_PROMISES = ['无需联网', '不用联网', '离线播放', '离线观看', '断网可播', '免流量'];

function itemOf(id: string, overrides: Partial<ContentItem> = {}): ContentItem {
  return { id, channelId: 'drama', title: `剧目 ${id}`, category: '战神', isPrivate: false, coverUrl: `/proxy/image/${id}`, ...overrides };
}
interface Options {
  hotWords?: string[]; suggestions?: SearchSuggestion[]; results?: SearchResult[];
  suggestionsError?: unknown; searchError?: unknown; debounceMs?: number;
}
function setup(options: Options = {}) {
  const calls = { search: [] as Array<{ q: string }>, suggestions: [] as string[], opened: [] as string[], browse: [] as BrowseTarget[] };
  const api = {
    search: async (input: { q: string }): Promise<SearchResponse> => {
      calls.search.push(input);
      if (options.searchError !== undefined) throw options.searchError;
      return { items: options.results ?? [], page: 1 };
    },
    suggestions: async (q: string) => {
      calls.suggestions.push(q);
      if (options.suggestionsError !== undefined) throw options.suggestionsError;
      return { query: q, suggestions: options.suggestions ?? [] };
    },
    channels: async () => { throw new Error('搜索视图不该读频道拓扑'); }
  } as unknown as SearchApi;
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const deps: SearchViewDeps = {
    api, root,
    onOpenTitle: (contentId) => void calls.opened.push(contentId),
    onBrowse: (target) => void calls.browse.push(target),
    debounceMs: options.debounceMs ?? 200
  };
  if ('hotWords' in options) deps.hotWords = options.hotWords;
  const view = createSearchView(deps);
  return { view, root, calls };
}
const pick = (root: HTMLElement, el: string): HTMLElement | null => root.querySelector(`[data-el="${el}"]`);
const stateOf = (root: HTMLElement, el: string): string | undefined => pick(root, el)?.getAttribute('data-state') ?? undefined;
const inputOf = (root: HTMLElement): HTMLInputElement => pick(root, 'search-input') as HTMLInputElement;
const composition = (root: HTMLElement, kind: string): void => { inputOf(root).dispatchEvent(new CompositionEvent(kind, { bubbles: true, data: 'zhan' })); };
const fireInput = async (root: HTMLElement, value: string, ms = 260): Promise<void> => {
  inputOf(root).value = value;
  inputOf(root).dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(ms);
};
const submit = async (root: HTMLElement, ms = 0): Promise<void> => {
  (pick(root, 'search-submit') as HTMLElement).click();
  await vi.advanceTimersByTimeAsync(ms);
};

describe('搜索视图：空态与热词（AC-16）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('热词只来自注入列表，点击即整词检索', async () => {
    const { view, root, calls } = setup({ hotWords: ['战神之龙王归来', ' 甜宠小娘子 ', ''] });
    await view.mount();
    expect(stateOf(root, 'search-hot')).toBe('ready');
    const chips = [...root.querySelectorAll('[data-el="hot-word"]')];
    expect(chips.map((chip) => chip.textContent)).toEqual(['战神之龙王归来', '甜宠小娘子']);
    (chips[1] as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.search).toEqual([{ q: '甜宠小娘子' }]);
  });

  it('没有注入热词时承认没有，且不编造任何词条', async () => {
    const { view, root } = setup({ hotWords: [] });
    await view.mount();
    expect(stateOf(root, 'search-hot')).toBe('empty');
    expect(root.querySelectorAll('[data-el="hot-word"]').length).toBe(0);
    expect(pick(root, 'search-hot')?.textContent).toContain('暂无本地公开热词');
    const bare = setup();
    await bare.view.mount();
    expect(bare.root.querySelectorAll('[data-el="hot-word"]').length).toBe(0);
  });

  it('空输入与超长输入都不发请求，输入框不被截断', async () => {
    const { view, root, calls } = setup();
    await view.mount();
    await submit(root);
    expect(calls.search).toEqual([]);
    expect(stateOf(root, 'search-results')).toBe('disabled');
    const tooLong = '龙'.repeat(81);
    await fireInput(root, tooLong);
    expect(calls.suggestions).toEqual([]);
    expect(calls.search).toEqual([]);
    await submit(root);
    expect(calls.search).toEqual([]);
    expect(inputOf(root).value).toBe(tooLong);
    expect(stateOf(root, 'search-results')).toBe('disabled');
    expect(root.textContent).toContain('80');
    expect(root.textContent).toContain('VALIDATION_ERROR');
  });
});

describe('搜索视图：输入法组合与防抖补全（AC-16）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('组合期间绝不发查询，compositionend 之后才补全', async () => {
    const { view, root, calls } = setup({ suggestions: [{ text: '战神之龙王归来', type: 'title' }] });
    await view.mount();
    composition(root, 'compositionstart');
    await fireInput(root, 'zhan shen', 0);
    inputOf(root).dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.suggestions).toEqual([]);
    await submit(root, 2_000);
    expect(calls.search).toEqual([]);
    composition(root, 'compositionend');
    await vi.advanceTimersByTimeAsync(300);
    expect(calls.suggestions).toEqual(['zhan shen']);
  });

  it('补全按防抖窗口只发一次，并以 trim 后的词查询', async () => {
    const { view, root, calls } = setup();
    await view.mount();
    inputOf(root).value = '战神';
    inputOf(root).dispatchEvent(new Event('input', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(100);
    expect(calls.suggestions).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls.suggestions).toEqual(['战神']);
    await fireInput(root, '  战神之  ');
    expect(calls.suggestions).toEqual(['战神', '战神之']);
  });

  it('补全最多十条且每条标明命中类型', async () => {
    const many = Array.from({ length: 12 }, (_, index): SearchSuggestion => ({ text: `候选 ${index}`, type: 'title' }));
    const { view, root } = setup({ suggestions: many });
    await view.mount();
    await fireInput(root, '候');
    const items = [...root.querySelectorAll('[data-el="suggest-item"]')];
    expect(items.length).toBe(10);
    expect(items[0].getAttribute('data-suggest-type')).toBe('title');
    expect(items[0].textContent).toContain('剧名');
    expect(pick(root, 'search-suggest')?.textContent).toContain('最多显示 10 条');
  });

  it('类型标签逐一对应，纠错与拼音不混为一谈', async () => {
    const mixed: SearchSuggestion[] = [
      { text: '战神之龙王归来', type: 'title' }, { text: '龙王归来', type: 'alias' },
      { text: 'zsldlgl', type: 'pinyin' }, { text: '战神', type: 'category' }, { text: '战神之龙亡归来', type: 'correction' }
    ];
    const { view, root } = setup({ suggestions: mixed });
    await view.mount();
    await fireInput(root, 'zs');
    expect(root.querySelectorAll('[data-suggest-type]').length).toBe(5);
    const labels = mixed.map((entry) => ({ title: '剧名', alias: '别名', pinyin: '拼音', category: '分类', correction: '纠错建议' })[entry.type]);
    for (const label of labels) expect(pick(root, 'search-suggest')?.textContent).toContain(label);
  });

  it('补全为空显示 empty，网络失败进入 disabled 并提示需联网', async () => {
    const empty = setup({ suggestions: [] });
    await empty.view.mount();
    await fireInput(empty.root, '无此词');
    expect(stateOf(empty.root, 'search-suggest')).toBe('empty');
    const offline = setup({ suggestionsError: new ApiError('NETWORK_ERROR', 0, '网络不可用') });
    await offline.view.mount();
    await fireInput(offline.root, '战神');
    expect(stateOf(offline.root, 'search-suggest')).toBe('disabled');
    expect(offline.root.textContent).toContain('需联网');
    for (const promise of OFFLINE_PROMISES) expect(offline.root.textContent ?? '').not.toContain(promise);
  });
});

describe('搜索视图：结果分组与合规边界（AC-16 / AC-02 / M-5）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('按 matchType 分组并显示命中理由，同名异剧各自保留', async () => {
    const results: SearchResult[] = [
      { item: itemOf('d_a', { title: '战神之龙王归来' }), matchType: 'exact' },
      { item: itemOf('m_a', { title: '战神之龙王归来', channelId: 'movie' }), matchType: 'exact' },
      { item: itemOf('d_b'), matchType: 'alias' },
      { item: itemOf('d_c'), matchType: 'pinyin' },
      { item: itemOf('d_d'), matchType: 'fuzzy' },
      { item: itemOf('d_e'), matchType: 'related' }
    ];
    const { view, root, calls } = setup({ results });
    await view.mount();
    await fireInput(root, '战神');
    (pick(root, 'search-input') as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.advanceTimersByTimeAsync(0);
    expect(stateOf(root, 'search-results')).toBe('ready');
    const groups = [...root.querySelectorAll('[data-match-type]')];
    expect(groups.map((node) => node.getAttribute('data-match-type'))).toEqual(['exact', 'alias', 'pinyin', 'fuzzy', 'related']);
    expect(groups[0].querySelectorAll('[data-el="result-card"]').length).toBe(2);
    expect(root.textContent).toContain('剧名精确命中');
    expect(root.textContent).toContain('拼音首字母或全拼命中');
    expect(root.textContent).toContain('模糊或纠错命中');
    expect(root.textContent).toContain('题材同类命中');
    const cards = [...root.querySelectorAll('[data-el="result-card"]')];
    cards[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(calls.opened).toEqual(['d_a']);
  });

  it('服务端返回 400 时按契约文案显示，不静默截断', async () => {
    const { view, root, calls } = setup({ searchError: new ApiError('VALIDATION_ERROR', 400, 'q 超长') });
    await view.mount();
    await fireInput(root, '战神');
    await submit(root);
    expect(calls.search).toEqual([{ q: '战神' }]);
    expect(stateOf(root, 'search-results')).toBe('error');
    expect(root.textContent).toContain('VALIDATION_ERROR（400）');
    const rate = setup({ searchError: new ApiError('RATE_LIMITED', 429, '频繁') });
    await rate.view.mount();
    await fireInput(rate.root, '战神');
    await submit(rate.root);
    expect(stateOf(rate.root, 'search-results')).toBe('error');
  });

  it('零结果给出频道/标签去处与可点的公开热词', async () => {
    const { view, root, calls } = setup({ results: [], hotWords: ['甜宠'] });
    await view.mount();
    await fireInput(root, '不存在词');
    await submit(root);
    expect(stateOf(root, 'search-results')).toBe('empty');
    expect(root.dataset.state).toBe('empty');
    expect(root.textContent).toContain('大视界');
    (pick(root, 'browse-fallback') as HTMLElement).click();
    expect(calls.browse).toEqual([{}]);
    (root.querySelector('[data-el="zero-word"]') as HTMLElement).click();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.search).toEqual([{ q: '不存在词' }, { q: '甜宠' }]);
  });

  it('公开结果渲染时 DOM 内不出现任何私密字样，混入的私密条目也被丢弃', async () => {
    const publicOnly = setup({ results: [{ item: itemOf('d_public'), matchType: 'exact' }] });
    await publicOnly.view.mount();
    await fireInput(publicOnly.root, '战神');
    await submit(publicOnly.root);
    const html = publicOnly.root.innerHTML;
    expect(html).not.toContain('private');
    expect(html).not.toContain('个人探索');
    expect(html.toLowerCase()).not.toContain('私密');
    expect(publicOnly.root.querySelectorAll('[data-el="result-card"]').length).toBe(1);

    const polluted = setup({ results: [
      { item: itemOf('d_public'), matchType: 'exact' },
      { item: itemOf('p_secret', { channelId: 'private', isPrivate: true, title: '深夜私语的秘密' }), matchType: 'fuzzy' }
    ] });
    await polluted.view.mount();
    await fireInput(polluted.root, '战神');
    await submit(polluted.root);
    expect(polluted.root.innerHTML).not.toContain('p_secret');
    expect(polluted.root.innerHTML).not.toContain('深夜私语的秘密');
    expect(polluted.root.querySelectorAll('[data-el="result-card"]').length).toBe(1);
  });

  it('界面没有任何大模型暗示，loading 与 destroy 边界正确', async () => {
    const { view, root, calls } = setup({ results: [{ item: itemOf('d_a'), matchType: 'exact' }] });
    await view.mount();
    expect(root.textContent ?? '').not.toMatch(M5_WORDS);
    await fireInput(root, '战神');
    (pick(root, 'search-submit') as HTMLElement).click();
    expect(stateOf(root, 'search-results')).toBe('loading');
    expect(root.dataset.state).toBe('loading');
    await vi.advanceTimersByTimeAsync(0);
    expect(root.dataset.state).toBe('ready');
    inputOf(root).value = '再看一次';
    inputOf(root).dispatchEvent(new Event('input', { bubbles: true }));
    view.destroy();
    expect(root.children.length).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.suggestions).toEqual(['战神']);
    expect(calls.search).toEqual([{ q: '战神' }]);
  });
});
