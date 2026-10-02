-- Cloudflare D1 增量迁移 0002
-- 项目：《光影Play》(Prism Play · play.prismos.org)
-- 版本：v2.2；承接 CLOUD-SYNC-JIT-PIPELINE-SPEC.md §2.1 与 §3.1
-- 适用：在已执行 0001_initial_schema.sql 的生产库上追加执行；本文件必须被
--       tests/verify_contracts.py 按序读取，不得游离于契约复核之外（复审 A-2）。

-- ─────────────────────────────────────────────────────────────────────────────
-- 一、 多端云同步中枢（手机 / TV / PC 接力）
-- ─────────────────────────────────────────────────────────────────────────────

-- 多端同步观看断点：主键 (coupon_code, content_id) 保证单剧单行、上报幂等覆盖。
-- 不带 ON DELETE CASCADE：私密内容在服务端写入前即被拒绝（SPEC §2.3），
-- 因此本表不可能出现 is_private = 1 的行；不做级联删除是刻意保留可审计性。
CREATE TABLE IF NOT EXISTS cloud_watch_history (
    coupon_code TEXT NOT NULL REFERENCES card_coupons(code),
    content_id TEXT NOT NULL REFERENCES content_items(id),
    episode_number INTEGER NOT NULL CHECK(episode_number > 0),
    position_seconds REAL NOT NULL CHECK(position_seconds >= 0),
    duration_seconds REAL NOT NULL CHECK(duration_seconds >= 0),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(coupon_code, content_id)
);
CREATE INDEX IF NOT EXISTS idx_cloud_history_coupon
    ON cloud_watch_history(coupon_code, updated_at DESC);

-- 多端同步用户偏好画像：每个卡密唯一一行。
-- preferences_json 为 21 个双字题材的偏好得分向量；由客户端计算后上报，
-- 服务端只做存储与 last-write-wins 仲裁，不解释其内容（SPEC §2.5）。
CREATE TABLE IF NOT EXISTS cloud_user_profile (
    coupon_code TEXT PRIMARY KEY REFERENCES card_coupons(code),
    preferences_json TEXT NOT NULL CHECK(json_valid(preferences_json)),
    total_plays INTEGER NOT NULL DEFAULT 0 CHECK(total_plays >= 0),
    updated_at INTEGER NOT NULL
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 二、 content_items 客观属性扩列（HotScore 与 AI 剧标定）
--     复审 A-6 要求：DDL 必须与 content-repo / types / serialize / openapi 同步
-- ─────────────────────────────────────────────────────────────────────────────

-- 上游点击量原始输入；缺失即 0，绝不反推。
ALTER TABLE content_items ADD COLUMN hits_week INTEGER NOT NULL DEFAULT 0 CHECK(hits_week >= 0);
ALTER TABLE content_items ADD COLUMN hits_total INTEGER NOT NULL DEFAULT 0 CHECK(hits_total >= 0);

-- 客观综合热度分：HotScore = log10(hits_week+1)*0.6 + log10(hits_total+1)*0.2 + RecencyBoost
-- 由批次任务计算好后写入，不在请求路径实时计算。
ALTER TABLE content_items ADD COLUMN hot_score REAL NOT NULL DEFAULT 0 CHECK(hot_score >= 0);

-- AI 短剧 / 漫剧形式标记：命中 AI 专区或 AI 特征词置 1。
ALTER TABLE content_items ADD COLUMN is_ai INTEGER NOT NULL DEFAULT 0 CHECK(is_ai IN (0,1));

-- 全网热门标记：hot_score 排名前 15% 置 1；由批次任务统一刷新。
ALTER TABLE content_items ADD COLUMN is_hot INTEGER NOT NULL DEFAULT 0 CHECK(is_hot IN (0,1));

CREATE INDEX IF NOT EXISTS idx_content_hot ON content_items(channel_id, is_hot, hot_score DESC);
CREATE INDEX IF NOT EXISTS idx_content_ai ON content_items(channel_id, is_ai, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_catalog_filter ON content_items(channel_id, enabled, is_private, category, updated_at DESC);
