import type { ContentItem } from '../../edge/src/types/api';
import { groupSeries } from '../core/series';

export function createSeasonSwitcher(current: ContentItem, items: readonly ContentItem[], open: (workId: string) => void): HTMLElement | null {
  if (current.isPrivate || current.channelId === 'private') return null;
  const candidates = items.filter((item) => !item.isPrivate && item.channelId !== 'private' && item.id !== current.id);
  const group = groupSeries([current, ...candidates]).find((entry) => entry.items.some((item) => item.id === current.id));
  if (!group || group.items.length < 2) return null;
  const root = document.createElement('section'); root.className = 'prism-season-switcher';
  root.dataset.prismUi = 'season-switcher';
  const label = document.createElement('label'); label.textContent = '选择季或部';
  const select = document.createElement('select'); select.className = 'pv-input';
  select.setAttribute('aria-label', `${group.title}选择季或部`);
  for (const item of group.items) {
    const text = group.labels?.[item.id] ? `${item.title} (${group.labels[item.id]})` : item.title;
    const option = document.createElement('option'); option.textContent = text; option.value = item.id;
    select.append(option);
  }
  select.value = current.id;
  select.addEventListener('change', () => { if (select.value !== current.id) open(select.value); });
  label.append(select); root.append(label);
  return root;
}
