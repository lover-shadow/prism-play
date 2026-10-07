/**
 * Query planning for the pure-lexical search surface (F-13, M-5).
 *
 * The candidate order is contractual, not a suggestion (API-SPEC §八): 精确/别名 → 拼音/首字母 →
 * 模糊纠偏 → 题材同类. Each stage is one FTS5 MATCH against one `public_search_fts` column joined back
 * to `content_items`, because the index is only ever a *candidate source* and D1 is the authority
 * (SPEC §6): the join carries the visibility predicate, so an unpublished or privately-flipped work
 * disappears from the very next request even if its index row is still there.
 *
 * Precision note (SPEC §11 trap #2): unicode61 does not segment Han, so a stage's MATCH expression is
 * an OR over the query's own grams and therefore recalls anything sharing a single character. Recall is
 * deliberately broad and the `covers()` check afterwards is what makes the hit honest: every gram of the
 * query must be present in the matched column. A query that fails coverage in every name column falls
 * through to the correction stage, which is where `matchType: 'fuzzy'` comes from.
 */

import { indexTokenColumn, indexTokens, isCjkChar, matchExpression } from '../core/tokens';
import type { MatchType } from '../types/api';
import {
  STAGE_ORDER_BY,
  correctionCandidates,
  correctionIds,
  publicVisibilityClause,
  type StageFilters
} from './correct';

/** Upper bound of ids pulled per stage; paging past this is best-effort, same as cross-page stability. */
export const SEARCH_STAGE_CANDIDATE_LIMIT = 120;

type FtsColumn = 'title_tokens' | 'alias_tokens' | 'pinyin_tokens' | 'tag_tokens';

export interface LexicalStage {
  readonly matchType: MatchType;
  readonly column: FtsColumn;
}

/** 精确剧名 / 别名 / 拼音与首字母. */
export const NAME_STAGES: readonly LexicalStage[] = [
  { matchType: 'exact', column: 'title_tokens' },
  { matchType: 'alias', column: 'alias_tokens' },
  { matchType: 'pinyin', column: 'pinyin_tokens' }
];

/** 题材同类: the controlled `content_tags` vocabulary is the only tag-backed stage. */
export const RELATED_STAGE: LexicalStage = { matchType: 'related', column: 'tag_tokens' };

export interface StageRequest extends StageFilters {
  query: string;
  limit?: number;
}

export interface StageHit {
  matchType: MatchType;
  contentIds: string[];
}

export interface RankedCandidate {
  contentId: string;
  matchType: MatchType;
}

export interface StageRecall {
  contentId: string;
  columnText: string;
}

/** Text columns a suggestion may be displayed from; all of them are authoritative D1 data. */
export type StageTextSource = 'title' | 'alias' | 'pinyin' | 'tag';

const TEXT_QUERIES: Record<StageTextSource, string> = {
  title: 'SELECT c.id AS content_id, c.title AS text FROM content_items c WHERE c.id IN',
  alias: 'SELECT content_id, alias AS text FROM content_aliases WHERE content_id IN',
  pinyin: 'SELECT content_id, pinyin AS text, pinyin_initials AS initials FROM content_aliases WHERE content_id IN',
  tag: 'SELECT content_id, tag AS text FROM content_tags WHERE content_id IN'
};

function termsOf(columnText: string): string[] {
  return columnText.split(' ').filter((term) => term !== '');
}

/**
 * Precision step. Recall is broad by construction, so a hit only counts when the candidate really
 * contains the query: a latin gram may also be matched by an indexed term that starts with it, which is
 * what makes partial pinyin (`zha` -> `zhan`) and partial english names work. Han grams need no prefix
 * rule, because the write side already stored single characters and bigrams.
 */
function coversTerms(grams: readonly string[], terms: readonly string[]): boolean {
  if (grams.length === 0 || terms.length === 0) return false;
  return grams.every((gram) =>
    terms.some((term) => term === gram || (isCjkChar(gram.charAt(0) as string)
      ? gram.length > 2 && term.includes(gram)
      : gram.length >= 2 && term.startsWith(gram)))
  );
}

export interface CompiledCoverage { normalized: string; tokens: string[] }
export function normalizeCoverage(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}
export function compileCoverage(value: string): CompiledCoverage {
  return { normalized: normalizeCoverage(value), tokens: indexTokens(value) };
}
/** Reusable precision predicate for a generation's precompiled display terms. */
export function coversCompiled(query: CompiledCoverage, target: CompiledCoverage): boolean {
  return query.normalized !== '' && (target.normalized.includes(query.normalized) || coversTerms(query.tokens, target.tokens));
}

/** Against a display string from an authoritative column (`content_items.title`, `content_aliases.alias`). */
export function covers(query: string, text: string): boolean {
  return coversCompiled(compileCoverage(query), compileCoverage(text));
}

/** Against a pre-tokenised `public_search_fts` column, whose terms are already space-separated. */
export function coversColumn(query: string, columnText: string): boolean {
  return coversTerms(indexTokens(query), termsOf(columnText));
}

/** Whole-name hit == the query's own gram string, i.e. the user typed the name exactly. */
function isWholeNameHit(query: string, columnText: string): boolean {
  const built = indexTokenColumn(query);
  return built !== '' && built === columnText.trim();
}

/**
 * One stage: FTS recall on `stage.column`, visibility predicate from the same statement, coverage
 * verification, then whole-name hits first so the literal title surfaces above partial ones.
 * `stage.column` is interpolated from the frozen stage table above and is never request data; every
 * value that can come from a client arrives as a bound placeholder.
 */
export async function stageRecall(
  db: D1Database,
  stage: LexicalStage,
  request: StageRequest
): Promise<StageRecall[]> {
  const expression = matchExpression(request.query, { prefixLatin: true });
  if (expression === null) return [];
  const visibility = publicVisibilityClause(request);
  const limit = request.limit ?? SEARCH_STAGE_CANDIDATE_LIMIT;
  const rows = await db
    .prepare(
      `SELECT f.content_id AS content_id, f.${stage.column} AS column_text FROM public_search_fts f ` +
        `JOIN content_items c ON c.id = f.content_id WHERE f.${stage.column} MATCH ?${visibility.sql}${STAGE_ORDER_BY} LIMIT ?`
    )
    .bind(expression, ...visibility.values, limit)
    .all<{ content_id: string; column_text: string | null }>();

  const wholeName: StageRecall[] = [];
  const partial: StageRecall[] = [];
  const claimed = new Set<string>();
  for (const row of rows.results) {
    const columnText = row.column_text ?? '';
    // A work can match the same stage twice (two aliases); the first row in contract order wins.
    if (claimed.has(row.content_id) || !coversColumn(request.query, columnText)) continue;
    claimed.add(row.content_id);
    if (isWholeNameHit(request.query, columnText)) wholeName.push({ contentId: row.content_id, columnText });
    else partial.push({ contentId: row.content_id, columnText });
  }
  return [...wholeName, ...partial];
}

async function stageHit(db: D1Database, stage: LexicalStage, request: StageRequest): Promise<StageHit> {
  const recall = await stageRecall(db, stage, request);
  return { matchType: stage.matchType, contentIds: recall.map((item) => item.contentId) };
}

/**
 * All stages in contract order. The correction stage sits between pinyin and 题材同类 exactly as
 * API-SPEC §八 requires, so a typo only reports `fuzzy` when no name column covered the query.
 */
export async function planStages(db: D1Database, request: StageRequest): Promise<StageHit[]> {
  const hits: StageHit[] = [];
  for (const stage of NAME_STAGES) hits.push(await stageHit(db, stage, request));
  const corrections = await correctionCandidates(db, request.query, request);
  hits.push({ matchType: 'fuzzy', contentIds: correctionIds(corrections) });
  hits.push(await stageHit(db, RELATED_STAGE, request));
  return hits;
}

/** Dedupe across stages by content id, keeping the earliest (best) stage and therefore its matchType. */
export function rankCandidates(hits: readonly StageHit[]): RankedCandidate[] {
  const seen = new Set<string>();
  const ranked: RankedCandidate[] = [];
  for (const hit of hits) {
    for (const contentId of hit.contentIds) {
      if (seen.has(contentId)) continue;
      seen.add(contentId);
      ranked.push({ contentId, matchType: hit.matchType });
    }
  }
  return ranked;
}

export function pageSlice(candidates: readonly RankedCandidate[], page: number, pageSize: number): RankedCandidate[] {
  const offset = (page - 1) * pageSize;
  return candidates.slice(offset, offset + pageSize);
}

/** Display text for ids from the authoritative tables; used by `/api/search/suggestions`. */
export async function displayStringsByContentId(
  db: D1Database,
  ids: readonly string[],
  source: StageTextSource
): Promise<Map<string, string[]>> {
  const grouped = new Map<string, string[]>();
  if (ids.length === 0) return grouped;
  const placeholders = ids.map(() => '?').join(', ');
  if (source === 'pinyin') {
    const rows = await db
      .prepare(`${TEXT_QUERIES.pinyin} (${placeholders}) ORDER BY content_id ASC, alias ASC`)
      .bind(...ids)
      .all<{ content_id: string; text: string | null; initials: string | null }>();
    for (const row of rows.results) {
      push(grouped, row.content_id, row.text);
      push(grouped, row.content_id, row.initials);
    }
    return grouped;
  }
  const order = source === 'title' ? ' ORDER BY c.id ASC' : ' ORDER BY content_id ASC, text ASC';
  const rows = await db
    .prepare(`${TEXT_QUERIES[source]} (${placeholders})${order}`)
    .bind(...ids)
    .all<{ content_id: string; text: string | null }>();
  for (const row of rows.results) push(grouped, row.content_id, row.text);
  return grouped;
}

function push(grouped: Map<string, string[]>, contentId: string, value: string | null): void {
  const text = (value ?? '').trim();
  if (text === '') return;
  const bucket = grouped.get(contentId);
  if (bucket === undefined) grouped.set(contentId, [text]);
  else if (!bucket.includes(text)) bucket.push(text);
}
