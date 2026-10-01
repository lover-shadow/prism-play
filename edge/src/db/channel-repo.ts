import type { ChannelId, ChannelItem, DeviceTier } from '../types/api';
import { isChannelId, parseRequiresTier, toBoolean } from '../core/validation';

/**
 * D1 is the only authority for the channel topology in Stage 1; nothing here reads or writes KV.
 * Columns stay snake_case inside this file — `types/api.ts` owns the camelCase wire shape.
 */
const CHANNEL_COLUMNS = 'id, name, sort_order, requires_tier, categories_json, enabled';

interface ChannelRow {
  id: string;
  name: string;
  sort_order: number;
  requires_tier: string;
  categories_json: string;
  enabled: number;
}

export const PRIVATE_CHANNEL_ID: ChannelId = 'private';

/**
 * Master decision M-3: which tiers may open 【个人探索】 is cloud configuration in
 * `channels.requires_tier`, so a route must never hardcode a tier set. This value is the shipped
 * default used only when the row is absent or its configured value is unusable.
 */
export const DEFAULT_PRIVATE_REQUIRED_TIERS: readonly DeviceTier[] = ['B', 'Y', 'S'];

/**
 * `ChannelsResponse.version` is a client cache key, so it must be stable while the data is stable.
 * This is the fixed integer reported for an empty `channels` table.
 */
export const EMPTY_TOPOLOGY_VERSION = 1;

export interface PrivateChannelConfig {
  /** The `private` row exists at all. */
  exists: boolean;
  /** Row exists and is enabled — the only state in which a session may be minted for it. */
  available: boolean;
  /** Never empty: see `privateTierGate`. */
  requiresTier: readonly DeviceTier[];
}

/**
 * A malformed categories_json degrades to an empty list for that one channel instead of failing the
 * whole topology request (SPEC AC-01 must still render the four public channels).
 */
function parseCategories(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

function toChannelItem(row: ChannelRow): ChannelItem | null {
  // An id outside the OpenAPI enum must never reach the wire, so the row is dropped, not renamed.
  if (!isChannelId(row.id)) return null;
  return {
    id: row.id,
    name: row.name,
    order: Number(row.sort_order),
    requiresTier: parseRequiresTier(row.requires_tier),
    categories: parseCategories(row.categories_json)
  };
}

/** Enabled channels in display order. `private` is included here; the route decides visibility. */
export async function listEnabledChannels(db: D1Database): Promise<ChannelItem[]> {
  const result = await db
    .prepare(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE enabled = 1 ORDER BY sort_order ASC, id ASC`)
    .all<ChannelRow>();
  const items: ChannelItem[] = [];
  for (const row of result.results) {
    const item = toChannelItem(row);
    if (item !== null) items.push(item);
  }
  return items;
}

/**
 * Fail-closed reading of the private tier knob: `'0'` or an unrecognised value must NOT widen the
 * gate to "everyone" — it falls back to the shipped default, because an empty tier set would let any
 * live credential past the first condition of AC-02's double invisibility.
 */
function privateTierGate(raw: string): readonly DeviceTier[] {
  const tiers = parseRequiresTier(raw);
  return tiers.length > 0 ? tiers : DEFAULT_PRIVATE_REQUIRED_TIERS;
}

export async function readPrivateChannelConfig(db: D1Database): Promise<PrivateChannelConfig> {
  const row = await db
    .prepare(`SELECT ${CHANNEL_COLUMNS} FROM channels WHERE id = ?`)
    .bind(PRIVATE_CHANNEL_ID)
    .first<ChannelRow>();
  if (row === null) return { exists: false, available: false, requiresTier: DEFAULT_PRIVATE_REQUIRED_TIERS };
  return { exists: true, available: toBoolean(Number(row.enabled)), requiresTier: privateTierGate(row.requires_tier) };
}

/**
 * Newest `channels.updated_at` in Unix seconds. Taken over the whole table (not only enabled rows)
 * so any operator edit invalidates a cached topology exactly once instead of going unnoticed.
 */
export async function readTopologyVersion(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT MAX(updated_at) AS newest FROM channels').first<{ newest: number | null }>();
  if (row === null || row.newest === null) return EMPTY_TOPOLOGY_VERSION;
  const version = Math.trunc(Number(row.newest));
  return Number.isFinite(version) && version > 0 ? version : EMPTY_TOPOLOGY_VERSION;
}
