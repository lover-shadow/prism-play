// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ContentItem, SearchResponse } from '../../edge/src/types/api';
import { createSearchView } from '../../src/views/search-view';
import { applySearchPage, createSearchPoll, type SearchSource } from '../../src/views/search-poll';
const entry = (id: string, title = id) => ({ item: { id, title, channelId: 'drama', category: '都市', isPrivate: false } as ContentItem, matchType: 'exact' as const });
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const views: ReturnType<typeof createSearchView>[] = [];
afterEach(() => { views.splice(0).forEach((view) => view.destroy()); vi.useRealTimers(); document.body.replaceChildren(); });
async function setup(online: (input: { q: string; page?: number; discoveryPage?: number }) => Promise<SearchResponse>) {
  const root = document.createElement('div'); document.body.append(root);
  const view = createSearchView({ root, onOpenTitle: vi.fn(), api: { localFirst: true,
    search: async () => ({ items: [entry('same', '本机旧标题')], page: 1, hasMore: false }),
    searchOnline: online, suggestions: async (query) => ({ query, suggestions: [] }) } });
  views.push(view); await view.mount();
  const submit = (q: string) => { const input = root.querySelector('input')!; input.value = q;
    input.dispatchEvent(new Event('input')); root.querySelector<HTMLButtonElement>('[data-el="search-submit"]')!.click(); };
  return { root, view, submit };
}
describe('pending discovery search polling', () => {
  it('shows local immediately, polls same window/source page, replaces stale metadata and stops when complete', async () => {
    vi.useFakeTimers();
    const online = vi.fn().mockResolvedValueOnce({ items: [], page: 1, hasMore: false, discoveryPage: 1, discoveryPending: true })
      .mockResolvedValueOnce({ items: [entry('same', '线上新标题'), entry('new')], page: 1, hasMore: false, discoveryPage: 1, discoveryPending: false });
    const s = await setup(online); s.submit('词'); await flush();
    expect(s.root.textContent).toContain('本机旧标题'); expect(s.root.textContent).toContain('仍在持续');
    await vi.advanceTimersByTimeAsync(1000); await flush();
    expect(online.mock.calls[1][0]).toEqual({ q: '词', page: 1, pageSize: 20, discoveryPage: 1 });
    expect(s.root.textContent).toContain('线上新标题'); expect(s.root.textContent).not.toContain('本机旧标题');
    expect(s.root.querySelectorAll('[data-el="result-card"]')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(5000); expect(online).toHaveBeenCalledTimes(2);
  });
  it('failure preserves successful results; changing words and destroying cancel timers', async () => {
    vi.useFakeTimers();
    const online = vi.fn().mockResolvedValue({ items: [entry('cloud')], page: 1, discoveryPending: true, discoveryFailed: true, hasMore: false });
    const s = await setup(online); s.submit('旧'); await flush();
    expect(s.root.querySelectorAll('[data-el="result-card"]')).toHaveLength(2);
    s.root.querySelector('input')!.value = '新'; s.root.querySelector('input')!.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(1000); expect(online).toHaveBeenCalledTimes(1);
    s.submit('新'); await flush(); s.view.destroy(); await vi.advanceTimersByTimeAsync(5000);
    expect(online).toHaveBeenCalledTimes(2); expect(s.root.childElementCount).toBe(0);
  });
  it('bounded polling leaves an explicit continuing state, never a false empty state', async () => {
    vi.useFakeTimers();
    const online = vi.fn().mockResolvedValue({ items: [], page: 1, discoveryPending: true, hasMore: false });
    const s = await setup(online); s.submit('词'); await flush();
    await vi.advanceTimersByTimeAsync(125000); await flush();
    expect(online).toHaveBeenCalledTimes(121); expect(s.root.textContent).toContain('仍在持续');
    expect(s.root.textContent).not.toContain('联网目录未命中');
    expect(s.root.querySelector<HTMLButtonElement>('[data-el="search-more"]')!.disabled).toBe(false);
  });
  it('revisits partial merged window when source page advances and updates same IDs', () => {
    const source: SearchSource = { online: true, page: 1, more: true, busy: false, done: false, error: '', items: [] };
    applySearchPage(source, { items: [entry('same')], page: 1, hasMore: false, discoveryPage: 1, discoveryHasMore: true });
    expect(source.page).toBe(1); expect(source.discoveryPage).toBe(2);
    applySearchPage(source, { items: [entry('same', '更新'), entry('new')], page: 1, hasMore: false, discoveryPage: 2 });
    expect(source.items.map((hit) => hit.item.title)).toEqual(['更新', 'new']); expect(source.more).toBe(false);
  });
  it('does not schedule nonpending responses and filters private new items', () => {
    vi.useFakeTimers(); const poll = createSearchPoll(), run = vi.fn();
    const source: SearchSource = { online: true, page: 1, more: true, busy: false, done: false, error: '', items: [] };
    const privateEntry = entry('private'); privateEntry.item.isPrivate = true;
    const response = { items: [privateEntry], page: 1, hasMore: false, discoveryPending: false };
    applySearchPage(source, response); poll.schedule(source, response, run);
    expect(source.items).toHaveLength(0); expect(vi.getTimerCount()).toBe(0); poll.cancel();
  });
});
