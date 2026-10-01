import type { Clock } from '../core/clock';
import type { DeviceIdentity } from '../auth/guard';
import type { Env } from '../types/env';
import type { PrivateSessionResponse } from '../types/api';
import { authenticate, tierAllows } from '../auth/guard';
import {
  hashPrivateSessionToken,
  issuePrivateSession,
  pruneExpiredRevocations,
  revokeSession
} from '../auth/private-session';
import { PRIVATE_SESSION_HEADER, probePrivateSession } from '../core/admission';
import { PRIVATE_SESSION_TTL_SECONDS } from '../core/constants';
import { errorResponse, unauthorizedResponse } from '../http/errors';
import { emptyResponse, noStoreJson, readJsonBody } from '../http/json';
import { readPrivateChannelConfig } from '../db/channel-repo';

/**
 * `POST /api/private-sessions` mints the second condition of AC-02's double admission;
 * `DELETE` destroys it again by writing a hash-only revocation tombstone.
 * Neither handler decides whether private data may be returned — `core/admission.ts` does that once.
 * Honest boundary: a granted session proves the server received an explicit opt-in request, nothing more.
 */
export async function handlePrivateSessions(request: Request, env: Env, clock: Clock): Promise<Response> {
  if (request.method === 'POST') return createPrivateSession(request, env, clock);
  if (request.method === 'DELETE') return destroyPrivateSession(request, env, clock);
  return new Response(null, { status: 405, headers: { Allow: 'POST, DELETE' } });
}

async function createPrivateSession(request: Request, env: Env, clock: Clock): Promise<Response> {
  const identity = await liveIdentity(request, env, clock);
  // No credential means no session; an expired credential also lands here as 401 because
  // authenticate() re-reads D1 and reports it as unusable.
  if (identity === null) return unauthorizedResponse();

  const body = await readJsonBody(request);
  // CONTRACT CONFLICT, resolved in favour of the machine-readable source of truth: openapi.yaml answers
  // 400 for "未确认免责提示" while API-SPEC §八.一 maps PRIVATE_SESSION_REQUIRED to 403. Status 400 is
  // emitted, the error code keeps its contract name, and every unusable body shares one response.
  if (body === null || body.acknowledged !== true) return errorResponse('PRIVATE_SESSION_REQUIRED', undefined, 400);

  const config = await readPrivateChannelConfig(env.DB);
  // Minting gate (M-3): the tier set is cloud configuration and is never hardcoded here.
  // `readPrivateChannelConfig` guarantees a non-empty set, so a misconfigured knob cannot open the
  // gate to every tier; an absent or disabled 个人探索 node cannot be entered at all.
  if (!config.available || !tierAllows(config.requiresTier, identity.tier)) return errorResponse('TIER_INSUFFICIENT');

  const issued = await issuePrivateSession(
    env.PRIVATE_SESSION_SECRET,
    identity.deviceId,
    clock.nowSeconds(),
    PRIVATE_SESSION_TTL_SECONDS
  );
  // A tombstone only protects its credential until that credential expires; pruning on this hot path
  // keeps private_session_revocations bounded without waiting for a cron.
  await pruneExpiredRevocations(env.DB, clock.nowSeconds());

  const payload: PrivateSessionResponse = {
    sessionToken: issued.token,
    expiresInSeconds: issued.expiresInSeconds
  };
  // AC-02-5 zero-disk: the credential is returned to memory only, and no cache may store it.
  return noStoreJson(payload, 201);
}

async function destroyPrivateSession(request: Request, env: Env, clock: Clock): Promise<Response> {
  const identity = await liveIdentity(request, env, clock);
  if (identity === null) return unauthorizedResponse();

  const presented = request.headers.get(PRIVATE_SESSION_HEADER);
  if (presented === null || presented.trim() === '') return unusableSessionResponse();

  const probe = await probePrivateSession(request, env, clock);
  // Already revoked: the tombstone exists and the caller's intent is fulfilled, so answer 204 again
  // and leave that single row untouched. Revocation is idempotent.
  if (probe.status === 'revoked') return emptyResponse();
  if (probe.status !== 'valid' || probe.payload === null) return unusableSessionResponse();
  // A tombstone is written only for the device the credential was issued to. This is the credential's
  // own device binding, not a second visibility rule: `evaluatePrivateAdmission` stays the only place
  // that decides whether private data may be returned.
  if (probe.payload.dev !== identity.deviceId) return unusableSessionResponse();

  await revokeSession(env.DB, await hashPrivateSessionToken(presented), probe.payload.exp, clock.nowSeconds());
  return emptyResponse();
}

/**
 * One indistinguishable answer for "credential missing", "credential not verifiable" and "credential
 * issued to another device": this endpoint must not reveal which of the three it hit.
 * PRIVATE_SESSION_REQUIRED is the closest member of the closed error enum. openapi.yaml documents only
 * 204 for DELETE, so 401 here follows the same "no credential, no access" rule as POST.
 */
function unusableSessionResponse(): Response {
  return errorResponse('PRIVATE_SESSION_REQUIRED', '个人探索凭据不可用，请重新开启后再试', 401);
}

async function liveIdentity(request: Request, env: Env, clock: Clock): Promise<DeviceIdentity | null> {
  const outcome = await authenticate(request, env, clock);
  return outcome.status === 'ok' ? outcome.identity : null;
}
