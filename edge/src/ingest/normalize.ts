import type { ProviderEpisodeRef, ProviderWork } from './adapter';

/**
 * Deterministic, token-free and alias-free normalisation for the ingest path.
 *
 * Scope guard (AC-17 / M-5): nothing here may be used to decide that two works are "the same".
 * Identity comes only from `(provider_id, source_item_id)` or a `trusted_work_mappings` row, so a
 * title is normalised purely to obtain a stable storage/display form and a stable identifier shape.
 */

export const CONTENT_ID_MAX_LENGTH = 96;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeTitle(value: string): string {
  return collapseWhitespace(value.normalize('NFKC'));
}

/** Source classification is adopted verbatim; only stray whitespace is removed (API-SPEC §八). */
export function normalizeCategory(value: string): string {
  return collapseWhitespace(value);
}

export function normalizeOptionalText(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const collapsed = collapseWhitespace(value.normalize('NFKC'));
  return collapsed === '' ? null : collapsed;
}

function sanitizeIdentityToken(value: string): string {
  const sanitized = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return sanitized === '' ? 'x' : sanitized;
}

/** Non-cryptographic FNV-1a; used only to keep over-long identifiers bounded and stable. */
export function fnv1a32Hex(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Work id for a brand-new `content_items` row. Derived from the same-source identity alone, so
 * re-ingesting a page yields the same id without a read (idempotency) and two providers carrying the
 * same title never collide (AC-17 同名异剧分立).
 */
export function stableContentId(providerId: string, sourceItemId: string): string {
  const composed = `w_${sanitizeIdentityToken(providerId)}-${sanitizeIdentityToken(sourceItemId)}`;
  if (composed.length <= CONTENT_ID_MAX_LENGTH) return composed;
  return `${composed.slice(0, CONTENT_ID_MAX_LENGTH - 9)}-${fnv1a32Hex(composed)}`;
}

/** Poster version for `content_items.cover_version`; changes only when the source cover changes. */
export function coverVersionOf(coverUrl: string | null): string | null {
  return coverUrl === null ? null : fnv1a32Hex(coverUrl);
}

/** Fixed key order and null-for-absent so the same payload always serialises to the same string. */
export function serializeWorkPayload(work: ProviderWork): string {
  return JSON.stringify({
    sourceItemId: work.sourceItemId,
    sourceRevision: work.sourceRevision,
    title: work.title,
    category: work.category,
    synopsis: work.synopsis ?? null,
    coverUrl: work.coverUrl ?? null,
    episodes: work.episodes.map((episode: ProviderEpisodeRef) => ({
      sourceEpisodeId: episode.sourceEpisodeId,
      episodeNumber: episode.episodeNumber,
      durationSeconds: episode.durationSeconds ?? null
    }))
  });
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function episodeOf(value: unknown): ProviderEpisodeRef | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const sourceEpisodeId = source.sourceEpisodeId;
  const episodeNumber = source.episodeNumber;
  if (typeof sourceEpisodeId !== 'string') return null;
  if (typeof episodeNumber !== 'number' || !Number.isFinite(episodeNumber)) return null;
  const episode: ProviderEpisodeRef = { sourceEpisodeId, episodeNumber };
  const durationSeconds = source.durationSeconds;
  if (typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)) {
    episode.durationSeconds = durationSeconds;
  }
  return episode;
}

/**
 * Rehydrates a stored `metadata_json` for a retry attempt. Unknown fields are ignored rather than
 * trusted — privacy is derived from `channel_id`, never from anything a source sent.
 * `null` is a signal to the caller to record a failure, never a swallowed error.
 */
export function parseWorkPayload(raw: string): ProviderWork | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const source = parsed as Record<string, unknown>;
  const sourceItemId = textOf(source.sourceItemId);
  const sourceRevision = textOf(source.sourceRevision);
  const title = textOf(source.title);
  const category = textOf(source.category);
  const rawEpisodes = source.episodes;
  if (sourceItemId === undefined || sourceRevision === undefined || title === undefined) return null;
  if (category === undefined || !Array.isArray(rawEpisodes)) return null;

  const episodes: ProviderEpisodeRef[] = [];
  for (const entry of rawEpisodes) {
    const episode = episodeOf(entry);
    if (episode === null) return null;
    episodes.push(episode);
  }

  const work: ProviderWork = { sourceItemId, sourceRevision, title, category, episodes };
  const synopsis = textOf(source.synopsis);
  const coverUrl = textOf(source.coverUrl);
  if (synopsis !== undefined) work.synopsis = synopsis;
  if (coverUrl !== undefined) work.coverUrl = coverUrl;
  return work;
}
