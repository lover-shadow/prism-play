import { describe, expect, it } from 'vitest';
import { buildClaims, getEdgeKeyMaterial, signJwt } from '../../edge/src/auth/jwt';
import {
  hashPrivateSessionToken,
  issuePrivateSession,
  revokeSession
} from '../../edge/src/auth/private-session';
import { PRIVATE_SESSION_HEADER } from '../../edge/src/core/admission';
import { PRIVATE_SESSION_TTL_SECONDS } from '../../edge/src/core/constants';
import { handleChannels } from '../../edge/src/routes/channels';
import { DEFAULT_PRIVATE_REQUIRED_TIERS, EMPTY_TOPOLOGY_VERSION } from '../../edge/src/db/channel-repo';
import { seedChannel, seedDevice, seedStandardChannels, FOUR_PUBLIC_CHANNELS } from '../support/seed';
import { PUBLIC_CHANNEL_IDS, type ChannelsResponse, type DeviceTier } from '../../edge/src/types/api';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';

const LIVE_UNTIL = TEST_BASE_TIME_SECONDS + 86_400;
const DEVICE_B = 'GY-BBBB0001';
const DEVICE_Q = 'GY-QQQQ0001';
const DEVICE_OTHER = 'GY-CCCC0001';

function channelsRequest(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:8787/api/channels', { headers });
}

async function topology(privateRequiresTier = 'B,Y,S'): Promise<PrismTestEnv> {
  const env = await createTestEnv();
  seedStandardChannels(env.db, privateRequiresTier);
  seedDevice(env.db, { deviceId: DEVICE_B, tier: 'B', tierName: '高级全源卡', expiresAt: LIVE_UNTIL });
  seedDevice(env.db, { deviceId: DEVICE_Q, tier: 'Q', tierName: '季度畅享卡', expiresAt: LIVE_UNTIL });
  seedDevice(env.db, { deviceId: DEVICE_OTHER, tier: 'B', tierName: '高级全源卡', expiresAt: LIVE_UNTIL });
  return env;
}

async function bearer(env: PrismTestEnv, deviceId: string, tier: DeviceTier): Promise<string> {
  const { signing } = await getEdgeKeyMaterial(env.JWT_PRIVATE_KEY_JWK);
  const claims = buildClaims({ deviceId, tier, expiresAt: LIVE_UNTIL, issuedAt: TEST_BASE_TIME_SECONDS, jti: `j-${deviceId}` });
  return `Bearer ${await signJwt(claims, signing, 'p2026')}`;
}

async function sessionFor(env: PrismTestEnv, deviceId: string): Promise<string> {
  const issued = await issuePrivateSession(env.PRIVATE_SESSION_SECRET, deviceId, env.clock.nowSeconds(), PRIVATE_SESSION_TTL_SECONDS);
  return issued.token;
}

async function revokedSessionFor(env: PrismTestEnv, deviceId: string): Promise<string> {
  const token = await sessionFor(env, deviceId);
  await revokeSession(env.DB, await hashPrivateSessionToken(token), LIVE_UNTIL, env.clock.nowSeconds());
  return token;
}

async function parse(response: Response): Promise<ChannelsResponse> {
  return JSON.parse(await response.text()) as ChannelsResponse;
}

/** AC-02-3: in a denied cell the word must not survive anywhere in the payload, in any casing. */
function expectPhysicallyInvisible(text: string): void {
  expect(text.toLowerCase()).not.toContain('private');
  expect(text).not.toContain('个人探索');
}

interface Cell {
  label: string;
  granted: boolean;
  headers(env: PrismTestEnv): Promise<Record<string, string>>;
}

const MATRIX: Cell[] = [
  { label: 'anonymous, no session', granted: false, headers: async () => ({}) },
  { label: 'live Q tier, no session', granted: false, headers: (env) => bearer(env, DEVICE_Q, 'Q').then((Authorization) => ({ Authorization })) },
  { label: 'live B tier, no session', granted: false, headers: (env) => bearer(env, DEVICE_B, 'B').then((Authorization) => ({ Authorization })) },
  {
    label: 'live B tier + live session',
    granted: true,
    headers: async (env) => ({ Authorization: await bearer(env, DEVICE_B, 'B'), [PRIVATE_SESSION_HEADER]: await sessionFor(env, DEVICE_B) })
  },
  {
    label: 'live B tier + session issued to another device',
    granted: false,
    headers: async (env) => ({ Authorization: await bearer(env, DEVICE_B, 'B'), [PRIVATE_SESSION_HEADER]: await sessionFor(env, DEVICE_OTHER) })
  },
  {
    label: 'live B tier + revoked session',
    granted: false,
    headers: async (env) => ({ Authorization: await bearer(env, DEVICE_B, 'B'), [PRIVATE_SESSION_HEADER]: await revokedSessionFor(env, DEVICE_B) })
  }
];

describe('GET /api/channels — AC-02 double admission matrix', () => {
  for (const cell of MATRIX) {
    it(`private node is ${cell.granted ? 'returned only' : 'physically absent'} for: ${cell.label}`, async () => {
      const env = await topology();
      const response = await handleChannels(channelsRequest(await cell.headers(env)), env, env.clock);
      expect(response.status).toBe(200);
      const text = await response.clone().text();
      const body = JSON.parse(text) as ChannelsResponse;
      const ids = body.channels.map((channel) => channel.id);
      expect(ids.includes('private')).toBe(cell.granted);
      if (cell.granted) {
        expect(body.channels.find((channel) => channel.id === 'private')?.name).toBe('个人探索');
        expect(body.channels.find((channel) => channel.id === 'private')?.categories).toEqual(['今日更新', '热门推荐']);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
      } else {
        expectPhysicallyInvisible(text);
        expectPhysicallyInvisible(JSON.stringify(body));
      }
      expect(ids.slice(0, 4)).toEqual([...PUBLIC_CHANNEL_IDS]);
    });
  }
});

describe('GET /api/channels — public topology never depends on the private gate', () => {
  it('serves the four public channels in sort_order with requiresTier [] and parsed categories', async () => {
    const env = await createTestEnv();
    FOUR_PUBLIC_CHANNELS.forEach((channel, index) =>
      seedChannel(env.db, { id: channel.id, name: channel.name, sortOrder: channel.order, requiresTier: '0', categories: ['都市', '战神'] }, TEST_BASE_TIME_SECONDS + index)
    );
    const body = await parse(await handleChannels(channelsRequest(), env, env.clock));
    expect(body.channels.map((channel) => channel.id)).toEqual(['drama', 'movie', 'anime', 'documentary']);
    expect(body.channels.map((channel) => channel.order)).toEqual([1, 2, 3, 4]);
    for (const channel of body.channels) {
      expect(channel.requiresTier).toEqual([]);
      expect(channel.categories).toEqual(['都市', '战神']);
    }
  });

  it('a bogus session header and a bogus bearer leave the public list intact', async () => {
    const env = await topology();
    const polluted = await parse(await handleChannels(channelsRequest({ [PRIVATE_SESSION_HEADER]: 'not-a-token' }), env, env.clock));
    const forgedBearer = await parse(
      await handleChannels(channelsRequest({ Authorization: 'Bearer forged.forged.forged', [PRIVATE_SESSION_HEADER]: 'not-a-token' }), env, env.clock)
    );
    const anonymous = await parse(await handleChannels(channelsRequest(), env, env.clock));
    expect(polluted).toEqual(anonymous);
    expect(forgedBearer).toEqual(anonymous);
    expect(forgedBearer.channels.map((channel) => channel.id)).toEqual(['drama', 'movie', 'anime', 'documentary']);
  });

  it('public cells are cacheable, the granted cell is not', async () => {
    const env = await topology();
    const denied = await handleChannels(channelsRequest(), env, env.clock);
    expect(denied.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(denied.headers.get('Vary')).toBe(`Authorization, ${PRIVATE_SESSION_HEADER}`);
  });

  it('categories_json that is JSON but not a string array degrades to [] and keeps the rest serving', async () => {
    const env = await topology();
    env.db.execute("UPDATE channels SET categories_json = 'null' WHERE id = 'movie'");
    env.db.execute('UPDATE channels SET categories_json = ? WHERE id = ?', '[1,2,{"nested":true}]', 'anime');
    const response = await handleChannels(channelsRequest(), env, env.clock);
    expect(response.status).toBe(200);
    const body = await parse(response);
    expect(body.channels.find((channel) => channel.id === 'movie')?.categories).toEqual([]);
    expect(body.channels.find((channel) => channel.id === 'anime')?.categories).toEqual([]);
    expect(body.channels.find((channel) => channel.id === 'drama')?.categories.length).toBeGreaterThan(0);
    expect(body.channels).toHaveLength(4);
  });

  it('the schema itself refuses literal garbage: CHECK json_valid(categories_json)', async () => {
    const env = await topology();
    expect(() => env.db.execute("UPDATE channels SET categories_json = 'not-json' WHERE id = 'movie'")).toThrow();
  });
});

describe('GET /api/channels — M-3 cloud-configurable tier set', () => {
  it('admits a Q device once the operator widens the gate, and denies it again after a revert', async () => {
    const widened = await topology('Q');
    const widenedBody = await parse(
      await handleChannels(channelsRequest({ Authorization: await bearer(widened, DEVICE_Q, 'Q'), [PRIVATE_SESSION_HEADER]: await sessionFor(widened, DEVICE_Q) }), widened, widened.clock)
    );
    expect(widenedBody.channels.map((channel) => channel.id)).toContain('private');

    const reverted = await topology('B,Y,S');
    const deniedBody = await parse(
      await handleChannels(channelsRequest({ Authorization: await bearer(reverted, DEVICE_Q, 'Q'), [PRIVATE_SESSION_HEADER]: await sessionFor(reverted, DEVICE_Q) }), reverted, reverted.clock)
    );
    expectPhysicallyInvisible(JSON.stringify(deniedBody));

    const byS = await topology('B,Y,S');
    expect(await privateVisibleIn(byS, DEVICE_B, 'B')).toBe(true);
  });

  it('the tier knob alone is never enough: a sessionless widened config still strips private', async () => {
    const env = await topology('Q');
    const response = await handleChannels(channelsRequest({ Authorization: await bearer(env, DEVICE_Q, 'Q') }), env, env.clock);
    const text = await response.text();
    expectPhysicallyInvisible(text);
  });

  it('an unparseable gate falls back to the shipped default instead of opening to everyone', async () => {
    const env = await topology();
    env.db.execute("UPDATE channels SET requires_tier = 'ZZZ' WHERE id = 'private'");
    expect(await privateVisibleIn(env, DEVICE_B, 'B')).toBe(true);
    expect(await privateVisibleIn(env, DEVICE_Q, 'Q')).toBe(false);
    expect(DEFAULT_PRIVATE_REQUIRED_TIERS).toEqual(['B', 'Y', 'S']);
  });

  it('a disabled private node stays invisible even with a granted session', async () => {
    const env = await topology();
    env.db.execute("UPDATE channels SET enabled = 0 WHERE id = 'private'");
    expect(await privateVisibleIn(env, DEVICE_B, 'B')).toBe(false);
    const body = await parse(
      await handleChannels(channelsRequest({ Authorization: await bearer(env, DEVICE_B, 'B'), [PRIVATE_SESSION_HEADER]: await sessionFor(env, DEVICE_B) }), env, env.clock)
    );
    expect(body.channels.map((channel) => channel.id)).toEqual(['drama', 'movie', 'anime', 'documentary']);
  });
});

describe('GET /api/channels — version is a stable cache key', () => {
  it('is identical across two identical requests and survives a clock advance', async () => {
    const env = await topology();
    const first = await parse(await handleChannels(channelsRequest(), env, env.clock));
    env.clock.advance(3_600);
    const second = await parse(await handleChannels(channelsRequest(), env, env.clock));
    expect(first.version).toBe(TEST_BASE_TIME_SECONDS);
    expect(second.version).toBe(first.version);
  });

  it('changes as soon as a channel row is edited', async () => {
    const env = await topology();
    const before = await parse(await handleChannels(channelsRequest(), env, env.clock));
    env.db.execute('UPDATE channels SET updated_at = ? WHERE id = ?', TEST_BASE_TIME_SECONDS + 60, 'anime');
    const after = await parse(await handleChannels(channelsRequest(), env, env.clock));
    expect(after.version).toBe(TEST_BASE_TIME_SECONDS + 60);
    expect(after.version).not.toBe(before.version);
  });

  it('reports the fixed integer on an empty table', async () => {
    const env = await createTestEnv();
    const body = await parse(await handleChannels(channelsRequest(), env, env.clock));
    expect(body.channels).toEqual([]);
    expect(body.version).toBe(EMPTY_TOPOLOGY_VERSION);
  });
});

async function privateVisibleIn(env: PrismTestEnv, deviceId: string, tier: DeviceTier): Promise<boolean> {
  const response = await handleChannels(
    channelsRequest({ Authorization: await bearer(env, deviceId, tier), [PRIVATE_SESSION_HEADER]: await sessionFor(env, deviceId) }),
    env,
    env.clock
  );
  const body = await parse(response);
  return body.channels.some((channel) => channel.id === 'private');
}
