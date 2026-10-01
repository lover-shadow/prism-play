import type { Env } from '../types/env';
import type { Clock } from '../core/clock';
import type { DeviceTier } from '../types/api';
import { PERMANENT_EXPIRES_AT } from '../types/api';
import { getEdgeKeyMaterial, verifyJwt } from './jwt';

export interface DeviceIdentity {
  deviceId: string;
  /** Read back from D1 on every request: the token alone never decides what is visible. */
  tier: DeviceTier;
  tierName: string;
  expiresAt: number;
  exemptUntil: number;
}

export type AuthOutcome =
  | { status: 'anonymous' }
  | { status: 'invalid' }
  | { status: 'ok'; identity: DeviceIdentity };

interface DeviceRow {
  device_id: string;
  tier: string;
  tier_name: string;
  expires_at: number;
  exempt_until: number;
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (!header) return null;
  const [scheme, credential, extra] = header.trim().split(/\s+/);
  if (extra !== undefined) return null;
  if (scheme.toLowerCase() !== 'bearer' || !credential) return null;
  return credential;
}

/** Trial tier '0' carries no expiry; every paid tier is live until its timestamp or the -1 sentinel. */
export function isCredentialLive(identity: DeviceIdentity, nowSeconds: number): boolean {
  if (identity.tier === '0') return true;
  return identity.expiresAt === PERMANENT_EXPIRES_AT || identity.expiresAt > nowSeconds;
}

export function hasEntitlement(identity: DeviceIdentity, nowSeconds: number): boolean {
  return identity.tier !== '0' && isCredentialLive(identity, nowSeconds);
}

export async function readDeviceIdentity(db: D1Database, deviceId: string): Promise<DeviceIdentity | null> {
  const row = await db
    .prepare('SELECT device_id, tier, tier_name, expires_at, exempt_until FROM devices WHERE device_id = ?')
    .bind(deviceId)
    .first<DeviceRow>();
  if (row === null) return null;
  return {
    deviceId: row.device_id,
    tier: row.tier as DeviceTier,
    tierName: row.tier_name,
    expiresAt: Number(row.expires_at),
    exemptUntil: Number(row.exempt_until)
  };
}

/**
 * Signature validity alone is never authorization: a revoked or downgraded device must lose access
 * on its next request, so the tier is always re-read from D1 (AC-14, AC-15).
 */
export async function authenticate(request: Request, env: Env, clock: Clock): Promise<AuthOutcome> {
  const token = bearerToken(request);
  if (token === null) return { status: 'anonymous' };
  const { verifying } = await getEdgeKeyMaterial(env.JWT_PRIVATE_KEY_JWK);
  const claims = await verifyJwt(token, verifying);
  if (claims === null) return { status: 'invalid' };
  const identity = await readDeviceIdentity(env.DB, claims.sub);
  if (identity === null) return { status: 'invalid' };
  if (!isCredentialLive(identity, clock.nowSeconds())) return { status: 'invalid' };
  return { status: 'ok', identity };
}

export function tierAllows(requiredTiers: readonly DeviceTier[], tier: DeviceTier): boolean {
  if (requiredTiers.length === 0) return true;
  return requiredTiers.includes(tier);
}
