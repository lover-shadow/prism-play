/**
 * Domain 1 — 安全凭证域 (SPEC §6.1 row 1; ARCHITECTURE §3.6.1; Master ruling M-8 落点 五.2).
 *
 * Exactly two assets live here: the Ed25519 JWT and the install `deviceId`. Every byte goes through
 * `getBridge().secureWrite`, which is Keystore-backed on Android and plain web storage on the web.
 * This module reports that difference instead of hiding it: a caller can never read a credential and
 * present it as "硬件级保护" unless `keystoreBacked` says so (AGENTS.md 禁止虚假 UI / SPEC §12.2 G3).
 *
 * The reason `deviceId` and the JWT must not be backed up is mechanical, not stylistic: Keystore keys
 * cannot migrate, so a restored phone would hold undecryptable ciphertext and lose its licence —
 * strictly worse than not backing up. That exclusion is `DOMAIN_BACKUP_POLICY.credentials`, mirrored
 * by `dataExtractionRules.xml` on the native side (device-only proof).
 */

import { bridgeSource, getBridge, type BridgeSource } from '../native/bridge';
import { assertWritable, DOMAIN_BACKUP_POLICY, type StorageDomain, type WriteGuardSubject } from './storage-domains';

export const CREDENTIAL_DOMAIN: StorageDomain = 'credentials';

/** The closed asset list for this domain. Anything else is a contract violation by construction. */
export const CREDENTIAL_KEYS = ['token', 'deviceId'] as const;
export type CredentialKey = (typeof CREDENTIAL_KEYS)[number];

/** Slot names inside the secure store. Never a path, never a file name, never a second dialect. */
const SECURE_SLOT: Readonly<Record<CredentialKey, string>> = {
  token: 'auth.jwt.ed25519',
  deviceId: 'identity.device.id'
};

/**
 * `deviceId` grammar is the OpenAPI `RedeemRequest.deviceId` pattern; kept as a local copy because the
 * client must not import edge runtime code, and pinned against `edge/src/core/validation.ts` by
 * `tests/client/13-credentials-vault.test.ts` so the two dialects cannot drift.
 */
export const DEVICE_ID_PATTERN = /^GY-[A-Z0-9]{8}$/;

/**
 * Three base64url segments is the JWT shape (RFC 8037 header.payload.signature). It is also the
 * accident-proof reason a 个人探索 session credential cannot be parked here: those are two-segment
 * HMAC strings, so a session token fails this test and AC-02-2 ("开启状态严禁持久化") holds by
 * construction rather than by caller honesty.
 */
const JWT_PATTERN = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}$/;

export class CredentialShapeError extends Error {
  constructor(key: CredentialKey, reason: string) {
    super(`凭证域拒绝写入 ${key}：${reason}`);
    this.name = 'CredentialShapeError';
  }
}

export function isCredentialKey(value: string): value is CredentialKey {
  return (CREDENTIAL_KEYS as readonly string[]).includes(value);
}

/** Validate the value shape, or treat null/blank as an explicit delete of that slot. */
export function credentialValueOrThrow(key: CredentialKey, value: string | null): string | null {
  if (value === null || value.trim() === '') return null;
  if (key === 'deviceId') {
    if (!DEVICE_ID_PATTERN.test(value)) {
      throw new CredentialShapeError(key, '设备标识须符合 GY- 加 8 位大写字母数字的合同格式');
    }
    return value;
  }
  if (!JWT_PATTERN.test(value)) {
    throw new CredentialShapeError(key, '授权凭证须为三段式 Ed25519 JWT，非 JWT 的短时凭据一律不入凭证域');
  }
  return value;
}

/** What the secure store actually reported, in the words the settings UI is allowed to show. */
export interface CredentialAssurance {
  domain: StorageDomain;
  keystoreBacked: boolean;
  bridgeSource: BridgeSource;
  /** True whenever Keystore did not answer — the web build is degraded, never "secure by default". */
  degraded: boolean;
  notice: string;
  backupPolicy: 'include' | 'exclude';
}

export interface CredentialWriteReceipt {
  key: CredentialKey;
  stored: boolean;
  cleared: boolean;
  assurance: CredentialAssurance;
}

export interface CredentialRecord {
  token: string | null;
  deviceId: string | null;
}

export class CredentialStore {
  /** Resolved per call so a late-installed native bridge is honoured without re-construction. */
  private get bridge() {
    return getBridge();
  }

  async assurance(): Promise<CredentialAssurance> {
    const keystoreBacked = await this.bridge.isKeystoreBacked();
    const source = bridgeSource();
    const degraded = !keystoreBacked || source !== 'native';
    return {
      domain: CREDENTIAL_DOMAIN,
      keystoreBacked,
      bridgeSource: source,
      degraded,
      notice: degraded
        ? '本构建无 Android Keystore：凭证以浏览器本地存储降级保存，不得对用户宣称硬件级加密'
        : '凭证由 Android Keystore 硬件密钥加密，且已从系统备份中显式排除',
      backupPolicy: DOMAIN_BACKUP_POLICY.credentials
    };
  }

  async read(key: CredentialKey): Promise<string | null> {
    return await this.bridge.secureRead(SECURE_SLOT[key]);
  }

  async readAll(): Promise<CredentialRecord> {
    return { token: await this.read('token'), deviceId: await this.read('deviceId') };
  }

  /**
   * The single gate runs here too, and it is not decoration: a caller that hands over a subject
   * carrying private provenance is refused before any I/O, so nothing derived from 个人探索 can be
   * parked in the one domain that survives a reinstall. The shape check is the second lock — it is
   * what stops a two-segment session credential from masquerading as the JWT slot.
   */
  async write(key: CredentialKey, value: string | null, subject: WriteGuardSubject = {}): Promise<CredentialWriteReceipt> {
    assertWritable('credentials', { ...subject, contentId: key });
    const normalized = credentialValueOrThrow(key, value);
    const slot = SECURE_SLOT[key];
    if (normalized === null) {
      await this.bridge.secureClear(slot);
    } else {
      await this.bridge.secureWrite(slot, normalized);
    }
    return {
      key,
      stored: normalized !== null,
      cleared: normalized === null,
      assurance: await this.assurance()
    };
  }

  async clear(key: CredentialKey): Promise<void> {
    assertWritable('credentials', { contentId: key });
    await this.bridge.secureClear(SECURE_SLOT[key]);
  }

  /**
   * Revoking the licence. This is the only path that empties the domain and it is a deliberate,
   * user-triggered action: 【清理缓存】 never reaches it (`PRESERVED_BY_CLEAR_CACHE` in the façade's
   * clear report, asserted by `tests/client/12-public-cache.test.ts`).
   */
  async clearAll(): Promise<CredentialKey[]> {
    for (const key of CREDENTIAL_KEYS) await this.clear(key);
    return [...CREDENTIAL_KEYS];
  }
}

export function createCredentialStore(): CredentialStore {
  return new CredentialStore();
}
