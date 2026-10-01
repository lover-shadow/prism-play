import type { Env } from '../types/env';
import type { Clock } from '../core/clock';
import type { DevicePingResponse } from '../types/api';
import { systemClock } from '../core/clock';
import { authenticate } from '../auth/guard';
import { unauthorizedResponse } from '../http/errors';
import { jsonResponse } from '../http/json';
import { signDeviceCredential } from './redeem';

/**
 * GET /api/device/ping — API-SPEC §四.1.
 * The tier and expiry handed back are `authenticate()`'s re-read of D1, never the presented claims,
 * so a valid signature alone renews nothing: a revoked, downgraded or expired row yields 401 and no
 * new credential. The token is always re-signed with a fresh `iat`/`jti`.
 */
export async function handleDevicePing(request: Request, env: Env, clock: Clock = systemClock): Promise<Response> {
  const nowSeconds = clock.nowSeconds();
  const outcome = await authenticate(request, env, clock);
  if (outcome.status !== 'ok') return unauthorizedResponse();

  const { identity } = outcome;
  const body: DevicePingResponse = {
    tier: identity.tier,
    expiresAt: identity.expiresAt,
    token: await signDeviceCredential(env, identity, nowSeconds)
  };
  return jsonResponse(body);
}
