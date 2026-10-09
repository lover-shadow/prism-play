import type { Env } from '../types/env';
import type { Clock } from '../core/clock';
import { PUBLIC_CHANNEL_IDS, type ContentItem, type SearchResponse, type SearchResult, type DiscoveryChangesResponse } from '../types/api';
import { generationCandidates, generationResults, generationSearch, type GenerationSearch, type SearchEntry } from '../search/generation';
import type { StageRequest } from '../search/lexical';
import { createDiscoveryProviders, discoveryConfigScope, readDiscoveryConfig } from '../search/discovery-config';
import { createCardDiscoveryService } from '../search/discovery-card-service';
import { readDiscoveryCard } from '../search/discovery-cards';
import { readDiscoveryChanges, readDiscoveryFact } from '../search/discovery-store';
import { publicDiscoveryContext, readPublicFact } from '../search/public-facts';
import { readDiscoveryQuery } from '../search/discovery-query';
import { discoveryQueryKey } from '../search/discovery-query';
import { itemFromAsset } from '../library/title-asset';
import { factsManifest } from '../library/work-facts';
import { configUnavailableResponse } from '../config/kv-config';
import { jsonResponse } from '../http/json';
import { originOf } from '../http/serialize';
import { invalidInputResponse, readPagingParameter } from './search';

const publicItem = (item: ContentItem) => item.enabled === true && item.isPrivate === false &&
  (PUBLIC_CHANNEL_IDS as readonly string[]).includes(item.channelId);
function originCard(item: ContentItem, origin: string): ContentItem {
  return { ...item, ...(item.coverUrl ? { coverUrl: `${origin}/proxy/img/${encodeURIComponent(item.id)}` } : {}) };
}
/** Full D1 discovery index, ordered by FIRST change sequence (never metadata update time).
 * Baseline stage order stays fixed; new discoveries append, even if their match stage is exact.
 * All provider-page jobs participate, including titles whose provider match is not lexical.
 * Only the final <=20 window reads R2 facts. No isolate-local session or truncated index.
 */
export async function searchWithDiscovery(request: Request, env: Env, clock: Clock,
  generation: GenerationSearch, filters: StageRequest, page: number, size: number, providerPage: number): Promise<Response> {
  const context = publicDiscoveryContext(env, generation.manifest, () => clock.nowSeconds());
  let failed = false, pending = false, providerMore = false, retry = 1;
  let service: ReturnType<typeof createCardDiscoveryService> | undefined;
  let serviceItems: SearchResult[] = [];
  try {
    service = createCardDiscoveryService(context, createDiscoveryProviders(readDiscoveryConfig(env)), {
      scope: `${await discoveryConfigScope(env)}:${generation.manifest.revision}`
    });
    const result = await service.query(filters.query, providerPage, request);
    serviceItems = result.items; pending = result.pending; failed = result.failed;
    providerMore = result.providerHasMore ?? result.hasMore; retry = result.retryAfterSeconds ?? 1;
  } catch { failed = true; }
  const baseline = generationCandidates(generation.entries, filters);
  const merged = new Map<string, { id: string; matchType: SearchResult['matchType']; baseline?: SearchEntry }>();
  for (const hit of baseline) merged.set(hit.entry.item.id, { id: hit.entry.item.id, matchType: hit.matchType, baseline: hit.entry });
  try {
    const rows = await env.DB.prepare(`SELECT w.work_id, w.card_json, MIN(c.seq) AS first_seq
      FROM (SELECT work_id, card_json FROM discovery_works WHERE enabled = 1 AND expires_at > ?
        UNION ALL SELECT work_id, card_json FROM discovery_cards) w
      JOIN discovery_changes c ON c.work_id = w.work_id
      GROUP BY w.work_id, w.card_json ORDER BY first_seq, w.work_id`)
      .bind(clock.nowSeconds()).all<{ work_id: string; card_json: string; first_seq: number }>();
    const jobIds = new Set(serviceItems.map((hit) => hit.item.id));
    if (service) for (let sourcePage = 1; sourcePage <= providerPage; sourcePage++) {
      const key = await discoveryQueryKey(filters.query, service.queryScope(sourcePage));
      const cached = await readDiscoveryQuery(env.DB, key, clock.nowSeconds());
      for (const id of cached?.ids ?? []) jobIds.add(id);
    }
    for (const row of rows.results) {
      let item: ContentItem;
      try { item = JSON.parse(row.card_json); } catch { continue; }
      if (!item || typeof item.title !== 'string' || typeof item.category !== 'string' ||
        !publicItem(item) || item.id !== row.work_id || (filters.channel && item.channelId !== filters.channel)) continue;
      const hit = generationCandidates([{ item, aliases: [], pinyin: [], tags: [item.category] }], filters)[0];
      if (!hit && (!jobIds.has(item.id) || (filters.tag && filters.tag !== item.category))) continue;
      if (!merged.has(item.id)) merged.set(item.id, { id: item.id, matchType: hit?.matchType ?? 'related' });
    }
  } catch { failed = true; }
  const candidates = [...merged.values()], window = candidates.slice((page - 1) * size, page * size);
  const baseEntries = window.flatMap((hit) => hit.baseline ? [hit.baseline] : []);
  const checked = await generationResults(env, { ...generation, entries: baseEntries }, filters, 1, size);
  if (checked.status !== 200) return checked;
  const base = await checked.json() as SearchResponse, byId = new Map(base.items.map((hit) => [hit.item.id, hit.item]));
  const items: SearchResult[] = [], origin = originOf(request);
  for (const hit of window) {
    let item = byId.get(hit.id);
    const stored = hit.baseline ? null : await readDiscoveryCard(context, hit.id);
    if (stored) item = stored.item;
    else {
      const read = hit.baseline ? await readPublicFact(env, generation.manifest, hit.id, clock.nowSeconds()) :
        await readDiscoveryFact(context, hit.id, clock.nowSeconds());
      if (read.status !== 'ok') continue;
      item = itemFromAsset(read.fact.asset, read.fact.asset.hasCover ? `${origin}/proxy/img/${encodeURIComponent(hit.id)}` : undefined);
      item.enabled = true; item.shareable = read.fact.shareable;
    }
    if (item && publicItem(item)) items.push({ item: originCard(item, origin), matchType: hit.matchType });
  }
  return jsonResponse({ items, page, hasMore: page * size < candidates.length,
    discoveryPending: pending, discoveryFailed: failed, discoveryPage: providerPage,
    discoveryHasMore: providerMore, ...(pending ? { retryAfterSeconds: retry } : {}) } satisfies SearchResponse,
  200, { 'Cache-Control': 'no-store' });
}

export async function handleSearchDiscoveries(request: Request, env: Env, clock: Clock): Promise<Response> {
  const params = new URL(request.url).searchParams, raw = params.get('after') ?? '0';
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) return invalidInputResponse('after 必须为非负安全整数');
  const limit = readPagingParameter(params, 'limit', 60, 100);
  if (!limit.ok) return limit.response;
  if (env.SEARCH_DISCOVERY_ENABLED !== 'true') return jsonResponse({ changes: [], cursor: Number(raw), hasMore: false }, 200, { 'Cache-Control': 'no-store' });
  const manifest = env.KV ? await factsManifest(env) : (await generationSearch(env, originOf(request)))?.manifest;
  if (!manifest) return configUnavailableResponse();
  const context = publicDiscoveryContext(env, manifest, () => clock.nowSeconds());
  const result = await readDiscoveryChanges(context, Number(raw), clock.nowSeconds(), limit.value);
  const changes: DiscoveryChangesResponse['changes'] = [];
  const checked = new Map<string, ContentItem | null>(), origin = originOf(request);
  async function cardFor(workId: string): Promise<ContentItem | null> {
    const stored = await readDiscoveryCard(context, workId);
    if (stored && publicItem(stored.item)) return originCard(stored.item, origin);
    const read = await readDiscoveryFact(context, workId, clock.nowSeconds());
    if (read.status !== 'ok') return null;
    const card = itemFromAsset(read.fact.asset, read.fact.asset.hasCover ? `${origin}/proxy/img/${encodeURIComponent(workId)}` : undefined);
    card.enabled = true; card.shareable = read.fact.shareable;
    return publicItem(card) ? card : null;
  }
  for (const change of result.changes) {
    if (change.operation === 'withdraw') { changes.push({ ...change, card: undefined }); continue; }
    if (!checked.has(change.workId)) checked.set(change.workId, await cardFor(change.workId));
    const card = checked.get(change.workId);
    if (!card) {
      changes.push({ seq: change.seq, workId: change.workId, operation: 'withdraw', updatedAt: change.updatedAt }); continue;
    }
    changes.push({ ...change, card });
  }
  return jsonResponse({ ...result, changes } satisfies DiscoveryChangesResponse, 200, { 'Cache-Control': 'no-store' });
}
