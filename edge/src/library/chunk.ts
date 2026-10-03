/**
 * R2 directory shard read (SPEC-CLOUD-REFACTOR v2 §3.1).
 *
 * The route ships the stored bytes **verbatim** — that is the point of the refactor: the Worker stops
 * being a query planner and becomes a pointer, so a browse request costs zero D1 rows (§C-3 / AC-C3-1).
 * Parsing still happens, but only as a gate in front of the passthrough: the object is checked against
 * §3.1 before its bytes are forwarded, and a shard that fails the check is refused (503) instead of
 * shipped. Validation therefore never re-serialises, so a passing shard leaves the edge byte-identical
 * to what CI wrote.
 */

import type { ContentItem } from '../types/api';
import type { CatalogManifest } from './manifest';
import { inventoryOf } from './manifest';
import type { AssetRejection, AssetVerdict } from './contract';
import { accept, isControlledCoverHandle, isCount, isNonEmptyText, isOptionalCount, isRecord, isSafeWorkId, reject } from './contract';

export interface CatalogShard {
  /** The exact stored JSON, forwarded untouched whenever the caller does not narrow it. */
  readonly raw: string;
  readonly items: readonly ContentItem[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly revision: number;
}

/**
 * §3.1 item shape. `isPrivate` may be absent (a public shard omits nothing today, but absence is not a
 * leak) while a *present* value must be boolean — `isPrivate: true` in a public shard is checked by
 * {@link itemIsPrivate}, never by the caller remembering to.
 */
function isShardItemShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isSafeWorkId(value.id)) return false;
  if (!isNonEmptyText(value.title)) return false;
  if (!isNonEmptyText(value.channelId)) return false;
  if (typeof value.category !== 'string') return false;
  if (value.isPrivate !== undefined && typeof value.isPrivate !== 'boolean') return false;
  if (value.isAi !== undefined && typeof value.isAi !== 'boolean') return false;
  if (value.isHot !== undefined && typeof value.isHot !== 'boolean') return false;
  // The two §3.1 additions are what the device-side boards sort on; a wrong type there is a wrong asset.
  return isOptionalCount(value.firstPublishedAt) && isOptionalCount(value.hitsTotal);
}

function itemIsPrivate(item: ContentItem): boolean {
  return item.isPrivate === true || item.channelId === 'private';
}

/**
 * A shard is only usable when its own `revision` agrees with the manifest that pointed at it: a stale
 * object under a new key would otherwise be served as the new snapshot and pin every client to it.
 *
 * `mode` is the privacy door. Public shards reject a private item outright (§2.2: 私密永不进入公开资产);
 * private shards are only ever read behind the double-admission predicate, so there the flag is expected
 * and the caller re-signs every cover instead of shipping the stored handle.
 */
export function parseCatalogShard(raw: string, expectedRevision: number, origin: string, mode: 'public' | 'private' = 'public'): AssetVerdict<CatalogShard> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return reject('malformed');
  }
  if (!isRecord(parsed)) return reject('malformed');
  if (!Array.isArray(parsed.items)) return reject('malformed');
  if (!isCount(parsed.page) || !isCount(parsed.total) || !isCount(parsed.revision)) return reject('malformed');
  if (parsed.revision !== expectedRevision) return reject('malformed');
  const items: unknown[] = parsed.items;
  for (const item of items) {
    if (!isShardItemShape(item)) return reject('malformed');
    // The cover is checked separately because it fails a different red line: §3.1 allows only a
    // same-origin handle, and an upstream address here would ship the source site to every client.
    if (!isControlledCoverHandle(isRecord(item) ? item.coverUrl : undefined, origin)) return reject('upstream-address');
    // The pipeline audit criterion (AC-C2b-1) is `is_private=1` count == 0 across the public prefix;
    // the edge re-checks it per response because a silent leak here is unrecoverable once cached.
    if (mode === 'public' && itemIsPrivate(item as ContentItem)) return reject('private-in-public');
  }
  return accept({
    raw,
    items: items as ContentItem[],
    page: parsed.page,
    pageSize: isCount(parsed.pageSize) ? parsed.pageSize : 0,
    total: parsed.total,
    revision: parsed.revision
  });
}

export type ShardRead =
  | { readonly status: 'absent' }
  | { readonly status: 'rejected'; readonly reason: AssetRejection }
  | { readonly status: 'ok'; readonly shard: CatalogShard };

/** One R2 get plus one validation pass. `absent` is a dangling manifest pointer, not a bad page. */
export async function readShardAt(
  bucket: R2Bucket,
  key: string,
  expectedRevision: number,
  origin: string,
  mode: 'public' | 'private' = 'public'
): Promise<ShardRead> {
  const object = await bucket.get(key);
  if (object === null) return { status: 'absent' };
  const text = await object.text();
  const verdict = parseCatalogShard(text, expectedRevision, origin, mode);
  if (verdict.ok === false) return { status: 'rejected', reason: verdict.reason };
  return { status: 'ok', shard: verdict.value };
}

/**
 * `category` is the one query §3.1 cannot index — a shard is a channel page, not a filtered view — so
 * the narrowing happens here, on the already-served page, while the paging fields stay the shard's own.
 * The client therefore still walks every page of the channel and cannot lose a match to the filter.
 */
export function filterShardByCategory(shard: CatalogShard, category: string): { items: ContentItem[]; page: number; pageSize: number; total: number; revision: number } {
  return {
    items: shard.items.filter((item) => item.category === category),
    page: shard.page,
    pageSize: shard.pageSize,
    total: shard.total,
    revision: shard.revision
  };
}

/** Page beyond the declared inventory: an honest empty page of the contract shape, never a 404. */
export function emptyShardResponse(manifest: CatalogManifest, channelId: string, page: number) {
  const inventory = inventoryOf(manifest, channelId);
  return { items: [] as ContentItem[], page, pageSize: manifest.pageSize, total: inventory.total, revision: manifest.revision };
}

/** Verbatim passthrough of a validated shard — the category-free hot path, zero re-serialisation. */
export function shardResponse(shard: CatalogShard, headers: Record<string, string>): Response {
  return new Response(shard.raw, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}
