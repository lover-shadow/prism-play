import type { Env } from '../types/env';
import { PUBLIC_CHANNEL_IDS, type ContentItem, type MatchType, type SearchSuggestion } from '../types/api';
import type { CatalogManifest } from '../library/manifest';
import { factsHash, factsManifest, readWorkFact } from '../library/work-facts';
import { isCount, isRecord } from '../library/contract';
import { parseCatalogShard } from '../library/chunk';
import { covers, type StageRequest } from './lexical';
import { isCorrectionWithinBudget } from './correct';
import { configUnavailableResponse } from '../config/kv-config';
import { jsonResponse } from '../http/json';
import { notFoundResponse } from '../http/errors';

export interface SearchEntry { item: ContentItem; aliases: string[]; pinyin: string[]; tags: string[] }
export type GenerationSearch = { manifest: CatalogManifest; entries: SearchEntry[] };
// At most two projections / 16 MiB encoded total, scoped to bucket identity and generation hash.
const cache = new Map<string, { bucket: R2Bucket; value: GenerationSearch; bytes: number }>();
const MAX_BYTES = 16777216;
const text = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 64 &&
  value.every((s) => typeof s === 'string' && [...s].length <= 160);

export async function generationSearch(env: Env, origin: string): Promise<GenerationSearch | null | undefined> {
  const manifest = await factsManifest(env);
  if (manifest === undefined || (manifest !== null && !manifest.workFacts)) return undefined;
  if (!manifest?.publicSearch || !env.APK_BUCKET) return null;
  const descriptor = manifest.publicSearch;
  const key = `${origin}:${manifest.revision}:${descriptor.sha256}`;
  const hit = cache.get(key);
  if (hit && hit.bucket === env.APK_BUCKET) return { manifest, entries: hit.value.entries };
  try {
    const object = await env.APK_BUCKET.get(descriptor.key);
    if (!object || object.size !== descriptor.bytes) return null;
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.length !== descriptor.bytes || await factsHash(bytes) !== descriptor.sha256) return null;
    const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!isRecord(raw) || raw.schema !== 1 || raw.revision !== manifest.revision ||
        !Array.isArray(raw.entries) || raw.entries.length !== descriptor.count) return null;
    const totals: Record<string, number> = {}, ids = new Set<string>();
    for (const entry of raw.entries) {
      if (!isRecord(entry) || !isRecord(entry.item) || !strings(entry.aliases) || !strings(entry.pinyin) || !strings(entry.tags)) return null;
      const item = entry.item;
      if (typeof item.id !== 'string' || ids.has(item.id) || item.enabled !== true || item.isPrivate !== false ||
          !(PUBLIC_CHANNEL_IDS as readonly unknown[]).includes(item.channelId) ||
          !isCount(item.episodeCount) || typeof item.shareable !== 'boolean') return null;
      const parsed = parseCatalogShard(JSON.stringify({ items: [item], page: 1, total: 1, revision: manifest.revision }), manifest.revision, origin);
      if (!parsed.ok) return null;
      ids.add(item.id);
      totals[item.channelId as string] = (totals[item.channelId as string] ?? 0) + 1;
    }
    for (const channel of PUBLIC_CHANNEL_IDS) if ((totals[channel] ?? 0) !== (manifest.channels[channel]?.total ?? 0)) return null;
    const value = { manifest, entries: raw.entries as unknown as SearchEntry[] };
    while (cache.size >= 2 || [...cache.values()].reduce((n, v) => n + v.bytes, 0) + bytes.length > MAX_BYTES) {
      const first = cache.keys().next().value; if (first === undefined) break; cache.delete(first);
    }
    cache.set(key, { bucket: env.APK_BUCKET, value, bytes: bytes.length });
    return value;
  } catch { return null; }
}

function order(a: SearchEntry, b: SearchEntry): number {
  return (b.item.firstPublishedAt ?? 0) - (a.item.firstPublishedAt ?? 0) || a.item.id.localeCompare(b.item.id);
}
function terms(entry: SearchEntry, stage: number): string[] {
  return stage === 0 ? [entry.item.title] : stage === 1 ? entry.aliases : stage === 2 ? entry.pinyin : entry.tags;
}
const TYPES: MatchType[] = ['exact', 'alias', 'pinyin', 'fuzzy', 'related'];
export function generationCandidates(entries: SearchEntry[], request: StageRequest) {
  const eligible = entries.filter((e) => (!request.channel || e.item.channelId === request.channel) &&
    (!request.tag || e.tags.includes(request.tag)));
  const seen = new Set<string>();
  const result: { entry: SearchEntry; matchType: MatchType; term: string }[] = [];
  for (let stage = 0; stage < 5; stage++) {
    const hits = eligible.flatMap((entry) => {
      const values = stage === 3 ? [entry.item.title, ...entry.aliases, ...entry.pinyin] : terms(entry, stage === 4 ? 4 : stage);
      const term = values.find((s) => stage === 3 ? isCorrectionWithinBudget(request.query, s) : covers(request.query, s));
      return term ? [{ entry, term }] : [];
    }).sort((a, b) => Number(text(b.term) === text(request.query)) - Number(text(a.term) === text(request.query)) || order(a.entry, b.entry));
    // Limit applies AFTER coverage and whole-title prioritisation, never to broad CJK recall.
    for (const hit of hits.slice(0, 120)) {
      if (seen.has(hit.entry.item.id)) continue;
      seen.add(hit.entry.item.id); result.push({ ...hit, matchType: TYPES[stage]! });
    }
  }
  return result;
}

async function verifiedItems(env: Env, generation: GenerationSearch, entries: SearchEntry[]): Promise<ContentItem[] | null> {
  const items: ContentItem[] = [];
  for (const entry of entries) {
    const read = await readWorkFact(env, generation.manifest, entry.item.id);
    if (read.status !== 'ok') return null;
    const fact = read.fact;
    if (fact.asset.title !== entry.item.title || fact.asset.channelId !== entry.item.channelId ||
        fact.asset.category !== entry.item.category || fact.asset.episodes.length !== entry.item.episodeCount ||
        fact.shareable !== entry.item.shareable) return null;
    const asset = fact.asset;
    for (const field of ['coverVersion', 'synopsis', 'firstPublishedAt', 'hitsTotal', 'isAi', 'isHot'] as const) {
      if (asset[field] !== entry.item[field]) return null;
    }
    if (Boolean(entry.item.coverUrl) !== asset.hasCover) return null;
    items.push(entry.item);
  }
  return items;
}
export async function generationResults(env: Env, generation: GenerationSearch, request: StageRequest, page: number, size: number) {
  const window = generationCandidates(generation.entries, request).slice((page - 1) * size, page * size);
  const items = await verifiedItems(env, generation, window.map((hit) => hit.entry));
  return items === null ? configUnavailableResponse() : jsonResponse({ page, items: items.map((item, i) => ({ item, matchType: window[i]!.matchType })) }, 200, { 'Cache-Control': 'no-store' });
}
export async function generationSuggestions(env: Env, generation: GenerationSearch, query: string) {
  const hits = generationCandidates(generation.entries, { query });
  const suggestions: SearchSuggestion[] = [], selected: SearchEntry[] = [], seen = new Set<string>();
  for (const hit of hits) {
    const key = text(hit.term); if (seen.has(key)) continue;
    const owners = generation.entries.filter((e) => [e.item.title, ...e.aliases, ...e.pinyin].some((s) => text(s) === key));
    const type = hit.matchType === 'exact' ? 'title' : hit.matchType === 'fuzzy' ? 'correction' : hit.matchType === 'related' ? 'category' : hit.matchType;
    suggestions.push({ text: hit.term, type, ...(owners.length === 1 && type !== 'category' ? { contentId: hit.entry.item.id } : {}) });
    selected.push(hit.entry); seen.add(key); if (suggestions.length === 10) break;
  }
  return await verifiedItems(env, generation, selected) === null ? configUnavailableResponse() :
    jsonResponse({ query, suggestions }, 200, { 'Cache-Control': 'no-store' });
}
export async function generationRelated(env: Env, generation: GenerationSearch, id: string) {
  const source = generation.entries.find((e) => e.item.id === id);
  if (!source) return notFoundResponse();
  const candidates = generation.entries.filter((e) => e.item.id !== id &&
    (e.item.category === source.item.category || e.tags.some((tag) => source.tags.includes(tag))))
    .sort((a, b) => Number(b.item.category === source.item.category) - Number(a.item.category === source.item.category) ||
      b.tags.filter((t) => source.tags.includes(t)).length - a.tags.filter((t) => source.tags.includes(t)).length || order(a, b)).slice(0, 10);
  const checked = await verifiedItems(env, generation, [source, ...candidates]);
  return checked === null ? configUnavailableResponse() : jsonResponse({ items: checked.slice(1) }, 200, { 'Cache-Control': 'no-store' });
}
