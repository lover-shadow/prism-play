-- ============================================================================
-- 《光影Play》(Prism Play) 预制卡密签发与管理运维脚本 (manage-coupons.sql)
--
-- 档位口径（2026-09-30 定案）：
--   Q: 季度畅享卡 (90天，¥9.9，公开销售，无个人探索)
--   A: 普通激活卡 (30天，历史兼容)
--   B: 高级全源卡 (90天，全源畅享，具备个人探索资格)
--   Y: 年度尊享卡 (365天，具备个人探索资格)
--   S: 极客纪念卡 (永久 -1，内部赠予不公开发售，具备个人探索资格)
--
-- 执行方式：
--   npx wrangler d1 execute prism-play-db --remote --file=scripts/manage-coupons.sql
-- ============================================================================

-- 1. 查看当前各档位卡密库存与核销统计
SELECT tier, tier_name, status, count(*) AS total_count, sum(device_count) AS total_bound_devices
FROM card_coupons 
GROUP BY tier, status;

-- 2. 查询最近被激活或绑定的卡密明细
SELECT code, tier, tier_name, status, device_count, max_devices, datetime(updated_at, 'unixepoch', '+8 hours') AS last_update_beijing
FROM card_coupons 
ORDER BY updated_at DESC 
LIMIT 10;

-- 3. 查看某张卡密绑定的具体设备列表 (将 'GY-Q90D-A7F2-8899' 替换为目标卡密)
-- SELECT b.coupon_code, b.device_id, datetime(b.bound_at, 'unixepoch', '+8 hours') AS bound_beijing, b.bound_ip
-- FROM coupon_bindings b
-- WHERE b.coupon_code = 'GY-Q90D-A7F2-8899';

-- 4. 批量签发新卡密样板 (以 Q 季卡与 B 高级卡为例，code 格式须符合 GY-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4})
-- INSERT INTO card_coupons (code, tier, tier_name, duration_days, status, max_devices, device_count, rejected_distinct_count, is_abnormal, created_at, updated_at) VALUES
-- ('GY-Q90D-AAAA-0001', 'Q', '季度畅享卡', 90, 'ACTIVE', 10, 0, 0, 0, strftime('%s','now'), strftime('%s','now')),
-- ('GY-Q90D-AAAA-0002', 'Q', '季度畅享卡', 90, 'ACTIVE', 10, 0, 0, 0, strftime('%s','now'), strftime('%s','now')),
-- ('GY-B90D-BBBB-0001', 'B', '高级全源卡', 90, 'ACTIVE', 10, 0, 0, 0, strftime('%s','now'), strftime('%s','now'));

-- 5. 作废/封禁异常卡密 (将 'GY-xxxx' 替换为目标卡密)
-- UPDATE card_coupons SET status = 'REVOKED', updated_at = strftime('%s','now') WHERE code = 'GY-xxxx';
