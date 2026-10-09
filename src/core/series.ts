import type { ContentItem } from '../../edge/src/types/api';
import { season } from '../../edge/src/search/providers/seasons';

export interface SeriesGroup {
  title: string;
  items: ContentItem[];
  labels?: Record<string, string>;
}

function normalizeBaseTitle(title: string): string {
  return title.normalize('NFKC').replace(/[\p{P}\s]+$/u, '').trim();
}

export function groupSeries(items: readonly ContentItem[]): SeriesGroup[] {
  const families = new Map<string, { title: string; unit: string; channelId: string; entries: { item: ContentItem; number: number }[] }>();
  for (const item of items) {
    const parsed = season(item.title);
    if (!parsed) continue;
    const baseKey = normalizeBaseTitle(parsed.base);
    const key = `${item.channelId}:${parsed.unit}:${baseKey}`;
    const family = families.get(key) ?? { title: parsed.base, unit: parsed.unit, channelId: item.channelId, entries: [] };
    if (!family.entries.some((e) => e.item.id === item.id)) {
      family.entries.push({ item, number: parsed.number });
    }
    families.set(key, family);
  }
  for (const family of families.values()) {
    const familyBase = normalizeBaseTitle(family.title);
    const siblings = [...families.values()].filter((entry) => normalizeBaseTitle(entry.title) === familyBase && entry.channelId === family.channelId);
    if (siblings.length !== 1) continue;
    const bases = items.filter((item) => normalizeBaseTitle(item.title) === familyBase && item.channelId === family.channelId && !season(item.title));
    for (const first of bases) {
      if (!family.entries.some((entry) => entry.item.id === first.id)) family.entries.push({ item: first, number: 1 });
    }
  }
  const byId = new Map<string, SeriesGroup>();
  for (const family of families.values()) {
    if (family.entries.length < 2) continue;
    const sorted = [...family.entries].sort((a, b) => a.number - b.number || a.item.title.localeCompare(b.item.title) || a.item.id.localeCompare(b.item.id));
    const titleCounts = new Map<string, number>();
    for (const entry of sorted) titleCounts.set(entry.item.title, (titleCounts.get(entry.item.title) ?? 0) + 1);
    const labels: Record<string, string> = {};
    const titleIndexes = new Map<string, number>();
    for (const entry of sorted) {
      if ((titleCounts.get(entry.item.title) ?? 0) > 1) {
        const next = (titleIndexes.get(entry.item.title) ?? 0) + 1;
        titleIndexes.set(entry.item.title, next);
        labels[entry.item.id] = `版本${next}`;
      }
    }
    const group: SeriesGroup = {
      title: family.title,
      items: sorted.map((entry) => entry.item),
      ...(Object.keys(labels).length > 0 ? { labels } : {})
    };
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
