// @vitest-environment jsdom
/**
 * AC-15 离线授权可验证（SPEC §9 P0 / §4 认证方案行）的证伪测试：验签闸门、14 天窗口闸门、档位读取。
 * 测试密钥对只活在本文件内存里，且断言其公钥值没有泄进生产源码；生产常量则逐字钉死为 Gate G3 决定的
 * 那一把 kid/x——「不认识该 kid 就一律无档位」是 AC-15 的命门，任何漂移（自造、误改、轮换未发版）都在这里红。
 */
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GrantProbeDependencies, GrantRejectReason, GrantStatus } from '../../src/core/identity/offline-grant';
import { createGrantProbe, grantAdaptersFor, grantCopyFor, LAST_ONLINE_CHECK_PREF_KEY, OFFLINE_GRACE_SECONDS, OFFLINE_WINDOW_DAYS, PINNED_VERIFICATION_KEYS } from '../../src/core/identity/offline-grant';
import { createCredentialStore, CredentialShapeError, type CredentialStore } from '../../src/core/storage/credentials';
import { createWebFallbackBridge, installNativeBridge } from '../../src/core/native/bridge';
import type { PreferenceStore } from '../../src/core/state/theme';
import { PERMANENT_EXPIRES_AT } from '../../edge/src/types/api';
import { JWT_AUDIENCE, JWT_ISSUER, OFFLINE_GRACE_SECONDS as EDGE_OFFLINE_GRACE_SECONDS } from '../../edge/src/core/constants';

if ((globalThis.crypto as { subtle?: SubtleCrypto }).subtle === undefined) {
  // jsdom 的 window.crypto 不实现 SubtleCrypto：把全局指向 Node 的 WebCrypto，让模块走与 WebView 同一条通路。
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
}

const productionSource = readFileSync(resolve(process.cwd(), 'src/core/identity/offline-grant.ts'), 'utf8');

const DEVICE = 'GY-TEST0000';
const NOW = 1_800_000_000;
const KID = 'p-test-key';
const DAY = 86_400;
/** 监理在《Gate G3 通过决定书》第一节签发的生产公钥坐标；改动它必须同时改契约与发版。 */
const ISSUED_PUBLIC_X = 'xL-Q-Hge2UGGtv7lslx23_9c7uiNJBRuaPQ9VE_dL74';

// Ed25519 在本环境签不动就整文件报错，绝不静默跳过（真机 WebView 支持度另列待验项）。
const pair = await globalThis.crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const publicJwk = await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey);
const PINNED_TEST_KEY: JsonWebKey = { kty: 'OKP', crv: 'Ed25519', x: String(publicJwk.x), alg: 'EdDSA', key_ops: ['verify'], ext: true };

function b64url(value: string): string {
  return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 用真私钥签一枚边缘同格式的令牌；claims / header 覆写用于构造各类非法输入。 */
async function mint(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}): Promise<string> {
  const body = { iss: JWT_ISSUER, aud: JWT_AUDIENCE, sub: DEVICE, tier: 'B', exp: NOW + DAY, iat: NOW - 3_600, jti: 'jti-0001', ...claims };
  const head = { alg: 'EdDSA', typ: 'JWT', kid: KID, ...header };
  const input = `${b64url(JSON.stringify(head))}.${b64url(JSON.stringify(body))}`;
  const signed = await globalThis.crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(String.fromCharCode(...Array.from(new Uint8Array(signed))))}`;
}

function fakePrefs(initial: Record<string, string> = {}) {
  const values = new Map<string, string>(Object.entries(initial));
  const written: Array<[string, string]> = [];
  const set = async (key: string, value: string): Promise<void> => { written.push([key, value]); values.set(key, value); };
  const get = async (key: string): Promise<string | null> => values.get(key) ?? null;
  return { written, values, store: { get, set } as PreferenceStore };
}

async function seed(token: string | null, deviceId: string | null = DEVICE) {
  const secure = new Map<string, string>();
  installNativeBridge({
    ...createWebFallbackBridge(),
    secureRead: async (key: string) => secure.get(key) ?? null,
    secureWrite: async (key: string, value: string) => void secure.set(key, value),
    secureClear: async (key: string) => void secure.delete(key), isKeystoreBacked: async () => true
  }, 'native');
  const credentials = createCredentialStore();
  if (token !== null) await credentials.write('token', token);
  if (deviceId !== null) await credentials.write('deviceId', deviceId);
  return { credentials, secure };
}

function probeFor(credentials: CredentialStore, prefs: ReturnType<typeof fakePrefs>, extra: Partial<GrantProbeDependencies> = {}) {
  return createGrantProbe({ credentials, prefs: prefs.store, nowSeconds: () => NOW, keys: { [KID]: PINNED_TEST_KEY }, ...extra });
}

const ONLINE_CHECKED = { [LAST_ONLINE_CHECK_PREF_KEY]: String(NOW) };
async function adaptersFor(token: string | null, prefsInitial: Record<string, string> = {}, deps: Partial<GrantProbeDependencies> = {}, deviceId: string | null = DEVICE) {
  const fixture = await seed(token, deviceId);
  const adapters = grantAdaptersFor(probeFor(fixture.credentials, fakePrefs(prefsInitial), deps), fixture.credentials);
  return { fixture, adapters };
}

async function statusFor(token: string | null, deps: Partial<GrantProbeDependencies> = {}, deviceId: string | null = DEVICE): Promise<GrantStatus> {
  const credentials = (await seed(token, deviceId)).credentials;
  return await probeFor(credentials, fakePrefs(ONLINE_CHECKED), deps).read();
}

afterEach(() => {
  installNativeBridge(createWebFallbackBridge(), 'web-fallback');
  vi.restoreAllMocks();
});

describe('AC-15 内置公钥与失效闭路（公钥只认监理签发值，绝不伪造）', () => {
  it('生产常量逐字等于 Gate G3 签发的 p2026：kid 单一、可导入为 Ed25519 验签密钥', async () => {
    expect(Object.keys(PINNED_VERIFICATION_KEYS)).toEqual(['p2026']);
    expect(PINNED_VERIFICATION_KEYS.p2026).toEqual({
      kty: 'OKP', crv: 'Ed25519', x: ISSUED_PUBLIC_X, alg: 'EdDSA', key_ops: ['verify'], ext: true
    });
    expect(productionSource).toContain(ISSUED_PUBLIC_X);
    expect(productionSource).not.toContain(String(publicJwk.x));   // 内存里的测试公钥绝不允许泄进生产
    const key = await globalThis.crypto.subtle.importKey('jwk', PINNED_VERIFICATION_KEYS.p2026, { name: 'Ed25519' }, true, ['verify']);
    expect(key.algorithm.name).toBe('Ed25519');
  });

  it('构建产物不认识该 kid（旧 APK 未发版 / 密钥轮换未跟进）时拿不到任何 tier', async () => {
    expect(await statusFor(await mint(), { keys: {} })).toEqual({ ok: false, reason: 'no-pinned-key' });
    const unbuilt = await adaptersFor(await mint({ tier: 'S', exp: PERMANENT_EXPIRES_AT }), ONLINE_CHECKED, { keys: {} });
    expect(await unbuilt.adapters.tierSource.currentTier()).toBeNull();
    expect(await unbuilt.adapters.credentials.readGrant()).toBeNull();
    expect(await unbuilt.adapters.deviceIdSource.currentDeviceId()).toBeNull();
  });

  it('内置了公钥但令牌 kid 不认识、或公钥转不成验签密钥：同样不通过，不降级为已验签', async () => {
    expect(await statusFor(await mint(), { keys: { other: PINNED_TEST_KEY } })).toEqual({ ok: false, reason: 'no-pinned-key' });
    const brokenKey: JsonWebKey = { kty: 'RSA', n: 'AQAB', e: 'AQAB', alg: 'RS256', key_ops: ['verify'], ext: true };
    expect(await statusFor(await mint(), { keys: { [KID]: brokenKey } })).toEqual({ ok: false, reason: 'no-pinned-key' });
  });

  it('环境没有 SubtleCrypto：判 crypto-unsupported，绝不「跳过验签即视为有效」', async () => {
    const probe = probeFor((await seed(await mint())).credentials, fakePrefs(ONLINE_CHECKED));
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true, writable: true });
    const status = await probe.read();
    if (original !== undefined) Object.defineProperty(globalThis, 'crypto', original);
    expect(status).toEqual({ ok: false, reason: 'crypto-unsupported' });
    expect((await probe.read()).ok).toBe(true);
  });
});

describe('AC-15 离线验签：规则与 edge/src/auth/jwt.ts 逐条对齐', () => {
  it('合法签名的令牌：ok，且 tier / deviceId / exp / iat / kid 逐字段取自 JWT', async () => {
    const issuedAt = NOW - 3_600;
    const token = await mint({ tier: 'Y', iat: issuedAt, exp: NOW + 30 * DAY });
    const status = await statusFor(token);
    expect(status).toEqual({
      ok: true,
      grant: { tier: 'Y', deviceId: DEVICE, expiresAt: NOW + 30 * DAY, issuedAt, kid: KID },
      verifiedAt: NOW
    });
  });

  it('S 档永久令牌：exp = -1 原样成立，不被改写成正数', async () => {
    const status = await statusFor(await mint({ tier: 'S', exp: PERMANENT_EXPIRES_AT }));
    expect(status.ok && status.grant.expiresAt).toBe(PERMANENT_EXPIRES_AT);
  });

  it('令牌只经凭证域，两把钥匙之外没有第三个槽位', async () => {
    const fixture = await seed(await mint());
    expect([...fixture.secure.keys()].sort()).toEqual(['auth.jwt.ed25519', 'identity.device.id']);
    expect(fixture.secure.size).toBe(2);
    await expect(seed('eyJhbGciOiJFZERTQSJ9.c2hvcnQ.bm90LWVub3VnaC1zaWduYXR1cmU')).rejects.toBeInstanceOf(CredentialShapeError);
  });

  it('篡改与降级算法：改一个字节 / alg=HS256 / alg=none 一律 unsigned', async () => {
    const token = await mint();
    const [head, body, signature] = token.split('.');
    const tampered = `${head}.${body[0] === 'e' ? 'a' : 'e'}${body.slice(1)}.${signature}`;
    expect(await statusFor(tampered)).toEqual({ ok: false, reason: 'unsigned' });
    expect(await statusFor(await mint({}, { alg: 'HS256' }))).toEqual({ ok: false, reason: 'unsigned' });
    expect(await statusFor(await mint({}, { alg: 'none' }))).toEqual({ ok: false, reason: 'unsigned' });
    expect(await statusFor(token, { verify: async () => false })).toEqual({ ok: false, reason: 'unsigned' });
    expect((await statusFor(token, { verify: async () => true })).ok).toBe(true);
    const unsupported = await statusFor(token, { verify: async () => { throw new DOMException('nope', 'NotSupportedError'); } });
    expect(unsupported).toEqual({ ok: false, reason: 'crypto-unsupported' });
  });

  it('claims 契约矩阵：iss/aud/tier/exp 形状、sub 与 deviceId 交叉核对，越界即 malformed/expired', async () => {
    const cases: Array<{ name: string; claims: Record<string, unknown>; expected: GrantRejectReason }> = [
      { name: 'aud 不符', claims: { aud: 'someone-else' }, expected: 'malformed' }, { name: 'iss 不符', claims: { iss: 'other-edge' }, expected: 'malformed' },
      { name: 'tier 非 DEVICE_TIERS 闭集', claims: { tier: 'Z' }, expected: 'malformed' }, { name: 'tier 是数字', claims: { tier: 2 }, expected: 'malformed' },
      { name: 'exp 是字符串', claims: { exp: String(NOW + DAY) }, expected: 'malformed' }, { name: 'iat 缺失', claims: { iat: undefined }, expected: 'malformed' },
      { name: '负数但不是 -1 哨兵', claims: { exp: -2 }, expected: 'malformed' }, { name: 'exp 已到点', claims: { exp: NOW }, expected: 'expired' },
      { name: 'sub 与凭证域 deviceId 不同机', claims: { sub: 'GY-OTHER000' }, expected: 'malformed' }, { name: 'exp 已过期', claims: { exp: NOW - 1 }, expected: 'expired' }
    ];
    for (const testCase of cases) {
      expect(await statusFor(await mint(testCase.claims)), testCase.name).toEqual({ ok: false, reason: testCase.expected });
    }
  });

  it('凭证缺失（无 JWT，或有 JWT 却无 deviceId 可交叉核对）一律 absent，不猜档位', async () => {
    expect(await statusFor(null)).toEqual({ ok: false, reason: 'absent' });
    expect(await statusFor(await mint(), {}, null)).toEqual({ ok: false, reason: 'absent' });
  });

  it('结构非法：段数不足被凭证域写入闸门挡在门外，槽位真有脏值时判 malformed', async () => {
    const [head, body, signature] = (await mint()).split('.');
    const fixture = await seed(null);
    const prefs = fakePrefs(ONLINE_CHECKED);
    await expect(fixture.credentials.write('token', `${head}.${body}`)).rejects.toBeInstanceOf(CredentialShapeError);
    fixture.secure.set('auth.jwt.ed25519', `${head}.${body}`); // 绕过写入闸门的脏值同样不能被读成档位
    expect(await probeFor(fixture.credentials, prefs).read()).toEqual({ ok: false, reason: 'malformed' });
    fixture.secure.set('auth.jwt.ed25519', `aaaaaaaa.${body}.${signature}`);
    expect(await probeFor(fixture.credentials, prefs).read()).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('AC-15 的 14 天离线窗口是独立闸门', () => {
  it('窗口数字唯一来源，并与边缘常量对账', () => {
    expect(OFFLINE_GRACE_SECONDS).toBe(14 * DAY);
    expect(OFFLINE_WINDOW_DAYS).toBe(14);
    expect(OFFLINE_GRACE_SECONDS).toBe(EDGE_OFFLINE_GRACE_SECONDS);
  });

  it('从未联网校验 = 超窗（不当作「刚校验过」）；recordOnlineCheck 后同一令牌翻转为 ok，偏好只多那一把钥匙', async () => {
    const fixture = await seed(await mint());
    const prefs = fakePrefs();
    const probe = probeFor(fixture.credentials, prefs);
    expect(await probe.read()).toEqual({ ok: false, reason: 'offline-window-exceeded' });
    await probe.recordOnlineCheck(NOW - OFFLINE_GRACE_SECONDS - 1);
    expect(await probe.read()).toEqual({ ok: false, reason: 'offline-window-exceeded' });
    await probe.recordOnlineCheck(NOW - OFFLINE_GRACE_SECONDS);
    expect((await probe.read()).ok).toBe(true);
    expect(prefs.values.size).toBe(1);
    expect([...prefs.values.keys()]).toEqual([LAST_ONLINE_CHECK_PREF_KEY]);
    expect(prefs.values.get(LAST_ONLINE_CHECK_PREF_KEY)).toBe(String(NOW - OFFLINE_GRACE_SECONDS));
  });

  it('超窗即拒：验签与有效期都过了也不给档位', async () => {
    const fixture = await seed(await mint({ exp: NOW + 365 * DAY }));
    const probe = probeFor(fixture.credentials, fakePrefs({ [LAST_ONLINE_CHECK_PREF_KEY]: String(NOW - 15 * DAY) }));
    expect(await probe.read()).toEqual({ ok: false, reason: 'offline-window-exceeded' });
    const garbage = probeFor(fixture.credentials, fakePrefs({ [LAST_ONLINE_CHECK_PREF_KEY]: 'not-a-number' }));
    expect(await garbage.read()).toEqual({ ok: false, reason: 'offline-window-exceeded' });
    await expect(probe.recordOnlineCheck(Number.NaN)).rejects.toBeInstanceOf(RangeError);
  });

  it('明文不落第二处：令牌与 payload 只在凭证槽出现一次，偏好里只有一个时间戳', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const token = await mint({ tier: 'S', exp: PERMANENT_EXPIRES_AT });
    const fixture = await seed(token);
    const prefs = fakePrefs();
    const probe = probeFor(fixture.credentials, prefs);
    expect((await probe.read()).ok).toBe(false);
    await probe.recordOnlineCheck(NOW);
    expect((await probe.read()).ok).toBe(true);
    expect(prefs.written).toEqual([[LAST_ONLINE_CHECK_PREF_KEY, String(NOW)]]);
    expect(prefs.values.size).toBe(1);
    expect(prefs.values.get(LAST_ONLINE_CHECK_PREF_KEY)).toBe(String(NOW));
    expect([...prefs.values.values()].join()).not.toContain('tier');
    expect([...fixture.secure.values()].join('|').split(token).length - 1).toBe(1);
    expect(setItem).not.toHaveBeenCalled();
  });
});

describe('AC-15 适配器与诚实文案', () => {
  it('grantAdaptersFor：未授权时 tier/readGrant 给 null（不是 0 档、不抛错）；readGrant 透传 -1；clearGrant 清空两把凭证键', async () => {
    const cold = await adaptersFor(null, ONLINE_CHECKED);
    expect(await cold.adapters.tierSource.currentTier()).toBeNull();
    expect(await cold.adapters.credentials.readGrant()).toBeNull();
    // 冷装引导回落：凭证域里已有安装标识但授权还不存在，AC-14 首枚令牌才拼得出请求体。
    expect(await cold.adapters.deviceIdSource.currentDeviceId()).toBe(DEVICE);
    await expect(cold.adapters.credentials.clearGrant()).resolves.toBeUndefined();
    expect(await cold.adapters.deviceIdSource.currentDeviceId()).toBeNull();

    const granted = await adaptersFor(await mint({ tier: 'S', exp: PERMANENT_EXPIRES_AT }), ONLINE_CHECKED);
    expect(await granted.adapters.tierSource.currentTier()).toBe('S');
    expect(await granted.adapters.deviceIdSource.currentDeviceId()).toBe(DEVICE);
    expect(await granted.adapters.credentials.readGrant()).toEqual({ tier: 'S', expiresAt: PERMANENT_EXPIRES_AT });
    await granted.adapters.credentials.clearGrant();
    expect(granted.fixture.secure.size).toBe(0);
    expect(await granted.fixture.credentials.readAll()).toEqual({ token: null, deviceId: null });
    expect(await granted.adapters.tierSource.currentTier()).toBeNull();
  });

  it('deviceIdSource 的回落只认凭证域形状：脏值、无 deviceId、验不过的授权都拿不到标识', async () => {
    const dirty = await adaptersFor(null);
    dirty.fixture.secure.delete('identity.device.id');
    dirty.fixture.secure.set('identity.device.id', 'gy-not-a-device');
    expect(await dirty.adapters.deviceIdSource.currentDeviceId()).toBeNull();
    const noDevice = await adaptersFor(await mint(), {}, {}, null);
    expect(await noDevice.adapters.deviceIdSource.currentDeviceId()).toBeNull();
    expect(await noDevice.adapters.tierSource.currentTier()).toBeNull();
    const stale = await adaptersFor(await mint({ exp: NOW - 1 }), ONLINE_CHECKED);
    expect(await stale.adapters.deviceIdSource.currentDeviceId()).toBeNull();
  });

  it('拒绝文案逐条各有说明，且都带 AC-15 边界：不承诺绝对不可绕过', () => {
    const reasons: GrantRejectReason[] = ['absent', 'no-pinned-key', 'unsigned', 'expired', 'offline-window-exceeded', 'malformed', 'crypto-unsupported'];
    const copies = reasons.map((reason) => grantCopyFor({ ok: false, reason }));
    expect(new Set(copies).size).toBe(reasons.length);
    for (const copy of copies) {
      expect(copy).toContain('点播仍须联网');
      expect(copy).toContain('个人探索绝不离线播放');
      expect(copy).not.toContain('绝对不可绕过');
      expect(copy).not.toContain('硬件级');
    }
    expect(copies[reasons.indexOf('offline-window-exceeded')]).toContain(`${OFFLINE_WINDOW_DAYS} 天`);
    const okCopy = grantCopyFor({ ok: true, grant: { tier: 'B', deviceId: DEVICE, expiresAt: PERMANENT_EXPIRES_AT, issuedAt: NOW, kid: KID }, verifiedAt: NOW });
    expect(okCopy).toContain('B');
    expect(okCopy).toContain('永久');
    expect(okCopy).toContain(KID);
  });
});
