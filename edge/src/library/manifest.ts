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
  workFacts?: { schema: 1; maxBytes: 524288; packs: Record<string, { key: string; bytes: number; sha256: string }> };
  coverOrigins?: string[];
  /** Internal, content-addressed public lexical projection; never a client endpoint. */
  publicSearch?: { schema: 1; count: number; key: string; bytes: number; sha256: string };
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
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > 65536) return null;
  if (!isCount(raw.revision)) return null;
  if (!isCount(raw.pageSize) || raw.pageSize < 1) return null;
  if (Number(raw.pageSize) !== CATALOG_PAGE_SIZE) return null;
  if (!isRecord(raw.channels)) return null;
  const manifest: CatalogManifest = { revision: Number(raw.revision), pageSize: CATALOG_PAGE_SIZE, channels: validateChannels(raw.channels) };
  if (raw.workFacts !== undefined) {
    const facts = raw.workFacts;
    if (!isRecord(facts) || ![1, 2].includes(Number(facts.schema)) || facts.maxBytes !== 524288 || !isRecord(facts.packs)) return null;
    if (facts.schema !== 1 && facts.schema !== 2) return null;
    const packs: NonNullable<CatalogManifest['workFacts']>['packs'] = {};
    const leaves = Object.keys(facts.packs).sort();
    for (let i = 0; i < leaves.length; i++) {
      const prefix = leaves[i], entry = facts.packs[prefix];
      if (facts.schema === 2 && (!Array.isArray(entry) || entry.length !== 2)) return null;
      const pack = facts.schema === 2 && Array.isArray(entry)
        ? { bytes: entry[0], sha256: entry[1], key: `library/facts/${entry[1]}.json` } : entry;
      if (!/^[a-f0-9]{2,64}$/.test(prefix) || (i > 0 && prefix.startsWith(leaves[i - 1]))) return null;
      if (!isRecord(pack) || typeof pack.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(pack.sha256)) return null;
      if (pack.key !== `library/facts/${pack.sha256}.json` || !isCount(pack.bytes) || pack.bytes < 1 || pack.bytes > 524288) return null;
      packs[prefix] = { key: pack.key, bytes: pack.bytes, sha256: pack.sha256 };
    }
    // Normalize internally so every existing reader follows the same verified directory.
    manifest.workFacts = { schema: 1, maxBytes: 524288, packs };
    if (!Array.isArray(raw.coverOrigins)) return null;
  }
  if (raw.publicSearch !== undefined) {
    const search = raw.publicSearch;
    if (!manifest.workFacts || !isRecord(search) || search.schema !== 1 || !isCount(search.count) ||
        !isCount(search.bytes) || search.bytes < 1 || search.bytes > 16777216 ||
        typeof search.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(search.sha256) ||
        search.key !== `library/search/${search.sha256}.json`) return null;
    manifest.publicSearch = search as unknown as NonNullable<CatalogManifest['publicSearch']>;
  }
  if (raw.coverOrigins !== undefined) {
    if (!Array.isArray(raw.coverOrigins) || !raw.coverOrigins.every((origin) => {
      if (typeof origin !== 'string') return false;
      try { const url = new URL(origin); return url.protocol === 'https:' && url.origin === origin && !url.username && !url.password; }
      catch { return false; }
    })) return null;
    manifest.coverOrigins = raw.coverOrigins;
  }
  return manifest;
}

/**
 * §C-2b publishes private *episode manifests* only, so the private pointer legitimately carries no
 * shard inventory: requiring one would make every private detail read impossible. `revision` is the only
 * field this door needs, because it is the path segment of `private/v{revision}/titles/…`.
 */
export function validatePrivateManifest(raw: unknown): CatalogManifest | null {
  if (!isRecord(raw)) return null;
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > 65536) return null;
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
