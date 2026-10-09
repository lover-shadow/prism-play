// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createSeriesCard } from '../../src/views/series-card';
import { createSearchView } from '../../src/views/search-view';
import type { ContentItem } from '../../edge/src/types/api';
const item = (id: string, title: string): ContentItem => ({ id, title, channelId: 'drama', category: '故事', isPrivate: false });
describe('series aggregate result card', () => {
  it('keeps all seasons selectable and opens the chosen work identity', () => {
    const open = vi.fn();
    const first = item('s1', '故事第一季'), second = item('s7', '故事第七季');
    const root = createSeriesCard({ title: '故事', items: [first, second] }, (value) => {
      const card = document.createElement('button'); card.textContent = value.title; return card;
    }, open);
    const select = root.querySelector('select')!;
    expect(select.options).toHaveLength(2);
    select.value = 's7'; root.querySelector<HTMLButtonElement>('[data-el="series-open"]')!.click();
    expect(open).toHaveBeenCalledWith('s7');
    expect(root.getAttribute('aria-label')).toContain('已找到 2');
  });
  it('merges seasons across exact and related result buckets', async () => {
    const root = document.createElement('div'), open = vi.fn(); document.body.append(root);
    const view = createSearchView({ root, onOpenTitle: open, api: {
      search: async () => ({ items: [
        { item: item('s1', '故事'), matchType: 'exact' },
        { item: item('s7', '故事第七季'), matchType: 'related' }
      ], page: 1 }), suggestions: async () => ({ query: '', suggestions: [] })
    } });
    await view.mount(); root.querySelector('input')!.value = '故事';
    root.querySelector<HTMLButtonElement>('[data-el="search-submit"]')!.click();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(root.querySelectorAll('[data-el="series-card"]')).toHaveLength(1);
    const select = root.querySelector('select')!; expect(select.options).toHaveLength(2);
    select.value = 's7'; root.querySelector<HTMLButtonElement>('[data-el="series-open"]')!.click();
    expect(open).toHaveBeenCalledWith('s7'); view.destroy(); root.remove();
  });
  it('merges a season arriving on a later result page without dropping either identity', async () => {
    const root = document.createElement('div'), open = vi.fn(); document.body.append(root);
    const view = createSearchView({ root, onOpenTitle: open, api: {
      search: async (input) => ({ items: [{ item: input.page === 1 ? item('s1', '故事') : item('s7', '故事第七季'), matchType: 'exact' }],
        page: input.page ?? 1, hasMore: input.page === 1 }), suggestions: async () => ({ query: '', suggestions: [] })
    } });
    await view.mount(); root.querySelector('input')!.value = '故事'; root.querySelector<HTMLButtonElement>('[data-el="search-submit"]')!.click();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    root.querySelector<HTMLButtonElement>('[data-el="search-more"]')!.click();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(root.querySelectorAll('[data-el="series-card"]')).toHaveLength(1);
    expect([...root.querySelector('select')!.options].map((entry) => entry.value)).toEqual(['s1', 's7']);
    view.destroy(); root.remove();
  });
  it('leaves single results as original cards', () => {
    const card = document.createElement('button');
    expect(createSeriesCard({ title: '单剧', items: [item('single', '单剧')] }, () => card, vi.fn())).toBe(card);
  });
  it('applies disambiguation labels for identical titles in group (AC-R04)', () => {
    const s3a = item('s3a', '持械入宋第三季');
    const s3b = item('s3b', '持械入宋第三季');
    const root = createSeriesCard({ title: '持械入宋', items: [s3a, s3b], labels: { s3a: '版本1', s3b: '版本2' } }, (v) => {
      const card = document.createElement('button'); card.textContent = v.title; return card;
    }, vi.fn());
    const options = Array.from(root.querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['持械入宋第三季 (版本1)', '持械入宋第三季 (版本2)']);
  });
});
