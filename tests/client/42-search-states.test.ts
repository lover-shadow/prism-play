// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const css = readFileSync(resolve(process.cwd(), 'src/views/views.css'), 'utf8');
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSearchView } from '../../src/views/search-view';
import type { SearchResponse, SuggestionsResponse } from '../../edge/src/types/api';

function setup() {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const api = {
    search: vi.fn(async (): Promise<SearchResponse> => ({ items: [], page: 1 })),
    suggestions: vi.fn(async (query: string): Promise<SuggestionsResponse> => ({
      query, suggestions: [{ text: '战神归来', type: 'title' }]
    }))
  };
  const view = createSearchView({ root, api, hotWords: ['战神'], localItems: () => [], onOpenTitle: () => undefined });
  const pick = (el: string) => root.querySelector<HTMLElement>(`[data-el="${el}"]`)!;
  const input = pick('search-input') as HTMLInputElement;
  const type = (word: string) => { input.value = word; input.dispatchEvent(new Event('input', { bubbles: true })); };
  const visible = () => [...root.children].filter((node) => !(node as HTMLElement).hidden);
  return { root, api, view, pick, input, type, visible };
}

describe('搜索视图：输入框下三态回归', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('空输入只显示推荐，输入立即让位给紧随表单的候选，清空恢复推荐', async () => {
    const { view, api, pick, type, visible, input } = setup();
    await view.mount();
    expect(visible().slice(2)).toEqual([pick('search-hot'), pick('search-history'), pick('rank-host')]);
    type('战');
    expect(input.closest('form')?.nextElementSibling).toBe(pick('search-suggest'));
    expect(visible().slice(2)).toEqual([pick('search-suggest')]);
    await vi.advanceTimersByTimeAsync(199);
    expect(api.suggestions).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(api.suggestions.mock.calls).toEqual([['战']]);
    expect(api.search).not.toHaveBeenCalled();
    type('   ');
    expect(visible().slice(2)).toEqual([pick('search-hot'), pick('search-history'), pick('rank-host')]);
    view.destroy();
  });

  it.each(['enter', 'submit', 'candidate', 'hot-word', 'history-word'])('%s 提交立即收起候选，加载及零结果紧随输入框', async (action) => {
    const { view, api, pick, input, type, visible } = setup();
    await view.mount();
    if (action === 'history-word') {
      pick('hot-word').click();
      await vi.advanceTimersByTimeAsync(0);
      type('');
    }
    if (action !== 'hot-word' && action !== 'history-word') {
      type('战');
      await vi.advanceTimersByTimeAsync(200);
    }
    api.search.mockImplementationOnce(() => new Promise(() => undefined));
    if (action === 'enter') input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    else pick(action === 'submit' ? 'search-submit' : action === 'candidate' ? 'suggest-item' : action).click();
    expect(visible().slice(2)).toEqual([pick('search-results')]);
    expect(pick('search-results').dataset.state).toBe('loading');
    expect(api.search).toHaveBeenCalled();
    view.destroy();
  });

  it('提交取消尚未触发的防抖，重新输入隐藏旧结果且不自动搜索', async () => {
    const { view, api, pick, type, visible } = setup();
    await view.mount();
    type('战');
    pick('search-submit').click();
    await vi.advanceTimersByTimeAsync(200);
    expect(api.suggestions).not.toHaveBeenCalled();
    expect(visible().slice(2)).toEqual([pick('search-results')]);
    expect(pick('search-results').dataset.state).toBe('empty');
    type('龙');
    expect(visible().slice(2)).toEqual([pick('search-suggest')]);
    await vi.advanceTimersByTimeAsync(200);
    expect(api.search).toHaveBeenCalledTimes(1);
    view.destroy();
  });

  it('已在途的补全不会在提交后回填，旧搜索不会覆盖新输入态', async () => {
    const { view, api, pick, type, visible } = setup();
    let resolveSuggestions!: (value: SuggestionsResponse) => void;
    let resolveSearch!: (value: SearchResponse) => void;
    api.suggestions.mockImplementationOnce(() => new Promise((resolve) => { resolveSuggestions = resolve; }));
    api.search.mockImplementationOnce(() => new Promise((resolve) => { resolveSearch = resolve; }));
    await view.mount();
    type('战');
    await vi.advanceTimersByTimeAsync(200);
    pick('search-submit').click();
    resolveSuggestions({ query: '战', suggestions: [{ text: '过期候选', type: 'title' }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(pick('search-suggest').textContent).not.toContain('过期候选');
    expect(visible().slice(2)).toEqual([pick('search-results')]);
    type('龙');
    resolveSearch({ items: [], page: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(visible().slice(2)).toEqual([pick('search-suggest')]);
    view.destroy();
  });

  it('compositionend 即使没有后续 input 也同步候选与榜单，清空组合恢复推荐', async () => {
    const { view, api, pick, input, visible } = setup();
    await view.mount();
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.value = '战神';
    input.dispatchEvent(new CompositionEvent('compositionend'));
    expect(visible().slice(2)).toEqual([pick('search-suggest')]);
    await vi.advanceTimersByTimeAsync(200);
    expect(api.suggestions.mock.calls).toEqual([['战神']]);
    expect(api.search).not.toHaveBeenCalled();
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.value = '';
    input.dispatchEvent(new CompositionEvent('compositionend'));
    expect(visible().slice(2)).toEqual([pick('search-hot'), pick('search-history'), pick('rank-host')]);
    view.destroy();
  });

  it('候选使用 tokens 限高与内部滚动，保留 44px 且不会被 flex 压缩', () => {
    const rule = css.match(/\.srch-view \.srch-suggest\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(rule).toMatch(/max-height:\s*calc\(var\(--space-16\)\s*\*\s*3\)/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
    const item = css.match(/\.srch-suggest-item\s*\{([^}]+)\}/)?.[1] ?? '';
    expect(item).toMatch(/min-height:\s*44px/);
    expect(item).toMatch(/flex-shrink:\s*0/);
    expect(css).toMatch(/\.srch-view\s*>\s*\[hidden\]\s*\{\s*display:\s*none/);
  });
});
