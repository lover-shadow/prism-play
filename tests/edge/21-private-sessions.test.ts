import { describe, expect, it } from 'vitest';
import { buildClaims, getEdgeKeyMaterial, signJwt } from '../../edge/src/auth/jwt';
import { hashPrivateSessionToken } from '../../edge/src/auth/private-session';
import { PRIVATE_SESSION_HEADER } from '../../edge/src/core/admission';
import { PRIVATE_SESSION_TTL_SECONDS } from '../../edge/src/core/constants';
import { handleChannels } from '../../edge/src/routes/channels';
import { handlePrivateSessions } from '../../edge/src/routes/private-sessions';
import { seedContent, seedDevice, seedStandardChannels } from '../support/seed';
import { PERMANENT_EXPIRES_AT, type DeviceTier, type PrivateSessionResponse } from '../../edge/src/types/api';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';

const SESSIONS_URL = 'http://localhost:8787/api/private-sessions';
const CHANNELS_URL = 'http://localhost:8787/api/channels';
const LIVE_UNTIL = TEST_BASE_TIME_SECONDS + 86_400;
const DEVICE_B = 'GY-BBBB0001';
const DEVICE_Y = 'GY-YYYY0001';
const DEVICE_S = 'GY-SSSS0001';
const DEVICE_Q = 'GY-QQQQ0001';
const DEVICE_A = 'GY-AAAA0001';
const DEVICE_TRIAL = 'GY-ZZZZ0001';
const PRIVATE_CONTENT_ID = 'd_private_probe';

const ROSTER: readonly (readonly [string, DeviceTier, string])[] = [
  [DEVICE_B, 'B', '高级全源卡'],
  [DEVICE_Y, 'Y', '年度尊享卡'],
  [DEVICE_S, 'S', '极客纪念卡'],
  [DEVICE_Q, 'Q', '季度畅享卡'],
  [DEVICE_A, 'A', '普通激活卡'],
  [DEVICE_TRIAL, '0', '默认试用']
];

function tierOf(deviceId: string): DeviceTier {
  const entry = ROSTER.find(([candidate]) => candidate === deviceId);
  if (entry === undefined) throw new Error(`test roster has no device ${deviceId}`);
  return entry[1];
}

async function sessions(privateRequiresTier = 'B,Y,S'): Promise<PrismTestEnv> {
  const env = await createTestEnv();
  seedStandardChannels(env.db, privateRequiresTier);
  for (const [deviceId, tier, tierName] of ROSTER) {
    seedDevice(env.db, { deviceId, tier, tierName, expiresAt: tier === 'S' ? PERMANENT_EXPIRES_AT : LIVE_UNTIL });
  }
  return env;
}

async function bearer(env: PrismTestEnv, deviceId: string): Promise<string> {
  const { signing } = await getEdgeKeyMaterial(env.JWT_PRIVATE_KEY_JWK);
  const claims = buildClaims({
    deviceId,
    tier: tierOf(deviceId),
    expiresAt: tierOf(deviceId) === 'S' ? PERMANENT_EXPIRES_AT : LIVE_UNTIL,
    issuedAt: TEST_BASE_TIME_SECONDS,
    jti: `j-${deviceId}`
  });
  return `Bearer ${await signJwt(claims, signing, 'p2026')}`;
}

async function postSession(env: PrismTestEnv, deviceId: string, payload: unknown): Promise<Response> {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', Authorization: await bearer(env, deviceId) };
  return handlePrivateSessions(new Request(SESSIONS_URL, { method: 'POST', headers, body }), env, env.clock);
}

async function deleteSession(env: PrismTestEnv, deviceId: string | null, token: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (deviceId !== null) headers.Authorization = await bearer(env, deviceId);
  if (token !== null) headers[PRIVATE_SESSION_HEADER] = token;
  return handlePrivateSessions(new Request(SESSIONS_URL, { method: 'DELETE', headers }), env, env.clock);
}

async function mintedToken(env: PrismTestEnv, deviceId: string): Promise<string> {
  const response = await postSession(env, deviceId, { acknowledged: true });
  expect(response.status).toBe(201);
  return (JSON.parse(await response.text()) as PrivateSessionResponse).sessionToken;
}

async function privateVisible(env: PrismTestEnv, deviceId: string, token: string | null): Promise<boolean> {
  const headers: Record<string, string> = { Authorization: await bearer(env, deviceId) };
  if (token !== null) headers[PRIVATE_SESSION_HEADER] = token;
  const text = await (await handleChannels(new Request(CHANNELS_URL, { headers }), env, env.clock)).text();
  return text.toLowerCase().includes('private');
}

function tombstones(env: PrismTestEnv): Record<string, unknown>[] {
  return env.db.selectAll('SELECT * FROM private_session_revocations');
}

describe('POST /api/private-sessions — explicit opt-in is mandatory', () => {
  const rejected: readonly [string, unknown][] = [
    ['missing key', {}],
    ['acknowledged false', { acknowledged: false }],
    ['non-boolean', { acknowledged: 'yes' }],
    ['unparsable body', 'not-json{'],
    ['empty body', ''],
    ['array body', '[1,2]']
  ];
  for (const [label, payload] of rejected) {
    it(`rejects ${label} with 400 PRIVATE_SESSION_REQUIRED and issues nothing`, async () => {
      const env = await sessions();
      const response = await postSession(env, DEVICE_B, payload);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ success: false, code: 'PRIVATE_SESSION_REQUIRED' });
      expect(text).not.toContain('sessionToken');
    });
  }

  it('refuses an anonymous or unusable bearer with 401 before touching the body', async () => {
    const env = await sessions();
    for (const authorization of [undefined, 'Bearer forged.forged.forged', 'Basic Z3ktYmJiYjowMDAx']) {
      for (const payload of [{ acknowledged: true }, 'garbage']) {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (authorization !== undefined) headers.Authorization = authorization;
        const response = await handlePrivateSessions(
          new Request(SESSIONS_URL, { method: 'POST', headers, body: typeof payload === 'string' ? payload : JSON.stringify(payload) }),
          env,
          env.clock
        );
        expect(response.status).toBe(401);
      }
    }

    const expired = await sessions();
    expired.db.execute('UPDATE devices SET expires_at = ? WHERE device_id = ?', TEST_BASE_TIME_SECONDS - 1, DEVICE_B);
    expect((await postSession(expired, DEVICE_B, { acknowledged: true })).status).toBe(401);
  });
});

describe('POST /api/private-sessions — tier gate under the default cloud config', () => {
  for (const deviceId of [DEVICE_B, DEVICE_Y, DEVICE_S]) {
    it(`${tierOf(deviceId)} receives a 201 no-store credential for the configured TTL`, async () => {
      const env = await sessions();
      const response = await postSession(env, deviceId, { acknowledged: true });
      expect(response.status).toBe(201);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const body = JSON.parse(await response.text()) as PrivateSessionResponse;
      expect(body.expiresInSeconds).toBe(PRIVATE_SESSION_TTL_SECONDS);
      expect(body.sessionToken.split('.')).toHaveLength(2);
      // 不落盘: issuing a session persists nothing; only an explicit revocation writes a tombstone.
      expect(env.db.count('private_session_revocations')).toBe(0);
    });
  }

  for (const deviceId of [DEVICE_Q, DEVICE_A, DEVICE_TRIAL]) {
    it(`${tierOf(deviceId)} is denied with 403 TIER_INSUFFICIENT and no token`, async () => {
      const env = await sessions();
      const response = await postSession(env, deviceId, { acknowledged: true });
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ success: false, code: 'TIER_INSUFFICIENT' });
      expect(text).not.toContain('sessionToken');
    });
  }

  it('widening the cloud knob to Q admits a Q device; a missing or disabled node admits nobody', async () => {
    const widened = await sessions('Q');
    const response = await postSession(widened, DEVICE_Q, { acknowledged: true });
    expect(response.status).toBe(201);

    const disabled = await sessions();
    disabled.db.execute("UPDATE channels SET enabled = 0 WHERE id = 'private'");
    expect((await postSession(disabled, DEVICE_B, { acknowledged: true })).status).toBe(403);

    const removed = await sessions();
    removed.db.execute("DELETE FROM channels WHERE id = 'private'");
    expect((await postSession(removed, DEVICE_B, { acknowledged: true })).status).toBe(403);
  });

  it('issues distinct credentials per device and one device cannot spend another session', async () => {
    const env = await sessions();
    const tokenB = await mintedToken(env, DEVICE_B);
    const tokenY = await mintedToken(env, DEVICE_Y);
    expect(tokenB).not.toBe(tokenY);
    expect(await privateVisible(env, DEVICE_B, tokenB)).toBe(true);
    expect(await privateVisible(env, DEVICE_Y, tokenB)).toBe(false);
    expect(await privateVisible(env, DEVICE_Y, null)).toBe(false);
  });

  it('prunes tombstones of expired credentials while a live tombstone survives', async () => {
    const env = await sessions();
    const staleToken = await mintedToken(env, DEVICE_B);
    await deleteSession(env, DEVICE_B, staleToken);
    env.clock.advance(3_600);
    const liveToken = await mintedToken(env, DEVICE_Y);
    await deleteSession(env, DEVICE_Y, liveToken);
    expect(env.db.count('private_session_revocations')).toBe(2);

    env.clock.advance(3_601);
    const survivor = await hashPrivateSessionToken(liveToken);
    expect(await privateVisible(env, DEVICE_S, await mintedToken(env, DEVICE_S))).toBe(true);
    const rows = tombstones(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(survivor);
  });

  it('answers 405 for a method the contract does not declare', async () => {
    const env = await sessions();
    const response = await handlePrivateSessions(new Request(SESSIONS_URL, { method: 'PUT' }), env, env.clock);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST, DELETE');
  });
});

describe('DELETE /api/private-sessions — immediate revocation, hash-only tombstone', () => {
  it('removes the private node on the very next request and records one tombstone', async () => {
    const env = await sessions();
    seedContent(env.db, { id: PRIVATE_CONTENT_ID, channelId: 'private', title: '私密探针', isPrivate: 1, shareable: 0 });
    const token = await mintedToken(env, DEVICE_B);
    expect(await privateVisible(env, DEVICE_B, token)).toBe(true);

    const response = await deleteSession(env, DEVICE_B, token);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(await privateVisible(env, DEVICE_B, token)).toBe(false);
    expect(await privateVisible(env, DEVICE_B, null)).toBe(false);

    const rows = tombstones(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      token_hash: await hashPrivateSessionToken(token),
      expires_at: tokenExpiry(env),
      revoked_at: env.clock.nowSeconds()
    });
    expect(String(rows[0]?.token_hash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the tombstone table stores no plaintext credential, no device id and no content id', async () => {
    const env = await sessions();
    seedContent(env.db, { id: PRIVATE_CONTENT_ID, channelId: 'private', title: '私密探针', isPrivate: 1, shareable: 0 });
    const token = await mintedToken(env, DEVICE_B);
    await deleteSession(env, DEVICE_B, token);
    const dump = JSON.stringify(tombstones(env));
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(token.split('.')[0]);
    expect(dump).not.toContain(DEVICE_B);
    expect(dump).not.toContain(PRIVATE_CONTENT_ID);
    expect(dump).not.toContain('私密探针');
    expect(Object.keys(tombstones(env)[0]).sort()).toEqual(['expires_at', 'revoked_at', 'token_hash']);
  });

  it('is idempotent: a second DELETE is still 204 and leaves exactly one row', async () => {
    const env = await sessions();
    const token = await mintedToken(env, DEVICE_B);
    expect((await deleteSession(env, DEVICE_B, token)).status).toBe(204);
    expect((await deleteSession(env, DEVICE_B, token)).status).toBe(204);
    expect((await deleteSession(env, DEVICE_B, token)).status).toBe(204);
    expect(tombstones(env)).toHaveLength(1);
  });

  it('re-opening the switch after a revocation mints a fresh usable credential', async () => {
    const env = await sessions();
    const first = await mintedToken(env, DEVICE_B);
    await deleteSession(env, DEVICE_B, first);
    const second = await mintedToken(env, DEVICE_B);
    expect(second).not.toBe(first);
    expect(await privateVisible(env, DEVICE_B, second)).toBe(true);
    expect(await privateVisible(env, DEVICE_B, first)).toBe(false);
  });

  it('answers every unusable credential identically and never revokes another device session', async () => {
    const env = await sessions();
    const foreign = await mintedToken(env, DEVICE_Y);
    const bodies: string[] = [];
    for (const presented of [null, '   ', 'aaaa.bbbb', foreign]) {
      const response = await deleteSession(env, DEVICE_B, presented);
      expect(response.status).toBe(401);
      bodies.push(await response.text());
    }
    // One undifferentiated answer: this endpoint must not reveal which case it hit.
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toMatchObject({ success: false, code: 'PRIVATE_SESSION_REQUIRED' });
    expect(tombstones(env)).toHaveLength(0);
    expect(await privateVisible(env, DEVICE_Y, foreign)).toBe(true);
  });

  it('requires a live identity, but never withholds a revocation from a downgraded device', async () => {
    const env = await sessions();
    const token = await mintedToken(env, DEVICE_B);
    expect((await deleteSession(env, null, token)).status).toBe(401);
    env.db.execute('UPDATE devices SET expires_at = ? WHERE device_id = ?', TEST_BASE_TIME_SECONDS - 1, DEVICE_B);
    expect((await deleteSession(env, DEVICE_B, token)).status).toBe(401);
    expect(tombstones(env)).toHaveLength(0);

    const downgraded = await sessions();
    const held = await mintedToken(downgraded, DEVICE_B);
    downgraded.db.execute("UPDATE devices SET tier = '0', expires_at = 0 WHERE device_id = ?", DEVICE_B);
    expect((await deleteSession(downgraded, DEVICE_B, held)).status).toBe(204);
    expect(await privateVisible(downgraded, DEVICE_B, held)).toBe(false);
  });
});

function tokenExpiry(env: PrismTestEnv): number {
  return env.clock.nowSeconds() + PRIVATE_SESSION_TTL_SECONDS;
}
