import { describe, expect, it } from 'vitest';
import { buildClaims, getEdgeKeyMaterial, signJwt, verifyJwt } from '../../edge/src/auth/jwt';
import {
  hashPrivateSessionToken,
  issuePrivateSession,
  isSessionRevoked,
  pruneExpiredRevocations,
  revokeSession,
  verifyPrivateSession
} from '../../edge/src/auth/private-session';
import { authenticate } from '../../edge/src/auth/guard';
import { evaluatePrivateAdmission, PRIVATE_SESSION_HEADER } from '../../edge/src/core/admission';
import { seedDevice, seedStandardChannels } from '../support/seed';
import type { DeviceTier } from '../../edge/src/types/api';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';

const SECRET = '544553542d414243442d454647482d30313233';

function requestWith(headers: Record<string, string>): Request {
  return new Request('http://localhost:8787/api/channels', { headers });
}

describe('Ed25519 authorization credential (AC-14 / AC-15)', () => {
  it('signs with the edge private key and verifies with the derived built-in public key', async () => {
    const { signing, verifying } = await getEdgeKeyMaterial(await freshPrivateJwk());
    const claims = buildClaims({ deviceId: 'GY-800DF614', tier: 'Q', expiresAt: TEST_BASE_TIME_SECONDS + 90 * 86400, issuedAt: TEST_BASE_TIME_SECONDS, jti: 'j-1' });
    const token = await signJwt(claims, signing, 'p2026');
    const verified = await verifyJwt(token, verifying);
    expect(verified?.sub).toBe('GY-800DF614');
    expect(verified?.tier).toBe('Q');
    expect(JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')))).toMatchObject({ alg: 'EdDSA', kid: 'p2026' });
  });

  it('rejects a tampered payload and a token from a foreign key without leaking a reason', async () => {
    const pair = await getEdgeKeyMaterial(await freshPrivateJwk());
    const other = await getEdgeKeyMaterial(await freshPrivateJwk());
    const claims = buildClaims({ deviceId: 'GY-800DF614', tier: 'Q', expiresAt: -1, issuedAt: TEST_BASE_TIME_SECONDS, jti: 'j-2' });
    const token = await signJwt(claims, pair.signing, 'p2026');
    expect(await verifyJwt(token, other.verifying)).toBeNull();
    const [header, payload, signature] = token.split('.');
    const forged = { ...JSON.parse(base64UrlDecode(payload)) as Record<string, unknown>, tier: 'S' };
    const upgraded = `${header}.${base64UrlEncode(JSON.stringify(forged))}.${signature}`;
    expect(await verifyJwt(upgraded, pair.verifying)).toBeNull();
    expect(await verifyJwt('not-a-token', pair.verifying)).toBeNull();
  });

  it('treats a signature-valid token whose device was revoked in D1 as invalid', async () => {
    const env = await createTestEnv({ PRIVATE_SESSION_SECRET: SECRET });
    seedDevice(env.db, { deviceId: 'GY-800DF614', tier: 'Q', expiresAt: TEST_BASE_TIME_SECONDS + 86400 });
    const { signing } = await getEdgeKeyMaterial(env.JWT_PRIVATE_KEY_JWK);
    const claims = buildClaims({ deviceId: 'GY-800DF614', tier: 'Q', expiresAt: TEST_BASE_TIME_SECONDS + 86400, issuedAt: TEST_BASE_TIME_SECONDS, jti: 'j-3' });
    const token = await signJwt(claims, signing, 'p2026');
    const outcome = await authenticate(requestWith({ Authorization: `Bearer ${token}` }), env, env.clock);
    expect(outcome.status).toBe('ok');

    env.db.execute("UPDATE devices SET tier = '0', expires_at = 0 WHERE device_id = 'GY-800DF614'");
    const afterRevoke = await authenticate(requestWith({ Authorization: `Bearer ${token}` }), env, env.clock);
    expect(afterRevoke.status === 'ok' && afterRevoke.identity.tier).toBe('0');

    env.db.execute('DELETE FROM devices WHERE device_id = ?', 'GY-800DF614');
    expect((await authenticate(requestWith({ Authorization: `Bearer ${token}` }), env, env.clock)).status).toBe('invalid');
    expect((await authenticate(requestWith({}), env, env.clock)).status).toBe('anonymous');
    expect((await authenticate(requestWith({ Authorization: 'Bearer garbage' }), env, env.clock)).status).toBe('invalid');
  });
});

describe('Private exploration session (AC-02 double admission)', () => {
  it('verifies a live credential, expires it on the clock, and honours the revocation tombstone', async () => {
    const env = await createTestEnv({ PRIVATE_SESSION_SECRET: SECRET });
    const issued = await issuePrivateSession(SECRET, 'GY-800DF614', TEST_BASE_TIME_SECONDS, 7200);
    const payload = await verifyPrivateSession(issued.token, SECRET, TEST_BASE_TIME_SECONDS);
    expect(payload?.dev).toBe('GY-800DF614');
    expect(await verifyPrivateSession(issued.token, SECRET, TEST_BASE_TIME_SECONDS + 7200)).toBeNull();
    expect(await verifyPrivateSession(`${issued.token}x`, SECRET, TEST_BASE_TIME_SECONDS)).toBeNull();

    const hash = await hashPrivateSessionToken(issued.token);
    expect(hash).not.toContain(issued.token);
    expect(await isSessionRevoked(env.DB, hash)).toBe(false);
    await revokeSession(env.DB, hash, TEST_BASE_TIME_SECONDS + 7200, TEST_BASE_TIME_SECONDS);
    expect(await isSessionRevoked(env.DB, hash)).toBe(true);
    env.clock.advance(7201);
    expect(await pruneExpiredRevocations(env.DB, env.clock.nowSeconds())).toBe(1);
  });

  it('grants private data only when a live B/Y/S credential and a matching live session coexist', async () => {
    const env = await createTestEnv({ PRIVATE_SESSION_SECRET: SECRET });
    seedStandardChannels(env.db, 'B,Y,S');
    const required: readonly DeviceTier[] = ['B', 'Y', 'S'];
    seedDevice(env.db, { deviceId: 'GY-BBBB0001', tier: 'B', tierName: '高级全源卡', expiresAt: TEST_BASE_TIME_SECONDS + 86400 });
    seedDevice(env.db, { deviceId: 'GY-QQQQ0001', tier: 'Q', tierName: '季度畅享卡', expiresAt: TEST_BASE_TIME_SECONDS + 86400 });
    const session = await issuePrivateSession(SECRET, 'GY-BBBB0001', TEST_BASE_TIME_SECONDS, 7200);
    const otherSession = await issuePrivateSession(SECRET, 'GY-QQQQ0001', TEST_BASE_TIME_SECONDS, 7200);

    const advanced = (await authenticate(requestWith({ Authorization: await bearerFor(env, 'GY-BBBB0001', 'B', TEST_BASE_TIME_SECONDS + 86400) }), env, env.clock));
    expect(advanced.status).toBe('ok');
    const advancedIdentity = advanced.status === 'ok' ? advanced.identity : null;

    const both = await evaluatePrivateAdmission({
      request: requestWith({ [PRIVATE_SESSION_HEADER]: session.token }),
      env,
      clock: env.clock,
      identity: advancedIdentity,
      requiredTiers: required
    });
    expect(both.granted).toBe(true);

    const noSession = await evaluatePrivateAdmission({ request: requestWith({}), env, clock: env.clock, identity: advancedIdentity, requiredTiers: required });
    expect(noSession.granted).toBe(false);
    expect(noSession.reason).toBe('session_missing');

    const wrongDevice = await evaluatePrivateAdmission({ request: requestWith({ [PRIVATE_SESSION_HEADER]: otherSession.token }), env, clock: env.clock, identity: advancedIdentity, requiredTiers: required });
    expect(wrongDevice.granted).toBe(false);
    expect(wrongDevice.reason).toBe('session_device_mismatch');

    const revoked = await evaluatePrivateAdmission({
      request: requestWith({ [PRIVATE_SESSION_HEADER]: session.token }),
      env,
      clock: env.clock,
      identity: advancedIdentity,
      requiredTiers: required
    });
    expect(revoked.granted).toBe(true);
    await revokeSession(env.DB, await hashPrivateSessionToken(session.token), TEST_BASE_TIME_SECONDS + 7200, env.clock.nowSeconds());
    const afterRevoke = await evaluatePrivateAdmission({
      request: requestWith({ [PRIVATE_SESSION_HEADER]: session.token }),
      env,
      clock: env.clock,
      identity: advancedIdentity,
      requiredTiers: required
    });
    expect(afterRevoke.granted).toBe(false);
    expect(afterRevoke.reason).toBe('session_revoked');

    const trial = (await authenticate(requestWith({ Authorization: await bearerFor(env, 'GY-QQQQ0001', 'Q', TEST_BASE_TIME_SECONDS + 86400) }), env, env.clock));
    const trialIdentity = trial.status === 'ok' ? trial.identity : null;
    const tierTooLow = await evaluatePrivateAdmission({ request: requestWith({ [PRIVATE_SESSION_HEADER]: otherSession.token }), env, clock: env.clock, identity: trialIdentity, requiredTiers: required });
    expect(tierTooLow.granted).toBe(false);
    expect(tierTooLow.reason).toBe('tier_not_allowed');

    env.clock.advance(86401);
    const expired = await evaluatePrivateAdmission({ request: requestWith({ [PRIVATE_SESSION_HEADER]: session.token }), env, clock: env.clock, identity: advancedIdentity, requiredTiers: required });
    expect(expired.granted).toBe(false);
  });
});

function base64UrlEncode(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(value: string): string {
  const withPadding = value.replace(/-/g, '+').replace(/_/g, '/');
  return atob(withPadding + '='.repeat((4 - (withPadding.length % 4)) % 4));
}

async function bearerFor(env: PrismTestEnv, deviceId: string, tier: 'B' | 'Q', expiresAt: number): Promise<string> {
  const { signing } = await getEdgeKeyMaterial(env.JWT_PRIVATE_KEY_JWK);
  return `Bearer ${await signJwt(buildClaims({ deviceId, tier, expiresAt, issuedAt: TEST_BASE_TIME_SECONDS, jti: `j-${deviceId}` }), signing, 'p2026')}`;
}

async function freshPrivateJwk(): Promise<string> {  const generated = await crypto.subtle.generateKey({ name: 'Ed25519', namedCurve: 'Ed25519' }, true, ['sign', 'verify']);
  const pair = generated as CryptoKeyPair;
  return JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey));
}
