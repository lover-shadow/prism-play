/**
 * `GET /api/search/suggestions` — public completion only (API-SPEC §八, openapi 最多 10 条).
 *
 * Prefix strategy, and why: every stage is an FTS5 prefix query (`matchExpression(q, {prefixLatin})`)
 * against a `public_search_fts` column joined back to `content_items` with the visibility predicate,
 * i.e. the auxiliary `prefix = '2 3'` index does the work and `content_items` is never scanned. A LIKE
 * on the token columns would also "work" but a leading wildcard cannot use an index at all, and the
 * columns hold pre-tokenised grams rather than display text, so the displayed string is always re-read
 * from the authoritative table (`content_items.title`, `content_aliases.alias/pinyin`, `content_tags`).
 *
 * Stage order is the search order: 剧名 → 别名 → 拼音/首字母 → 题材 → 有限纠错. A candidate only counts as
 * a completion when the query is covered by the candidate text, and a text that literally starts with
 * the query is preferred inside the stage. The 题材 arm contributes vocabulary (no `contentId`), the
 * work-level arms carry the id, and 个人探索 is absent by construction because the public index never
 * holds a private row and the SQL still filters `is_private = 0` plus the four public channels.
 */

import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import type { SearchSuggestion, SearchSuggestionType, SuggestionsResponse } from '../types/api';
import { SEARCH_MAX_SUGGESTIONS } from '../core/constants';
import { correctionCandidates } from '../search/correct';
import {
  NAME_STAGES,
  RELATED_STAGE,
  covers,
  displayStringsByContentId,
  stageRecall,
  type LexicalStage,
  type StageTextSource
} from '../search/lexical';
import { jsonResponse } from '../http/json';
import { readQueryParameter } from './search';

const SUGGESTIONS_CACHE_CONTROL = 'no-store';
const SUGGESTION_STAGE_RECALL_LIMIT = SEARCH_MAX_SUGGESTIONS * 2;

interface StageSpec {
  type: SearchSuggestionType;
  source: StageTextSource;
  carriesContentId: boolean;
}

/** The three name stages plus the controlled tag vocabulary, in contract order. */
const SUGGESTION_STAGES: readonly StageSpec[] = [
  { type: 'title', source: 'title', carriesContentId: true },
  { type: 'alias', source: 'alias', carriesContentId: true },
  { type: 'pinyin', source: 'pinyin', carriesContentId: true },
  { type: 'category', source: 'tag', carriesContentId: false }
];

function comparable(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/** One honest completion per content id: covered by the query, preferring a literal prefix. */
function stageEntries(
  query: string,
  ids: readonly string[],
  strings: Map<string, string[]>,
  vocabulary: boolean
): { text: string; contentId: string }[] {
  const needle = comparable(query);
  const entries: { text: string; contentId: string }[] = [];
  const emitted = new Set<string>();
  for (const contentId of ids) {
    const covered = (strings.get(contentId) ?? []).filter((text) => covers(query, text));
    if (covered.length === 0) continue;
    // A work-level completion offers one name per work; a vocabulary completion offers every term,
    // because the client is browsing the 题材 list rather than jumping straight to a single work.
    const candidates = vocabulary ? covered : [covered.find((text) => comparable(text).startsWith(needle)) ?? (covered[0] as string)];
    for (const text of candidates) {
      const key = `${text} ${contentId}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      entries.push({ text, contentId });
    }
  }
  return entries;
}

/**
 * Same text reached from two works (AC-16 同名异剧) must not pretend to identify one of them: the text
 * stays offered, the `contentId` is dropped, and the client re-queries instead of jumping blind.
 */
function suggestionsFrom(
  entries: readonly { text: string; contentId: string }[],
  type: SearchSuggestionType,
  carriesContentId: boolean
): SearchSuggestion[] {
  const grouped: { text: string; owners: string[] }[] = [];
  const indexOf = new Map<string, number>();
  for (const entry of entries) {
    const key = comparable(entry.text);
    const at = indexOf.get(key);
    const bucket = at === undefined ? undefined : grouped[at];
    if (at === undefined || bucket === undefined) {
      indexOf.set(key, grouped.length);
      grouped.push({ text: entry.text, owners: [entry.contentId] });
    } else if (!bucket.owners.includes(entry.contentId)) {
      bucket.owners.push(entry.contentId);
    }
  }
  return grouped.map((bucket) => ({
    text: bucket.text,
    type,
    ...(carriesContentId && bucket.owners.length === 1 ? { contentId: bucket.owners[0] } : {})
  }));
}

async function stageSuggestions(
  db: D1Database,
  query: string,
  spec: StageSpec,
  stageIndex: number
): Promise<SearchSuggestion[]> {
  const stage = stageIndex < NAME_STAGES.length ? (NAME_STAGES[stageIndex] as LexicalStage) : RELATED_STAGE;
  const recall = await stageRecall(db, stage, { query, limit: SUGGESTION_STAGE_RECALL_LIMIT });
  if (recall.length === 0) return [];
  const strings = await displayStringsByContentId(db, recall.map((item) => item.contentId), spec.source);
  return suggestionsFrom(
    stageEntries(query, recall.map((item) => item.contentId), strings, !spec.carriesContentId),
    spec.type,
    spec.carriesContentId
  );
}

export async function handleSearchSuggestions(request: Request, env: Env, _clock: Clock): Promise<Response> {
  const searchParams = new URL(request.url).searchParams;
  const query = readQueryParameter(searchParams);
  if (!query.ok) return query.response;

  const suggestions: SearchSuggestion[] = [];
  const seen = new Set<string>();
  const add = (candidate: SearchSuggestion): void => {
    // One text per surface: the same string reached through two stages is one completion, not two.
    const key = comparable(candidate.text);
    if (key === '' || seen.has(key) || suggestions.length >= SEARCH_MAX_SUGGESTIONS) return;
    seen.add(key);
    suggestions.push(candidate);
  };

  for (let index = 0; index < SUGGESTION_STAGES.length; index += 1) {
    if (suggestions.length >= SEARCH_MAX_SUGGESTIONS) break;
    for (const suggestion of await stageSuggestions(env.DB, query.value, SUGGESTION_STAGES[index] as StageSpec, index)) {
      add(suggestion);
    }
  }

  if (suggestions.length < SEARCH_MAX_SUGGESTIONS) {
    // Corrections go through the same grouping as the name stages, so an ambiguous corrected text
    // never claims a single work either.
    const corrected = (await correctionCandidates(env.DB, query.value)).map((candidate) => ({
      text: candidate.term,
      contentId: candidate.contentId
    }));
    for (const suggestion of suggestionsFrom(corrected, 'correction', true)) add(suggestion);
  }

  const body: SuggestionsResponse = { query: query.value, suggestions };
  return jsonResponse(body, 200, { 'Cache-Control': SUGGESTIONS_CACHE_CONTROL });
}
