/**
 * KV read side of the catalogue manifest (SPEC-CLOUD-REFACTOR v2 §3.3).
 *
 * `catalog:manifest` is the only pointer the Worker follows into R2, which is what makes the browse
 * path cost zero D1 rows: revision, page size and per-channel shard inventory come from one KV get,
 * and the shard itself is served verbatim. Like every other KV value in this system the rule is
 * reject-don't-repair (SPEC 10 via `config/kv-config.ts`): a missing, malformed or contradictory
 * manifest is a 503, never a synthesised "empty catalogue", because an empty page the client believes
 * would drop a whole channel from every device that asks.
 *
 * The two keys are kept separate on purpose — §C-2b — so a private revision bump can never move a
 * public cursor, and so the private inventory is not reachable through the public manifest at all.
 */

import { parseStoredJson, readKvText } from '../config/kv-config';
import { isCount, isRecord, WORK_ID_PATTERN } from './contract';

/** KV keys, §3.3 and §C-2b-2. */
export const CATALOG_MANIFEST_KV_KEY = 'catalog:manifest';
export const PRIVATE_MANIFEST_KV_KEY = 'catalog:private-manifest';

/** §3.1 pins one shard to one client page of 60; anything else is a pipeline drift we refuse to serve. */
export const CATALOG_PAGE_SIZE = 60;

export interface ChannelInventory {
  /** Number of shards published for the channel, `chunk-0` … `chunk-(chunks-1)`. */
  chunks: number;
  /** Item count the channel claims, echoed to the client for paging arithmetic. */
  total: number;
}

export interface CatalogManifest {
  revision: number;
  pageSize: number;
  channels: Record<string, ChannelInventory>;
}

function isChannelKey(value: string): boolean {
  // The key becomes an R2 path segment, so the id charset is checked before it is ever interpolated.
  return WORK_ID_PATTERN.test(value);
}

function validateInventory(value: unknown): ChannelInventory | null {
  if (!isRecord(value)) return null;
  if (!isCount(value.chunks) || !isCount(value.total)) return null;
  return { chunks: value.chunks, total: value.total };
}

function validateChannels(value: unknown): Record<string, ChannelInventory> {
  if (!isRecord(value)) return {};
  const channels: Record<string, ChannelInventory> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isChannelKey(key)) continue;
    const inventory = validateInventory(raw);
    if (inventory !== null) channels[key] = inventory;
  }
  return channels;
}

/**
 * The published pointer must be complete, not merely parseable: `revision`, `pageSize` and the channel
 * inventory are all in §3.3, and a manifest that declares no channels would otherwise be served as "this
 * channel is empty" — which every client would commit as a snapshot and silently lose the channel. So an
 * absent `channels` object is a half-finished publish and is rejected, exactly like a bad `pageSize`.
 */
export function validatePublicManifest(raw: unknown): CatalogManifest | null {
  if (!isRecord(raw)) return null;
  if (!isCount(raw.revision)) return null;
  if (!isCount(raw.pageSize) || raw.pageSize < 1) return null;
  if (Number(raw.pageSize) !== CATALOG_PAGE_SIZE) return null;
  if (!isRecord(raw.channels)) return null;
  return { revision: Number(raw.revision), pageSize: CATALOG_PAGE_SIZE, channels: validateChannels(raw.channels) };
}

/**
 * §C-2b publishes private *episode manifests* only, so the private pointer legitimately carries no
 * shard inventory: requiring one would make every private detail read impossible. `revision` is the only
 * field this door needs, because it is the path segment of `private/v{revision}/titles/…`.
 */
export function validatePrivateManifest(raw: unknown): CatalogManifest | null {
  if (!isRecord(raw)) return null;
  if (!isCount(raw.revision)) return null;
  const pageSize = raw.pageSize;
  if (pageSize !== undefined && (!isCount(pageSize) || pageSize < 1)) return null;
  return { revision: Number(raw.revision), pageSize: CATALOG_PAGE_SIZE, channels: validateChannels(raw.channels) };
}

/** The public pointer, or `null` when it is absent or unusable (the caller answers 503). */
export async function readPublicManifest(kv: KVNamespace): Promise<CatalogManifest | null> {
  const text = await readKvText(kv, CATALOG_MANIFEST_KV_KEY);
  if (text === null) return null;
  return validatePublicManifest(parseStoredJson(text));
}

/** The private pointer, validated by its own (narrower) rules for the same reason: separate pipeline. */
export async function readPrivateManifest(kv: KVNamespace): Promise<CatalogManifest | null> {
  const text = await readKvText(kv, PRIVATE_MANIFEST_KV_KEY);
  if (text === null) return null;
  return validatePrivateManifest(parseStoredJson(text));
}

/** Inventory of one channel; a channel the manifest does not declare simply has nothing published. */
export function inventoryOf(manifest: CatalogManifest, channelId: string): ChannelInventory {
  return manifest.channels[channelId] ?? { chunks: 0, total: 0 };
}
