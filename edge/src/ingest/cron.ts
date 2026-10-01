import type { Clock } from '../core/clock';
import type { ProviderAdapter, ProviderPage } from './adapter';
import { serializeWorkPayload } from './normalize';
import {
  advanceSourceCursorStatement,
  insertSourceRecordStatement,
  listEnabledIngestSources,
  listPendingSourceRecords,
  readSourceRecord
} from './repository';
import { processRecord, recordAttemptFailure, type IngestErrorCode, type ProcessResult } from './state-machine';

/**
 * Scheduled ingest run (F-14 / AC-17). ARCHITECTURE §3.4: a wake only has to advance the cursors it
 * actually consumed, so pages and backlog are both bounded per run.
 */

/** Pages pulled per provider per wake; the stored cursor lets the next wake continue. */
export const INGEST_MAX_PAGES_PER_RUN = 5;
/** Source records re-processed per provider per wake, so a poisoned backlog cannot starve new pulls. */
export const INGEST_MAX_BACKLOG_PER_SOURCE = 200;

export interface IngestCycleDeps {
  db: D1Database;
  /** provider_id -> adapter. Injection only: this module performs no network call and knows no URL. */
  adapters: ReadonlyMap<string, ProviderAdapter>;
  clock: Clock;
  signal?: AbortSignal;
}

export interface IngestStorageError {
  recordId: number;
  message: string;
}

export interface IngestSourceReport {
  providerId: string;
  pagesFetched: number;
  recordsInserted: number;
  recordsDuplicate: number;
  payloadConflicts: number;
  linked: number;
  retried: number;
  quarantined: number;
  cursorAfter: string | null;
  passComplete: boolean;
  adapterErrorCode: IngestErrorCode | null;
  adapterErrorMessage: string | null;
  storageErrors: IngestStorageError[];
}

export interface IngestRunReport {
  ranAtSeconds: number;
  sources: IngestSourceReport[];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function newSourceReport(providerId: string, cursor: string | null): IngestSourceReport {
  return {
    providerId,
    pagesFetched: 0,
    recordsInserted: 0,
    recordsDuplicate: 0,
    payloadConflicts: 0,
    linked: 0,
    retried: 0,
    quarantined: 0,
    cursorAfter: cursor,
    passComplete: false,
    adapterErrorCode: null,
    adapterErrorMessage: null,
    storageErrors: []
  };
}

function tally(report: IngestSourceReport, result: ProcessResult): void {
  if (result.outcome === 'linked') report.linked += 1;
  else if (result.outcome === 'retry') report.retried += 1;
  else if (result.outcome === 'rejected') report.quarantined += 1;
  else if (result.outcome === 'payload_conflict') report.payloadConflicts += 1;
}

/**
 * Same idempotency key with a different payload means the source rewrote a revision it had already
 * published. The stored row wins and the anomaly is reported; rewriting it would break idempotency.
 */
async function detectPayloadConflict(
  db: D1Database,
  providerId: string,
  work: { sourceItemId: string; sourceRevision: string },
  metadataJson: string
): Promise<boolean> {
  const stored = await readSourceRecord(db, providerId, work.sourceItemId, work.sourceRevision);
  return stored !== null && stored.metadata_json !== metadataJson;
}

/**
 * One page per batch: the record inserts and the cursor advance commit together, so an interrupted run
 * resumes exactly at the cursor of the last page it fully stored — no duplicate consumption, no gap.
 */
async function pullPages(
  deps: IngestCycleDeps,
  source: { providerId: string; adapter: ProviderAdapter },
  startCursor: string | null,
  nowSeconds: number,
  report: IngestSourceReport
): Promise<string | null> {
  let cursor = startCursor;
  for (let page = 0; page < INGEST_MAX_PAGES_PER_RUN; page += 1) {
    let pulled: ProviderPage;
    try {
      pulled = await source.adapter.fetchPage(cursor, deps.signal);
    } catch (error) {
      // A provider that throws must not stop the run: the reason is recorded for this source only.
      report.adapterErrorCode = 'ADAPTER_UNAVAILABLE';
      report.adapterErrorMessage = describeError(error);
      return cursor;
    }

    const statements: D1PreparedStatement[] = [];
    const payloads: { sourceItemId: string; sourceRevision: string; metadataJson: string }[] = [];
    for (const work of pulled.items) {
      const metadataJson = serializeWorkPayload(work);
      statements.push(
        insertSourceRecordStatement(deps.db, {
          providerId: source.providerId,
          sourceItemId: work.sourceItemId,
          sourceRevision: work.sourceRevision,
          title: work.title,
          metadataJson,
          nowSeconds
        })
      );
      payloads.push({ sourceItemId: work.sourceItemId, sourceRevision: work.sourceRevision, metadataJson });
    }
    statements.push(advanceSourceCursorStatement(deps.db, source.providerId, pulled.nextCursor, nowSeconds));
    const batchResults = await deps.db.batch(statements);

    for (let index = 0; index < payloads.length; index += 1) {
      const inserted = Number(batchResults[index]?.meta.changes ?? 0) === 1;
      if (inserted) {
        report.recordsInserted += 1;
        continue;
      }
      report.recordsDuplicate += 1;
      const payload = payloads[index];
      if (await detectPayloadConflict(deps.db, source.providerId, payload, payload.metadataJson)) {
        report.payloadConflicts += 1;
      }
    }

    report.pagesFetched += 1;
    report.cursorAfter = pulled.nextCursor;
    cursor = pulled.nextCursor;
    if (cursor === null) {
      report.passComplete = true;
      return null;
    }
  }
  return cursor;
}

async function processPendingBacklog(
  db: D1Database,
  providerId: string,
  nowSeconds: number,
  report: IngestSourceReport
): Promise<void> {
  const pending = await listPendingSourceRecords(db, providerId, nowSeconds, INGEST_MAX_BACKLOG_PER_SOURCE);
  for (const record of pending) {
    try {
      tally(report, await processRecord(db, record, nowSeconds));
    } catch (error) {
      // Storage-level fault: written back through the retry path so the reason survives, the rest of
      // the batch keeps going, and the row stays visible instead of being dropped.
      const outcome = await recordAttemptFailure(db, record, 'CATALOG_WRITE_FAILED', nowSeconds);
      report.storageErrors.push({ recordId: record.id, message: describeError(error) });
      tally(report, { outcome, recordId: record.id, contentId: record.content_id, errorCode: 'CATALOG_WRITE_FAILED' });
    }
  }
}

export async function runIngestCycle(deps: IngestCycleDeps): Promise<IngestRunReport> {
  const nowSeconds = deps.clock.nowSeconds();
  const sources = await listEnabledIngestSources(deps.db);
  const report: IngestRunReport = { ranAtSeconds: nowSeconds, sources: [] };

  for (const source of sources) {
    const sourceReport = newSourceReport(source.provider_id, source.cursor);
    report.sources.push(sourceReport);
    const adapter = deps.adapters.get(source.provider_id);
    if (adapter === undefined) {
      sourceReport.adapterErrorCode = 'ADAPTER_UNAVAILABLE';
      sourceReport.adapterErrorMessage = `no adapter injected for ${source.provider_id}`;
    } else if (adapter.providerId !== source.provider_id) {
      // A mis-wired adapter would file another provider's items under this provider's rows.
      sourceReport.adapterErrorCode = 'PROVIDER_UNCONFIGURED';
      sourceReport.adapterErrorMessage = `adapter id ${adapter.providerId} does not match source ${source.provider_id}`;
    } else {
      await pullPages(deps, { providerId: source.provider_id, adapter }, source.cursor, nowSeconds, sourceReport);
    }
    // Backlog drains either way: rows stored by an earlier interrupted wake must not stall.
    await processPendingBacklog(deps.db, source.provider_id, nowSeconds, sourceReport);
  }

  return report;
}
