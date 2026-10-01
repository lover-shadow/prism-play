/**
 * Contract DTO layer.
 * Mechanical projection of docs/03-contracts/openapi.yaml (machine-readable authority).
 * Field names here are lowerCamelCase because the wire format is camelCase; D1 columns are
 * snake_case and are mapped in the repository layer only.
 */

export const CHANNEL_IDS = ['drama', 'movie', 'anime', 'documentary', 'private'] as const;
export type ChannelId = (typeof CHANNEL_IDS)[number];

export const PUBLIC_CHANNEL_IDS = ['drama', 'movie', 'anime', 'documentary'] as const;
export type PublicChannelId = (typeof PUBLIC_CHANNEL_IDS)[number];

export const DEVICE_TIERS = ['0', 'Q', 'A', 'B', 'Y', 'S'] as const;
export type DeviceTier = (typeof DEVICE_TIERS)[number];

export const COUPON_TIERS = ['Q', 'A', 'B', 'Y', 'S'] as const;
export type CouponTier = (typeof COUPON_TIERS)[number];

/** openapi.yaml pins the 个人探索 eligibility set to these three tiers. */
export const PRIVATE_ELIGIBLE_TIERS = ['B', 'Y', 'S'] as const;
export type PrivateEligibleTier = (typeof PRIVATE_ELIGIBLE_TIERS)[number];

/** `devices.expires_at` sentinel meaning "never expires"; only tier S uses it. */
export const PERMANENT_EXPIRES_AT = -1;

export interface ChannelItem {
  id: ChannelId;
  name: string;
  order: number;
  /** Empty array means every device may see the channel; non-empty means those tiers only. */
  requiresTier: DeviceTier[];
  categories: string[];
}

export interface ContentItem {
  id: string;
  channelId: ChannelId;
  title: string;
  category: string;
  isPrivate: boolean;
  coverUrl?: string;
  coverVersion?: string;
  synopsis?: string;
  episodeCount?: number;
  enabled?: boolean;
  shareable?: boolean;
}

export interface EpisodeItem {
  episodeId: number;
  episodeNumber: number;
  title?: string;
  durationSeconds?: number;
}

export interface TitleDetail {
  item: ContentItem;
  episodes: EpisodeItem[];
}

export interface PlaybackInfo {
  episodeId: number;
  /** Same-origin short-lived proxy handle; never an upstream address. */
  url: string;
  mimeType?: string;
  durationSeconds?: number;
  expiresInSeconds?: number;
}

export interface SourceProvider {
  id: string;
  name: string;
  channelId: ChannelId;
  /** Same-origin controlled proxy base, not the upstream domain. */
  apiBase: string;
  priority: number;
  latencyMs: number;
  healthy: boolean;
}

export interface RedeemRequest {
  code: string;
  deviceId: string;
  platform: 'android';
  appVersion?: string;
  inviteRef?: string;
}

export interface RedeemSuccessResponse {
  success: true;
  tier: CouponTier;
  tierName: string;
  /** Unix seconds; -1 means permanent (tier S only). */
  expiresAt: number;
  token: string;
  message: string;
}

export interface PrivateSessionRequest {
  acknowledged: boolean;
}

export interface PrivateSessionResponse {
  sessionToken: string;
  expiresInSeconds: number;
}

export interface DevicePingResponse {
  tier: DeviceTier;
  expiresAt: number;
  token: string;
  message?: string;
}

export const SEARCH_SUGGESTION_TYPES = ['title', 'alias', 'pinyin', 'category', 'correction'] as const;
export type SearchSuggestionType = (typeof SEARCH_SUGGESTION_TYPES)[number];

export interface SearchSuggestion {
  text: string;
  type: SearchSuggestionType;
  contentId?: string;
}

/** Lexical match kinds only — `semantic` is deliberately absent (Master decision M-5). */
export const MATCH_TYPES = ['exact', 'alias', 'pinyin', 'fuzzy', 'related'] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

export interface SearchResult {
  item: ContentItem;
  matchType: MatchType;
}

export interface CatalogUpsertChange {
  revision: number;
  contentId: string;
  operation: 'upsert';
  item: ContentItem;
}

export interface CatalogDeleteChange {
  revision: number;
  contentId: string;
  operation: 'delete';
}

export type CatalogChange = CatalogUpsertChange | CatalogDeleteChange;

export interface ChannelsResponse {
  version: number;
  channels: ChannelItem[];
}

export interface SourcesResponse {
  updatedAt: number;
  providers: SourceProvider[];
}

export interface CatalogResponse {
  items: ContentItem[];
  page: number;
  pageSize: number;
  total: number;
  revision: number;
}

export interface CatalogChangesResponse {
  changes: CatalogChange[];
  nextRevision: number;
  hasMore: boolean;
}

export interface SearchResponse {
  items: SearchResult[];
  page: number;
}

export interface SuggestionsResponse {
  query: string;
  suggestions: SearchSuggestion[];
}

export interface RelatedResponse {
  items: ContentItem[];
}

export interface MonetizationTier {
  tier: CouponTier;
  name: string;
  durationDays: number;
  priceYuan: number;
  desc?: string;
}

export interface NudgePolicy {
  freeTrialSeconds: number;
  stage1UntilSeconds: number;
  stage2UntilSeconds: number;
  stage1IntervalSeconds: number;
  stage2IntervalSeconds: number;
  stage3IntervalSeconds: number;
  dialogTitle: string;
  dialogBody: string;
}

export interface MonetizationConfig {
  activeTiers: MonetizationTier[];
  nudgePolicy: NudgePolicy;
  /**
   * Cloud-configured tiers eligible for 个人探索. Delivered on this public endpoint precisely so the
   * settings screen can decide whether to show the switch without `/api/channels` leaking the
   * private channel node (supervision ruling A-3 on AC-02-1 vs AC-02-3).
   */
  privateAccessTiers?: PrivateEligibleTier[];
}

export interface AndroidRelease {
  versionCode: number;
  versionName: string;
  changelog?: string;
  downloadUrl: string;
  minVersionCode?: number;
  force?: boolean;
}

export interface VersionResponse {
  android: AndroidRelease;
}

/** Closed set; must stay aligned with openapi.yaml ErrorResponse.code enum. */
export const ERROR_CODES = [
  'COUPON_NOT_FOUND',
  'COUPON_REVOKED',
  'COUPON_DEVICE_LIMIT_EXCEEDED',
  'COUPON_INVALID_FORMAT',
  'DEVICE_ID_INVALID',
  'RATE_LIMITED',
  'PRIVATE_SESSION_REQUIRED',
  'TIER_INSUFFICIENT',
  'NOT_FOUND',
  'SERVICE_UNAVAILABLE',
  'PLATFORM_UNSUPPORTED',
  'CREDENTIAL_EXPIRED',
  'VALIDATION_ERROR',
  'PROXY_SIGNATURE_INVALID',
  'CATALOG_REVISION_CONFLICT',
  'CATALOG_CURSOR_EXPIRED'
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorResponse {
  success: false;
  code: ErrorCode;
  message: string;
}

export interface AuthTokenClaims {
  iss: string;
  aud: string;
  sub: string;
  tier: DeviceTier;
  /** Unix seconds; -1 means permanent. */
  exp: number;
  iat: number;
  jti: string;
}
