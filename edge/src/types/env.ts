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
}

export interface Env extends EdgeSecrets {
  DB: D1Database;
  KV: KVNamespace;
  APK_BUCKET?: R2Bucket;
  /**
   * Public base of the R2 bucket, used only to build the 302 target of `/dl/latest/android`. Unset
   * until the supervision agent attaches a domain to `prism-play-releases`; then no artifact and no
   * invented host — the route answers 404 (API-SPEC §五.3).
   */
  APK_PUBLIC_BASE_URL?: string;
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
