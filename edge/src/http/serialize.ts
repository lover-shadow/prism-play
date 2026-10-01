import type { ChannelId, ContentItem, EpisodeItem } from '../types/api';
import type { ContentRow, EpisodeRow } from '../db/content-repo';
import { buildProxyUrl, issueSignedProxyUrl } from '../core/proxy-signature';

/** Same-origin by construction: rebuilt from the incoming request, never from a stored or sent URL. */
export function originOf(request: Request): string {
  return new URL(request.url).origin;
}

/**
 * Public posters keep a stable, unsigned address so AC-18 caching by `coverVersion` + ETag works.
 * The handle is the content id, and `/proxy` still re-checks `enabled`/`is_private` in D1 per request.
 */
export function publicCoverProxyUrl(origin: string, contentId: string): string {
  return buildProxyUrl(origin, 'img', contentId);
}

/**
 * A private poster is bound to the current session: same short-lived signature as a media handle,
 * because a copyable URL must not outlive the credential that authorised it (SPEC §5 谓词).
 */
export function signedCoverProxyUrl(
  origin: string,
  secret: string,
  contentId: string,
  nowSeconds: number,
  ttlSeconds: number
): Promise<string> {
  return issueSignedProxyUrl(origin, secret, 'img', contentId, nowSeconds, ttlSeconds).then((issued) => issued.url);
}

export interface ItemContext {
  origin: string;
  /** Pre-computed signed cover for a private item; public items never need it. */
  coverUrl?: string;
}

function optional(value: string | null): string | undefined {
  return value === null || value === '' ? undefined : value;
}

/**
 * `content_items.cover_url` holds the upstream address and is therefore never emitted: the wire only
 * ever carries the same-origin proxy form derived from the content id (API-SPEC §〇 上游地址零暴露).
 */
export function toContentItem(row: ContentRow, context: ItemContext): ContentItem {
  const item: ContentItem = {
    id: row.id,
    channelId: row.channel_id as ChannelId,
    title: row.title,
    category: row.category,
    isPrivate: row.is_private === 1,
    enabled: row.enabled === 1,
    shareable: row.shareable === 1
  };
  if (row.cover_url !== null && row.cover_url !== '') {
    item.coverUrl = context.coverUrl ?? publicCoverProxyUrl(context.origin, row.id);
  }
  const coverVersion = optional(row.cover_version);
  if (coverVersion !== undefined) item.coverVersion = coverVersion;
  const synopsis = optional(row.synopsis);
  if (synopsis !== undefined) item.synopsis = synopsis;
  if (row.episode_count !== null) item.episodeCount = Number(row.episode_count);
  return item;
}

export function toEpisodeItem(row: EpisodeRow): EpisodeItem {
  const item: EpisodeItem = {
    episodeId: Number(row.id),
    episodeNumber: Number(row.episode_number)
  };
  const title = optional(row.title);
  if (title !== undefined) item.title = title;
  if (row.duration_seconds !== null) item.durationSeconds = Number(row.duration_seconds);
  return item;
}
