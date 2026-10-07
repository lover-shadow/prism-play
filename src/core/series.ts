import type { ContentItem } from '../../edge/src/types/api';
import { season } from '../../edge/src/search/providers/seasons';

export interface SeriesGroup { title: string; items: ContentItem[] }

export function groupSeries(items: readonly ContentItem[]): SeriesGroup[] {
  const families = new Map<string, { title: string; entries: { item: ContentItem; number: number }[] }>();
  for (const item of items) {
    const parsed = season(item.title);
    if (!parsed) continue;
    const key = `${item.channelId}:${parsed.unit}:${parsed.base}`;
    const family = families.get(key) ?? { title: parsed.base, entries: [] };
    family.entries.push({ item, number: parsed.number }); families.set(key, family);
  }
  for (const family of families.values()) {
    const siblings = [...families.values()].filter((entry) => entry.title === family.title && entry.entries[0].item.channelId === family.entries[0].item.channelId);
    if (siblings.length !== 1 || family.entries.some((entry) => entry.number === 1)) continue;
    const bases = items.filter((item) => item.title === family.title && item.channelId === family.entries[0].item.channelId);
    const first = bases.length === 1 ? bases[0] : undefined;
    if (first && !family.entries.some((entry) => entry.item.id === first.id)) family.entries.push({ item: first, number: 1 });
  }
  const byId = new Map<string, SeriesGroup>();
  for (const family of families.values()) {
    if (family.entries.length < 2 || new Set(family.entries.map((entry) => entry.number)).size !== family.entries.length) continue;
    const group = { title: family.title, items: family.entries.sort((a, b) => a.number - b.number || a.item.id.localeCompare(b.item.id)).map((entry) => entry.item) };
    for (const item of group.items) byId.set(item.id, group);
  }
  const emitted = new Set<SeriesGroup>(), result: SeriesGroup[] = [];
  for (const item of items) {
    const group = byId.get(item.id);
    if (!group) { result.push({ title: item.title, items: [item] }); continue; }
    if (!emitted.has(group)) { emitted.add(group); result.push(group); }
  }
  return result;
}
