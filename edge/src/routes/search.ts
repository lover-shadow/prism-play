/**
 * `GET /api/search` — public lexical, pinyin and typo-tolerant search (F-13 / AC-16).
 *
 * Unauthenticated by contract (SPEC §5), and it never serves private data, so it does not read the
 * credential at all: no `Authorization` handling means no cache-splitting and no second visibility
 * rule. SPEC §10 scopes public search to the four public channels, therefore `channel=private` is
 * answered as "this channel does not exist" (404) for *every* caller — including a fully admitted
 * advanced device — because 个人探索 has no public index, no completions and no hot words.
 *
 * Paging: results come out in stage order, deterministically inside each stage (`first_published_at
 * DESC, id ASC`). SPEC §12.1 and openapi.yaml both state paging is best-effort and that the client
 * de-duplicates by content id across pages, so no snapshot cursor is pretend-implemented here.
 */

import { generationSearch, generationResults } from '../search/generation';
import { configUnavailableResponse } from '../config/kv-config';
import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import type { SearchResponse, SearchResult } from '../types/api';
import {
  SEARCH_DEFAULT_PAGE_SIZE,
  SEARCH_MAX_PAGE_SIZE,
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_QUERY_MIN_LENGTH
} from '../core/constants';
import { isChannelId } from '../core/validation';
import { findContentRowsByIds, isPubliclyVisible } from '../db/content-repo';
import { errorResponseNoStore, notFoundResponse } from '../http/errors';
import { jsonResponse } from '../http/json';
import { originOf, toContentItem } from '../http/serialize';
import { pageSlice, planStages, rankCandidates, type RankedCandidate, type StageRequest } from '../search/lexical';

/** A withdrawn work must vanish on the very next request, so no shared cache may hold a result page. */
const SEARCH_CACHE_CONTROL = 'no-store';

type ParamResult<T> = { ok: true; value: T } | { ok: false; response: Response };

/**
 * CONTRACT GAP, resolved and reported: openapi.yaml pins `q` to 1..80 characters, but the closed
 * openapi.yaml declares no 400 for these endpoints and the closed `ErrorResponse.code` enum has no
 * generic validation member. Reusing a coupon code here would tell the client the wrong thing, so the
 * status alone answers; ratifying `VALIDATION_ERROR` (400) is filed with the Stage 2 report.
 */
export function invalidInputResponse(message: string): Response {
  return errorResponseNoStore('VALIDATION_ERROR', message);
}

export function readQueryParameter(searchParams: URLSearchParams): ParamResult<string> {
  const raw = searchParams.get('q');
  if (raw === null) return { ok: false, response: invalidInputResponse('缺少检索词 q') };
  const query = raw.normalize('NFKC').trim();
  const length = [...query].length;
  if (query === '' || length < SEARCH_QUERY_MIN_LENGTH) {
    return { ok: false, response: invalidInputResponse('检索词不能为空') };
  }
  if (length > SEARCH_QUERY_MAX_LENGTH) {
    return { ok: false, response: invalidInputResponse(`检索词最长 ${SEARCH_QUERY_MAX_LENGTH} 个字符`) };
  }
  return { ok: true, value: query };
}

/**
 * Missing → default; anything that is not a decimal integer ≥ 1 → 400 (that input cannot be honoured
 * at all); above `cap` → clamped. The contract words the ceiling as an output limit ("pageSize
 * 默认/上限 20", SPEC §10), so asking for 40 is answered with 20 rather than with an error a client
 * cannot recover from.
 */
export function readPagingParameter(
  searchParams: URLSearchParams,
  name: string,
  defaultValue: number,
  cap?: number
): ParamResult<number> {
  const raw = (searchParams.get(name) ?? '').trim();
  if (raw === '') return { ok: true, value: defaultValue };
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    return { ok: false, response: invalidInputResponse(`${name} 必须是正整数`) };
  }
  const parsed = Number(raw);
  if (cap !== undefined && parsed > cap) return { ok: true, value: cap };
  return { ok: true, value: parsed };
}

/**
 * `channel` is a public-channel filter only. An unrecognised id and `private` get the same 404 as an
 * unknown resource, so this endpoint never confirms the existence of the 个人探索 channel (§10 scope).
 */
function readChannelFilter(searchParams: URLSearchParams): ParamResult<string | undefined> {
  const raw = (searchParams.get('channel') ?? '').trim();
  if (raw === '') return { ok: true, value: undefined };
  if (!isChannelId(raw) || raw === 'private') return { ok: false, response: notFoundResponse() };
  return { ok: true, value: raw };
}

export async function handleSearch(request: Request, env: Env, _clock: Clock): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;

  const query = readQueryParameter(searchParams);
  if (!query.ok) return query.response;
  const channel = readChannelFilter(searchParams);
  if (!channel.ok) return channel.response;
  const page = readPagingParameter(searchParams, 'page', 1);
  if (!page.ok) return page.response;
  const pageSize = readPagingParameter(searchParams, 'pageSize', SEARCH_DEFAULT_PAGE_SIZE, SEARCH_MAX_PAGE_SIZE);
  if (!pageSize.ok) return pageSize.response;
  const tag = (searchParams.get('tag') ?? '').trim();

  const filters: StageRequest = { query: query.value, ...(channel.value ? { channel: channel.value } : {}), ...(tag === '' ? {} : { tag }) };
  const generation = await generationSearch(env, originOf(request));
  if (generation === null) return configUnavailableResponse();
  if (generation !== undefined) return generationResults(env, generation, filters, page.value, pageSize.value);
  const ranked = rankCandidates(await planStages(env.DB, filters));
  const window = pageSlice(ranked, page.value, pageSize.value);

  const body: SearchResponse = { items: await itemsForRanking(env, request, window), page: page.value };
  return jsonResponse(body, 200, { 'Cache-Control': SEARCH_CACHE_CONTROL });
}

/**
 * The last authority check: an FTS hit only made an id a *candidate*; `content_items` decides whether it
 * is still publicly visible, and `toContentItem` re-derives the cover URL from the request origin so no
 * stored upstream address can leak (API-SPEC §〇 上游地址零暴露).
 */
async function itemsForRanking(env: Env, request: Request, window: readonly RankedCandidate[]): Promise<SearchResult[]> {
  if (window.length === 0) return [];
  const rows = await findContentRowsByIds(env.DB, window.map((candidate) => candidate.contentId));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const origin = originOf(request);
  const items: SearchResult[] = [];
  for (const candidate of window) {
    const row = byId.get(candidate.contentId);
    if (row === undefined || !isPubliclyVisible(row)) continue;
    items.push({ item: toContentItem(row, { origin }), matchType: candidate.matchType });
  }
  return items;
}
