import type { CatalogChangesResponse } from '../types/api';
import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import type { ErrorCode } from '../types/api';
import { CHANGES_DEFAULT_LIMIT, CHANGES_MAX_LIMIT } from '../core/constants';
import { configUnavailableResponse } from '../config/kv-config';
import { errorResponseNoStore } from '../http/errors';
import { isCursorExpired, readChangePage, readRevisionCursor } from '../db/change-repo';
import { jsonResponse } from '../http/json';
import { originOf } from '../http/serialize';

/**
 * `GET /api/catalog/changes` — the public incremental directory (API-SPEC §八, SPEC §6).
 *
 * The data source moved from the D1 change log to the difference between adjacent R2 revisions
 * (§C-3-3); every wire rule this route owns is unchanged:
 *  - bad input is a **400**, never a plausible empty page: a fabricated empty page would tell the
 *    client it is caught up, which is how a catalogue silently rots;
 *  - `after` ahead of the current revision is also a **400** (the client holds a cursor from the
 *    future — a clock or a restored-backup defect, not a synchronisation state);
 *  - a cursor the published assets cannot replay is **410**: re-pull the snapshot;
 *  - no manifest to diff against is **503**, not a fake empty page;
 *  - revision numbers strictly increase but may contain holes (a failed write). A hole is never a
 *    missing page, so this route never invents one and never compares gaps.
 */

/** Public pages are short-cacheable: a cached page delays sync for a bounded, small window only. */
const CHANGES_PAGE_CACHE_SECONDS = 15;

/*
 * Ruling G2 A-1 ratified `VALIDATION_ERROR` (400) and `CATALOG_CURSOR_EXPIRED` (410), so both answers
 * carry the standard ErrorResponse body; `errorResponse` keeps the enum's one-status-per-code pin.
 */
function protocolError(code: ErrorCode, status: number, message?: string): Response {
  return errorResponseNoStore(code, message, status);
}

function invalidRequest(message: string): Response {
  return protocolError('VALIDATION_ERROR', 400, message);
}

/** Strict `^\d+$`: no sign, no exponent, no whitespace, no fractional part, and inside int64 range. */
function parseNonNegativeInteger(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export async function handleChanges(request: Request, env: Env, _clock: Clock): Promise<Response> {
  const params = new URL(request.url).searchParams;

  const rawAfter = params.get('after');
  if (rawAfter === null || rawAfter === '') {
    return invalidRequest('after 为必填参数，应为不小于 0 的公开目录修订号');
  }
  const after = parseNonNegativeInteger(rawAfter);
  if (after === null) return invalidRequest('after 应为不小于 0 的整数修订号，增量游标不可自行加 1');

  const rawLimit = params.get('limit');
  let limit = CHANGES_DEFAULT_LIMIT;
  if (rawLimit !== null && rawLimit !== '') {
    const parsedLimit = parseNonNegativeInteger(rawLimit);
    if (parsedLimit === null || parsedLimit < 1 || parsedLimit > CHANGES_MAX_LIMIT) {
      return invalidRequest(`limit 应为 1 到 ${CHANGES_MAX_LIMIT} 之间的整数`);
    }
    limit = parsedLimit;
  }

  const cursor = await readRevisionCursor(env);
  // No manifest pointer means there is nothing to diff against: refuse instead of answering a page.
  if (cursor === null) return configUnavailableResponse();
  if (after > cursor.current) return invalidRequest('游标大于当前公开修订号，请核对本地快照的修订号');

  // Only a change this cursor still needs can be unanswerable: integer holes, and revisions the client
  // has already passed, are irrelevant — exactly the rule the D1 retention window used to enforce.
  if (isCursorExpired(after, cursor)) return protocolError('CATALOG_CURSOR_EXPIRED', 410);

  const page = await readChangePage(env, after, limit, originOf(request));
  // `null` is "the published assets cannot replay this cursor", including a diff too wide to fit one
  // page: the contract's only honest answer is the snapshot re-pull a 410 asks for.
  if (page === null) return protocolError('CATALOG_CURSOR_EXPIRED', 410);
  return changesPageResponse(page);
}

function changesPageResponse(body: CatalogChangesResponse): Response {
  return jsonResponse(body, 200, { 'Cache-Control': `public, max-age=${CHANGES_PAGE_CACHE_SECONDS}` });
}
