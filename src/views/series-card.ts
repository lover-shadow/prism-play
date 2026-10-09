import type { ContentItem } from '../../edge/src/types/api';
import type { SeriesGroup } from '../core/series';
import { button, make } from './history-view';

export function createSeriesCard(group: SeriesGroup, card: (item: ContentItem) => HTMLElement, open: (id: string) => void): HTMLElement {
  if (group.items.length === 1) return card(group.items[0]);
  const root = make('section', 'srch-series-card');
  root.setAttribute('aria-label', `${group.title}，已找到 ${group.items.length} 季或部`);
  root.dataset.el = 'series-card';
  root.append(card(group.items[0]));
  const select = make('select', 'pv-input');
  select.setAttribute('aria-label', `${group.title}选择季或部`);
  for (const item of group.items) {
    const text = group.labels?.[item.id] ? `${item.title} (${group.labels[item.id]})` : item.title;
    const option = make('option', '', text); option.value = item.id; select.append(option);
  }
  root.append(make('span', 'pv-meta', `已找到 ${group.items.length} 季或部`), select,
    button('播放所选季', () => open(select.value), { cls: 'pv-btn-ghost', el: 'series-open' }));
  return root;
}
