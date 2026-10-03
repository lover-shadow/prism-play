import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import { HTTP_STATUS_BY_ERROR_CODE, buildErrorResponse } from '../http/errors';
import { jsonResponse } from '../http/json';
import { isSafeWorkId } from '../library/contract';

/**
 * `POST /api/telemetry/lines` — device-reported line failures (§C-4).
 *
 * This is the only content-adjacent write left in D1 after the refactor: a small append-only signal
 * table that nobody reads on the request path (analysis is `wrangler d1 execute --command=… > csv`,
 * §C-4-4). It exists so line quality is measurable without the cloud ever proxying a video segment.
 *
 * Deliberately unauthenticated and deliberately **not** per-device throttled: a per-device cap needs a
 * D1 row *read* per report, which is exactly the quota this refactor is trying to stop spending. The
 * server-side cap is therefore the whole defence (§C-4-3): a request ships at most
 * `TELEMETRY_MAX_ROWS_PER_REQUEST` rows, everything past the cap is dropped without a word, and the
 * client is expected to batch on leave-screen instead of streaming.
 *
 * A malformed batch is refused (400) because that is the client's bug to fix, while a batch holding a
 * few malformed entries is accepted with those entries dropped — one broken record must not cost the
 * report of the nineteen good ones beside it.
 */

/** §C-4-1: one request writes at most this many rows; the excess is truncated silently. */
export const TELEMETRY_MAX_ROWS_PER_REQUEST = 20;

/** 1 KB per row is generous for a five-field signal; a 32 KB body is a client defect, not a burst. */
export const TELEMETRY_MAX_BODY_BYTES = 32_000;

/** §C-4 schema: only these three failure codes exist, so a typo can never invent a fourth 口径. */
export const LINE_FAILURE_CODES = ['timeout', 'http_error', 'decode_error'] as const;
export type LineFailureCode = (typeof LINE_FAILURE_CODES)[number];

export interface LineHealthSignalRow {
  readonly providerId: string;
  readonly workId: string;
  readonly lineIndex: number;
  readonly failureCode: LineFailureCode;
  readonly deviceHash: string;
  readonly reportedAt: number;
}

/** `provider_`-prefixed abstract code — a real brand name must never reach the ledger (AGENTS §二.1). */
const PROVIDER_ID_PATTERN = /^provider_[A-Za-z0-9]{1,32}$/;
const DEVICE_HASH_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
/** Line ranks are a small ordinal; a larger index is a client bug, not a line we can name. */
const LINE_INDEX_MAX = 32;

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isFailureCode(value: unknown): value is LineFailureCode {
  return typeof value === 'string' && (LINE_FAILURE_CODES as readonly string[]).includes(value);
}

/**
 * `reportedAt` is bounded to a plausible Unix-seconds window rather than validated against a clock:
 * the route is unauthenticated, so a device with a wrong clock is expected, and a garbage timestamp is
 * the only field that would silently poison a CSV trend line.
 */
function isPlausibleEpoch(value: unknown): value is number {
  return isInteger(value) && value >= 1_500_000_000 && value <= 4_000_000_000;
}

function toSignalRow(value: unknown): LineHealthSignalRow | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.providerId !== 'string' || !PROVIDER_ID_PATTERN.test(row.providerId)) return null;
  if (!isSafeWorkId(row.workId)) return null;
  if (!isInteger(row.lineIndex) || row.lineIndex < 0 || row.lineIndex > LINE_INDEX_MAX) return null;
  if (!isFailureCode(row.failureCode)) return null;
  if (typeof row.deviceHash !== 'string' || !DEVICE_HASH_PATTERN.test(row.deviceHash)) return null;
  if (!isPlausibleEpoch(row.reportedAt)) return null;
  return {
    providerId: row.providerId,
    workId: row.workId,
    lineIndex: row.lineIndex,
    failureCode: row.failureCode,
    deviceHash: row.deviceHash,
    reportedAt: row.reportedAt
  };
}

function refusal(message: string): Response {
  return jsonResponse(buildErrorResponse('VALIDATION_ERROR', message), HTTP_STATUS_BY_ERROR_CODE.VALIDATION_ERROR, {
    'Cache-Control': 'no-store'
  });
}

const INSERT_SIGNAL =
  'INSERT INTO line_health_signals (provider_id, work_id, line_index, failure_code, device_hash, reported_at) VALUES (?, ?, ?, ?, ?, ?)';

function insertStatement(db: D1Database, row: LineHealthSignalRow) {
  return db
    .prepare(INSERT_SIGNAL)
    .bind(row.providerId, row.workId, row.lineIndex, row.failureCode, row.deviceHash, row.reportedAt);
}

async function readJsonArray(request: Request): Promise<unknown[] | null> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text === '' || text.length > TELEMETRY_MAX_BODY_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}

export async function handleTelemetryLines(request: Request, env: Env, _clock: Clock): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  const entries = await readJsonArray(request);
  if (entries === null) return refusal('请求体必须是线路遥测对象组成的 JSON 数组');

  // §C-4-1: truncate, never reject — a client that batched 25 rows has already paid for the request.
  const rows: LineHealthSignalRow[] = [];
  for (const entry of entries.slice(0, TELEMETRY_MAX_ROWS_PER_REQUEST)) {
    const row = toSignalRow(entry);
    if (row !== null) rows.push(row);
  }
  if (rows.length === 0) return jsonResponse({ success: true, accepted: 0 }, 200, { 'Cache-Control': 'no-store' });

  // One D1 batch: a partial write would leave the ledger claiming a signal the client never got told
  // about, so either the whole accepted set lands or none of it does (409/500 surfaces as 503 upstream).
  await env.DB.batch(rows.map((row) => insertStatement(env.DB, row)));
  return jsonResponse({ success: true, accepted: rows.length }, 200, { 'Cache-Control': 'no-store' });
}
