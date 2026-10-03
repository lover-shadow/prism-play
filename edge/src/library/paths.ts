/**
 * R2 object-key grammar for the catalogue assets (SPEC-CLOUD-REFACTOR v2 §3.1 / §3.2).
 *
 * Track 2a writes these keys; this file is the only place the Worker spells them, so the producer and
 * the reader cannot drift into two dialects. Both prefixes live in the *existing* `APK_BUCKET`
 * (`prism-play-releases`) next to `releases/android/latest.apk`, which `routes/dl.ts` owns — the three
 * prefixes are disjoint, so no second R2 binding is introduced.
 *
 *   library/v{revision}/{channelId}/chunk-{pageIndex}.json   public directory shard, 60 items
 *   library/v{revision}/titles/{workId}.json                 public episode manifest
 *   private/v{revision}/titles/{workId}.json                 private episode manifest (§C-2b)
 *   library/titles/{workId}.json                             public stable alias (bootstrap ships one copy)
 *   private/titles/{workId}.json                             private stable alias
 */

import { isSafeWorkId } from './contract';

export const PUBLIC_ASSET_PREFIX = 'library';
export const PRIVATE_ASSET_PREFIX = 'private';

function revisionSegment(revision: number): string {
  return `v${revision}`;
}

function join(segments: readonly string[]): string {
  return segments.join('/');
}

export function chunkKey(revision: number, channelId: string, pageIndex: number): string {
  return join([PUBLIC_ASSET_PREFIX, revisionSegment(revision), channelId, `chunk-${pageIndex}.json`]);
}

/** Prefix of every public shard of one channel in one revision — also the diff inventory handle. */
export function chunkPrefix(revision: number, channelId: string): string {
  return join([PUBLIC_ASSET_PREFIX, revisionSegment(revision), channelId, 'chunk-']);
}

export function previousChunkPrefix(revision: number, channelId: string): string {
  return chunkPrefix(revision - 1, channelId);
}

/**
 * Private shards are not produced by §C-2b (私密频道不做批量目录下发), but the key grammar is defined
 * so the route can serve them the moment the pipeline does: same shape, private prefix, private revision.
 */
export function privateChunkKey(revision: number, pageIndex: number): string {
  return join([PRIVATE_ASSET_PREFIX, revisionSegment(revision), 'private', `chunk-${pageIndex}.json`]);
}

export function titleKey(revision: number, workId: string): string {
  return join([PUBLIC_ASSET_PREFIX, revisionSegment(revision), 'titles', `${workId}.json`]);
}

export function privateTitleKey(revision: number, workId: string): string {
  return join([PRIVATE_ASSET_PREFIX, revisionSegment(revision), 'titles', `${workId}.json`]);
}

/**
 * Revision-free stable aliases, written by CI for every touched title and read by the routes as the
 * fallback when the versioned key is absent. Without them a revision bump would force a re-upload of
 * all ~8.7k manifests; with them, bootstrap ships one copy per title and daily runs only rewrite the
 * titles that actually changed. The reader tries `titleKey(revision, …)` first and falls back here —
 * the contract is spelled in `edge/scripts/config-sources.mjs` (stableTitleKey) and mirrored here
 * because key grammar must not grow a second dialect.
 */
export function stableTitleKey(workId: string): string {
  return join([PUBLIC_ASSET_PREFIX, 'titles', `${workId}.json`]);
}

export function stablePrivateTitleKey(workId: string): string {
  return join([PRIVATE_ASSET_PREFIX, 'titles', `${workId}.json`]);
}

/**
 * Key building is a trust boundary: an id that reaches here already passed the route's path check, and
 * this guard is the second one, because a `/` or `..` in a key would read outside the revision prefix.
 */
export function isKeySafeWorkId(workId: string): boolean {
  return isSafeWorkId(workId);
}
