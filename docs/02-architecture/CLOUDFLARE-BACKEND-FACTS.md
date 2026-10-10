# 《光影Play》（Prism Play）Cloudflare 边缘云脑白皮书与事实正本 (CLOUDFLARE-BACKEND-FACTS.md)

2026-10-09 最小闭环已部署：Worker版本 `d8d63d31-9336-40a7-bc25-a5a36759d259`，APK公告2.6.6/21606、force=false。config:version.artifact对应R2不可变包，官网下载同域302→200，完整下载SHA `1dd650d62a34b1554d76a1bbd00b46ec93dac4cad730f160408da0f880e6d9b8`、36,379,585字节与验收包一致；config:announcements消息读取200。原绑定和密钥保留，不新增资源/D1表，不迁移重置数据库，未Git提交。回退基线为 `b5ba77bf-7980-4fcb-a43c-937f230e558d`，新旧不可变包保留；收据 `outputs/deploy266-live-receipt.json`。本次仅证明发布样本与下载正确，真机和长期网络表现仍待观察。

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
| **`AD_STRIP_ENABLED`** | 纯文本变量 | `"true"` / `"false"` | **广告清单清洗总开关**。与白名单同时成立才生效；关闭时清洗入口 302 回目标地址，行为与未部署完全一致（紧急熔断位）。 |
| **`AD_STRIP_TARGET_HOSTS`** | 纯文本变量 | `play.modujx17.com,bf.modujx17.com` | **清洗目标主机精确白名单**（逗号分隔、非子串匹配）。下发包裹端与入口路由共用同一份口径，半开状态在配置层就不可能发生。 |
| **`AD_STRIP_CONFIG`** | 纯文本变量（可选） | `{"dominantRatio":0.55,...}` | **判定引擎参数覆盖**（可选）。支持 `dominantRatio` / `repeatBlocks` / `maxBlockSeconds` / `maxSegments` / `maxBytes`；越界或损坏一律退回默认，不阻断播放。 |

---

## 三、 D1 数据库物理拓扑与核心表架构 (Database Schema)

D1 物理建表定义按序分布在 `edge/migrations/0001_initial_schema.sql` ~ `0007_discovery_cards.sql`：0001 首批部署 20 张业务表（下列职责映射即这一批），0002~0007 增量叠加后当前共 **38 张真实业务表 + 5 张 FTS5 影子表**，与 `npm run verify:contracts` 的实测口径一致（该门禁逐张断言表数，不是文案）。

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

### 4. 广告清单清洗入口（`GET /proxy/hls/clean?target=&work=`）
上游切片站会向 m3u8 清单里动态拼接赌博类推广切片（实测：广告块恒被 `#EXT-X-DISCONTINUITY` 包裹、单块 17.64s、跨剧逐字节复用、目录与正片完全不同）。本入口在云端实时剥离这类块，视频分片仍由客户端直连上游 CDN（零视频带宽、零转码）：
- **判定引擎（`edge/src/media/ad-stripper.ts`）**：五道闸门——格式安检 → 主流确认（累计时长占比 ≥ `dominantRatio`，默认 0.55）→ 少数派圈定 → 重复验证（同签名 ≥2 个独立块）→ 结构验证（存在 DISCONTINUITY 边界且单块 ≤45s）。任一道不过即原样放行，宁可漏杀绝不错杀；
- **校准依据**：短剧集正片占比实测 63%~80%（2 分钟正片夹 2 条广告），长剧集 98%+，故门槛取 0.55；真实加密（AES-128）与 `EXT-X-MAP` 的清单一律不动刀，`METHOD=NONE` 明文声明随段处置；
- **安全边界**：仅 https + 精确白名单主机；重定向逐跳复核、最多 2 跳；全程 8s 超时预算 + 响应体字节上限；清洗失败/解析放弃一律透传原清单；总开关关闭时 302 回目标；
- **下发口径**：`/api/titles/{id}` 仅对 `provider_m1` 的公开 `.m3u8` 线路包裹本入口并携带 `work` 参数（`edge/src/library/title-asset.ts`）；私密剧目与原生加密线路永不经过本入口；
- **审计（`edge/src/media/ad-strip-audit.ts`）**：每次实际剔除写入 KV `adstrip/audit/{ts}-{rand}`（30 天过期），记录作品、主机、块数、秒数、主流占比；本期只审计、不参与过滤决策。

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
# 查询当前数据库表列表（0007 之后为 38 张真实业务表 + 5 张 FTS5 影子表）
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

### 6. W3 服务端第一批：刷新协调与预算（2026-10-10，本地实现，未部署）

- 实现范围：`edge/src/search/discovery-refresh.ts` 查询租约30s、10s心跳、任务占用跟随查询租约；`discovery-query.ts` owner条件续租（过期不能复活），`discovery-jobs.ts` owner条件续期/释放。异常及时释放，进程中断后任务不再保留独立300s占用。
- 写入围栏：`discovery-store.ts` work发布锁30s，refresh传入父租约；发布前检查父owner，最终D1 `INSERT…SELECT` 同时校验work/parent owner与时效，再原子更新指针及changes。INSERT候选不成立则UPSERT也不会执行；失锁期间至多留下私有R2孤儿，不产生可读指针。撤片与原有timestamp+hash CAS保持。
- 预算同源：`discovery-budget.ts` 前台2请求/3000ms，后台24请求/25000ms；目前按**单次provider resolve**计，重定向与读体共用该预算。`discovery-cards.ts` 前台冷详情接预算；`s1-directory.ts`及生产registry不再忽略调用方预算。已知card的上游超预算/blocked进入title路由503，不伪装成功或未知404。
- refresh最多3个provider resolve并行，默认每批仍2部。初始化batch在单isolate内部串行，其他解析并发；该链不是跨isolate锁，真正互斥靠D1 owner条件。**本地测试适配器不能重叠batch，这不是生产D1要求所有批次串行。**
- **不能宣称完成的边界**：整轮DB/R2/provider墙钟deadline、共享provider累计请求池、jitter尚未施工；work发布锁暂无心跳，R2慢于30s安全拒写而非自动延长；旧`discovery-service.ts`查询300s锁仍残留。数据库校验使用提交前采样时间，不证明排队后实际执行时间仍未过期；已落库的owner接管/撤片仍被围栏拒写。
- 快速起播事实：生产S1一次目录得到全部videoId，M1一次详情得到全部播放组，未证实目标集独立上游接口；只缩小响应不等于冷详情获取已解耦。bootstrap候选只有lineSummary不足以起播，实施时必须正式约定真实lines/native、索引、事实版本、pending与后台任务；本批未新增路径或后台完整事实任务。
- 本地验证：SQLite真实迁移与可控R2/provider夹具，失锁发布先Red后Green；续租/重领/心跳清理/并发发布/前台预算/S1贯通回归，云端73套800项过。P0、Edge类型与契约绿；无生产请求/部署/迁移/新资源，旧API路径和表数未增。
- 运维/回退：线上保持原版本，不执行release。后续获部署授权后按标准流水线；排查先分辨lease key/owner/expiry、job lease_until及失败冷却，不人工删生产锁绕过条件。回退代码不删schema或事实对象；本地新增回归保留。工作包状态与下一动作以计划§10.3为准。

### 7. W3 bootstrap 与后台完整事实（2026-10-10，本地实现，未部署）

- 新入口 `GET /api/titles/{titleId}/bootstrap?ep=1..5000`；只ep且最多一次，非法/注入400，不存在/未准入/缺目标同构404，空线路/目录切代/临时失败503，所有响应no-store。响应schema1、目标实际线路(保持lineIndex)、item、公开revision、完整title投影SHA256 factVersion、generatedAt/servedAt、catalogStatus=complete、persistenceStatus=stored/scheduled。
- 准入沿用handleTitles完整事实验证和私密双准入；新增可选resolveCard接缝仅供bootstrap从已核验全目录RAM读。`discovery-prepared.ts`身份/完整性验证后再核候选，发布前再核；store最终D1匹配candidate_json，删除/替换发生在上传中也阻止旧pointer。cold authority每次从KV重读目录，返回前若公共revision已变则503，下次重新按新代查，不返回旧target。
- complete表示已读取核验全目录，不表示所有视频已解码。scheduled只表示ctx.waitUntil登记背景发布，不保证持久化；失败不产生新pointer，客户端完整title读取须可重试。无ctx冷结果503，不同步持久化冒充非阻塞。原生native-playback生产ctx复用bootstrap，仍由服务端选目标与线路，不接受客户端videoId；背景未完成时可能重复目录fetch，不能宣称所有重复网络已消除。
- 真实收益仅“目标响应小+前台不等待R2写入”；现有S1/M1仍一次抓取完整目录/详情，后台不是虚构新上游单集协议。RAM核验未发布不构成内容授权依据，继续现行准入，不新增DRM处理或密钥返回。
- 回归入口tests/edge/w3-bootstrap.test.ts：slow-R2 gate先200后背景完成旧title兼容、发布失败不冒称stored、原生复核不等慢写、卡片上传期删除、warm读中revision变化503、未准入私密同构、空lines503、非法参数400；只本地SQLite/R2/provider固定夹具，未真实边缘验证。
- 运行/回滚：本批无新表/资源；部署仍等待整个最小核心出口及标准review/全量门禁/旧版本回滚记录。Master05:09已给条件式Worker部署授权，达出口后不重复询问；不包含官网APK指针/公告发布。出现bootstrap异常可让新APP退旧完整title，旧APP请求路径未变；不得删除完整事实补救。具体部署ID和生产回执须实际部署后补入，当前为空。

### 8. W3公开元数据预热（2026-10-10，本地未部署）

- POST `/api/titles/{titleId}/prefetch`仅公开作品（私密即使有效双准入也404，不进入后台存储），严格requestId/episodeNumbers/reason三键、JSON原始体4KiB流式限额、最多4个唯一1..5000集且窗口跨度≤3。200表示现存完整目录已就绪且不触上游；202只表示waitUntil登记或合并，不承诺预热成功/可播放。
- 防放大：平台CF-Connecting-IP摘要为caller，每60s最多12请求（ready同样计数）、超限429 Retry-After；同work原子30s租约合并、每work+episode30s窗口去重；后台10s心跳且续租MAX不缩短。预热限流独立于兑换限流，复用discovery_rate_windows，无新表。
- 后台只请求目录元数据；复用prepareCardDetail完整公共身份/集数/线路校验，24请求/25s单provider预算。登记失败不启动fetch；无ctx冷请求503。发布检查当前候选、当前manifest authority、父owner以及最终D1候选JSON+NOT EXISTS disabled，防在途旧任务复活已撤回条目；失败/清理异常记录类别日志，TTL最终回收。
- 禁止夸大：后台不是durable队列，KV authority和D1提交不是跨存储原子；IO整体hard deadline、shared budget/jitter、资源/SWR治理未完成。私密后台不存；metadata-ready不是RAM媒体缓存，也不是视频预下载，分片不经本入口。
- 证据：w3-prefetch18项(真实SQLite迁移、可控provider/R2、分块超4KiB取消、有效私密凭证也拒绝、ready/cold限流、登记失败、后台失败)，publication追加disabled不复活、lease追加乱序续期不缩短均先Red后Green；云端75套836项过，最后新增单调续租45项专项过，前端/edge类型/契约31路径/P0552绿。部署ID仍无。
- 运维回退：无生产变更；当前无需迁移。日后部署后观察prefetch失败类别与429、owner过期、实际目录请求数；不得把accepted作为播放成功统计。回退Worker时旧完整title继续用，不清历史/事实。APP70%探针接线未施工，计划TODO保留。

## 七、 技术演进与储备规划 (v2.1+ Backlog)

1. **边缘大模型推荐引擎 (Workers AI)**：
   - 储备调用 Cloudflare 免算力费用的开源大模型（DeepSeek R1 / Qwen 2.5 7B）；
   - 基于用户的本地历史，在边缘侧生成高度个性化的自然语言推剧理由。
2. **多语言与语义检索 (Vectorize + BGE-M3)**：
   - 演进接入 Cloudflare Vectorize 向量数据库，支持意图检索（如“类似狂飙的年代反黑剧”）；
   - 当前 v2.0 保持 D1 FTS5 零外部依赖，具备确定性与极低资源消耗。

---

## 八、 生产部署履历与回滚快照

- **2026-10-10 16:49 阶段一部署**：
  - 部署版本：`a05be1a0-d74c-479b-abbf-d08c43665117`
  - 部署前服务buildId留档：`c3941935-a785-47a0-81fb-5f6884bf0986`；实际回滚需先核验Cloudflare版本/部署列表的可用目标，不将服务响应ID直接当作已经演练的一键回滚证明。
  - 部署内容：W3 服务端（30s 刷新租约续期、失锁原子发布围栏、前后台双轨预算、`/api/titles/{id}/bootstrap` 快速当前集起播、`/api/titles/{id}/prefetch` 邻集元数据预热）
  - 生产冒烟验证：7 项端点全绿（版本状态 200、四频道 200、旧详情 `/api/titles/:id` 200 向下兼容、新起播 `/bootstrap` 200、新预热 `/prefetch` 200、广告清洗 `/proxy/hls/clean` 400 校验正常、私密边界 `/api/catalog?channel=private` 404 隔离正常）。
  - 结论（修订1.2校准）：已实现三批子集接口可达；单样本详情200及无参清洗400不证明旧APK全面播放/授权/广告净化无退化。旧动态详情3s预算兼容补验、W3剩余机制与真机验收仍未完成，见计划§4.7/§10.3.1。
