-- Cloudflare D1 增量迁移 0004 — 运营后台与分析（ADMIN-ANALYTICS-AND-COUPON-SPEC-AND-PLAN §2.4）
-- 项目：《光影Play》(Prism Play · play.prismos.org)
-- 适用：在已执行 0001 / 0002 / 0003 的生产库上追加执行；本文件必须被
--       tests/verify_contracts.py 与 tests/support/sqlite-d1.ts 按序读取，不得游离于契约复核之外。
-- 纪律：仅 additive（CREATE + ALTER ADD COLUMN），不 DROP、不改写既有业务列、不回填旧数据。
--       旧 card_coupons 行的新增列取常量 DEFAULT 'UNKNOWN'，须人工确认库存后方可分发。
-- 编号说明：落地前须复核生产 migration ledger 是否已占用 0004（并行施工风险，见计划 §1.1）。

-- ─────────────────────────────────────────────────────────────────────────────
-- 一、分析：每日聚合计数（有限维度原子 UPSERT，不读 JSON 再覆盖）
-- ─────────────────────────────────────────────────────────────────────────────
-- day 为 Asia/Shanghai 的 'YYYY-MM-DD'；服务端 Unix 秒落 updated_at。只计通过校验的公开 GET。
CREATE TABLE IF NOT EXISTS analytics_daily (
    day TEXT NOT NULL,                            -- 'YYYY-MM-DD'
    surface TEXT NOT NULL,                        -- 'portal' | 'dl' | 'share'
    channel TEXT NOT NULL DEFAULT 'unknown',      -- 受控预登记代号；未知归 unknown/direct
    terminal TEXT NOT NULL DEFAULT 'other',       -- 'wechat' | 'android' | 'windows' | 'other'
    requests INTEGER NOT NULL DEFAULT 0 CHECK(requests >= 0),
    downloads INTEGER NOT NULL DEFAULT 0 CHECK(downloads >= 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(day, surface, channel, terminal)
);
CREATE INDEX IF NOT EXISTS idx_analytics_day ON analytics_daily(day);

-- 二、分析：匿名浏览器去重（visitor_hash 为服务端 HMAC 摘要，绝不存原始 Cookie）
CREATE TABLE IF NOT EXISTS analytics_visitors (
    visitor_hash TEXT PRIMARY KEY,                -- HMAC(visitor UUID)，不可逆
    first_seen_day TEXT NOT NULL,                 -- 首见日，冻结后不覆盖
    last_seen_at INTEGER NOT NULL,                -- 最近服务端可见时刻（非精确停留时长）
    first_channel TEXT NOT NULL DEFAULT 'unknown' -- 首见渠道，冻结后不覆盖
);
CREATE INDEX IF NOT EXISTS idx_analytics_visitor_first_day ON analytics_visitors(first_seen_day);

-- 三、分析：按“标识×日×surface”的布尔事实，支撑跨日 DISTINCT/EXISTS 交集，不做每日 UV 相加
CREATE TABLE IF NOT EXISTS analytics_visitor_days (
    day TEXT NOT NULL,
    visitor_hash TEXT NOT NULL,
    surface TEXT NOT NULL,
    page_seen INTEGER NOT NULL DEFAULT 0 CHECK(page_seen IN (0,1)),
    download_seen INTEGER NOT NULL DEFAULT 0 CHECK(download_seen IN (0,1)),
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY(day, visitor_hash, surface)
);
CREATE INDEX IF NOT EXISTS idx_analytics_visitor_days_visitor ON analytics_visitor_days(visitor_hash);
CREATE INDEX IF NOT EXISTS idx_analytics_visitor_days_day ON analytics_visitor_days(day);

-- ─────────────────────────────────────────────────────────────────────────────
-- 四、后台会话：仅存 opaque session 的 SHA-256 摘要，登出/过期删除；不复用 App JWT
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,                  -- SHA-256(session)，绝不存 session 明文
    csrf_hash TEXT NOT NULL,                      -- 会话绑定 CSRF 摘要
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,                  -- 绝对到期，无滑动续期
    auth_version INTEGER NOT NULL                 -- ADMIN_AUTH_VERSION 变更后旧会话整体失效
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires ON admin_sessions(expires_at);

-- 五、后台登录限流：按可信 CF 来源 IP 摘要的固定窗口原子计数（不用 KV 最终一致计数）
CREATE TABLE IF NOT EXISTS admin_login_limits (
    ip_hash TEXT NOT NULL,                        -- SHA-256(来源 IP)，不存明文 IP
    window_start INTEGER NOT NULL,                -- 窗口起点 Unix 秒
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    failed_count INTEGER NOT NULL DEFAULT 0 CHECK(failed_count >= 0),
    blocked_until INTEGER NOT NULL DEFAULT 0 CHECK(blocked_until >= 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(ip_hash, window_start)
);

-- 六、卡密批次：request_id UNIQUE 保证网络重试幂等（一请求一批，不重复造资产）
CREATE TABLE IF NOT EXISTS coupon_batches (
    batch_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    tier TEXT NOT NULL CHECK(tier IN ('Q', 'B', 'Y', 'S')),
    count INTEGER NOT NULL CHECK(count BETWEEN 1 AND 100),
    note TEXT,
    created_at INTEGER NOT NULL
);

-- 七、卡密分发标记：additive 列。dispatch_status 独立于核销 status，二者不可互相冒充。
ALTER TABLE card_coupons ADD COLUMN batch_id TEXT;
ALTER TABLE card_coupons ADD COLUMN dispatch_status TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK(dispatch_status IN ('IDLE', 'DISPATCHED', 'UNKNOWN'));
ALTER TABLE card_coupons ADD COLUMN dispatch_note TEXT;
ALTER TABLE card_coupons ADD COLUMN dispatched_at INTEGER;
-- 分发认领对账 trip-wire 的判定依据：同一码被不同请求竞争时，只有 request_id 命中者视为成功。
ALTER TABLE card_coupons ADD COLUMN dispatch_request_id TEXT;

-- 八、运营审计：request_id UNIQUE 供认领幂等判定；details 不含口令/session/全码明文。
CREATE TABLE IF NOT EXISTS admin_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT UNIQUE,
    actor TEXT NOT NULL DEFAULT 'admin',
    action TEXT NOT NULL,                         -- 'COUPON_CREATE'|'COUPON_DISPATCH'|'COUPON_REVOKE'|'STOCK_CONFIRM'
    target_hash TEXT,                             -- 目标对象摘要（如卡密 SHA-256），不存全码
    batch_id TEXT,
    details_json TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at);
