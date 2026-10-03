import type { CatalogChangesResponse, ContentItem } from '../types/api';
import type { Env } from '../types/env';
import type { CatalogManifest } from '../library/manifest';
import { inventoryOf, readPublicManifest } from '../library/manifest';
import { chunkKey } from '../library/paths';
import { parseCatalogShard } from '../library/chunk';

/**
 * The public incremental directory, derived from R2 shards instead of `public_catalog_changes`
 * (§C-3-3). The wire rules this module is still accountable for are unchanged, and they are the reason
 * it refuses rather than approximates:
 *  - bad input is a **400** (that decision stays in the route), never a plausible empty page: a
 *    fabricated empty page tells the client it is caught up, which is how a catalogue silently rots;
 *  - a cursor the published assets cannot replay is **410** — the contract's instruction to re-pull a
 *    snapshot, exactly what the old 30-day retention window produced for an aged cursor;
 *  - revisions strictly increase but may contain holes (a failed CI publish). A hole is not a missing
 *    page, so nothing here invents one.
 *
 * What the diff actually is: the item-level difference between `library/v{after}` and
 * `library/v{current}`. Completeness is non-negotiable, so both sides are read **in full**, which caps
 * how wide this endpoint can be: Cloudflare allows 50 subrequests per invocation on the free plan, so a
 * four-channel library of more than `CHANGES_DIFF_CHUNK_BUDGET` shards per revision cannot be diffed in
 * one request at all. Over budget — or over the page `limit`, which could not be paginated because every
 * change in a revision carries that revision's single number — the answer is 410 and the client re-pulls
 * shards. That is the cheap direction now (a page is one R2 object), and it is why the refactor does not
 * need a wider incremental feed.
 */

/** Shard gets this endpoint will perform for one revision side before declaring the diff unanswerable. */
export const CHANGES_DIFF_CHUNK_BUDGET = 20;

/** One side of the comparison: content id → the card exactly as the shard stores it. */
type ItemTable = Map<string, ContentItem>;

interface ChannelPlan {
  readonly channelId: string;
  readonly chunks: number;
}

function plansOf(manifest: CatalogManifest): ChannelPlan[] {
  return Object.keys(manifest.channels)
    .filter((channelId) => channelId !== 'private')
    .map((channelId) => ({ channelId, chunks: inventoryOf(manifest, channelId).chunks }));
}

function shardCount(plans: readonly ChannelPlan[]): number {
  return plans.reduce((total, plan) => total + plan.chunks, 0);
}

/** Key order is not data order: two runs that emit the same fields differently must compare equal. */
function canonicalForm(item: ContentItem): string {
  const record = item as unknown as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return JSON.stringify(keys.map((key) => [key, record[key]]));
}

async function readShard(
  bucket: R2Bucket,
  revision: number,
  channelId: string,
  index: number,
  origin: string,
  table: ItemTable
): Promise<boolean> {
  const object = await bucket.get(chunkKey(revision, channelId, index));
  if (object === null) return false;
  const verdict = parseCatalogShard(await object.text(), revision, origin);
  if (verdict.ok === false) return false;
  for (const item of verdict.value.items) {
    // The same work in two shards would make the diff depend on read order: that is a broken publish.
    if (table.has(item.id)) return false;
    table.set(item.id, item);
  }
  return true;
}

/** Every declared shard must be there; a dangling manifest pointer is not an answerable page. */
async function readRevisionSide(
  bucket: R2Bucket,
  revision: number,
  plans: readonly ChannelPlan[],
  origin: string
): Promise<ItemTable | null> {
  const table: ItemTable = new Map();
  for (const plan of plans) {
    for (let index = 0; index < plan.chunks; index += 1) {
      if (!(await readShard(bucket, revision, plan.channelId, index, origin, table))) return null;
    }
  }
  return table;
}

/**
 * The previous revision is not described by any manifest — KV holds only the newest pointer — so it is
 * read with the current revision's shard counts and the shard after them is **probed**: if that exists,
 * the older revision was wider than anything this request can bound, and a diff that cannot see the
 * difference in width would silently drop deletes. Refusing is the only honest move.
 */
async function readPreviousSide(
  bucket: R2Bucket,
  revision: number,
  plans: readonly ChannelPlan[],
  origin: string
): Promise<ItemTable | null> {
  const table: ItemTable = new Map();
  let anyShard = false;
  for (const plan of plans) {
    for (let index = 0; index < plan.chunks; index += 1) {
      if (!(await readShard(bucket, revision, plan.channelId, index, origin, table))) break;
      anyShard = true;
    }
    if (await readShard(bucket, revision, plan.channelId, plan.chunks, origin, new Map())) return null;
  }
  return anyShard ? table : null;
}
function upsertContent(revision: number, item: ContentItem): CatalogChangesResponse['changes'][number] {
  // The card leaves in the dialect the shard serves it in, so a client never caches two shapes.
  return { revision, contentId: item.id, operation: 'upsert', item };
}

function tombstone(revision: number, contentId: string): CatalogChangesResponse['changes'][number] {
  // Exactly three keys: an unknown-but-removed work must not leak a single field of its metadata.
  return { revision, contentId, operation: 'delete' };
}

function diffTables(revision: number, previous: ItemTable, current: ItemTable): CatalogChangesResponse['changes'] {
  const changes: CatalogChangesResponse['changes'] = [];
  for (const [contentId, item] of [...current.entries()].sort(([left], [right]) => (left < right ? -1 : 1))) {
    const before = previous.get(contentId);
    if (before === undefined || canonicalForm(before) !== canonicalForm(item)) changes.push(upsertContent(revision, item));
  }
  for (const contentId of [...previous.keys()].sort()) {
    if (!current.has(contentId)) changes.push(tombstone(revision, contentId));
  }
  return changes;
}

/**
 * `null` means "this cursor cannot be replayed from the published assets" — the route turns it into the
 * contract's 410 and the client re-pulls a snapshot.
 */
export async function readChangePage(
  env: Env,
  after: number,
  limit: number,
  origin: string
): Promise<CatalogChangesResponse | null> {
  const manifest = await readPublicManifest(env.KV);
  const bucket = env.APK_BUCKET;
  if (manifest === null || bucket === undefined) return null;

  const current = manifest.revision;
  if (after >= current) return { changes: [], nextRevision: after, hasMore: false };
  // CI prunes older revisions, so the replay window is one revision wide (§1.2-4: one publish a day).
  // `after=0` is the deliberate exception: a client with no snapshot at all diffs against the empty set,
  // so every card of the first published revision is an upsert and no older object has to exist.
  const freshClient = after === 0;
  if (!freshClient && after !== current - 1) return null;

  const plans = plansOf(manifest);
  if (shardCount(plans) > CHANGES_DIFF_CHUNK_BUDGET) return null;
  if (!freshClient && shardCount(plans) * 2 > CHANGES_DIFF_CHUNK_BUDGET) return null;

  const currentTable = await readRevisionSide(bucket, current, plans, origin);
  if (currentTable === null) return null;
  if (freshClient) {
    const changes = diffTables(current, new Map(), currentTable);
    if (changes.length > limit) return null;
    return { changes, nextRevision: current, hasMore: false };
  }

  const previousTable = await readPreviousSide(bucket, current - 1, plans, origin);
  if (previousTable === null) return null;

  const changes = diffTables(current, previousTable, currentTable);
  // Over `limit` cannot be paginated: every change here carries the same revision, so a cursor could not
  // resume inside the page. 410 asks for a snapshot instead of shipping half a diff.
  if (changes.length > limit) return null;
  return { changes, nextRevision: current, hasMore: false };
}

/**
 * Current public revision and its replay floor, both read from the KV manifest; `null` when the publish
 * is not there to read. `null` is a refusal (503) rather than `0`, because `0` is a legitimate revision
 * and a client holding `after=0` would otherwise be told it is caught up by an unprovisioned cloud.
 */
export async function readRevisionCursor(env: Env): Promise<{ current: number; oldest: number } | null> {
  const manifest = await readPublicManifest(env.KV);
  if (manifest === null) return null;
  // A revision of 0 means "nothing published yet": there is no floor to expire a cursor against.
  return { current: manifest.revision, oldest: manifest.revision === 0 ? 0 : manifest.revision - 1 };
}

/**
 * Retention rule in the asset dialect: a cursor older than the replay floor can never be answered.
 * Integer holes and revisions the client has already passed stay irrelevant, exactly as in the D1
 * version — which is why a cursor at the floor replays and one below it does not.
 *
 * `after=0` is never expired here: a device with no snapshot at all is making a legitimate bootstrap
 * request, and whether its diff is answerable is decided by the published assets, not by the floor.
 */
export function isCursorExpired(after: number, cursor: { current: number; oldest: number }): boolean {
  if (after >= cursor.current) return false;
  if (after === 0) return false;
  return after < cursor.oldest;
}
