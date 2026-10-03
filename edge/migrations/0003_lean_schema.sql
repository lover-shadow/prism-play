-- Cloudflare D1 增量迁移 0003 — Track 2 云端读路径重构（SPEC-CLOUD-REFACTOR v2 §C-4 / §C-5）
-- 项目：《光影Play》(Prism Play · play.prismos.org)
-- 适用：在已执行 0001 / 0002 的生产库上追加执行；本文件必须被 tests/verify_contracts.py
--       与 tests/support/sqlite-d1.ts 按序读取，不得游离于契约复核之外（复审 A-2）。
--
-- 施工顺序硬依赖（SPEC §五）：本文件的「停用标记」段落只在 C-3/C-3b 读路径切换完成之后才有效力；
-- 先于读路径切换执行会立即打断目录与详情链路。

-- ─────────────────────────────────────────────────────────────────────────────
-- 一、C-4：线路健康遥测小表（唯一保留在 D1 的内容邻域写路径）
-- ─────────────────────────────────────────────────────────────────────────────

-- 端侧离场批量上报的线路失败信号。请求路径**只写不读**：分析出口是
-- `wrangler d1 execute prism-play-db --remote --command="SELECT * FROM line_health_signals WHERE reported_at > …"`
-- 导 CSV 本地比对（§C-4-4），因此本表永远不会进入目录读路径，也就不消耗 500 万行/天的行读额度。
CREATE TABLE IF NOT EXISTS line_health_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT NOT NULL,                  -- 抽象源编号（provider_m1 式）；严禁写入外部站源名
    work_id TEXT NOT NULL,                      -- 归一 work id，与 R2 剧集清单同名
    line_index INTEGER NOT NULL DEFAULT 0 CHECK(line_index >= 0),
    failure_code TEXT NOT NULL CHECK(failure_code IN ('timeout','http_error','decode_error')),
    device_hash TEXT NOT NULL,                  -- 端侧设备摘要；服务端不要求可逆，也不参与鉴权
    reported_at INTEGER NOT NULL,               -- 设备自述 Unix 秒；只用于趋势，不做准入判定
    CHECK(reported_at >= 0)
);
CREATE INDEX IF NOT EXISTS idx_line_health_reported ON line_health_signals(reported_at);
CREATE INDEX IF NOT EXISTS idx_line_health_work ON line_health_signals(work_id, provider_id, reported_at);

-- ─────────────────────────────────────────────────────────────────────────────
-- 二、C-5：内容大表标记停用（DEPRECATED）——**本迁移不执行任何 DROP**
-- ─────────────────────────────────────────────────────────────────────────────
--
-- 决策依据（SPEC §1.2-1）：D1 从「仓库」退回「账本」。目录与剧集行整体迁出 D1，改由
-- R2 静态资产（library/、private/ 前缀）+ KV 清单（catalog:manifest、catalog:private-manifest）
-- 承载；CI 只推送资产，不再灌 D1。
--
-- 之所以「标记而不物理删除」：
--   1. cloud_watch_history.content_id 与 content_aliases / content_tags 等仍以 content_items 为外键锚点，
--      DROP 会级联破坏多端同步与归一映射的可审计性（§C-5 保留清单）；
--   2. 灰度期间旧版 APK 仍可能命中尚未切换的读路径，留一份可回读的旧表是唯一兜底；
--   3. 真正下线 content_items 需要独立的、经 Master 审批的数据销毁迁移，不属于本次施工范围。
--
-- 【DEPRECATED — 路由层不得再查询以下表】（SPEC-CLOUD-REFACTOR v2 §五 C-5）
--   content_items               → 目录卡片：R2 library/v{revision}/{channelId}/chunk-{n}.json（§3.1）
--   content_episodes            → 剧集清单：R2 library|private/v{revision}/titles/{workId}.json（§3.2）
--   episode_sources             → 播放地址：同上剧集清单 lines[].mediaUrl（视频流不再经云端代理）
--   public_search_fts           → 检索：端侧 SQLite FTS5 本地索引（SPEC-APP-REFACTOR §1.2-6）
--   public_catalog_changes      → 增量：相邻 revision 分片比对（本文件配套 C-3-3）
--   source_records              → 采集产物：CI 直接生成 R2 资产，不再入库
--   ingest_sources              → 同上，采集游标语义随 CI 化而退役
--   source_episode_links        → 同上
--   content_tags                → 分类/标签：随目录分片的 category 字段下发
--   channels                    → 频道拓扑：KV 清单 taxonomyVersion + catalog:manifest.channels（§3.3）
--   channel_tier_audit_logs     → 档位审计：改由 KV config:sources 与商业化配置承载
--   source_providers            → 源目录：KV config:sources（§C-6），线路健康改看 line_health_signals
--
-- 【保留 — 账本与归一映射】devices, card_coupons, coupon_bindings, coupon_rejected_devices,
--   cloud_watch_history, cloud_user_profile, content_aliases, trusted_work_mappings,
--   invitation_logs, private_session_revocations, line_health_signals。
--
-- 尚未在本 Track 内切换、因而**暂时**仍读取停用表的路径（越界项已在交付报告列明，待 Master 裁决）：
--   /api/search、/api/titles/{id}/related（public_search_fts / content_items / content_tags）、
--   /api/sources 与 /proxy 上游白名单（source_providers）、core/admission.ts 的 requires_tier（channels）。
-- 这些表未被 DROP，故上述路径仍可运行；一旦独立审批的销毁迁移落地，必须先完成同批路由切换。
