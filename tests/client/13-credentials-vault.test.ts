// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TitleDetail } from '../../edge/src/types/api';
import {
  createCredentialStore,
  credentialValueOrThrow,
  CredentialShapeError,
  CREDENTIAL_KEYS,
  DEVICE_ID_PATTERN
} from '../../src/core/storage/credentials';
import { createPrivateVault, PRIVATE_VOLATILE_NAMESPACES } from '../../src/core/storage/private-vault';
import { createPublicCache, MemoryCacheDisk } from '../../src/core/storage/public-cache';
import { bridgeSource, createWebFallbackBridge, getBridge, installNativeBridge, isNativeCapabilityAvailable } from '../../src/core/native/bridge';
import { DEVICE_ID_PATTERN as EDGE_DEVICE_ID_PATTERN } from '../../edge/src/core/validation';

const JWT = 'eyJhbGciOiJFZERTQSIsImtpZCI6InAyMDI2In0.eyJzdWIiOiJHWS1URVNUMDAwMDEifQ.ZmFrZV9idXRfY3JlZGlibGVfZWRkc2FfaWdudXJlX2J5dGVz';
const SESSION_TOKEN = 'eyJzaWQiOiJhYjEyMyIsImRldiI6IkdZLVRFU1QwMDAwMSIsImV4cCI6MX0.c2lnbmF0dXJl';

function repoText(relative: string): string {
  let directory = process.cwd();
  for (let step = 0; step < 5; step += 1) {
    const candidate = resolve(directory, relative);
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    directory = resolve(directory, '..');
  }
  throw new Error(`找不到仓库文件：${relative}`);
}

function keystoreStub(secure: Map<string, string>, backed: boolean, log: string[] = []) {
  const web = createWebFallbackBridge();
  const bridge = {
    ...web,
    secureRead: async (key: string) => {
      log.push(`read:${key}`);
      return secure.get(key) ?? null;
    },
    secureWrite: async (key: string, value: string) => {
      log.push(`write:${key}`);
      secure.set(key, value);
    },
    secureClear: async (key: string) => {
      log.push(`clear:${key}`);
      secure.delete(key);
    },
    isKeystoreBacked: async () => backed
  };
  installNativeBridge(bridge, backed ? 'native' : 'web-fallback');
  return { bridge, log };
}

const privateTitle: TitleDetail = {
  item: { id: 'private_x', channelId: 'private', title: '个人探索剧目', category: '成人', isPrivate: true },
  episodes: [{ episodeId: 501, episodeNumber: 1, durationSeconds: 900 }]
};

afterEach(() => {
  installNativeBridge(createWebFallbackBridge(), 'web-fallback');
  vi.restoreAllMocks();
});

describe('domain 1 credentials: two assets, Keystore or an honest downgrade', () => {
  it('stores only the JWT and the device id, in the two pinned slot names', async () => {
    const secure = new Map<string, string>();
    const { log } = keystoreStub(secure, true);
    const store = createCredentialStore();
    const written = await store.write('token', JWT);
    await store.write('deviceId', 'GY-TEST0000');

    expect([...secure.keys()].sort()).toEqual(['auth.jwt.ed25519', 'identity.device.id']);
    expect(await store.readAll()).toEqual({ token: JWT, deviceId: 'GY-TEST0000' });
    expect(log.filter((entry) => entry.startsWith('write:'))).toEqual(['write:auth.jwt.ed25519', 'write:identity.device.id']);
    expect(written.stored).toBe(true);
    expect(CREDENTIAL_KEYS).toEqual(['token', 'deviceId']);
  });

  it('reports the web build as degraded instead of claiming Keystore', async () => {
    keystoreStub(new Map<string, string>(), false);
    const assurance = await createCredentialStore().assurance();
    expect(assurance.keystoreBacked).toBe(false);
    expect(assurance.degraded).toBe(true);
    expect(assurance.bridgeSource).toBe('web-fallback');
    expect(assurance.notice).toContain('无 Android Keystore');
    expect(assurance.notice).toContain('不得对用户宣称硬件级加密');
    expect(await isNativeCapabilityAvailable()).toBe(false);
  });

  it('claims hardware backing only when a native bridge with Keystore answered', async () => {
    keystoreStub(new Map<string, string>(), true);
    const assurance = await createCredentialStore().assurance();
    expect(assurance).toMatchObject({ degraded: false, keystoreBacked: true, bridgeSource: 'native', backupPolicy: 'exclude' });
    expect(assurance.notice).toContain('Android Keystore 硬件密钥');
    expect(await isNativeCapabilityAvailable()).toBe(true);
  });

  it('keeps the web fallback reachable and never throws on a missing credential', async () => {
    installNativeBridge(createWebFallbackBridge(), 'web-fallback');
    const store = createCredentialStore();
    expect(await store.read('token')).toBeNull();
    expect(bridgeSource()).toBe('web-fallback');
    await store.write('deviceId', 'GY-WEB00001');
    expect(await store.read('deviceId')).toBe('GY-WEB00001');
    await expect(getBridge().isKeystoreBacked()).resolves.toBe(false);
  });

  it('refuses values that are not the two credential shapes', async () => {
    keystoreStub(new Map<string, string>(), true);
    const store = createCredentialStore();
    await expect(store.write('token', 'not-a-jwt')).rejects.toBeInstanceOf(CredentialShapeError);
    await expect(store.write('deviceId', 'GY-lowercase')).rejects.toBeInstanceOf(CredentialShapeError);
    expect(() => credentialValueOrThrow('deviceId', 'GY-TEST0000')).not.toThrow();
    expect(credentialValueOrThrow('token', null)).toBeNull();
  });

  it('structurally rejects a private-session credential, which is two segments not three', async () => {
    const secure = new Map<string, string>();
    keystoreStub(secure, true);
    const store = createCredentialStore();
    await expect(store.write('token', SESSION_TOKEN)).rejects.toBeInstanceOf(CredentialShapeError);
    expect(secure.size).toBe(0);
    expect(SESSION_TOKEN.split('.')).toHaveLength(2);
  });

  it('treats an empty value as an explicit clear of that slot', async () => {
    const secure = new Map<string, string>();
    keystoreStub(secure, true);
    const store = createCredentialStore();
    await store.write('token', JWT);
    const cleared = await store.write('token', '   ');
    expect(cleared.cleared).toBe(true);
    expect(await store.read('token')).toBeNull();
  });

  it('clearAll is the only whole-domain reset and cache clearing cannot reach it', async () => {
    const secure = new Map<string, string>();
    const { log } = keystoreStub(secure, true);
    const store = createCredentialStore();
    await store.write('token', JWT);
    await store.write('deviceId', 'GY-TEST0000');
    const cache = createPublicCache(new MemoryCacheDisk());
    cache.stagePage('drama', { items: [{ id: 'drama_a', channelId: 'drama', title: '公开', category: '都市', isPrivate: false }], page: 1, pageSize: 1, total: 1, revision: 3 });
    await cache.commitSnapshot();

    const report = await cache.clearCache();
    expect(report.removedKeys).toBeGreaterThan(0);
    expect(secure.size).toBe(2);
    expect(log.filter((entry) => entry.startsWith('clear:'))).toEqual([]);

    expect(await store.clearAll()).toEqual(['token', 'deviceId']);
    expect(secure.size).toBe(0);
    expect(await store.readAll()).toEqual({ token: null, deviceId: null });
  });

  it('pins the client deviceId grammar to the edge contract', () => {
    expect(DEVICE_ID_PATTERN.source).toBe(EDGE_DEVICE_ID_PATTERN.source);
    expect('GY-TEST0000'.length).toBe(11);
  });
});

describe('domain 4 private vault: RAM only, by construction', () => {
  it('never touches a storage API while holding titles, posters, breakpoints and the session', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const vault = createPrivateVault();
    vault.putTitle(privateTitle);
    vault.putPoster('private_x', new Uint8Array([1, 2, 3]));
    vault.session.write(SESSION_TOKEN);
    vault.putBreakpoint({
      content_id: 'private_x',
      title: '个人探索剧目',
      cover_url: null,
      last_episode_id: 501,
      last_episode_number: 1,
      position_seconds: 42,
      duration_seconds: 900,
      total_episodes: null,
      updated_at: 1
    });

    expect(vault.size()).toBe(4);
    expect(setItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
    expect(vault.sessionToken()).toBe(SESSION_TOKEN);
  });

  it('namespaces every key and drops all of them on clear, idempotently', () => {
    const vault = createPrivateVault();
    vault.putTitle(privateTitle);
    vault.putPoster('private_x', new Uint8Array([9]));
    vault.session.write(SESSION_TOKEN);
    expect(vault.keys().map((key) => key.split(':')[0]).sort()).toEqual([...PRIVATE_VOLATILE_NAMESPACES].filter((name) => name !== 'breakpoint').sort());

    expect(vault.clear()).toBe(3);
    expect(vault.keys()).toEqual([]);
    expect(vault.size()).toBe(0);
    expect(vault.clear()).toBe(0);
    expect(vault.sessionToken()).toBeNull();
    expect(vault.getTitle('private_x')).toBeUndefined();
    expect(vault.listTitles()).toEqual([]);
    expect(vault.listBreakpoints()).toEqual([]);
  });

  it('leaves no content id recallable after clear, including via the breakpoint list', () => {
    const vault = createPrivateVault();
    vault.putBreakpoint({
      content_id: 'private_z',
      title: '个人探索剧目',
      cover_url: null,
      last_episode_id: 1,
      last_episode_number: 1,
      position_seconds: 1,
      duration_seconds: 2,
      total_episodes: null,
      updated_at: 5
    });
    expect(vault.keys().join()).toContain('private_z');
    vault.clear();
    expect(vault.keys().some((key) => key.includes('private_z'))).toBe(false);
    expect(vault.getBreakpoint('private_z')).toBeUndefined();
  });

  it('hands out copies so a stray field cannot outlive clear', () => {
    const vault = createPrivateVault();
    const original = new Uint8Array([1, 2, 3]);
    vault.putPoster('private_x', original);
    original[0] = 99;
    const read = vault.getPoster('private_x');
    expect(Array.from(read ?? new Uint8Array())).toEqual([1, 2, 3]);
    if (read !== undefined) read[1] = 77;
    expect(vault.getPoster('private_x')?.[1]).toBe(2);
  });

  it('has no persistence-looking surface in its own source', () => {
    const source = repoText('src/core/storage/private-vault.ts');
    // The module is allowed to *describe* Keystore, SQLite and the file system in its contract notes;
    // what must be absent is any code that could reach them, so comments are stripped before scanning.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const forbidden of ['Filesystem', 'Preferences', 'SQLite', 'localStorage', 'sessionStorage', 'IndexedDB', 'document.cookie', 'fetch(', 'require(', 'new Map(', 'async ', 'await ', 'Promise', 'bridge']) {
      expect(code, `私密域代码不得出现 ${forbidden}`).not.toContain(forbidden);
    }
    const imports = [...code.matchAll(/from '([^']+)'/g)].map((match) => match[1]).sort();
    expect(imports).toEqual(['../../../edge/src/types/api', '../api/client', './storage-domains']);
    expect(code).toContain('createVolatileStore');
  });
});
