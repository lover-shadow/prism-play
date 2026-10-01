/**
 * Bounded typo correction for the lexical surface (SPEC §12.1 item 2: 错字).
 *
 * No model, no network, no new dependency (M-5): the query is compared against terms that already
 * exist in `public_search_fts`, and a substitution is accepted only when the optimal-string-alignment
 * distance to the query is within budget. Recall is FTS-indexed — one single-column MATCH per token
 * column, because SQLite rejects `MATCH ... OR MATCH ...` across columns — and every recalled row is
 * re-validated against `content_items` inside the same statement, so a withdrawn or private work can
 * never be offered as a correction.
 *
 * Threshold: 1 edit, and only for terms of at least 2 characters (4 for latin/pinyin).
 * Why 1 and not 2: this corpus is small and names are short, so a budget of 2 already maps one query
 * onto unrelated works (「甜宠」 and 「战神」 are exactly 2 edits apart). AC-16 asks for single-typo
 * recovery, not tolerant IR, and widening the budget would corrupt the `matchType: 'fuzzy'` signal the
 * client uses to tell the user "we corrected you".
 *
 * Known limit, stated rather than hidden: recall needs one exact query gram to hit the index, so a Han
 * typo is always reachable (it shares 5 of 7 grams with the title) while a latin/pinyin typo is only
 * correctable when at least one syllable is still spelled right. Prefixing the recall would turn every
 * partial pinyin into a "correction", which is a completion, not a typo fix, and belongs to
 * `/api/search/suggestions` instead.
 */

import { isCjkChar, matchExpression } from '../core/tokens';
import { PUBLIC_CHANNEL_IDS } from '../types/api';

/** Columns a typo may be corrected against; the tag vocabulary is a different match class. */
const CORRECTION_COLUMNS = ['title_tokens', 'alias_tokens', 'pinyin_tokens'] as const;

/** Rows pulled per column before the distance filter, so the worst case stays bounded on a big corpus. */
export const CORRECTION_RECALL_ROW_LIMIT = 64;
export const CORRECTION_MAX_TERMS = 24;
export const CORRECTION_MAX_DISTANCE = 1;
const MIN_HAN_TERM_LENGTH = 2;
const MIN_LATIN_TERM_LENGTH = 4;
/** Below this a query has no typo signal: it is a prefix, and the prefix path already serves it. */
const MIN_QUERY_LENGTH = 2;

export interface StageFilters {
  /** Public channel the caller narrowed to; `private` is rejected by the route before it gets here. */
  channel?: string;
  /** Controlled `content_tags` vocabulary term the caller narrowed to. */
  tag?: string;
}

/**
 * The one visibility predicate every public search statement shares, assembled from bound placeholders
 * only. `channel_id IN (four public ids)` is a second fence behind `is_private = 0`: SPEC §10 scopes
 * public search to the four public channels, so even a stray private row in the FTS table stays hidden.
 */
export function publicVisibilityClause(
  filters: StageFilters,
  alias = 'c'
): { sql: string; values: string[] } {
  const prefix = `${alias}.`;
  let sql = ` AND ${prefix}enabled = 1 AND ${prefix}is_private = 0 AND ${prefix}channel_id IN (?, ?, ?, ?)`;
  const values: string[] = [...PUBLIC_CHANNEL_IDS];
  if (filters.channel !== undefined) {
    sql += ` AND ${prefix}channel_id = ?`;
    values.push(filters.channel);
  }
  if (filters.tag !== undefined) {
    sql += ` AND EXISTS (SELECT 1 FROM content_tags t WHERE t.content_id = ${prefix}id AND t.tag = ?)`;
    values.push(filters.tag);
  }
  return { sql, values };
}

/** Deterministic candidate order inside a stage; SPEC already concedes cross-page stability is best-effort. */
export const STAGE_ORDER_BY = ' ORDER BY c.first_published_at DESC, c.id ASC';

export interface CorrectionCandidate {
  term: string;
  contentId: string;
  distance: number;
}

function normalizeTerm(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function isLatinTerm(term: string): boolean {
  return !isCjkChar(term.charAt(0) as string);
}

/**
 * Optimal-string-alignment distance (Levenshtein plus one adjacent transposition, which is what a
 * keyboard slip actually is). Names are short (< 80 code points), so the full matrix is negligible.
 */
export function editDistance(input: string, target: string): number {
  const left = [...input];
  const right = [...target];
  const matrix: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0)
  );
  for (let i = 0; i <= left.length; i += 1) matrix[i][0] = i;
  for (let j = 0; j <= right.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = (matrix[i - 1]![j - 1] as number) + (left[i - 1] === right[j - 1] ? 0 : 1);
      const deletion = (matrix[i - 1]![j] as number) + 1;
      const insertion = (matrix[i]![j - 1] as number) + 1;
      let best = Math.min(substitution, deletion, insertion);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) {
        best = Math.min(best, (matrix[i - 2]![j - 2] as number) + 1);
      }
      matrix[i]![j] = best;
    }
  }
  return matrix[left.length]![right.length] as number;
}

/** 0 means "no correction is allowed for this term at all". */
function distanceBudget(term: string): number {
  const length = [...term].length;
  if (length === 0) return 0;
  if (isLatinTerm(term)) return length >= MIN_LATIN_TERM_LENGTH ? CORRECTION_MAX_DISTANCE : 0;
  return length >= MIN_HAN_TERM_LENGTH ? CORRECTION_MAX_DISTANCE : 0;
}

export function isCorrectionWithinBudget(query: string, term: string): boolean {
  const normalizedQuery = normalizeTerm(query);
  const normalizedTerm = normalizeTerm(term);
  if (normalizedQuery === '' || normalizedTerm === '') return false;
  // A one-character query carries no typo signal at all: it is a prefix query, and the prefix path
  // already serves it. Without this floor a search for 「战」 would "correct" itself to 「战神」.
  if ([...normalizedQuery].length < MIN_QUERY_LENGTH) return false;
  const distance = editDistance(normalizedQuery, normalizedTerm);
  return distance > 0 && distance <= distanceBudget(normalizedTerm);
}

interface TermRow {
  content_id: string;
  terms: string | null;
}

async function recallTermRows(
  db: D1Database,
  column: string,
  expression: string,
  filters: StageFilters
): Promise<TermRow[]> {
  const visibility = publicVisibilityClause(filters);
  const rows = await db
    .prepare(
      `SELECT f.content_id AS content_id, f.${column} AS terms FROM public_search_fts f ` +
        `JOIN content_items c ON c.id = f.content_id WHERE f.${column} MATCH ?${visibility.sql}${STAGE_ORDER_BY} LIMIT ?`
    )
    .bind(expression, ...visibility.values, CORRECTION_RECALL_ROW_LIMIT)
    .all<TermRow>();
  return rows.results;
}

/**
 * Corrected terms for a query, ordered by (distance, term, content id) so identical input always yields
 * an identical list. Distance 0 is not a correction — that is the exact hit an earlier stage reported.
 */
export async function correctionCandidates(
  db: D1Database,
  query: string,
  filters: StageFilters = {}
): Promise<CorrectionCandidate[]> {
  const expression = matchExpression(query);
  if (expression === null) return [];
  const found: CorrectionCandidate[] = [];
  const seen = new Set<string>();
  for (const column of CORRECTION_COLUMNS) {
    const rows = await recallTermRows(db, column, expression, filters);
    for (const row of rows) {
      for (const term of (row.terms ?? '').split(' ')) {
        if (term === '' || !isCorrectionWithinBudget(query, term)) continue;
        const key = `${term} ${row.content_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ term, contentId: row.content_id, distance: editDistance(normalizeTerm(query), normalizeTerm(term)) });
      }
    }
  }
  found.sort((left, right) => {
    if (left.distance !== right.distance) return left.distance - right.distance;
    if (left.term !== right.term) return left.term < right.term ? -1 : 1;
    return left.contentId < right.contentId ? -1 : left.contentId === right.contentId ? 0 : 1;
  });
  return found.slice(0, CORRECTION_MAX_TERMS);
}

/** Ids the correction stage contributes, best distance first, deduped. */
export function correctionIds(candidates: readonly CorrectionCandidate[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.contentId)) continue;
    seen.add(candidate.contentId);
    ids.push(candidate.contentId);
  }
  return ids;
}
