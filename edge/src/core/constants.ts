/**
 * Numeric and textual constants that the contract pins to a single value.
 * SPEC §10 forbids a second口径 for the redeem rate limit; keeping every one of them here
 * makes a drift visible in review instead of scattered across route files.
 */

/** SPEC §10: `/api/redeem` single IP, at most 10 attempts per minute. */
export const REDEEM_MAX_ATTEMPTS_PER_WINDOW = 10;
export const REDEEM_RATE_WINDOW_SECONDS = 60;

/** AC-14: rejected *distinct* devices strictly above this count marks the coupon abnormal. */
export const COUPON_ABNORMAL_THRESHOLD = 20;

/** AC-02 / API-SPEC §二: private exploration credential lifetime for the current process run. */
export const PRIVATE_SESSION_TTL_SECONDS = 7200;

/** AC-15: offline window only means "authorization remains verifiable". */
export const OFFLINE_GRACE_SECONDS = 14 * 24 * 60 * 60;

/** M-4: one invite settles 3 days, applied to exempt_until or expires_at depending on inviter tier. */
export const INVITE_REWARD_DAYS = 3;

/** SPEC §3.4 / AC-17: a source record gets at most 3 automatic retries before quarantine. */
export const INGEST_MAX_AUTO_RETRIES = 3;

export const JWT_ISSUER = 'prism-play-edge';
export const JWT_AUDIENCE = 'prism-play-client';

/** API-SPEC §四.1 / openapi PlaybackInfo.expiresInSeconds example: 7200. */
export const PLAYBACK_HANDLE_TTL_SECONDS = 7200;

/** Catalogue paging: SPEC §5 pins pageSize default 20 and the /api/catalog ceiling at 50. */
export const CATALOG_DEFAULT_PAGE_SIZE = 20;
export const CATALOG_MAX_PAGE_SIZE = 50;

/** /api/catalog/changes: openapi.yaml limit minimum 1, maximum 100, default 50. */
export const CHANGES_DEFAULT_LIMIT = 50;
export const CHANGES_MAX_LIMIT = 100;

/**
 * How far back the public change log stays replayable. Anything older forces a full snapshot, which
 * is exactly what a 410 tells the client to do (API-SPEC §八). Retention window in seconds.
 */
export const CHANGES_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/** AC-16: openapi.yaml pins search input to 1..80 characters and suggestions to at most 10 rows. */
export const SEARCH_QUERY_MIN_LENGTH = 1;
export const SEARCH_QUERY_MAX_LENGTH = 80;
export const SEARCH_MAX_SUGGESTIONS = 10;
export const SEARCH_DEFAULT_PAGE_SIZE = 20;
export const SEARCH_MAX_PAGE_SIZE = 20;

/** KV is the only home for the cloud-delivered commercial and OTA config (SPEC §6 has no table). */
export const MONETIZATION_KV_KEY = 'config:monetization';
export const VERSION_KV_KEY = 'config:version';

/**
 * Public poster browser cache. NOT pinned by any contract document (SPEC only says 公开海报可用
 * ETag/版本指纹复用), so it lives here as one number pending supervision ratification rather than
 * being repeated per route.
 */
export const PUBLIC_POSTER_MAX_AGE_SECONDS = 300;

/** Share landing page: `?ep=` defaults to episode 1 (SPEC §5 /s/:drama_id). */
export const SHARE_DEFAULT_EPISODE = 1;

/**
 * `/api/user/sync` throttling (CLOUD-SYNC-JIT-PIPELINE-SPEC §2.4).
 *
 * Keyed by deviceId, NOT by IP: one coupon may bind up to 10 devices that share a household
 * egress IP, so an IP bucket would punish a normal family while still allowing a single device
 * to write freely. Every `INSERT OR REPLACE` here is a real D1 row write, and the free tier caps
 * the whole account at 100,000 rows/day — an unthrottled device can take the entire database
 * offline, so this limit is load-bearing rather than cosmetic.
 */
export const USER_SYNC_WINDOW_SECONDS = 300;
export const USER_SYNC_POST_MAX_ATTEMPTS = 20;
export const USER_SYNC_GET_MAX_ATTEMPTS = 60;

/** Maximum rows `GET /api/user/sync` returns, newest first (SPEC §2.2). */
export const USER_SYNC_HISTORY_LIMIT = 50;

/**
 * HotScore weights (SPEC §3.2). Weekly clicks dominate so an older title with a huge lifetime
 * count cannot permanently outrank what people are watching now; `RecencyBoost` lifts anything
 * first published inside the freshness window.
 */
export const HOTSCORE_WEEK_WEIGHT = 0.6;
export const HOTSCORE_TOTAL_WEIGHT = 0.2;
export const HOTSCORE_RECENCY_BOOST = 0.8;
export const HOTSCORE_FRESH_WINDOW_SECONDS = 72 * 3600;
/** Top slice by HotScore that earns `is_hot = 1` (SPEC §3.2). */
export const HOT_TOP_PERCENT = 0.15;
