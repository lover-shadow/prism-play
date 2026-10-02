import type { Env } from '../types/env';
import type { Clock } from '../core/clock';
import type {
  UserSyncAcceptedResponse,
  UserSyncRequest,
  UserSyncStateResponse,
  SyncHistoryRow,
  UserSyncPreferences
} from '../types/api';
import { systemClock } from '../core/clock';
import {
  USER_SYNC_GET_MAX_ATTEMPTS,
  USER_SYNC_HISTORY_LIMIT,
  USER_SYNC_POST_MAX_ATTEMPTS,
  USER_SYNC_WINDOW_SECONDS
} from '../core/constants';
import { authenticate } from '../auth/guard';
import { unauthorizedResponse } from '../http/errors';
import { jsonResponse, readJsonBody } from '../http/json';
import { errorResponse } from '../http/errors';
import { createKvRateLimiter } from '../core/rate-limit';

/**
 * `GET|POST /api/user/sync` — multi-device watch-state relay (CLOUD-SYNC-JIT-PIPELINE-SPEC §2).
 *
 * The identity anchor is the **coupon**, not the device, so phone / TV / PC bound to the same code
 * share one history. The JWT carries only `sub` (deviceId) — there is no coupon claim — so the code
 * is always resolved server-side through `devices.bound_coupon`.
 *
 * Two invariants dominate this file:
 *
 * 1. **Private content never reaches the cloud.** A single coupon serves up to 10 devices in one
 *    household, so syncing 个人探索 would surface it on a living-room TV. The write is refused
 *    *before* any INSERT, and — critically — an unknown content id and a private one answer with
 *    byte-identical bodies. Otherwise "foreign key error" versus "silently skipped" would let any
 *    card holder probe which private ids exist (AC-02-3; independent audit A-3).
 * 2. **Every write is a real D1 row.** Unthrottled, one device could exhaust the account's daily
 *    row budget and take the whole database offline, so the limiter is keyed by device and enforced
 *    before any write.
 */

/** One shared body for every accepted POST, including the cases where nothing was stored. */
function acceptedBody(nowSeconds: number): UserSyncAcceptedResponse {
  return { success: true, syncedAt: nowSeconds };
}

function accepted(nowSeconds: number): Response {
  return jsonResponse(acceptedBody(nowSeconds), 200, { 'Cache-Control': 'no-store' });
}

async function couponCodeOf(db: D1Database, deviceId: string): Promise<string | null> {
  const row = await db
    .prepare('SELECT bound_coupon FROM devices WHERE device_id = ?')
    .bind(deviceId)
    .first<{ bound_coupon: string | null }>();
  const code = row?.bound_coupon ?? null;
  return code === null || code === '' ? null : code;
}

/**
 * Refusal reasons are collapsed into one answer on purpose.
 * Returns `null` when the content may be written; anything else means "write nothing, but answer
 * exactly as if it had been written".
 */
async function isWritableContent(db: D1Database, contentId: string): Promise<boolean> {
  if (typeof contentId !== 'string' || contentId === '') return false;
  const row = await db
    .prepare('SELECT is_private, channel_id, enabled FROM content_items WHERE id = ?')
    .bind(contentId)
    .first<{ is_private: number; channel_id: string; enabled: number }>();
  if (row === null) return false;
  if (Number(row.is_private) !== 0) return false;
  if (row.channel_id === 'private') return false;
  return Number(row.enabled) === 1;
}

function limitExceeded(): Response {
  return errorResponse('RATE_LIMITED', '同步请求过于频繁，请稍后再试', 429);
}

function syncLimiter(env: Env, clock: Clock, maxAttempts: number) {
  return createKvRateLimiter(env.KV, clock, {
    windowSeconds: USER_SYNC_WINDOW_SECONDS,
    maxAttempts
  });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Structural validation only: a malformed body is a 400, never a partial write. */
function parseRequest(body: unknown): UserSyncRequest | null {
  if (body === null || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const preferences = record.preferences as Record<string, unknown> | undefined;
  if (preferences === undefined || typeof preferences !== 'object') return null;

  const genres = preferences.genres;
  if (genres === undefined || typeof genres !== 'object' || genres === null) return null;
  for (const value of Object.values(genres as Record<string, unknown>)) {
    if (!isFiniteNumber(value) || value < 0) return null;
  }
  const totalPlays = preferences.totalPlays;
  if (!isFiniteNumber(totalPlays) || totalPlays < 0 || !Number.isInteger(totalPlays)) return null;

  const raw = record.history;
  let history: UserSyncRequest['history'] = null;
  if (raw !== null && raw !== undefined) {
    if (typeof raw !== 'object') return null;
    const entry = raw as Record<string, unknown>;
    const { contentId, episodeNumber, positionSeconds, durationSeconds } = entry;
    if (typeof contentId !== 'string' || contentId === '') return null;
    if (!isFiniteNumber(episodeNumber) || !Number.isInteger(episodeNumber) || episodeNumber < 1) return null;
    if (!isFiniteNumber(positionSeconds) || positionSeconds < 0) return null;
    if (!isFiniteNumber(durationSeconds) || durationSeconds < 0) return null;
    history = { contentId, episodeNumber, positionSeconds, durationSeconds };
  }

  return { history, preferences: { genres: genres as Record<string, number>, totalPlays } };
}

export async function handleUserSync(request: Request, env: Env, clock: Clock = systemClock): Promise<Response> {
  const nowSeconds = clock.nowSeconds();
  const outcome = await authenticate(request, env, clock);
  if (outcome.status !== 'ok') return unauthorizedResponse();

  const deviceId = outcome.identity.deviceId;
  const isWrite = request.method === 'POST';
  const limiter = syncLimiter(env, clock, isWrite ? USER_SYNC_POST_MAX_ATTEMPTS : USER_SYNC_GET_MAX_ATTEMPTS);
  const decision = await limiter.consume(`user-sync:${deviceId}`);
  if (!decision.allowed) return limitExceeded();

  const couponCode = await couponCodeOf(env.DB, deviceId);
  // A trial device has no coupon and therefore no shared history. It must still receive the same
  // success shape as a synced member, or the status itself becomes a membership oracle.
  if (couponCode === null) {
    return isWrite ? accepted(nowSeconds) : jsonResponse({ success: true, history: [], preferences: null }, 200, { 'Cache-Control': 'no-store' });
  }

  if (!isWrite) return await readState(env, couponCode);
  return await writeState(request, env, couponCode, nowSeconds);
}

async function readState(env: Env, couponCode: string): Promise<Response> {
  const historyRows = await env.DB
    .prepare(
      'SELECT content_id, episode_number, position_seconds, duration_seconds, updated_at ' +
        'FROM cloud_watch_history WHERE coupon_code = ? ORDER BY updated_at DESC LIMIT ?'
    )
    .bind(couponCode, USER_SYNC_HISTORY_LIMIT)
    .all<{ content_id: string; episode_number: number; position_seconds: number; duration_seconds: number; updated_at: number }>();

  const profile = await env.DB
    .prepare('SELECT preferences_json, total_plays, updated_at FROM cloud_user_profile WHERE coupon_code = ?')
    .bind(couponCode)
    .first<{ preferences_json: string; total_plays: number; updated_at: number }>();

  const history: SyncHistoryRow[] = historyRows.results.map((row) => ({
    contentId: row.content_id,
    episodeNumber: Number(row.episode_number),
    positionSeconds: Number(row.position_seconds),
    durationSeconds: Number(row.duration_seconds),
    updatedAt: Number(row.updated_at)
  }));

  let preferences: (UserSyncPreferences & { updatedAt: number }) | null = null;
  if (profile !== null) {
    try {
      const parsed = JSON.parse(profile.preferences_json) as { genres?: Record<string, number> };
      preferences = {
        genres: parsed.genres ?? {},
        totalPlays: Number(profile.total_plays),
        updatedAt: Number(profile.updated_at)
      };
    } catch {
      // A profile row that no longer parses is reported as absent rather than partially trusted.
      preferences = null;
    }
  }

  const body: UserSyncStateResponse = { success: true, history, preferences };
  return jsonResponse(body, 200, { 'Cache-Control': 'no-store' });
}

async function writeState(request: Request, env: Env, couponCode: string, nowSeconds: number): Promise<Response> {
  const body = await readJsonBody(request);
  const parsed = parseRequest(body);
  if (parsed === null) return errorResponse('VALIDATION_ERROR', '同步载荷格式不正确', 400);

  const statements: D1PreparedStatement[] = [];

  const history = parsed.history;
  if (history !== null && (await isWritableContent(env.DB, history.contentId))) {
    statements.push(
      env.DB
        .prepare(
          'INSERT OR REPLACE INTO cloud_watch_history ' +
            '(coupon_code, content_id, episode_number, position_seconds, duration_seconds, updated_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?)'
        )
        .bind(
          couponCode,
          history.contentId,
          history.episodeNumber,
          history.positionSeconds,
          history.durationSeconds,
          nowSeconds
        )
    );
  }

  statements.push(
    env.DB
      .prepare(
        'INSERT OR REPLACE INTO cloud_user_profile (coupon_code, preferences_json, total_plays, updated_at) ' +
          'VALUES (?, ?, ?, ?)'
      )
      .bind(couponCode, JSON.stringify({ genres: parsed.preferences.genres }), parsed.preferences.totalPlays, nowSeconds)
  );

  await env.DB.batch(statements);
  return accepted(nowSeconds);
}
