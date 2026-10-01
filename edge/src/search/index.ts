/**
 * Public lexical index writer for `public_search_fts` (SPEC §6).
 *
 * One row per content id, built from the authoritative tables:
 *   title_tokens  <- content_items.title        (pre-tokenised CJK grams, see core/tokens.ts)
 *   alias_tokens  <- content_aliases.alias       (pre-tokenised)
 *   pinyin_tokens <- content_aliases.pinyin + pinyin_initials (stored verbatim, lowercased)
 *   tag_tokens    <- content_tags.tag             (pre-tokenised)
 *
 * SPEC §6 pins one invariant this module owns: 私密不进入公开 FTS. A private row is refused before a
 * single statement runs, and an unpublished row is refused too — the correct move for those is
 * `removeContentFromIndex`, never a write.
 *
 * OPEN GAP (needs Master): there is no Han -> pinyin dictionary in this repo and M-5 forbids a new
 * dependency, so `pinyin`/`pinyin_initials` are *input* data supplied by operators or ingest. This
 * writer indexes and refreshes it; it does not generate it.
 */

import { indexTokenColumn } from '../core/tokens';
import { findContentRow, listTagsOfContent, type ContentRow } from '../db/content-repo';

/** A `content_aliases` row in the shape the index consumes. */
export interface IndexAlias {
  alias: string;
  pinyin: string | null;
  pinyin_initials: string | null;
}

export interface SearchIndexTokens {
  contentId: string;
  titleTokens: string;
  aliasTokens: string;
  pinyinTokens: string;
  tagTokens: string;
}

export type IndexRefusalReason = 'unknown' | 'private' | 'unpublished';

/** Raised instead of writing a forbidden row; ops and ingest must treat it as a hard error. */
export class PublicIndexRefusalError extends Error {
  constructor(
    readonly reason: IndexRefusalReason,
    readonly contentId: string
  ) {
    super(`public_search_fts write refused (${reason}) for ${contentId}`);
    this.name = 'PublicIndexRefusalError';
  }
}

const ALIAS_SELECT =
  'SELECT alias, pinyin, pinyin_initials FROM content_aliases WHERE content_id = ? ORDER BY alias ASC';

const INSERT_SQL =
  'INSERT INTO public_search_fts (content_id, title_tokens, alias_tokens, pinyin_tokens, tag_tokens) VALUES (?, ?, ?, ?, ?)';
const DELETE_SQL = 'DELETE FROM public_search_fts WHERE content_id = ?';

export async function readIndexAliases(db: D1Database, contentId: string): Promise<IndexAlias[]> {
  const rows = await db.prepare(ALIAS_SELECT).bind(contentId).all<IndexAlias>();
  return rows.results;
}

function trimmed(value: string | null | undefined): string {
  return (value ?? '').normalize('NFKC').trim();
}

/** Each term is tokenised on its own, then the columns are space-joined (SPEC §11 worked example). */
function tokenColumn(values: readonly (string | null | undefined)[]): string {
  return [...new Set(values.map(trimmed).filter((value) => value !== ''))].map(indexTokenColumn).join(' ');
}

/** Pure builder, so fixtures and the production writer can never drift apart. */
export function buildIndexTokens(entry: {
  contentId: string;
  title: string;
  aliases: readonly IndexAlias[];
  tags: readonly string[];
}): SearchIndexTokens {
  const pinyinParts = entry.aliases.flatMap((alias) => [alias.pinyin, alias.pinyin_initials]);
  return {
    contentId: entry.contentId,
    titleTokens: indexTokenColumn(entry.title),
    aliasTokens: tokenColumn(entry.aliases.map((alias) => alias.alias)),
    // Syllables and initials are already whitespace-separated words; unicode61 indexes them as terms.
    pinyinTokens: tokenColumn(pinyinParts).toLowerCase(),
    tagTokens: tokenColumn(entry.tags)
  };
}

function refusalReason(row: ContentRow | null): IndexRefusalReason | null {
  if (row === null) return 'unknown';
  if (row.is_private === 1 || row.channel_id === 'private') return 'private';
  if (row.enabled !== 1) return 'unpublished';
  return null;
}

async function assertIndexable(db: D1Database, contentId: string): Promise<ContentRow> {
  const row = await findContentRow(db, contentId);
  const reason = refusalReason(row);
  if (reason !== null || row === null) throw new PublicIndexRefusalError(reason ?? 'unknown', contentId);
  return row;
}

/**
 * Rebuilds the single index row for one content id: delete-then-insert inside one `db.batch()`, so
 * running it twice leaves exactly one row and never a duplicate hit.
 */
export async function reindexContent(db: D1Database, contentId: string): Promise<SearchIndexTokens> {
  const row = await assertIndexable(db, contentId);
  const [aliases, tags] = await Promise.all([readIndexAliases(db, contentId), listTagsOfContent(db, contentId)]);
  const tokens = buildIndexTokens({ contentId, title: row.title, aliases, tags });
  await db.batch([
    db.prepare(DELETE_SQL).bind(contentId),
    db.prepare(INSERT_SQL).bind(tokens.contentId, tokens.titleTokens, tokens.aliasTokens, tokens.pinyinTokens, tokens.tagTokens)
  ]);
  return tokens;
}

/** Drop a work from the public index: unpublish, private flip, or a hard delete. */
export async function removeContentFromIndex(db: D1Database, contentId: string): Promise<void> {
  await db.batch([db.prepare(DELETE_SQL).bind(contentId)]);
}

export interface AliasTerm {
  alias: string;
  pinyin?: string | null;
  pinyinInitials?: string | null;
}

export interface ContentTermsInput {
  aliases?: readonly AliasTerm[];
  tags?: readonly string[];
  /** `content_tags.taxonomy_version` is NOT NULL; the controlled vocabulary version the tags came from. */
  taxonomyVersion?: number;
}

/**
 * Ops/ingest entry point: replace the alias and tag vocabulary of one work (delete-then-insert per
 * table, in a single batch) and rebuild its index row. Refuses a private or unpublished work before
 * touching any table, so a mis-piped id can never seed the public index.
 */
export async function putContentTermsAndIndex(
  db: D1Database,
  contentId: string,
  input: ContentTermsInput
): Promise<SearchIndexTokens> {
  await assertIndexable(db, contentId);
  const statements: D1PreparedStatement[] = [];
  const taxonomyVersion = input.taxonomyVersion ?? 1;

  if (input.aliases !== undefined) {
    const unique = [...new Map(input.aliases.map((term) => [term.alias, term])).values()];
    statements.push(db.prepare('DELETE FROM content_aliases WHERE content_id = ?').bind(contentId));
    for (const term of unique) {
      statements.push(
        db
          .prepare('INSERT INTO content_aliases (content_id, alias, pinyin, pinyin_initials) VALUES (?, ?, ?, ?)')
          .bind(contentId, term.alias, term.pinyin ?? null, term.pinyinInitials ?? null)
      );
    }
  }
  if (input.tags !== undefined) {
    const uniqueTags = [...new Set(input.tags)];
    statements.push(db.prepare('DELETE FROM content_tags WHERE content_id = ?').bind(contentId));
    for (const tag of uniqueTags) {
      statements.push(
        db
          .prepare('INSERT INTO content_tags (content_id, tag, taxonomy_version) VALUES (?, ?, ?)')
          .bind(contentId, tag, taxonomyVersion)
      );
    }
  }
  if (statements.length > 0) await db.batch(statements);
  return reindexContent(db, contentId);
}
