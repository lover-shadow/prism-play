/**
 * R2 episode manifest read (SPEC-CLOUD-REFACTOR v2 §3.2) — the object `/api/titles/{id}` is now made of.
 *
 * This is the only place in the system that holds playable addresses (§3.2: 播放地址只存在于剧集清单),
 * which is why the two prefixes are read through different doors: a public manifest is CDN-cacheable,
 * a private manifest is only ever produced behind the double-admission predicate and shipped `no-store`
 * (§C-3b-1). An id that reaches here has already passed the route's path check; the key builder checks
 * it again because the id *is* a path segment.
 *
 * The response keeps the §3.2 field set — that is the contract Track 1 and the share page consume — and
 * adds a `item` projection of the same work so a client written against the pre-refactor
 * `TitleDetail` shape still has its card. Nothing else is invented: an episode row carries no numeric
 * id, because numeric `content_episodes` ids belong to the table this refactor stops reading.
 */

import type { ChannelId, ContentItem } from '../types/api';
import { CHANNEL_IDS } from '../types/api';
import type { AssetRejection, AssetVerdict } from './contract';
import { accept, isCount, isHttpUrl, isNonEmptyText, isRecord, isSafeWorkId, reject } from './contract';

export interface EpisodeLine {
  /** Abstract provider code (`provider_m1` style): never a brand name, per AGENTS.md §二.1. */
  readonly providerId: string;
  readonly mediaUrl: string;
}

export interface TitleEpisodeEntry {
  readonly episodeNumber: number;
  readonly title?: string;
  readonly durationSeconds?: number;
  readonly lines: readonly EpisodeLine[];
}

export interface TitleAsset {
  readonly workId: string;
  readonly title: string;
  readonly channelId: ChannelId;
  readonly isPrivate: boolean;
  readonly episodes: readonly TitleEpisodeEntry[];
  readonly generatedAt: number;
  readonly category: string;
  /** Presence only: the stored cover value is never echoed, the route re-derives the handle. */
  readonly hasCover: boolean;
  coverVersion?: string;
  synopsis?: string;
  episodeCount?: number;
  isAi?: boolean;
  isHot?: boolean;
  firstPublishedAt?: number;
  hitsTotal?: number;
}

/** §3.2 + the compat `item` projection; the wire shape of `GET /api/titles/{titleId}`. */
export interface TitleAssetResponse {
  readonly workId: string;
  readonly title: string;
  readonly channelId: ChannelId;
  readonly isPrivate: boolean;
  readonly episodes: readonly TitleEpisodeEntry[];
  readonly generatedAt: number;
  readonly item: ContentItem;
}

function isChannelValue(value: unknown): value is ChannelId {
  return typeof value === 'string' && (CHANNEL_IDS as readonly string[]).includes(value);
}

function parseLine(value: unknown): EpisodeLine | null {
  if (!isRecord(value)) return null;
  const providerId = value.providerId;
  const mediaUrl = value.mediaUrl;
  if (typeof providerId !== 'string' || !isSafeWorkId(providerId)) return null;
  if (!isHttpUrl(mediaUrl)) return null;
  return { providerId, mediaUrl };
}

function parseEpisode(value: unknown): TitleEpisodeEntry | null {
  if (!isRecord(value)) return null;
  if (!isCount(value.episodeNumber) || Number(value.episodeNumber) < 1) return null;
  if (!Array.isArray(value.lines)) return null;
  const lines: EpisodeLine[] = [];
  for (const entry of value.lines) {
    const line = parseLine(entry);
    if (line === null) return null;
    lines.push(line);
  }
  const episode: TitleEpisodeEntry = { episodeNumber: Number(value.episodeNumber), lines };
  const withTitle = typeof value.title === 'string' ? { title: value.title } : {};
  const withDuration = isCount(value.durationSeconds) ? { durationSeconds: Number(value.durationSeconds) } : {};
  return { ...episode, ...withTitle, ...withDuration };
}

export function parseTitleAsset(raw: string, expectedWorkId: string): AssetVerdict<TitleAsset> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return reject('malformed');
  }
  if (!isRecord(parsed)) return reject('malformed');
  if (!isSafeWorkId(parsed.workId) || parsed.workId !== expectedWorkId) return reject('malformed');
  if (!isNonEmptyText(parsed.title)) return reject('malformed');
  if (!isChannelValue(parsed.channelId)) return reject('malformed');
  if (!Array.isArray(parsed.episodes)) return reject('malformed');
  if (!isCount(parsed.generatedAt)) return reject('malformed');
  const isPrivate = parsed.isPrivate === true;
  const episodes: TitleEpisodeEntry[] = [];
  for (const entry of parsed.episodes) {
    const episode = parseEpisode(entry);
    if (episode === null) return reject('malformed');
    episodes.push(episode);
  }
  const asset: TitleAsset = {
    workId: parsed.workId,
    title: parsed.title,
    channelId: parsed.channelId,
    isPrivate,
    episodes,
    generatedAt: Number(parsed.generatedAt),
    category: typeof parsed.category === 'string' ? parsed.category : '',
    // Presence only: the stored value is never echoed, since it may be an upstream address (§3.1).
    hasCover: isNonEmptyText(parsed.coverUrl)
  };
  if (typeof parsed.coverVersion === 'string' && parsed.coverVersion !== '') asset.coverVersion = parsed.coverVersion;
  if (typeof parsed.synopsis === 'string' && parsed.synopsis !== '') asset.synopsis = parsed.synopsis;
  if (isCount(parsed.episodeCount)) asset.episodeCount = parsed.episodeCount;
  if (isCount(parsed.firstPublishedAt)) asset.firstPublishedAt = parsed.firstPublishedAt;
  if (isCount(parsed.hitsTotal)) asset.hitsTotal = parsed.hitsTotal;
  if (typeof parsed.isAi === 'boolean') asset.isAi = parsed.isAi;
  if (typeof parsed.isHot === 'boolean') asset.isHot = parsed.isHot;
  return accept(asset);
}

/**
 * The compat card projection. `coverUrl` is supplied by the caller — a same-origin handle for a public
 * work, a session-bound signature for a private one — because the signature depends on credentials this
 * layer must not inspect.
 */
export function itemFromAsset(asset: TitleAsset, coverUrl?: string): ContentItem {
  const item: ContentItem = {
    id: asset.workId,
    channelId: asset.channelId,
    title: asset.title,
    category: asset.category,
    isPrivate: asset.isPrivate
  };
  if (coverUrl !== undefined) item.coverUrl = coverUrl;
  if (asset.coverVersion !== undefined) item.coverVersion = asset.coverVersion;
  if (asset.synopsis !== undefined) item.synopsis = asset.synopsis;
  if (asset.episodeCount !== undefined) item.episodeCount = asset.episodeCount;
  else item.episodeCount = asset.episodes.length;
  if (asset.isAi === true) item.isAi = true;
  if (asset.isHot === true) item.isHot = true;
  if (asset.firstPublishedAt !== undefined) item.firstPublishedAt = asset.firstPublishedAt;
  if (asset.hitsTotal !== undefined) item.hitsTotal = asset.hitsTotal;
  return item;
}

/**
 * Numeric order is part of what the old D1 read guaranteed (`ORDER BY episode_number ASC`), and the
 * player indexes by episode number, so the manifest is sorted on the way out rather than trusting the
 * order CI happened to write. Nothing else about the payload is touched.
 */
export function titleAssetResponse(asset: TitleAsset, coverUrl?: string): TitleAssetResponse {
  return {
    workId: asset.workId,
    title: asset.title,
    channelId: asset.channelId,
    isPrivate: asset.isPrivate,
    episodes: [...asset.episodes].sort((left, right) => left.episodeNumber - right.episodeNumber),
    generatedAt: asset.generatedAt,
    item: itemFromAsset(asset, coverUrl)
  };
}

export type TitleRead =
  | { readonly status: 'absent' }
  | { readonly status: 'rejected'; readonly reason: AssetRejection }
  | { readonly status: 'ok'; readonly asset: TitleAsset };

/** One R2 get plus one §3.2 validation pass; `absent` is what the route turns into the shared 404. */
export async function readTitleAt(bucket: R2Bucket, key: string, workId: string): Promise<TitleRead> {
  const object = await bucket.get(key);
  if (object === null) return { status: 'absent' };
  const text = await object.text();
  const verdict = parseTitleAsset(text, workId);
  if (verdict.ok === false) return { status: 'rejected', reason: verdict.reason };
  return { status: 'ok', asset: verdict.value };
}
