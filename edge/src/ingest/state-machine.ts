import { INGEST_MAX_AUTO_RETRIES } from '../core/constants';
import type { ProviderWork } from './adapter';
import {
  coverVersionOf,
  normalizeCategory,
  normalizeOptionalText,
  normalizeTitle,
  parseWorkPayload,
  stableContentId
} from './normalize';
import { publish, publishToPrivateCatalog } from './publish';
import {
  ensureContentEpisode,
  findContentIdForSourceItem,
  insertContentItemStatement,
  linkSourceEpisodeStatement,
  markRecordLinkedStatement,
  markRecordPublishedStatement,
  readContentItem,
  readProviderChannelId,
  readTrustedMapping,
  recordAttemptFailureStatement,
  updateContentItemMetadataStatement,
  type LinkEvidence,
  type SourceRecordRow,
  type SourceRecordStatus
} from './repository';

/**
 * Record lifecycle: receive -> link -> (publish | retry | reject).
 * `enriched` is reachable only once metadata processing exists, which M-5 removed for this period.
 */

export const INGEST_ERROR_CODES = [
  'ADAPTER_UNAVAILABLE',
  'PROVIDER_UNCONFIGURED',
  'PAYLOAD_INVALID',
  'PAYLOAD_CONFLICT',
  'LINK_AMBIGUOUS',
  'CATALOG_WRITE_FAILED'
] as const;
export type IngestErrorCode = (typeof INGEST_ERROR_CODES)[number];

export const PROCESS_OUTCOMES = ['linked', 'retry', 'rejected', 'skipped', 'payload_conflict'] as const;
export type ProcessOutcome = (typeof PROCESS_OUTCOMES)[number];

/**
 * Delay in seconds before the next automatic attempt, indexed by the attempt that just failed.
 * The Worker wakes twice a day, so the effective wait is max(this value, the cron cadence); the ladder
 * only needs to order "retry soon" against "retry later" before quarantine closes the record.
 */
export const INGEST_RETRY_BACKOFF_SECONDS: readonly number[] = [3600, 14400, 43200];

const TERMINAL_STATUSES: readonly SourceRecordStatus[] = ['linked', 'published', 'rejected'];

export function retryDelaySeconds(attemptCount: number): number {
  const index = Math.min(Math.max(attemptCount, 1), INGEST_RETRY_BACKOFF_SECONDS.length) - 1;
  return INGEST_RETRY_BACKOFF_SECONDS[index];
}

export interface ProcessResult {
  readonly outcome: ProcessOutcome;
  readonly recordId: number;
  readonly contentId: string | null;
  readonly errorCode: IngestErrorCode | null;
}

export type IdentityDecision =
  | { readonly kind: 'resolved'; readonly contentId: string; readonly evidence: LinkEvidence }
  | { readonly kind: 'ambiguous'; readonly errorCode: IngestErrorCode; readonly detail: string };

export class IngestTransitionError extends Error {
  readonly recordId: number;
  readonly reason: string;

  constructor(recordId: number, reason: string) {
    super(`source record ${recordId} cannot take this transition: ${reason}`);
    this.name = 'IngestTransitionError';
    this.recordId = recordId;
    this.reason = reason;
  }
}

/** Rules mirror the DDL CHECKs so a rejected payload never reaches a constraint mid-batch. */
export function validateWork(work: ProviderWork): IngestErrorCode | null {
  if (work.sourceItemId.trim() === '' || work.sourceRevision.trim() === '') return 'PAYLOAD_INVALID';
  if (normalizeTitle(work.title) === '') return 'PAYLOAD_INVALID';
  if (normalizeCategory(work.category) === '') return 'PAYLOAD_INVALID';
  if (work.episodes.length === 0) return 'PAYLOAD_INVALID';
  const episodeIds = new Set<string>();
  const episodeNumbers = new Set<number>();
  for (const episode of work.episodes) {
    if (episode.sourceEpisodeId.trim() === '') return 'PAYLOAD_INVALID';
    if (!Number.isInteger(episode.episodeNumber) || episode.episodeNumber <= 0) return 'PAYLOAD_INVALID';
    const duration = episode.durationSeconds;
    if (duration !== undefined && (!Number.isInteger(duration) || duration < 0)) return 'PAYLOAD_INVALID';
    if (episodeIds.has(episode.sourceEpisodeId) || episodeNumbers.has(episode.episodeNumber)) return 'PAYLOAD_INVALID';
    episodeIds.add(episode.sourceEpisodeId);
    episodeNumbers.add(episode.episodeNumber);
  }
  return null;
}

/**
 * Identity resolution, in contract order, and deliberately blind to titles:
 * 1. the same `(provider_id, source_item_id)` on another revision -> `same_source_id`;
 * 2. a `trusted_work_mappings` row with recorded evidence -> `trusted_cross_source_map`;
 * 3. otherwise a brand-new work -> `new_work`.
 * A mapping whose target is absent or filed under another channel is unusable evidence, so it is
 * quarantined through the retry path instead of silently forking a duplicate work.
 */
export async function resolveWorkIdentity(
  db: D1Database,
  providerId: string,
  sourceItemId: string,
  excludeRecordId: number
): Promise<IdentityDecision> {
  const known = await findContentIdForSourceItem(db, providerId, sourceItemId, excludeRecordId);
  if (known !== null) return { kind: 'resolved', contentId: known, evidence: 'same_source_id' };

  const mapping = await readTrustedMapping(db, providerId, sourceItemId);
  if (mapping === null) {
    return { kind: 'resolved', contentId: stableContentId(providerId, sourceItemId), evidence: 'new_work' };
  }
  const target = await readContentItem(db, mapping.content_id);
  if (target === null) {
    return { kind: 'ambiguous', errorCode: 'LINK_AMBIGUOUS', detail: `mapping points at absent content ${mapping.content_id}` };
  }
  const providerChannel = await readProviderChannelId(db, providerId);
  if (providerChannel === null) {
    return { kind: 'ambiguous', errorCode: 'PROVIDER_UNCONFIGURED', detail: `provider ${providerId} is not configured` };
  }
  if (target.channel_id !== providerChannel) {
    return {
      kind: 'ambiguous',
      errorCode: 'LINK_AMBIGUOUS',
      detail: `mapping target channel ${target.channel_id} conflicts with provider channel ${providerChannel}`
    };
  }
  return { kind: 'resolved', contentId: mapping.content_id, evidence: 'trusted_cross_source_map' };
}

/** attempt_count counts attempts, and reaching INGEST_MAX_AUTO_RETRIES closes the record for good. */
export async function recordAttemptFailure(
  db: D1Database,
  record: SourceRecordRow,
  errorCode: IngestErrorCode,
  nowSeconds: number
): Promise<'retry' | 'rejected'> {
  const attemptCount = record.attempt_count + 1;
  const quarantined = attemptCount >= INGEST_MAX_AUTO_RETRIES;
  await recordAttemptFailureStatement(db, {
    recordId: record.id,
    status: quarantined ? 'rejected' : 'retry',
    errorCode,
    attemptCount,
    nextAttemptAt: quarantined ? null : nowSeconds + retryDelaySeconds(attemptCount),
    nowSeconds
  }).run();
  return quarantined ? 'rejected' : 'retry';
}

/**
 * The source row that created a work owns its metadata. A cross-source merge only contributes episodes,
 * otherwise two providers would overwrite each other's title and cover on every alternating cycle.
 */
async function materializeWork(
  db: D1Database,
  contentId: string,
  channelId: string,
  evidence: LinkEvidence,
  work: ProviderWork,
  nowSeconds: number
): Promise<void> {
  const title = normalizeTitle(work.title);
  const synopsis = normalizeOptionalText(work.synopsis);
  const coverUrl = normalizeOptionalText(work.coverUrl);
  const existing = await readContentItem(db, contentId);
  if (existing === null) {
    await insertContentItemStatement(db, {
      contentId,
      channelId,
      title,
      category: normalizeCategory(work.category),
      coverUrl,
      coverVersion: coverVersionOf(coverUrl),
      synopsis,
      nowSeconds
    }).run();
    return;
  }
  if (evidence === 'trusted_cross_source_map') return;
  if (existing.title === title && existing.cover_url === coverUrl && existing.synopsis === synopsis) return;
  await updateContentItemMetadataStatement(db, {
    contentId,
    title,
    coverUrl,
    coverVersion: coverVersionOf(coverUrl),
    synopsis,
    nowSeconds
  }).run();
}

async function linkEpisodes(
  db: D1Database,
  recordId: number,
  contentId: string,
  work: ProviderWork,
  nowSeconds: number
): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const episode of work.episodes) {
    const episodeId = await ensureContentEpisode(
      db,
      contentId,
      episode.episodeNumber,
      episode.durationSeconds ?? null,
      nowSeconds
    );
    statements.push(linkSourceEpisodeStatement(db, recordId, episode.sourceEpisodeId, episodeId));
  }
  if (statements.length > 0) await db.batch(statements);
}

/** One record, one attempt. Storage faults propagate so the caller can record them, never here. */
export async function processRecord(db: D1Database, record: SourceRecordRow, nowSeconds: number): Promise<ProcessResult> {
  const fail = async (errorCode: IngestErrorCode): Promise<ProcessResult> => {
    const outcome = await recordAttemptFailure(db, record, errorCode, nowSeconds);
    return { outcome, recordId: record.id, contentId: record.content_id, errorCode };
  };
  if (TERMINAL_STATUSES.includes(record.status)) {
    return { outcome: 'skipped', recordId: record.id, contentId: record.content_id, errorCode: null };
  }
  const work = parseWorkPayload(record.metadata_json);
  if (work === null || work.sourceItemId !== record.source_item_id || work.sourceRevision !== record.source_revision) {
    return fail('PAYLOAD_INVALID');
  }
  const invalid = validateWork(work);
  if (invalid !== null) return fail(invalid);
  const channelId = await readProviderChannelId(db, record.provider_id);
  if (channelId === null) return fail('PROVIDER_UNCONFIGURED');

  const identity = await resolveWorkIdentity(db, record.provider_id, record.source_item_id, record.id);
  if (identity.kind === 'ambiguous') return fail(identity.errorCode);

  await materializeWork(db, identity.contentId, channelId, identity.evidence, work, nowSeconds);
  await linkEpisodes(db, record.id, identity.contentId, work, nowSeconds);
  await markRecordLinkedStatement(db, record.id, identity.contentId, identity.evidence, nowSeconds).run();
  return { outcome: 'linked', recordId: record.id, contentId: identity.contentId, errorCode: null };
}

/**
 * Explicit publication step (SPEC §6: 元数据确认后显式上架) — the scheduled run links work, an operator
 * publishes it. Public works get an atomic catalogue write plus a change row; 个人探索 work only flips
 * visibility, and a record that is not `linked` cannot be published at all.
 */
export async function publishLinkedRecord(
  db: D1Database,
  record: SourceRecordRow,
  nowSeconds: number
): Promise<{ revision: number | null }> {
  if (record.status !== 'linked') {
    throw new IngestTransitionError(record.id, `only a linked record can be published, found ${record.status}`);
  }
  const content = await readContentItem(db, record.content_id ?? '');
  if (content === null) {
    throw new IngestTransitionError(record.id, `linked content ${String(record.content_id)} is gone`);
  }
  if (content.channel_id === 'private') {
    await publishToPrivateCatalog(db, content.id, nowSeconds);
    await markRecordPublishedStatement(db, record.id, nowSeconds).run();
    return { revision: null };
  }
  const revision = await publish(db, content.id, nowSeconds);
  await markRecordPublishedStatement(db, record.id, nowSeconds).run();
  return { revision };
}
