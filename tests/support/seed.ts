import type { SqliteD1 } from './sqlite-d1';
import { TEST_BASE_TIME_SECONDS } from './test-env';

type SeedValue = string | number | boolean | null | undefined;
type SeedRow = Record<string, SeedValue>;

function normalize(value: SeedValue): SeedValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value === undefined ? null : value;
}

/** Column-name keys come from this file only, never from a request, so interpolation is test-local. */
export function insert(db: SqliteD1, table: string, row: SeedRow): void {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  db.execute(sql, ...keys.map((key) => normalize(row[key])));
}

export function upsert(db: SqliteD1, table: string, row: SeedRow): void {
  const keys = Object.keys(row);
  const sql = `INSERT OR REPLACE INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  db.execute(sql, ...keys.map((key) => normalize(row[key])));
}

const PUBLIC_CATEGORIES = ['最新上线', '都市', '战神', '逆袭', '甜宠', '古装', '悬疑'];

export const FOUR_PUBLIC_CHANNELS: readonly { id: string; name: string; order: number }[] = [
  { id: 'drama', name: '短剧精选', order: 1 },
  { id: 'movie', name: '院线电影', order: 2 },
  { id: 'anime', name: '热血动漫', order: 3 },
  { id: 'documentary', name: '人文纪录', order: 4 }
];

export interface CouponSeed {
  code: string;
  tier: string;
  tierName: string;
  durationDays: number;
  status?: string;
  maxDevices?: number;
  deviceCount?: number;
  rejectedDistinctCount?: number;
  isAbnormal?: number;
}

export function seedCoupon(db: SqliteD1, coupon: CouponSeed, now = TEST_BASE_TIME_SECONDS): void {
  insert(db, 'card_coupons', {
    code: coupon.code,
    tier: coupon.tier,
    tier_name: coupon.tierName,
    duration_days: coupon.durationDays,
    status: coupon.status ?? 'UNUSED',
    max_devices: coupon.maxDevices ?? 10,
    device_count: coupon.deviceCount ?? 0,
    rejected_distinct_count: coupon.rejectedDistinctCount ?? 0,
    is_abnormal: coupon.isAbnormal ?? 0,
    created_at: now,
    updated_at: now
  });
}

export interface DeviceSeed {
  deviceId: string;
  tier?: string;
  tierName?: string;
  expiresAt?: number;
  exemptUntil?: number;
  boundCoupon?: string | null;
  invitedBy?: string | null;
}

export function seedDevice(db: SqliteD1, device: DeviceSeed, now = TEST_BASE_TIME_SECONDS): void {
  insert(db, 'devices', {
    device_id: device.deviceId,
    platform: 'android',
    tier: device.tier ?? '0',
    tier_name: device.tierName ?? '默认试用',
    expires_at: device.expiresAt ?? 0,
    exempt_until: device.exemptUntil ?? 0,
    bound_coupon: device.boundCoupon ?? null,
    invited_by: device.invitedBy ?? null,
    last_active_at: now,
    created_at: now,
    updated_at: now
  });
}

export interface ChannelSeed {
  id: string;
  name: string;
  sortOrder?: number;
  requiresTier?: string;
  categories?: string[];
  enabled?: number;
}

export function seedChannel(db: SqliteD1, channel: ChannelSeed, now = TEST_BASE_TIME_SECONDS): void {
  insert(db, 'channels', {
    id: channel.id,
    name: channel.name,
    sort_order: channel.sortOrder ?? 1,
    requires_tier: channel.requiresTier ?? '0',
    categories_json: JSON.stringify(channel.categories ?? PUBLIC_CATEGORIES),
    enabled: channel.enabled ?? 1,
    created_at: now,
    updated_at: now
  });
}

/** The four public channels plus 个人探索, matching the D1 CHECK rules for requires_tier. */
export function seedStandardChannels(db: SqliteD1, privateRequiresTier = 'B,Y,S'): void {
  FOUR_PUBLIC_CHANNELS.forEach((channel, index) =>
    seedChannel(db, {
      id: channel.id,
      name: channel.name,
      sortOrder: index + 1,
      requiresTier: '0',
      categories: PUBLIC_CATEGORIES
    })
  );
  seedChannel(db, {
    id: 'private',
    name: '个人探索',
    sortOrder: 9,
    requiresTier: privateRequiresTier,
    categories: ['今日更新', '热门推荐']
  });
}

export interface ContentSeed {
  id: string;
  channelId: string;
  title: string;
  category?: string;
  isPrivate?: number;
  enabled?: number;
  shareable?: number;
  coverUrl?: string | null;
  coverVersion?: string | null;
  synopsis?: string | null;
  firstPublishedAt?: number | null;
}

export function seedContent(db: SqliteD1, content: ContentSeed, now = TEST_BASE_TIME_SECONDS): void {
  insert(db, 'content_items', {
    id: content.id,
    channel_id: content.channelId,
    title: content.title,
    category: content.category ?? '逆袭',
    is_private: content.isPrivate ?? 0,
    enabled: content.enabled ?? 1,
    shareable: content.shareable ?? 1,
    cover_url: content.coverUrl ?? null,
    cover_version: content.coverVersion ?? null,
    synopsis: content.synopsis ?? null,
    first_published_at: content.firstPublishedAt ?? now,
    created_at: now,
    updated_at: now
  });
}

export function seedEpisode(
  db: SqliteD1,
  contentId: string,
  episodeNumber: number,
  durationSeconds = 120,
  now = TEST_BASE_TIME_SECONDS
): number {
  db.execute(
    'INSERT INTO content_episodes (content_id, episode_number, title, duration_seconds, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    contentId,
    episodeNumber,
    `第 ${episodeNumber} 集`,
    durationSeconds,
    now,
    now
  );
  const row = db.selectOne(
    'SELECT id FROM content_episodes WHERE content_id = ? AND episode_number = ?',
    contentId,
    episodeNumber
  );
  return Number(row?.id ?? 0);
}

export function seedProvider(
  db: SqliteD1,
  provider: { id: string; channelId: string; name?: string; upstreamUrl?: string; healthy?: number; latencyMs?: number },
  now = TEST_BASE_TIME_SECONDS
): void {
  insert(db, 'source_providers', {
    id: provider.id,
    name: provider.name ?? '光影极速专线',
    channel_id: provider.channelId,
    upstream_url: provider.upstreamUrl ?? 'https://upstream.invalid/catalog',
    priority: 1,
    latency_ms: provider.latencyMs ?? 90,
    healthy: provider.healthy ?? 1,
    last_checked_at: now,
    created_at: now,
    updated_at: now
  });
}

export function seedEpisodeSource(
  db: SqliteD1,
  link: { episodeId: number; providerId: string; upstreamMediaUrl?: string; enabled?: number },
  now = TEST_BASE_TIME_SECONDS
): void {
  insert(db, 'episode_sources', {
    episode_id: link.episodeId,
    provider_id: link.providerId,
    upstream_media_url: link.upstreamMediaUrl ?? 'https://upstream.invalid/segment.m3u8',
    enabled: link.enabled ?? 1,
    created_at: now,
    updated_at: now
  });
}

export function couponRow(db: SqliteD1, code: string): Record<string, unknown> | undefined {
  return db.selectOne('SELECT * FROM card_coupons WHERE code = ?', code);
}

export function deviceRow(db: SqliteD1, deviceId: string): Record<string, unknown> | undefined {
  return db.selectOne('SELECT * FROM devices WHERE device_id = ?', deviceId);
}

