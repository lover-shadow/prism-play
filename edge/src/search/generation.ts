import type { Env } from '../types/env';
import { PUBLIC_CHANNEL_IDS, type ContentItem, type MatchType, type SearchSuggestion } from '../types/api';
import type { CatalogManifest } from '../library/manifest';
import { factsHash, factsManifest, readWorkFact } from '../library/work-facts';
import { isCount, isRecord } from '../library/contract';
import { parseCatalogShard } from '../library/chunk';
import { compileCoverage, coversCompiled, normalizeCoverage, type CompiledCoverage, type StageRequest } from './lexical';
import { isCorrectionWithinBudget } from './correct';
import { configUnavailableResponse } from '../config/kv-config';
import { jsonResponse } from '../http/json';
import { notFoundResponse } from '../http/errors';

export interface SearchEntry { item: ContentItem; aliases: string[]; pinyin: string[]; tags: string[] }
export type GenerationSearch = { manifest: CatalogManifest; entries: SearchEntry[] };
// At most two projections / 16 MiB encoded total, scoped to bucket identity and generation hash.
const cache = new Map<string, { bucket: R2Bucket; value: GenerationSearch; bytes: number }>();
const MAX_BYTES = 16777216;
const text = normalizeCoverage;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 64 &&
  value.every((s) => typeof s === 'string' && [...s].length <= 160);

export async function generationSearch(env: Env, origin: string): Promise<GenerationSearch | null | undefined> {
  const manifest = await factsManifest(env);
  if (manifest === undefined || (manifest !== null && !manifest.workFacts)) return undefined;
  if (!manifest?.publicSearch || !env.APK_BUCKET) return null;
  const descriptor = manifest.publicSearch;
  const key = JSON.stringify([origin, manifest.revision, descriptor.sha256, descriptor.bytes, descriptor.count, manifest.channels]);
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
      ids.add(item.id);
      totals[item.channelId as string] = (totals[item.channelId as string] ?? 0) + 1;
    }
    // Same per-item gate, one JSON round-trip rather than one tiny shard per work.
    const parsed = parseCatalogShard(JSON.stringify({ items: raw.entries.map((entry) => entry.item), page: 1,
      total: raw.entries.length, revision: manifest.revision }), manifest.revision, origin);
    if (!parsed.ok) return null;
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
type Candidate = { entry: SearchEntry; matchType: MatchType; term: string };
type Term = CompiledCoverage & { display: string; length: number };
type Projection = { rows: { entry: SearchEntry; stages: Term[][] }[]; owners: Map<string, Set<string>>;
  queries: Map<string, Candidate[]>; bytes: number };
// Entry-array identity is inherited from the bucket + revision + projection-hash cache.
// Standalone callers also get isolation; no unbounded WeakMap of compiled projections.
const projections = new Map<SearchEntry[], Projection>();
function projection(entries: SearchEntry[]): Projection {
  const hit = projections.get(entries);
  if (hit) return hit;
  const vocabulary = new Map<string, Term>();
  const term = (display: string): Term => {
    let value = vocabulary.get(display);
    if (!value) {
      const compiled = compileCoverage(display);
      value = { ...compiled, display, length: [...compiled.normalized].length };
      vocabulary.set(display, value);
    }
    return value;
  };
  const owners = new Map<string, Set<string>>();
  const rows = entries.map((entry) => {
    const title = [term(entry.item.title)], aliases = entry.aliases.map(term), pinyin = entry.pinyin.map(term);
    for (const value of [...title, ...aliases, ...pinyin]) {
      let ids = owners.get(value.normalized);
      if (!ids) { ids = new Set(); owners.set(value.normalized, ids); }
      ids.add(entry.item.id);
    }
    return { entry, stages: [title, aliases, pinyin, [...title, ...aliases, ...pinyin], entry.tags.map(term)] };
  });
  const bytes = JSON.stringify(entries).length * 2 + [...vocabulary.values()].reduce((n, t) =>
    n + 2 * (t.display.length + t.normalized.length + t.tokens.join(' ').length) + 128, 0);
  const value = { rows, owners, queries: new Map<string, Candidate[]>(), bytes };
  while (projections.size >= 2 || [...projections.values()].reduce((n, p) => n + p.bytes, 0) + bytes > MAX_BYTES * 4) {
    const first = projections.keys().next().value; if (!first) break; projections.delete(first);
  }
  if (bytes <= MAX_BYTES * 4) projections.set(entries, value);
  return value;
}
const TYPES: MatchType[] = ['exact', 'alias', 'pinyin', 'fuzzy', 'related'];
export function generationCandidates(entries: SearchEntry[], request: StageRequest) {
  const compiled = projection(entries), query = compileCoverage(request.query);
  const key = JSON.stringify([query.normalized, query.tokens, request.channel ?? '', request.tag ?? '']);
  const cached = compiled.queries.get(key);
  if (cached) return cached.slice();
  const eligible = compiled.rows.filter(({ entry: e }) => (!request.channel || e.item.channelId === request.channel) &&
    (!request.tag || e.tags.includes(request.tag)));
  const seen = new Set<string>(), result: Candidate[] = [];
  const length = [...query.normalized].length;
  const corrections = new Map<Term, boolean>();
  for (let stage = 0; stage < 5; stage++) {
    const hits: { entry: SearchEntry; term: Term }[] = [];
    for (const row of eligible) {
      if (seen.has(row.entry.item.id)) continue;
      const term = row.stages[stage]!.find((target) => {
        if (stage !== 3) return coversCompiled(query, target);
        if (length < 2 || Math.abs(length - target.length) > 1) return false;
        let corrected = corrections.get(target);
        if (corrected === undefined) {
          corrected = isCorrectionWithinBudget(query.normalized, target.normalized);
          corrections.set(target, corrected);
        }
        return corrected;
      });
      if (term) hits.push({ entry: row.entry, term });
    }
    hits.sort((a, b) => Number(b.term.normalized === query.normalized) - Number(a.term.normalized === query.normalized) || order(a.entry, b.entry));
    for (const hit of hits) {
      seen.add(hit.entry.item.id);
      result.push({ entry: hit.entry, term: hit.term.display, matchType: TYPES[stage]! });
    }
  }
  // At most eight complete ranked queries per projection; pagination never truncates recall.
  if (compiled.queries.size >= 8) compiled.queries.delete(compiled.queries.keys().next().value!);
  compiled.queries.set(key, result);
  return result.slice();
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
  const candidates = generationCandidates(generation.entries, request);
  const window = candidates.slice((page - 1) * size, page * size);
  const items = await verifiedItems(env, generation, window.map((hit) => hit.entry));
  return items === null ? configUnavailableResponse() : jsonResponse({ page, hasMore: page * size < candidates.length,
    items: items.map((item, i) => ({ item, matchType: window[i]!.matchType })) }, 200, { 'Cache-Control': 'no-store' });
}
export async function generationSuggestions(env: Env, generation: GenerationSearch, query: string) {
  const hits = generationCandidates(generation.entries, { query });
  const suggestions: SearchSuggestion[] = [], selected: SearchEntry[] = [], seen = new Set<string>();
  for (const hit of hits) {
    const key = text(hit.term); if (seen.has(key)) continue;
    const owners = projection(generation.entries).owners.get(key);
    const type = hit.matchType === 'exact' ? 'title' : hit.matchType === 'fuzzy' ? 'correction' : hit.matchType === 'related' ? 'category' : hit.matchType;
    suggestions.push({ text: hit.term, type, ...(owners?.size === 1 && type !== 'category' ? { contentId: hit.entry.item.id } : {}) });
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
