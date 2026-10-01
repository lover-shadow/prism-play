import type { Env } from '../types/env';
import type { Clock } from '../core/clock';
import type { DeviceTier } from '../types/api';
import type { DeviceIdentity } from '../auth/guard';
import { authenticate, isCredentialLive } from '../auth/guard';
import { readPrivateChannelConfig } from '../db/channel-repo';
import {
  hashPrivateSessionToken,
  isSessionRevoked,
  verifyPrivateSession,
  type PrivateSessionPayload
} from '../auth/private-session';

export const PRIVATE_SESSION_HEADER = 'X-Private-Session';

export type PrivateSessionStatus = 'missing' | 'invalid' | 'revoked' | 'valid';

export interface PrivateSessionProbe {
  status: PrivateSessionStatus;
  payload: PrivateSessionPayload | null;
}

/**
 * SPEC §5 私密准入谓词 — the single implementation every private-gated path must call.
 * Granted only when BOTH hold: a live B/Y/S-class authorization AND an unrevoked, unexpired
 * session issued to that same device. Anything else is reported as "does not exist" upstream.
 */
export type PrivateAdmissionReason =
  | 'granted'
  | 'no_identity'
  | 'tier_not_allowed'
  | 'credential_expired'
  | 'session_missing'
  | 'session_invalid'
  | 'session_revoked'
  | 'session_device_mismatch';

export interface PrivateAdmission {
  granted: boolean;
  reason: PrivateAdmissionReason;
  session: PrivateSessionPayload | null;
}

export async function probePrivateSession(
  request: Request,
  env: Env,
  clock: Clock
): Promise<PrivateSessionProbe> {
  const token = request.headers.get(PRIVATE_SESSION_HEADER);
  if (token === null || token.trim() === '') return { status: 'missing', payload: null };
  const payload = await verifyPrivateSession(token, env.PRIVATE_SESSION_SECRET, clock.nowSeconds());
  if (payload === null) return { status: 'invalid', payload: null };
  if (await isSessionRevoked(env.DB, await hashPrivateSessionToken(token))) {
    return { status: 'revoked', payload: null };
  }
  return { status: 'valid', payload };
}

/** `reason` is for server-side logs only; a response must never branch on it (anti-probing). */
export async function evaluatePrivateAdmission(input: {
  request: Request;
  env: Env;
  clock: Clock;
  identity: DeviceIdentity | null;
  requiredTiers: readonly DeviceTier[];
}): Promise<PrivateAdmission> {  const fail = (reason: PrivateAdmissionReason): PrivateAdmission => ({ granted: false, reason, session: null });
  const { identity } = input;
  if (identity === null) return fail('no_identity');
  if (input.requiredTiers.length > 0 && !input.requiredTiers.includes(identity.tier)) {
    return fail('tier_not_allowed');
  }
  if (!isCredentialLive(identity, input.clock.nowSeconds())) return fail('credential_expired');

  const probe = await probePrivateSession(input.request, input.env, input.clock);
  if (probe.status === 'missing') return fail('session_missing');
  if (probe.status === 'invalid') return fail('session_invalid');
  if (probe.status === 'revoked') return fail('session_revoked');
  if (probe.payload === null || probe.payload.dev !== identity.deviceId) return fail('session_device_mismatch');
  return { granted: true, reason: 'granted', session: probe.payload };
}

/**
 * The one call every private-gated route makes. It composes the three steps that were previously
 * repeated per route — read the bearer identity, load the cloud-configured tier set, run the
 * predicate — so a new endpoint cannot accidentally skip the tier lookup and pass an empty or
 * hardcoded set, which would silently dismantle the first condition of AC-02's double admission.
 */
export interface PrivateAccessState {
  /** The 个人探索 row exists and is enabled; without it nothing private is enterable at all. */
  available: boolean;
  granted: boolean;
  identity: DeviceIdentity | null;
  session: PrivateSessionPayload | null;
  reason: PrivateAdmissionReason | 'channel_unavailable';
}

export async function resolvePrivateAccess(request: Request, env: Env, clock: Clock): Promise<PrivateAccessState> {
  const outcome = await authenticate(request, env, clock);
  const identity = outcome.status === 'ok' ? outcome.identity : null;
  const config = await readPrivateChannelConfig(env.DB);
  const admission = await evaluatePrivateAdmission({
    request,
    env,
    clock,
    identity,
    requiredTiers: config.requiresTier
  });
  const granted = config.available && admission.granted;
  return {
    available: config.available,
    granted,
    identity,
    session: granted ? admission.session : null,
    reason: granted ? 'granted' : config.available ? admission.reason : 'channel_unavailable'
  };
}
