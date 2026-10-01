-- Cloudflare D1 边缘数据库 Schema
-- 项目：《光影Play》(Prism Play · play.prismos.org)
-- 版本：v2.0.0；仅供新库初始化，已有生产数据必须单独审核增量迁移。

-- 1. 设备资产表 (记录已激活或登记的终端设备)
CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,                     -- 本期 'android'；其他平台须另立迁移/契约
    tier TEXT NOT NULL DEFAULT '0',             -- '0':试用, 'Q':季度(公开), 'A':普通(历史兼容), 'B':高级, 'Y':年度, 'S':永久(内部)
    tier_name TEXT NOT NULL DEFAULT '默认试用',
    expires_at INTEGER NOT NULL DEFAULT 0,      -- Unix 秒级时间戳, 0 表示未激活, -1 表示永久
    exempt_until INTEGER NOT NULL DEFAULT 0,    -- 免打扰到期时间戳 (邀请裂变累加)
    bound_coupon TEXT,                          -- 最近一次绑定的预制卡密代码
    invited_by TEXT,                            -- 邀请人 device_id
    registered_ip TEXT,
    last_active_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(bound_coupon) REFERENCES card_coupons(code),
    FOREIGN KEY(invited_by) REFERENCES devices(device_id),
    CHECK(platform = 'android'),
    CHECK(tier IN ('0', 'Q', 'A', 'B', 'Y', 'S'))
);

-- 2. 预制卡密台账表 (支持宽松家庭共享裂变，默认允许最多 10 台设备激活)
CREATE TABLE IF NOT EXISTS card_coupons (
    code TEXT PRIMARY KEY,                      -- 卡密 (如: 'GY-B90D-A7F2-8899')
    tier TEXT NOT NULL,                         -- 'Q' | 'A' | 'B' | 'Y' | 'S'（仅 B/Y/S 具备个人探索资格）
    tier_name TEXT NOT NULL,                    -- '季度畅享卡' | '普通激活卡' | '高级全源卡' | '年度尊享卡' | '极客纪念卡'
    duration_days INTEGER NOT NULL,             -- 有效天数 (30, 90, 365, -1 为永久)
    status TEXT NOT NULL DEFAULT 'UNUSED',      -- 'UNUSED' | 'ACTIVE' | 'REVOKED'
    max_devices INTEGER NOT NULL DEFAULT 10,    -- 宽松共享额度 (默认 10 台，促进家庭口碑裂变)
    device_count INTEGER NOT NULL DEFAULT 0,    -- 成功绑定设备数，严格不超过10台
    rejected_distinct_count INTEGER NOT NULL DEFAULT 0, -- 被拒绝的不同新设备尝试数
    is_abnormal INTEGER NOT NULL DEFAULT 0,     -- 被拒绝的不同新设备尝试数>20时标记
    first_redeemed_at INTEGER,
    note TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK(tier IN ('Q', 'A', 'B', 'Y', 'S')),
    CHECK(duration_days > 0 OR (tier = 'S' AND duration_days = -1)),
    CHECK(status IN ('UNUSED', 'ACTIVE', 'REVOKED')),
    CHECK(max_devices BETWEEN 1 AND 10),
    CHECK(device_count BETWEEN 0 AND max_devices),
    CHECK(rejected_distinct_count >= 0),
    CHECK(is_abnormal IN (0, 1))
);

-- 3. 卡密-设备绑定流水表 (1对多设备绑定关系记录)
CREATE TABLE IF NOT EXISTS coupon_bindings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    coupon_code TEXT NOT NULL,                  -- 关联卡密
    device_id TEXT NOT NULL,                    -- 关联设备
    bound_at INTEGER NOT NULL,                  -- 绑定时间戳
    bound_ip TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(coupon_code, device_id),
    FOREIGN KEY(coupon_code) REFERENCES card_coupons(code),
    FOREIGN KEY(device_id) REFERENCES devices(device_id)
);

-- 拒绝新设备的去重流水：仅真实不同 device_id 计数，重试不叠加。
CREATE TABLE IF NOT EXISTS coupon_rejected_devices (
    coupon_code TEXT NOT NULL REFERENCES card_coupons(code),
    device_id TEXT NOT NULL,
    first_rejected_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(coupon_code, device_id)
);

-- 4. 动态“大视界”频道配置表 (云端动态下发，支持随时增减频道)
CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,                        -- 'drama' | 'movie' | 'anime' | 'documentary' | 'private'
    name TEXT NOT NULL,                         -- '短剧精选' | '院线电影' | '热血动漫' | '人文纪录' | '私密频道'
    sort_order INTEGER NOT NULL DEFAULT 1,
    requires_tier TEXT NOT NULL DEFAULT '0',    -- '0':公开；非'0'为准入档位集合(如'B,Y,S')，仅用于 private
    categories_json TEXT NOT NULL,              -- 二级吸顶横滑分类胶囊 JSON 数组
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK(id IN ('drama','movie','anime','documentary','private')),
    CHECK((id <> 'private' AND requires_tier = '0') OR (id = 'private' AND requires_tier <> '0')),
    CHECK(json_valid(categories_json))
);

-- 私密准入档位变更审计日志 (治理高危旋钮)
CREATE TABLE IF NOT EXISTS channel_tier_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL REFERENCES channels(id),
    old_requires_tier TEXT NOT NULL,
    new_requires_tier TEXT NOT NULL,
    changed_by TEXT NOT NULL,
    changed_at INTEGER NOT NULL
);

-- 5. 抽象播放源与健康巡检表 (每日 2 次轮询频道测速，仅存地址与元数据，绝不存视频文件)
CREATE TABLE IF NOT EXISTS source_providers (
    id TEXT PRIMARY KEY,                        -- 去平台化抽象 ID ('provider_s1', 'provider_m1')
    name TEXT NOT NULL,                         -- 中性展示名称 ('光影极速专线A')
    channel_id TEXT NOT NULL,                   -- 归属频道 ID
    upstream_url TEXT NOT NULL,                 -- 真实上游采集地址 (保留在云端)
    priority INTEGER NOT NULL DEFAULT 1,
    latency_ms INTEGER NOT NULL DEFAULT 999,    -- 最近一次 Cron 探针实测延迟
    healthy INTEGER NOT NULL DEFAULT 1 CHECK(healthy IN (0,1)),
    last_checked_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(channel_id) REFERENCES channels(id)
);

-- 服务端可信内容目录，分享/搜索/播放均从此处解析，绝不信任客户端传入私密标志。
CREATE TABLE IF NOT EXISTS content_items (
    id TEXT PRIMARY KEY,                        -- 稳定 content_id / drama_id
    channel_id TEXT NOT NULL REFERENCES channels(id),
    title TEXT NOT NULL,
    cover_url TEXT,
    cover_version TEXT,                         -- 公开海报版本；源封面变化时更新，用于端侧增量缓存
    synopsis TEXT,
    category TEXT NOT NULL,
    is_private INTEGER NOT NULL DEFAULT 0 CHECK(is_private IN (0,1)),
    shareable INTEGER NOT NULL DEFAULT 0 CHECK(shareable IN (0,1)), -- 默认禁止分享，显式确认后允许；private 恒为 0
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),  -- 默认不发布；元数据确认后显式上架
    first_published_at INTEGER,               -- 初次公开时间；最新上线只依据此字段，不以入库时间代替
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK((channel_id = 'private' AND is_private = 1 AND shareable = 0) OR (channel_id <> 'private' AND is_private = 0))
);
CREATE TABLE IF NOT EXISTS content_episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id TEXT NOT NULL REFERENCES content_items(id),
    episode_number INTEGER NOT NULL CHECK(episode_number > 0),
    title TEXT,
    duration_seconds INTEGER CHECK(duration_seconds >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(content_id, episode_number)
);
CREATE TABLE IF NOT EXISTS episode_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    episode_id INTEGER NOT NULL REFERENCES content_episodes(id),
    provider_id TEXT NOT NULL REFERENCES source_providers(id),
    upstream_media_url TEXT NOT NULL,           -- 仅服务端持有，不回传真实上游
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(episode_id, provider_id)
);

-- 6. 邀请与裂变流水表
CREATE TABLE IF NOT EXISTS invitation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inviter_device_id TEXT NOT NULL,
    invitee_device_id TEXT NOT NULL UNIQUE REFERENCES devices(device_id),
    reward_type TEXT NOT NULL DEFAULT 'NUDGE_FREE' CHECK(reward_type IN ('NUDGE_FREE','TIER_EXTEND')), -- M-4: 非会员延免打扰, 会员延有效期
    reward_days INTEGER NOT NULL DEFAULT 3 CHECK(reward_days >= 0),
    settled INTEGER NOT NULL DEFAULT 0 CHECK(settled IN (0,1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(inviter_device_id) REFERENCES devices(device_id),
    CHECK(inviter_device_id <> invitee_device_id)
);

-- 私密会话撤销墓碑：只存不可逆 token 摘要及过期时刻，不存用户开启状态或内容身份。
-- 关闭开关时写入摘要；每次私密请求核对 D1 后拒绝命中，过期后可清理。
CREATE TABLE IF NOT EXISTS private_session_revocations (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_private_revocations_expiry ON private_session_revocations(expires_at);

-- 7. 索引优化
CREATE INDEX IF NOT EXISTS idx_coupons_status ON card_coupons(status);
CREATE INDEX IF NOT EXISTS idx_coupons_abnormal ON card_coupons(is_abnormal);
CREATE INDEX IF NOT EXISTS idx_bindings_coupon ON coupon_bindings(coupon_code);
CREATE INDEX IF NOT EXISTS idx_bindings_device ON coupon_bindings(device_id);
CREATE INDEX IF NOT EXISTS idx_devices_expires ON devices(expires_at);
CREATE INDEX IF NOT EXISTS idx_sources_channel_healthy ON source_providers(channel_id, healthy, latency_ms);
CREATE INDEX IF NOT EXISTS idx_content_channel ON content_items(channel_id);
CREATE INDEX IF NOT EXISTS idx_content_visible ON content_items(channel_id, enabled, is_private);
CREATE INDEX IF NOT EXISTS idx_episode_sources_provider ON episode_sources(provider_id);
CREATE INDEX IF NOT EXISTS idx_invitations_inviter ON invitation_logs(inviter_device_id);

-- 2026-10-01：以下为尚未投产的新库增补；若生产库已使用 0001，须新建增量迁移而不是原地重跑。
-- 公共目录序列：客户端按 (revision, id) 拉增量及墓碑；个人探索永不进入公开变更表。
CREATE TABLE IF NOT EXISTS public_catalog_changes (
    revision INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id TEXT NOT NULL,
    operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
    changed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_catalog_changes_content ON public_catalog_changes(content_id, revision);
-- 公开目录每次发布/撤片须与变更日志写入同一个原子提交单元；revision 由变更表分配。
-- 当前公开修订号为 MAX(revision)，初始 0；保留的最小 revision 及快照边界
-- 由服务端同步逻辑维护，不能单凭 AUTOINCREMENT 声称跨分页历史快照可用。

-- 已配置来源的增量采集；原始记录不直接对外发布，归并映射保留可拆分性。
CREATE TABLE IF NOT EXISTS ingest_sources (
    provider_id TEXT PRIMARY KEY REFERENCES source_providers(id),
    enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
    cursor TEXT,
    last_success_at INTEGER,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS source_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT NOT NULL REFERENCES source_providers(id),
    source_item_id TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    content_id TEXT REFERENCES content_items(id),
    link_evidence TEXT CHECK(link_evidence IS NULL OR link_evidence IN ('same_source_id','trusted_cross_source_map','new_work')), -- 可拆分的作品身份依据
    title TEXT NOT NULL,
    synopsis TEXT,
    metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
    status TEXT NOT NULL CHECK(status IN ('received','enriched','linked','published','retry','rejected')), -- 可重试状态机；跨源归并另依赖受信映射
    classification_json TEXT CHECK(classification_json IS NULL OR json_valid(classification_json)),
    model_version TEXT,
    error_code TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
    next_attempt_at INTEGER,                  -- 失败后按上限退避；达到上限留 rejected/隔离，不无限重试
    updated_at INTEGER NOT NULL,
    UNIQUE(provider_id, source_item_id, source_revision)
);
CREATE INDEX IF NOT EXISTS idx_source_records_work ON source_records(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_source_records_content ON source_records(content_id);
-- 同一源内部的稳定 ID 可幂等关联，跨源合并必须由可信映射证据显式入表；
-- 此表不存 AI 相似分，也不允许模型推断本身触发跨源自动归并。
CREATE TABLE IF NOT EXISTS trusted_work_mappings (
    provider_id TEXT NOT NULL REFERENCES source_providers(id),
    source_item_id TEXT NOT NULL,
    content_id TEXT NOT NULL REFERENCES content_items(id),
    evidence_ref TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(provider_id, source_item_id)
);
CREATE TABLE IF NOT EXISTS source_episode_links (
    source_record_id INTEGER NOT NULL REFERENCES source_records(id),
    source_episode_id TEXT NOT NULL,
    episode_id INTEGER REFERENCES content_episodes(id),
    PRIMARY KEY(source_record_id, source_episode_id)
);

-- 规范剧目标签/别名；文本索引只是候选源，查询结果必须回 content_items 校验当前准入。
CREATE TABLE IF NOT EXISTS content_aliases (
    content_id TEXT NOT NULL REFERENCES content_items(id),
    alias TEXT NOT NULL,
    pinyin TEXT,
    pinyin_initials TEXT,
    PRIMARY KEY(content_id, alias)
);
CREATE TABLE IF NOT EXISTS content_tags (
    content_id TEXT NOT NULL REFERENCES content_items(id),
    tag TEXT NOT NULL,
    taxonomy_version INTEGER NOT NULL,
    PRIMARY KEY(content_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_content_tags_tag ON content_tags(tag, content_id);
CREATE VIRTUAL TABLE IF NOT EXISTS public_search_fts USING fts5(
    content_id UNINDEXED,
    title_tokens,
    alias_tokens,
    pinyin_tokens,
    tag_tokens,
    tokenize = 'unicode61',
    prefix = '2 3'
);
-- 应用层按同一 content_id 执行索引删除再插入并校验回表；FTS 的中文词元由写入侧
-- 预生成。unicode61 下仅写入“战神 归来”时查询“战”不命中，中文单字必须由
-- 额外单字词元/受控前缀路径覆盖；连续中文片语的排序及多音字须样本验证。
-- 不得让私密作品进入此公开 FTS，撤片以 D1 权威过滤先行。
-- Vectorize 索引以 content_id 为键，独立异步维护，永不作为授权或撤片判定。
