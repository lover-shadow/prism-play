import { PUBLIC_CHANNEL_IDS, type ContentItem } from '../types/api';
import { isRecord, isSafeWorkId } from '../library/contract';
import { itemFromAsset, parseTitleAsset, type TitleAsset } from '../library/title-asset';
import { factsHash, type WorkFact } from '../library/work-facts';
import { assertAllowedTarget } from '../media/upstream';

export const MAX_DISCOVERY_FACT_BYTES = 524288;
export const MAX_DISCOVERY_CARD_BYTES = 16384;
export interface DiscoveryFact {
  workId: string; title: string; channelId: string; category: string;
  enabled: true; isPrivate: false; shareable: boolean; generatedAt: number;
  episodeCount: number; episodes: TitleAsset['episodes'];
  coverTargetUrl?: string; coverVersion?: string; synopsis?: string;
  firstPublishedAt?: number; hitsTotal?: number; isAi?: boolean; isHot?: boolean;
  tags?: string[]; releaseYear?: number; region?: string; language?: string;
  releaseStatus?: 'finished' | 'ongoing'; lastSyncedEpisode?: number; lastSyncedAt?: number;
}
export interface ValidatedDiscoveryFact {
  stored: DiscoveryFact; asset: TitleAsset; card: ContentItem; fact: WorkFact;
}
export function discoveryJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}
export function discoverySafeHttps(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 8192) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    assertAllowedTarget(value, new Set([url.origin]));
    return true;
  } catch { return false; }
}
export async function discoveryWorkId(providerId: string, sourceId: string): Promise<string> {
  if (!/^provider_[a-z0-9_]{1,48}$/.test(providerId) || !sourceId.trim() || sourceId.length > 256) {
    throw new Error('Invalid discovery identity');
  }
  return `discovery_${await factsHash(discoveryJsonBytes([providerId, sourceId]))}`;
}
/** Canonical IDs are source-bound; the default hashed store identity stays compatible. */
export function discoveryCanonicalId(providerId: string, sourceId: string, id: string): boolean {
  if (!/^\d{1,32}$/.test(sourceId)) return false;
  return providerId === 'provider_s1' ? id === `drama_s_${sourceId}` :
    providerId === 'provider_m1' && /^(drama|movie|anime|documentary)_m_/.test(id) && id.endsWith(`_m_${sourceId}`);
}
function hasProtection(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (Array.isArray(value)) return value.some((v) => hasProtection(v, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, v]) =>
    (/^(encrypted|isEncrypted|encryption|drm|key|keyHex|cencKeyHex|spade_a|kid|keyUrl|licenseUrl|isPrivate)$/i.test(key) &&
      v !== false && v !== null && v !== undefined) || hasProtection(v, depth + 1));
}
/** Strict public admission, then whitelist canonical storage: unknown provider fields never survive. */
export function validateDiscoveryFact(raw: unknown, id: string): ValidatedDiscoveryFact | null {
  try {
    if (!isRecord(raw) || !isSafeWorkId(id) || raw.workId !== id || raw.enabled !== true ||
      raw.isPrivate !== false || typeof raw.shareable !== 'boolean' || hasProtection(raw) ||
      !(PUBLIC_CHANNEL_IDS as readonly unknown[]).includes(raw.channelId) ||
      typeof raw.title !== 'string' || raw.title.trim().length === 0 || raw.title.length > 240 ||
      (raw.category !== undefined && (typeof raw.category !== 'string' || raw.category.length > 160)) ||
      !Number.isSafeInteger(raw.episodeCount) || Number(raw.episodeCount) < 1 || Number(raw.episodeCount) > 5000 ||
      !Array.isArray(raw.episodes) || raw.episodes.length !== raw.episodeCount ||
      discoveryJsonBytes(raw).length > MAX_DISCOVERY_FACT_BYTES) return null;
    if (raw.coverTargetUrl !== undefined && !discoverySafeHttps(raw.coverTargetUrl)) return null;
    // Never accept a direct public cover URL; only a private target with a route-derived public handle.
    if (raw.coverUrl !== undefined) return null;
    const numbers = new Set<number>();
    for (const ep of raw.episodes) {
      if (!isRecord(ep) || !Number.isSafeInteger(ep.episodeNumber) || Number(ep.episodeNumber) < 1 ||
        Number(ep.episodeNumber) > Number(raw.episodeCount) || numbers.has(Number(ep.episodeNumber)) ||
        !Array.isArray(ep.lines) || ep.lines.length < 1 || ep.lines.length > 32 ||
        (ep.title !== undefined && (typeof ep.title !== 'string' || ep.title.length > 240)) ||
        (ep.durationSeconds !== undefined && (!Number.isSafeInteger(ep.durationSeconds) || Number(ep.durationSeconds) < 0))) return null;
      numbers.add(Number(ep.episodeNumber));
      if (ep.lines.some((line) => !isRecord(line) || typeof line.providerId !== 'string' ||
        !/^provider_[a-z0-9_]{1,48}$/.test(line.providerId) ||
        (line.mediaUrl !== undefined && !discoverySafeHttps(line.mediaUrl)) ||
        (line.mediaUrl === undefined && !('native' in line)))) return null;
    }
    const parsed = parseTitleAsset(JSON.stringify({ ...raw, coverUrl: raw.coverTargetUrl }), id);
    if (!parsed.ok) return null;
    const asset = parsed.value;
    const stored: DiscoveryFact = { workId: id, title: asset.title, channelId: asset.channelId,
      category: asset.category, enabled: true, isPrivate: false, shareable: raw.shareable,
      generatedAt: asset.generatedAt, episodeCount: asset.episodes.length,
      episodes: [...asset.episodes].sort((a, b) => a.episodeNumber - b.episodeNumber) };
    if (raw.coverTargetUrl !== undefined) stored.coverTargetUrl = raw.coverTargetUrl as string;
    for (const key of ['coverVersion', 'synopsis', 'firstPublishedAt', 'hitsTotal', 'isAi', 'isHot',
      'tags', 'releaseYear', 'region', 'language', 'releaseStatus', 'lastSyncedEpisode', 'lastSyncedAt'] as const) {
      const v = asset[key]; if (v !== undefined) Object.assign(stored, { [key]: v });
    }
    // Synopsis follows the established metadata-policy sanitizer in parseTitleAsset.
    const card = itemFromAsset(asset);
    card.enabled = true; card.shareable = raw.shareable;
    if (asset.hasCover) card.coverUrl = `/proxy/img/${encodeURIComponent(id)}`;
    if (discoveryJsonBytes(card).length > MAX_DISCOVERY_CARD_BYTES ||
      discoveryJsonBytes(stored).length > MAX_DISCOVERY_FACT_BYTES) return null;
    const fact: WorkFact = { asset, shareable: stored.shareable, row: { id, title: asset.title,
      channel_id: asset.channelId, category: asset.category, is_private: 0, enabled: 1,
      shareable: stored.shareable ? 1 : 0, cover_url: stored.coverTargetUrl ?? null,
      cover_version: asset.coverVersion ?? null, synopsis: asset.synopsis ?? null,
      first_published_at: asset.firstPublishedAt ?? null, updated_at: asset.generatedAt,
      episode_count: stored.episodeCount } };
    return { stored, asset, card, fact };
  } catch { return null; }
}
