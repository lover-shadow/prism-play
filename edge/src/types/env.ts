/**
 * Worker runtime bindings.
 * Names match edge/wrangler.toml; binding IDs are provisioned by the supervision agent and are
 * never edited here. `APK_BUCKET` is optional because the download route lands in Stage 2.
 */

export interface EdgeSecrets {
  /** Ed25519 private JWK serialized as JSON; signing capability, never sent to clients. */
  JWT_PRIVATE_KEY_JWK: string;
  /** Key id embedded in the JWS header so clients can pick the built-in public key. */
  JWT_KID?: string;
  /** Server-only HMAC key for private-session credentials; never shipped to the client. */
  PRIVATE_SESSION_SECRET: string;
  /**
   * Server-only HMAC key for `/proxy/{kind}/{handle}?exp=&sig=` short-lived URLs. The client may
   * replay a signed URL inside its window but cannot extend or retarget it (API-SPEC §六).
   */
  PROXY_SIGNING_SECRET: string;
  ADMIN_PASSWORD_HASH?: string;
  ADMIN_AUTH_VERSION?: string;
  ANALYTICS_HASH_SECRET?: string;
  ANALYTICS_ENABLED?: string;
}

export interface Env extends EdgeSecrets {
  DB: D1Database;
  KV: KVNamespace;
  APK_BUCKET?: R2Bucket;
  DISCOVERY_BUCKET?: R2Bucket;
  CF_VERSION_METADATA?: { id: string; timestamp: string; tag?: string };
  SEARCH_DISCOVERY_ENABLED?: string;
  SEARCH_DISCOVERY_CONFIG?: string;
  /** 广告清单清洗总开关（'true' 启用）；与白名单同时成立才生效，默认关闭。 */
  AD_STRIP_ENABLED?: string;
  /** 逗号分隔的目标主机白名单（精确匹配）；包裹端与入口端共用同一份口径。 */
  AD_STRIP_TARGET_HOSTS?: string;
  /** 可选 JSON 参数覆盖（dominantRatio / repeatBlocks / maxBlockSeconds / maxSegments / maxBytes）。 */
  AD_STRIP_CONFIG?: string;
}

export interface RequestContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface ScheduledController {
  cron: string;
  scheduledTime: number;
  noRetry?: boolean;
  waitUntil(promise: Promise<unknown>): void;
}
