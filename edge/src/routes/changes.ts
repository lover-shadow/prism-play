import type { CatalogChangesResponse } from '../types/api';
import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import type { ErrorCode } from '../types/api';
import { CHANGES_DEFAULT_LIMIT, CHANGES_MAX_LIMIT } from '../core/constants';
import { errorResponseNoStore } from '../http/errors';
import { readChangePage, readExpiredNeededRevision } from '../db/change-repo';
import { readPublicRevision } from '../db/content-repo';
import { jsonResponse } from '../http/json';
import { originOf } from '../http/serialize';

/**
 * `GET /api/catalog/changes` — the public incremental directory (API-SPEC §八, SPEC §6).
 *
 * Wire rules this route owns:
 *  - bad input is a **400**, never a plausible empty page: a fabricated empty page would tell the
 *    client it is caught up, which is how a catalogue silently rots;
 *  - `after` ahead of the current revision is also a **400** (the client holds a cursor from the
 *    future — a clock or a restored-backup defect, not a synchronisation state);
 *  - `after` older than the replay window is **410**: re-pull the snapshot. The window is measured
 *    against the changes this cursor still needs, not against a `MIN(revision)` floor, so neither an
 *    integer hole nor an already-passed expired row can force a fresh client into a 410 loop;
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

export async function handleChanges(request: Request, env: Env, clock: Clock): Promise<Response> {
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

  const current = await readPublicRevision(env.DB);
  if (after > current) return invalidRequest('游标大于当前公开修订号，请核对本地快照的修订号');

  // Only a change this cursor still needs can expire: rows already behind it, and integer holes, are
  // irrelevant, which is why a fresh `after=0` client replays a fully retained log without a 410.
  const expired = await readExpiredNeededRevision(env.DB, after, clock.nowSeconds());
  if (expired !== null) {
    return protocolError('CATALOG_CURSOR_EXPIRED', 410);
  }

  return changesPageResponse(await readChangePage(env.DB, after, limit, originOf(request)));
}

function changesPageResponse(body: CatalogChangesResponse): Response {
  return jsonResponse(body, 200, { 'Cache-Control': `public, max-age=${CHANGES_PAGE_CACHE_SECONDS}` });
}
