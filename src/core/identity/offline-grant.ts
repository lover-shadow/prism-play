/**
 * AC-15 离线授权可验证（SPEC §9 P0；§4 认证方案行；§11「对称签名导致授权可伪造」；§10 单文件 ≤300 行）。
 *
 * 本模块只回答一个问题：凭证域里那枚 Ed25519 JWT，断网时能否继续作为本机档位的依据。三条边界写死，
 * 上层文案不得美化（`grantCopyFor` 把边界与结论一并带出，避免视图各自表态）：
 * ① 离线只证明「已联网核对过的授权尚未过期」，任何点播仍须联网取流；
 * ② 个人探索绝不离线播放——私密会话凭据本就是 RAM 短时凭据（见 `storage/private-vault.ts`，AC-02-2/5），
 *    它既不入凭证域，也不被本模块读取；
 * ③ 云端撤销无法即时通知离线设备，14 天窗口是「可验证」的上界，不是风险豁免，更不宣称绝对不可绕过。
 *
 * fail-closed 是唯一取向：无内置公钥、验签失败、claims 不合契约、超窗、从未联网校验，一律判为不可用，
 * 绝不出现「解析出来了就先当有效」。公钥随 APK 内置、本期不设动态下发端点（SPEC §4），值由监理方在
 * Gate G3 决定书签发；kid 不认识的令牌一律 `no-pinned-key`，轮换未发版的设备宁可看不到档位也不放行。
 */

import type { DeviceTier } from '../../../edge/src/types/api';
import { DEVICE_TIERS, PERMANENT_EXPIRES_AT } from '../../../edge/src/types/api';
import { JWT_AUDIENCE, JWT_ISSUER } from '../../../edge/src/core/constants';
import type { CredentialStore } from '../storage/index';
import { CREDENTIAL_KEYS, DEVICE_ID_PATTERN } from '../storage/credentials';
import type { CredentialWriter } from '../../views/history-view';
import type { DeviceIdReader, TierReader } from '../../views/settings-view';
import type { PreferenceStore } from '../state/theme';

export interface OfflineGrant {
  tier: DeviceTier;
  deviceId: string;
  expiresAt: number;
  issuedAt: number;
  kid: string;
}

export type GrantRejectReason =
  | 'absent'
  | 'no-pinned-key'
  | 'unsigned'
  | 'expired'
  | 'offline-window-exceeded'
  | 'malformed'
  | 'crypto-unsupported';

export type GrantStatus = { ok: true; grant: OfflineGrant; verifiedAt: number } | { ok: false; reason: GrantRejectReason };

export interface GrantProbe {
  read(): Promise<GrantStatus>;
  recordOnlineCheck(atSeconds: number): Promise<void>;
}

export interface GrantProbeDependencies {
  credentials: CredentialStore;
  prefs: PreferenceStore;
  nowSeconds: () => number;
  keys?: Record<string, JsonWebKey>;
  verify?: (token: string, key: CryptoKey) => Promise<boolean>;
}

/** SPEC §4：离线窗口 14 天。全仓库只有这一个数字来源，视图与测试都从这里读。 */
export const OFFLINE_GRACE_SECONDS = 14 * 24 * 60 * 60;
export const OFFLINE_WINDOW_DAYS = Math.round(OFFLINE_GRACE_SECONDS / 86_400);

/** 偏好域里唯一允许出现的一把钥匙：非授权数值，清缓存与备份都不影响授权本身。 */
export const LAST_ONLINE_CHECK_PREF_KEY = 'prism.lastOnlineCheck';

/**
 * kid -> 内置公钥 JWK。SPEC §4 锁定当前密钥标识为 `p2026`，其值必须由私钥持有方（边缘侧）导出公钥半、
 * 经监理方核对后随 APK 发版回填；施工方自造密钥对会让「验过自造签名的令牌」变成合法档位，
 * 等于把 AC-15 反着实现，故本表只接受监理签发的值。
 * 下方 JWK 出自《Gate G3 通过决定书》(docs/05-audit/G3-SUPERVISION-DECISION-2026-10-01.md 第一节)。
 * 真机仍需证明的一件事：该公钥与线上 Worker 密文 `JWT_PRIVATE_KEY_JWK` 是否配对。不配对不会误放行，
 * 只会让所有设备落 `unsigned` 而看不到离线档位——fail-closed 的代价是可用性，不是安全。
 */
export const PINNED_VERIFICATION_KEYS: Record<string, JsonWebKey> = {
  p2026: {
    kty: 'OKP', crv: 'Ed25519', x: 'xL-Q-Hge2UGGtv7lslx23_9c7uiNJBRuaPQ9VE_dL74',
    alg: 'EdDSA', key_ops: ['verify'], ext: true
  }
};

const JWT_ALG = 'EdDSA';
const ED25519_ALGORITHM = { name: 'Ed25519' } as const;

interface ClaimShape {
  sub: string;
  tier: DeviceTier;
  exp: number;
  iat: number;
}

/** 返回类型交给推断：显式写 `Uint8Array` 会被 TS 5.7+ 放宽成 `ArrayBufferLike`，WebCrypto 不接受。 */
function base64UrlToBytes(segment: string) {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** 解不出合法 JSON 对象即视为 malformed：结构问题不配拿到「已验签」的待遇。 */
function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function subtleOf(): SubtleCrypto | null {
  const host = globalThis.crypto as { subtle?: SubtleCrypto } | undefined;
  return host?.subtle ?? null;
}

/** 只认 `name === 'NotSupportedError'`：算法不被环境支持才降级为「能力缺失」，其余异常按验签失败处理。 */
function isNotSupported(error: unknown): boolean {
  return (error as { name?: unknown }).name === 'NotSupportedError';
}

/** 逐字段对齐 `edge/src/auth/jwt.ts` 的 `verifyJwt`，并比边缘更严：边缘在 D1 复核 `iss`，端侧没有 D1 可依。 */
function parseClaims(value: Record<string, unknown> | null): ClaimShape | null {
  if (value === null) return null;
  if (value.iss !== JWT_ISSUER || value.aud !== JWT_AUDIENCE) return null;
  const { sub, tier, exp, iat } = value;
  if (typeof sub !== 'string' || typeof tier !== 'string') return null;
  if (typeof exp !== 'number' || typeof iat !== 'number') return null;
  if (!Number.isFinite(exp) || !Number.isFinite(iat)) return null;
  if (!(DEVICE_TIERS as readonly string[]).includes(tier)) return null;
  return { sub, tier: tier as DeviceTier, exp, iat };
}

function webVerify(subtle: SubtleCrypto, token: string, key: CryptoKey): Promise<boolean> {
  const [header, payload, signature] = token.split('.');
  return subtle.verify('Ed25519', key, base64UrlToBytes(signature), new TextEncoder().encode(`${header}.${payload}`));
}

export function createGrantProbe(deps: GrantProbeDependencies): GrantProbe {
  /** 每次读都重取，方便测试注入，也防止运行期把已回填的公钥烤进闭包。 */
  const keysOf = (): Record<string, JsonWebKey> => deps.keys ?? PINNED_VERIFICATION_KEYS;

  async function read(): Promise<GrantStatus> {
    const now = deps.nowSeconds();
    const [token, deviceId] = await Promise.all([deps.credentials.read('token'), deps.credentials.read('deviceId')]);
    if (token === null || deviceId === null || token === '' || deviceId === '') return { ok: false, reason: 'absent' };

    const segments = token.split('.');
    if (segments.length !== 3) return { ok: false, reason: 'malformed' };
    const header = decodeJsonSegment(segments[0]);
    if (header === null || typeof header.kid !== 'string') return { ok: false, reason: 'malformed' };
    // `none` / `HS256` 之类降级永不进 WebCrypto：它不是「本系统签的」，与验签失败同判。
    if (header.alg !== JWT_ALG) return { ok: false, reason: 'unsigned' };

    const pinned = keysOf()[header.kid];
    if (pinned === undefined) return { ok: false, reason: 'no-pinned-key' };
    const subtle = subtleOf();
    if (subtle === null) return { ok: false, reason: 'crypto-unsupported' };

    let verifyingKey: CryptoKey;
    try {
      verifyingKey = await subtle.importKey('jwk', pinned, ED25519_ALGORITHM, true, ['verify']);
    } catch (error) {
      return { ok: false, reason: isNotSupported(error) ? 'crypto-unsupported' : 'no-pinned-key' };
    }

    const verify = deps.verify ?? ((raw: string, key: CryptoKey): Promise<boolean> => webVerify(subtle, raw, key));
    let intact = false;
    try {
      intact = await verify(token, verifyingKey);
    } catch (error) {
      if (isNotSupported(error)) return { ok: false, reason: 'crypto-unsupported' };
    }
    if (!intact) return { ok: false, reason: 'unsigned' };

    const claims = parseClaims(decodeJsonSegment(segments[1]));
    if (claims === null) return { ok: false, reason: 'malformed' };
    // 别人的授权不是本机授权：`sub` 与凭证域 `deviceId` 必须同机，否则判 malformed 而非降档可用。
    if (claims.sub !== deviceId) return { ok: false, reason: 'malformed' };
    if (claims.exp !== PERMANENT_EXPIRES_AT) {
      if (claims.exp < 0) return { ok: false, reason: 'malformed' };
      if (claims.exp <= now) return { ok: false, reason: 'expired' };
    }

    /**
     * 从未联网校验（pref 缺失）与「14 天前的校验」同判超窗：令牌已在凭证域却没有任何一次在线确认，
     * 说不上「距最后一次联网校验 ≤14 天」。不选 `absent`——absent 留给「凭证域根本没有东西」这一种，
     * 两者混淆会让安装后离线首启被误读成未安装授权，也让运维无从分辨。
     */
    const lastOnline = Number(await deps.prefs.get(LAST_ONLINE_CHECK_PREF_KEY));
    if (!Number.isFinite(lastOnline) || now - lastOnline > OFFLINE_GRACE_SECONDS) {
      return { ok: false, reason: 'offline-window-exceeded' };
    }

    return {
      ok: true,
      grant: { tier: claims.tier, deviceId: claims.sub, expiresAt: claims.exp, issuedAt: claims.iat, kid: header.kid },
      verifiedAt: now
    };
  }

  return {
    read,
    /** 宿主在 `/api/device/ping` 或 `/api/redeem` 成功后调用；本模块不自己发请求，也不碰 API 层。 */
    recordOnlineCheck: async (atSeconds: number): Promise<void> => {
      if (!Number.isFinite(atSeconds)) throw new RangeError('联网校验时刻须为有限 Unix 秒');
      await deps.prefs.set(LAST_ONLINE_CHECK_PREF_KEY, String(Math.floor(atSeconds)));
    }
  };
}

/**
 * 三个视图小接口共用同一次判定：任何一路都只在 `ok` 时给值，否则给 `null`——档位没有「未知即 0 档」
 * 这种捷径。唯一的例外是 `currentDeviceId` 的冷装引导：`deviceId` 本身不是授权凭证，而是核销请求的
 * 主键（`RedeemRequest.deviceId`，OpenAPI 格式 `GY-` + 8 位）。若授权尚不存在就一律返回 null，
 * AC-14「首次输入卡密核销」将永远拼不出请求体，本机也永远拿不到第一枚 JWT，两条 P0 互锁成死锁。
 * 因此仅在 `reason === 'absent'`（凭证域里根本没有授权）时回落到凭证域原值，且仍须过
 * `DEVICE_ID_PATTERN`；一旦授权存在但验不过（`unsigned` 等），null 语义保持不变——不给伪造授权
 * 背书，也不把可疑 deviceId 送进核销。
 */
export function grantAdaptersFor(probe: GrantProbe, credentials: CredentialStore): {
  tierSource: TierReader;
  deviceIdSource: DeviceIdReader;
  credentials: CredentialWriter;
} {
  const granted = async (): Promise<OfflineGrant | null> => {
    const status = await probe.read();
    return status.ok ? status.grant : null;
  };
  /** 只服务「尚无授权」这一种状态：值取自凭证域，形状不合契约就仍然返回 null，绝不伪造。 */
  const bootstrapDeviceId = async (): Promise<string | null> => {
    const stored = await credentials.read('deviceId');
    return stored !== null && DEVICE_ID_PATTERN.test(stored) ? stored : null;
  };
  return {
    tierSource: { currentTier: async () => (await granted())?.tier ?? null },
    deviceIdSource: {
      currentDeviceId: async () => {
        const status = await probe.read();
        if (status.ok) return status.grant.deviceId;
        return status.reason === 'absent' ? await bootstrapDeviceId() : null;
      }
    },
    credentials: {
      // `expiresAt` 原样透传 JWT 的 `exp`：S 档永久是 -1（`PERMANENT_EXPIRES_AT`），改成正数即谎报有效期。
      readGrant: async () => {
        const grant = await granted();
        return grant === null ? null : { tier: grant.tier, expiresAt: grant.expiresAt };
      },
      clearGrant: async () => {
        for (const key of CREDENTIAL_KEYS) await credentials.clear(key);
      }
    }
  };
}

const OFFLINE_HONEST_BOUNDARY =
  '离线验签只说明「已核对过的授权尚未过期」：点播仍须联网取流，个人探索绝不离线播放，联网侧的撤销也无法即时送达离线设备。';

const REJECT_COPY: Readonly<Record<GrantRejectReason, string>> = {
  absent: '本机凭证域暂无授权凭证，档位与个人探索资格一律不显示。',
  'no-pinned-key': '本构建未内置可核对的验签公钥（或该密钥标识未被内置），离线授权按无效处理。',
  unsigned: '授权凭证的签名与内置公钥不符，本机不把它当作有效授权。',
  expired: '授权凭证已过有效期，请联网重新核销。',
  'offline-window-exceeded': `距最后一次联网校验已超过 ${OFFLINE_WINDOW_DAYS} 天，或本机从未完成联网校验，请联网后重试。`,
  malformed: '授权凭证内容不符合契约字段格式，本机不从中读取档位。',
  'crypto-unsupported': '当前运行环境不支持非对称签名验签（Ed25519），离线授权按无效处理。'
};

export function grantCopyFor(status: GrantStatus): string {
  if (!status.ok) return `${REJECT_COPY[status.reason]}${OFFLINE_HONEST_BOUNDARY}`;
  const lifetime = status.grant.expiresAt === PERMANENT_EXPIRES_AT ? '永久' : new Date(status.grant.expiresAt * 1000).toLocaleDateString('zh-CN');
  return `本机授权离线验签通过，档位 ${status.grant.tier}，有效期至 ${lifetime}，密钥标识 ${status.grant.kid}。${OFFLINE_HONEST_BOUNDARY}`;
}
