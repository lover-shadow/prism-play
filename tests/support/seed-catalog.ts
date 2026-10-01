import type { SqliteD1 } from './sqlite-d1';
import { indexTokenColumn } from '../../edge/src/core/tokens';
import { TEST_BASE_TIME_SECONDS } from './test-env';
import { insert, seedContent, seedEpisode } from './seed';

/** Search-side fixtures: aliases, controlled tags and the pre-tokenised FTS row. */

export interface AliasSeed {
  contentId: string;
  alias: string;
  pinyin?: string;
  pinyinInitials?: string;
}

export function seedAlias(db: SqliteD1, alias: AliasSeed): void {
  insert(db, 'content_aliases', {
    content_id: alias.contentId,
    alias: alias.alias,
    pinyin: alias.pinyin ?? null,
    pinyin_initials: alias.pinyinInitials ?? null
  });
}

export function seedTag(db: SqliteD1, contentId: string, tag: string, taxonomyVersion = 1): void {
  insert(db, 'content_tags', { content_id: contentId, tag, taxonomy_version: taxonomyVersion });
}

/** Writes the FTS row the way production must: pre-generated Chinese grams, never the raw title alone. */
export function seedSearchRow(
  db: SqliteD1,
  entry: {
    contentId: string;
    title: string;
    aliases?: readonly { alias: string; pinyin?: string; pinyinInitials?: string }[];
    tags?: readonly string[];
  }
): void {
  const aliasText = (entry.aliases ?? []).map((item) => item.alias).join(' ');
  const pinyinText = (entry.aliases ?? [])
    .flatMap((item) => [item.pinyin, item.pinyinInitials])
    .filter((value): value is string => value !== undefined)
    .join(' ');
  db.execute(
    'INSERT INTO public_search_fts (content_id, title_tokens, alias_tokens, pinyin_tokens, tag_tokens) VALUES (?, ?, ?, ?, ?)',
    entry.contentId,
    indexTokenColumn(entry.title),
    aliasText === '' ? '' : indexTokenColumn(aliasText),
    pinyinText.toLowerCase(),
    (entry.tags ?? []).map((tag) => indexTokenColumn(tag)).join(' ')
  );
}

export function seedCatalogChange(
  db: SqliteD1,
  contentId: string,
  operation: 'upsert' | 'delete',
  now = TEST_BASE_TIME_SECONDS
): number {
  db.execute(
    'INSERT INTO public_catalog_changes (content_id, operation, changed_at) VALUES (?, ?, ?)',
    contentId,
    operation,
    now
  );
  const row = db.selectOne('SELECT MAX(revision) AS revision FROM public_catalog_changes');
  return Number(row?.revision ?? 0);
}

export interface WorkSeed {
  id: string;
  channelId?: string;
  title: string;
  category?: string;
  episodes?: number;
  shareable?: number;
  isPrivate?: number;
  coverVersion?: string | null;
  synopsis?: string | null;
  aliases?: readonly { alias: string; pinyin?: string; pinyinInitials?: string }[];
  tags?: readonly string[];
}

/**
 * Publishes a work the way `ingest/publish.ts` does — the flip and the change row together — so the
 * catalogue, change-feed and share suites all start from a state the production path can reach.
 * Private works get no change row and no public FTS entry (SPEC §6 「私密不进入公开 FTS」).
 */
export function seedPublishedWork(
  db: SqliteD1,
  work: WorkSeed,
  now = TEST_BASE_TIME_SECONDS
): { revision: number; episodeIds: number[] } {
  const channelId = work.channelId ?? 'drama';
  seedContent(db, {
    id: work.id,
    channelId,
    title: work.title,
    category: work.category,
    isPrivate: work.isPrivate ?? 0,
    enabled: 1,
    shareable: work.shareable ?? 1,
    coverVersion: work.coverVersion ?? `v1-${work.id}`,
    synopsis: work.synopsis ?? null,
    firstPublishedAt: now
  }, now);

  const episodeIds: number[] = [];
  for (let number = 1; number <= (work.episodes ?? 1); number += 1) {
    episodeIds.push(seedEpisode(db, work.id, number, 120, now));
  }

  for (const alias of work.aliases ?? []) {
    seedAlias(db, { contentId: work.id, ...alias });
  }
  for (const tag of work.tags ?? []) {
    seedTag(db, work.id, tag);
  }

  const isPrivate = channelId === 'private';
  const revision = isPrivate ? 0 : seedCatalogChange(db, work.id, 'upsert', now);
  if (!isPrivate) {
    seedSearchRow(db, {
      contentId: work.id,
      title: work.title,
      aliases: work.aliases ?? [],
      tags: work.tags ?? []
    });
  }
  return { revision, episodeIds };
}
