# 《光影Play》（Prism Play）Cloudflare 边缘云脑白皮书与事实正本 (CLOUDFLARE-BACKEND-FACTS.md)

> **版本**：v2.0 生产基线  
> **生效日期**：2026-10-02  
> **服务主域**：`https://play.prismos.org`  
> **编制目的**：消除云端“黑盒”，将云端基础设施、数据库拓扑、加密密钥、定时调度、网络代理及运维指令固化为绝对可查、可操作、可追溯的单源事实正本。后续任何迭代与优化严禁重新摸索，必须本文件为依据。

---

## 一、 云端基础设施全景资产总账 (Assets Ledger)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                     【Cloudflare Serverless 边缘云脑资产全貌】                   │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 1. 账号体系                                                                      │
│    • 归属账号：Shadow.lover@live.cn's Account                                    │
│    • Account ID：3d11a910907ee5175e7f807cd34a2ada                                │
│    • 托管母域 (Zone)：prismos.org (Zone ID: 94207aa1bfe9927a37fdc4a8bada2975)    │
│    • 服务二级主域：play.prismos.org (CNAME 代理解析至 prismos.org, 橙色小云朵开启)│
├──────────────────────────────────────────────────────────────────────────────────┤
│ 2. 计算与路由 (Workers)                                                          │
│    • 服务名称：prism-play-edge                                                   │
│    • 兼容性日期：2026-09-01                                                      │
│    • 绑定路由：play.prismos.org/*                                                │
│    • 核心路由划分：App API 走 /api/*，静态页面走 / 与 /dl 与 /s/*，管理中枢走 /admin 与 /api/admin/* │
│    • 运行节点：亚太 APAC（主要调度大阪 KIX / 香港 HKG / 首尔 ICN 机房）           │
│    • 性能实测：冷启 ~4ms，全球边缘延迟平均 ≤15ms                                  │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 3. 分布式数据库 (D1)                                                             │
│    • 数据库名称：prism-play-db                                                   │
│    • Database UUID：e54f7f0b-1be7-4d40-89bd-b91c8faf576b                         │
│    • 存储格式：SQLite 分布式复制实例（亚太 APAC 主节点）                          │
│    • 表结构规模：38 张真实业务表 + 5 张 FTS5 全文索引影子表（0001~0007 增量迁移全覆盖） │
│    • 核心领域：内容与频道账本、会员与设备绑定、多端同步画像、线路健康遥测、运营后台与分析、共享发现与独立卡片库 │
│    • 当前数据规模：20,163 部全量聚合片单分片承载于 R2，D1 纯作为轻量核心账本、分析枢纽与共享发现账本│
├──────────────────────────────────────────────────────────────────────────────────┤
│ 4. 键值极速缓存 (KV)                                                             │
│    • 空间名称：prism-play-kv                                                     │
│    • Namespace ID：7a8d672743d6462f8d2ae13d9416f0da                              │
│    • 核心作用：毫秒级下发 `config:monetization` (商业策略) 与 `config:version`    │
├──────────────────────────────────────────────────────────────────────────────────┤
│ 5. 对象存储桶 (R2)                                                               │
│    • 存储桶名称：prism-play-releases                                             │
│    • 核心作用：存放 Android APK 编译交付物、未来 OTA 更新包与静态资产            │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、 环境变量与核心加密密钥系统 (Secrets & Cryptography)

云端与客户端基于 **Ed25519 非对称现代椭圆曲线** 建立完全单向的信任根基，严禁对称 HMAC 密钥流入客户端。

| 环境变量/密钥键名 | 存储形式 | 当前配置值 / 格式说明 | 核心职责与安全边界 |
| :--- | :--- | :--- | :--- |
| **`JWT_KID`** | 纯文本 | `p2026` | 密钥版本标识符，注入 JWS Header 用于客户端选定内置公钥。 |
| **`JWT_PRIVATE_KEY_JWK`** | 云端密文 | `{"key_ops":["sign"],"ext":true,"alg":"EdDSA","crv":"Ed25519",...}` | **Ed25519 生产私钥**。用于为卡密核销成功后的设备签发 JWT 授权令牌。**严禁泄露或打包进客户端**。 |
| **客户端配对公钥** | 端侧内置 | `x: "QdLReD6QICQGapTQbPaSyOjwwsOmEdoddIy4Nb8Ay84"` | 内置于 `src/core/identity/offline-grant.ts`。客户端仅凭公钥可离线 14 天验签档位，无法伪造授权。 |
| **`PRIVATE_SESSION_SECRET`** | 云端密文 | `544553542d414243442d454647482d30313233` | 个人探索会话 HMAC 密钥。用户在免责弹窗点击同意后签发短时会话凭据 `X-Private-Session`。**内存级，冷启动即焚**。 |
| **`PROXY_SIGNING_SECRET`** | 云端密文 | `30313233343536373839616263646566` | 受控媒体防盗链签名密钥。通过 AES-256-GCM 封装流媒体切片句柄，带 `exp` 与 `sig` 防重放与防外发。 |
| **`ADMIN_PASSWORD_HASH`** | 云端密文 | `pbkdf2-sha256:100000:<salt>:<hash>` | **管理员口令哈希**。10 万次 PBKDF2-SHA256 迭代计算，严防弱口令与彩虹表攻击；明文口令保存在项目根目录 `admin-access.local`。 |
| **`ADMIN_AUTH_VERSION`** | 云端密文 | `1`（正整数数值字符串） | **管理员会话全局版本门禁**。递增此值可强制全网已颁发的所有存量 `__Host-prism_admin_session` 会话瞬间失效。 |
| **`ANALYTICS_HASH_SECRET`** | 云端密文 | 256 位随机十六进制串 | **访客分析标识单向签名密钥**。服务端通过 HMAC-SHA256 生成 `visitor_hash`，数据库绝不保存原始 `p_vid` Cookie 明文。 |
| **`ANALYTICS_ENABLED`** | 纯文本变量 | `"true"` / `"false"` | **边缘统计写入全局熔断开关**。配置为 `"false"` 时，系统跳过所有异步聚合写与 Cookie 植入，作为防写放大紧急安全网。 |

---

## 三、 D1 数据库物理拓扑与核心表架构 (Database Schema)

D1 物理建表定义位于 `edge/migrations/0001_initial_schema.sql`，全量部署 20 张业务表：

### 1. 核心表职责映射表
- **`channels` (频道拓扑表)**：云端下发 `drama`（短剧精选）、`movie`（院线电影）、`anime`（热血动漫）、`documentary`（人文纪录）与 `private`（个人探索）；
- **`content_items` (内容主表)**：存储剧目 ID、频道归属、剧名、简介、分类标签、封面版本与发布状态；
- **`content_episodes` (剧集分集表)**：存储分集号（1~N 集）、集标题、持续时间；
- **`episode_sources` (分集播放源表)**：关联抽象源 `provider_id` 与加密前的真实上游流媒体地址（仅服务端持有）；
- **`source_providers` (来源白名单与巡检表)**：定义上游节点名称、通道、真实域名、优先级与探测延迟，**防 SSRF 白名单基准**；
- **`card_coupons` (卡密台账表)**：预制卡密库（Q 季卡、A 普通卡、B 高级卡、Y 年卡、S 极客卡），记录有效期、核销设备数；
- **`coupon_bindings` (设备绑定表)**：卡密与设备物理 ID 的一对多幂等绑定记录；
- **`devices` (激活设备表)**：终端设备 ID、激活档位、最后活跃时间；
- **`cloud_watch_history` (多端观看历史表)**：以 `(coupon_code, content_id)` 为复合主键，记录会员在手机/TV/PC间接力续播的最新分集与时间戳；
- **`cloud_user_profile` (多端偏好画像表)**：以 `coupon_code` 为主键，记录多端共享的 21 题材偏好得分向量 JSON 与总播放次数；
- **`public_search_fts` (FTS5 虚拟全文检索表)**：中文 CJK 原生倒排分词索引表，纯 SQLite 词法计算，无需外部 AI 大模型；
- **`line_health_signals` (线路健康遥测表 · 0003 增量)**：客户端播放失败（timeout / http_error / decode_error）自动上报账本，服务端只写不读；
- **`analytics_daily` (每日访问与转化聚合表 · 0004 增量)**：以 `(day, surface, channel, terminal)` 为复合主键，原子累加页面访问与下载触发；
- **`analytics_visitors` (匿名访客档案表 · 0004 增量)**：仅在用户同意后以 `visitor_hash`（HMAC 摘要）为主键记录首访日与首访渠道；
- **`analytics_visitor_days` (按日去重事实表 · 0004 增量)**：以 `(day, visitor_hash, surface)` 记录按日页面浏览与下载触发布尔事实，支撑跨日去重 UV 与转化率交集；
- **`admin_sessions` (后台管理会话表 · 0004 增量)**：以 `token_hash` 为主键，记录 12 小时到期的管理员会话与绑定的 CSRF 摘要；
- **`admin_login_limits` (管理员登录防爆破限流表 · 0004 增量)**：按来源 IP 哈希记录 15 分钟窗口内的失败尝试与锁定到期时间；
- **`coupon_batches` (卡密批次生产台账表 · 0004 增量)**：以唯一 `request_id` 记录每批卡密生成指令，保证网络重试绝对幂等；
- **`admin_audit_logs` (运营敏感操作审计日志表 · 0004 增量)**：记录卡密生成、全码查看、确认库存、确认分发及停止核销的不可篡改流水；
- **`card_coupons` 扩展字段 (`0004` 增量)**：扩展 `batch_id`、`dispatch_status` (`UNKNOWN`/`IDLE`/`DISPATCHED`)、`dispatch_note`、`dispatched_at`、`dispatch_request_id`，实现分发状态与核销状态解耦。

### 2. 数据库级三大刚性安全约束 (CHECK 铁律)
1. **私密内容物理封死外发 (R-1 彻底闭环)**：
   ```sql
   CHECK((channel_id = 'private' AND is_private = 1 AND shareable = 0) OR (channel_id <> 'private' AND is_private = 0))
   ```
   *作用：数据库引擎底层拒绝任何 `is_private=1` 但 `shareable=1` 的写入，从物理层阻断私密剧目外发分享。*
2. **卡密 10 台家庭共享上限原子条件更新**：
   ```sql
   UPDATE card_coupons 
   SET device_count = device_count + 1 
   WHERE code = ? AND status IN ('UNUSED','ACTIVE') AND device_count < max_devices;
   ```
   *作用：D1 无交互式事务，通过 `device_count < 10` 条件更新返回的受影响行数决定第 11 台设备熔断拒绝，杜绝并发超兑。*
3. **卡密手动分发与认领原子对账 (NOT NULL Trip-Wire 约束)**：
   ```sql
   -- 分发更新与审计插入置于同一 D1 batch 内，未命中则触发 NOT NULL 回滚
   UPDATE card_coupons
   SET dispatch_status = 'DISPATCHED', dispatch_note = ?, dispatched_at = ?, dispatch_request_id = ?, updated_at = ?
   WHERE code = ? AND dispatch_status = 'IDLE' AND device_count = 0 AND status <> 'REVOKED';
   ```
   *作用：确保只有空闲、未绑定且未作废的卡密才能被标记分发，多人争抢同一卡密时仅一人成功，败者整批回滚且不残留虚假成功审计。*

---

## 四、 定时任务与健康度调度引擎 (Scheduled Cron Trigger)

- **调度配置**：`edge/wrangler.toml` 中的 `[triggers] crons = ["0 4,16 * * *"]`；
- **计时口径**：**Cloudflare 严格以 UTC（世界协调时）计时**；
  - `04:00 UTC` = **北京时间 12:00（中午）**；
  - `16:00 UTC` = **北京时间 00:00（午夜次日）**；
- **每日 2 次巡检执行逻辑 (`edge/src/index.ts` -> `scheduled`)**：
  1. 遍历 `source_providers` 中的可用播放源，按栏目分批发起轻量 HEAD / GET 测速探针并更新延迟；
  2. 执行 `pruneExpiredRevocations`：自动清理 `private_session_revocations` 撤销表中过期的会话墓碑；
  3. 执行 `cleanupAnalytics`：自动执行按主键索引的限量数据留存清理（90天去重明细、180天访客、365天统计与审计、过期管理员会话、24小时限流窗口），单表单次硬顶 1,000 行，零写风暴；
  4. **绝不抓取或存储任何视频文件实体**，仅流转地址与必要元数据。

---

## 五、 网络跨域 (CORS) 与受控媒体代理链路 (Proxy Pipeline)

### 1. 移动端跨域 (CORS) 统一响应通道
由于 Android 原生 WebView 的应用源为 `https://localhost`，请求 `https://play.prismos.org` 时必须跨域。  
`edge/src/index.ts` 内置了全局 `withCors` 拦截管道：
- **`OPTIONS` 探测**：一律以 `HTTP 204 No Content` 极速放行，携带 `Access-Control-Max-Age: 86400`（浏览器缓存 24 小时预检）；
- **响应头标准**：
  ```http
  Access-Control-Allow-Origin: https://localhost
  Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
  Access-Control-Allow-Headers: Content-Type, Authorization, X-Private-Session, Range
  Access-Control-Expose-Headers: Content-Range, Accept-Ranges, Content-Length
  ```

### 2. 受控媒体代理两路工作模型
- **封面图片代理 (`GET /proxy/img/{content_id}`)**：
  - 客户端通过内容 ID 寻址，边缘根据 `cover_version` 计算并回写强 `ETag: "img-xxx-v1"`；
  - `Cache-Control: public, max-age=300`，支持 304 极速重协商，不向客户端暴露真实图床源地址；
- **流媒体切片代理 (`GET /proxy/media/{handle}?exp=&sig=`)**：
  - 加密句柄封装真实流地址，边缘实时重写 HLS `.m3u8` 清单；
  - 为子分片（`.ts` / `.m4s`）动态签署相同生命周期的签名子 URL；
  - 完美支持 HTTP Range (206 Partial Content) 断点拖拽快进快退，无内存堆积。

### 3. 管理后台与全链路分析路由隔离模型
为了在单一 Worker 内交付管理控制台，同时 100% 避免破坏 App 前台的 CORS 与凭据管道，系统采用前置硬路由拦截模型：
- **前置拦截点 (`edge/src/index.ts` -> `default.fetch`)**：
  在进入公共 `routeRequest` 与 `withCors` 之前，优先判断路径是否以 `/admin`、`/api/admin` 开头，直接分发至 `handleAdminRequest`；
- **同源严格防护**：
  管理请求绝不套用 `withCors`，绝不向外部跨域反射任何 `Access-Control-Allow-*` 响应头，绝不接收任何 App Bearer JWT；
- **安全头体系**：
  所有管理响应统一注入：
  ```http
  Cache-Control: no-store
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'
  ```

---

## 六、 常用运维命令与数据操作手册 (Runbook)

所有云端操作均可在本地工程根目录直接执行，无需登录 Cloudflare 网页后台：

### 1. 边缘代码部署与调试
```bash
# 进入云端工程目录
cd D:\DEV\prism-play\edge

# 本地无云模拟运行调试 (本地 D1/KV 沙箱)
npx wrangler dev

# 生产环境一键编译与热部署发布 (秒级推送到全球 300+ 边缘机房)
npx wrangler deploy

# 查看云端实时运行日志流水 (Tail Logs)
npx wrangler tail
```

### 2. D1 数据库在线管理与查询 (Remote D1)
```bash
# 查询当前数据库表列表 (30 张业务表)
npx wrangler d1 execute prism-play-db --remote --command "SELECT name FROM sqlite_master WHERE type='table';"

# 查询全部频道及当前片单统计
npx wrangler d1 execute prism-play-db --remote --command "SELECT channel_id, count(*) as count FROM content_items GROUP BY channel_id;"

# 查看卡密库存分发状态统计
npx wrangler d1 execute prism-play-db --remote --command "SELECT tier, status, dispatch_status, count(*) as count FROM card_coupons GROUP BY tier, status, dispatch_status;"

# 查看最近管理员敏感操作审计日志
npx wrangler d1 execute prism-play-db --remote --command "SELECT id, action, target_hash, datetime(created_at, 'unixepoch', '+8 hours') as bj_time FROM admin_audit_logs ORDER BY id DESC LIMIT 10;"

# 查看近 7 天每日访问与下载统计
npx wrangler d1 execute prism-play-db --remote --command "SELECT day, sum(requests) as req, sum(downloads) as dl FROM analytics_daily GROUP BY day ORDER BY day DESC LIMIT 7;"
```

### 3. 管理员口令与运营应急维护
- **本地口令凭据获取**：读取工程根目录 `D:\DEV\prism-play\admin-access.local`。
- **全网管理员会话一键失效**：
  ```bash
  cd D:\DEV\prism-play\edge
  npx wrangler secret put ADMIN_AUTH_VERSION
  # 输入新的版本号（如 2）并确认
  ```
- **生产数据库灾备书签回滚 (Time-Travel Restore)**：
  ```bash
  cd D:\DEV\prism-play\edge
  npx wrangler d1 time-travel restore prism-play-db --bookmark=000000aa-00000002-000050fb-6181c2a3c9b29b64c4a1c8ec99dc6aae
  ```
- **详细运营与卡密发卡 SOP 手册**：详见《光影Play管理后台与卡密运维操作手册》(`docs/04-spec/ADMIN-OPERATION-MANUAL.md`)。

### 3. 如何在云端快速上架一部新剧目 (SQL 样板)
```sql
-- 1. 确保源提供商在白名单中 (若不在先插入 source_providers)
INSERT OR IGNORE INTO source_providers (id, name, channel_id, upstream_url, priority, latency_ms, healthy, last_checked_at, created_at, updated_at)
VALUES ('provider_hls', '全景流媒体节点', 'drama', 'https://test-streams.mux.dev', 1, 10, 1, strftime('%s','now'), strftime('%s','now'), strftime('%s','now'));

-- 2. 插入剧目主信息 (例如短剧精选)
INSERT OR REPLACE INTO content_items (id, channel_id, title, cover_url, cover_version, synopsis, category, is_private, shareable, enabled, first_published_at, created_at, updated_at)
VALUES ('drama_new_001', 'drama', '九霄龙吟惊天变', 'https://images.unsplash.com/photo-1536440136628-849c177e76a1?w=400', 'v1', '潜龙在渊，一朝入世震九霄！', '战神', 0, 1, 1, strftime('%s','now'), strftime('%s','now'), strftime('%s','now'));

-- 3. 插入第 1 集与媒体源
INSERT OR REPLACE INTO content_episodes (id, content_id, episode_number, title, duration_seconds, created_at, updated_at)
VALUES (101, 'drama_new_001', 1, '第1集：潜龙出渊', 120, strftime('%s','now'), strftime('%s','now'));

INSERT OR REPLACE INTO episode_sources (episode_id, provider_id, upstream_media_url, enabled, created_at, updated_at)
VALUES (101, 'provider_hls', 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8', 1, strftime('%s','now'), strftime('%s','now'));
```

### 4. 批量内容清洗导入与全网刷新工序 (流水线自动化)
针对大批量片单扩充与多频道更新，工程提供全自动清洗与导入工具：
```bash
# 进入云端目录
cd D:\DEV\prism-play\edge

# 运行采集清洗与 SQL 生成器 (自动从成熟验证源拉取 1080P HLS 与海报并做 CJK 分词)
"C:/Users/Master/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" scripts/seed-runner.mjs

# 一键灌装进线上远程 D1 数据库 (自动更新 items, episodes, sources, FTS5 与 catalog_changes)
npx wrangler d1 execute prism-play-db --remote --file=scripts/seed-data.sql
### 5. 多端状态同步与无人值守追新管线
```bash
# 1. 回填与重算客观 HotScore 与 AI 短剧标定
node edge/scripts/compute-hotscore.mjs
cd edge && npx wrangler d1 execute prism-play-db --remote --file=scripts/backfill-hotscore.sql

# 2. 本地触发增量追新采集与入库测试
node edge/scripts/sync-incremental.mjs
cd edge && npx wrangler d1 execute prism-play-db --remote --file=scripts/sync-incremental.sql

# 3. 生产环境由 GitHub Actions 每日凌晨 03:00 (UTC 19:00) 自动无人值守执行
#    详见工作流定义：.github/workflows/content-sync.yml
```
*详见专门事实正本：《大视界内容拓扑、分类规范与数据运维事实正本》(`docs/02-architecture/CONTENT-CATALOG-FACTS.md`) 与《云端多端同步中枢、JIT穿透引擎与定时追新工程规格书》(`docs/04-spec/CLOUD-SYNC-JIT-PIPELINE-SPEC.md`)。*

---

## 七、 技术演进与储备规划 (v2.1+ Backlog)

1. **边缘大模型推荐引擎 (Workers AI)**：
   - 储备调用 Cloudflare 免算力费用的开源大模型（DeepSeek R1 / Qwen 2.5 7B）；
   - 基于用户的本地历史，在边缘侧生成高度个性化的自然语言推剧理由。
2. **多语言与语义检索 (Vectorize + BGE-M3)**：
   - 演进接入 Cloudflare Vectorize 向量数据库，支持意图检索（如“类似狂飙的年代反黑剧”）；
   - 当前 v2.0 保持 D1 FTS5 零外部依赖，具备确定性与极低资源消耗。
