# 《光影Play》（Prism Play）云端多端同步中枢、JIT穿透引擎与定时追新工程规格书 (CLOUD-SYNC-JIT-PIPELINE-SPEC.md)

> **版本**：v2.2（按 `AUDIT-CLOUD-SYNC-JIT-SPEC-2026-10-03.md` 复审报告修正后版本）  
> **生效日期**：2026-10-03  
> **维护主体**：Master_流光逸影 (战略定案) & MVP开发专家团 (云端专员全栈闭环)  
> **服务主域**：`https://play.prismos.org`  
> **文档属性**：云端施工与验收法定依据（施工前必须先满足 §七「施工前置门禁」全部条件）  
> **修订说明**：本版针对独立复审报告的 A-1~A-14 逐条修正。其中**模块三（JIT 穿透）已按 A-4 降级为待决策项**，未获 `ADR-006` 批准前禁止施工。

---

## 一、 业务场景与系统边界

### 1.1 业务诉求
1. **多端家庭互联（手机 / TV / PC 接力）**：会员卡密天然支持最多 10 台设备共享（`card_coupons.max_devices BETWEEN 1 AND 10`）。用户凭同一卡密在任一端继承观看断点与题材偏好画像，免除手机号注册与密码验证。
2. **AI 剧战略倾斜与大盘支撑**：云端标定客观形式与热度属性（`is_ai`、`is_hot`、`hot_score`），为端侧 3.5(AI) : 3.5(热门) : 3(探索) 混排提供权威基准。
3. **海量长尾覆盖**：不做全量静态镜像，改为按需沉淀。

### 1.2 身份锚点（A-1 修正 · 本文件最关键的定义）

**必须澄清的事实**：JWT 凭据中**不存在** `couponCode` 字段。`edge/src/auth/jwt.ts:56-72` 的 `buildClaims()` 实际声明的 claims 仅有：

```ts
{ iss, aud, sub /* = deviceId */, tier, exp, iat, jti }
```

因此同步身份锚点**必须**由服务端按以下链路解析，规格书不允许其他写法：

```
Authorization: Bearer <Ed25519 JWT>
  → auth/guard.ts authenticate() → claims.sub = deviceId
  → SELECT bound_coupon FROM devices WHERE device_id = ?
  → card_coupons.code
```

**换绑语义（A-1 衍生问题 · 必须显式定义）**：`devices.bound_coupon` 的语义是「**最近一次**绑定的预制卡密代码」，续费换卡时会被新卡密覆盖。本规格书裁定：

- 同步域以 **`devices.bound_coupon` 的当前值**为准，即同一设备换绑新卡密后，其后续同步跟随新卡密；
- 旧卡密下的历史**不迁移、不删除**（保留在旧 `coupon_code` 名下；若该卡密仍被其他设备使用，历史仍然可见）；
- 该行为登记为**已知边界**：用户换卡后在新卡密域内首次同步时，此前的记录不会自动出现。

### 1.3 私密内容不同步（产品理由，非假想合规铁律）

`is_private = 1`（个人探索）内容**永不进入云端同步链路**。

**理由属于产品与体验层面，且是硬性的**：一张卡密允许最多 10 台设备共享，实际场景包含客厅大屏电视。若私密内容被同步到云端，家庭成员在电视首页的续播卡上会直接看到该内容 —— 这是用户体面的问题，与是否「合规」无关。因此该限制是**产品设计选择**，不是外部强加的教条。

### 1.4 未激活设备

`devices.bound_coupon` 允许为 `NULL`（未核销卡密的试用设备）。此类设备**不参与**云同步，且服务端必须**显式拒绝**（A-10），不得依赖外键约束抛错。

---

## 二、 模块一：多端云同步中枢 (User Sync Hub)

### 2.1 D1 迁移（新建 `edge/migrations/0002_user_sync_schema.sql`）

```sql
-- 多端同步观看断点：主键 (coupon_code, content_id) 保证单剧单行、幂等覆盖
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

-- 多端同步用户偏好画像：每卡密唯一一行
CREATE TABLE IF NOT EXISTS cloud_user_profile (
    coupon_code TEXT PRIMARY KEY REFERENCES card_coupons(code),
    preferences_json TEXT NOT NULL CHECK(json_valid(preferences_json)),
    total_plays INTEGER NOT NULL DEFAULT 0 CHECK(total_plays >= 0),
    updated_at INTEGER NOT NULL
);
```

> **约束说明**：两表均**不带 `ON DELETE CASCADE`**。私密内容在服务端**写入前**即被拒绝（见 §2.3），因此表中不可能出现 `is_private = 1` 的行。

### 2.2 端点契约（新增 `GET` / `POST /api/user/sync`）

**认证**：必须复用 `edge/src/auth/guard.ts` 的 `authenticate()`。凡 `status !== 'ok'` 一律返回 `401 Unauthorized`，不得泄漏差异原因。

**`POST /api/user/sync` 请求体**：
```json
{
  "history": { "contentId": "...", "episodeNumber": 12, "positionSeconds": 145.5, "durationSeconds": 300.0 },
  "preferences": { "genres": { "战神": 24.5, "逆袭": 18.0 }, "totalPlays": 48 }
}
```
- `history` 可为 `null`（仅退出程序、当时无播放）；
- `preferences` 恒必填；服务端须校验 `totalPlays` 为非负整数、`genres` 各值均为有限非负数。

**`GET /api/user/sync` 响应体**：
```json
{
  "history": [ { "contentId": "...", "episodeNumber": 12, "positionSeconds": 145.5, "durationSeconds": 300.0, "updatedAt": 1790945000 } ],
  "preferences": { "genres": { "战神": 24.5 }, "totalPlays": 48, "updatedAt": 1790945000 }
}
```
- `history` 最多返回 50 条，按 `updated_at DESC` 排序。

### 2.3 服务端处理顺序（A-3 修正 · 反探测侧信道闭合）

**这是本模块唯一的正确实现顺序，不得调换：**

```
1. authenticate() → status !== 'ok' 一律 401
2. 解析 coupon_code：SELECT bound_coupon FROM devices WHERE device_id = ?
   → 为 NULL 或查不到卡密 → 返回 200 { success: true }（与成功同形，不写库、不报错） [A-10]
3. 若 history 非 null：
   a. SELECT is_private, channel_id FROM content_items WHERE id = ?
   b. 行不存在 或 is_private = 1 或 channel_id = 'private'
      → 直接返回 200 { success: true }，不写库、不抛错  【必须先于任何 INSERT】     [A-3]
   c. 否则 INSERT OR REPLACE INTO cloud_watch_history (...)
4. UPSERT cloud_user_profile
5. 统一返回 200 { "success": true, "syncedAt": <now> }
```

**A-3 反探测要求的可测化断言**：以下三种输入必须产生**字节完全一致**的响应（状态码、响应体、`Content-Type` 均相同）：

| 输入情形 | 期望响应 |
| :--- | :--- |
| 不存在的 `contentId` | `200` + 标准成功响应字节 |
| 真实存在且 `is_private = 1` 的 `contentId` | `200` + **完全相同的字节** |
| 真实公开的 `contentId` | `200` + 标准成功响应字节 |

理由：若"不存在"走外键异常而"存在但私密"走静默分支，两者响应即可区分，构成对私密作品存在性的探测通道，违反 AC-02-3。参考 `tests/edge/70-catalog.test.ts` 中 `NOT_FOUND_BYTES` 的既有做法。

### 2.4 限流（A-8 修正 · 必须实现）

`POST /api/user/sync` **必须**接入限流。否则单卡密 10 台设备被脚本刷写即可打穿 D1 免费层 100,000 行/日的写入上限，导致**全站数据服务不可用**（D1 超限后所有查询被拒绝）。

- **限流键**：`deviceId`（非 IP —— 家庭共享下多设备常在同一出口 IP）；
- **窗口与上限**：`windowSeconds = 300`，`maxAttempts = 20`，复用 `edge/src/core/rate-limit.ts` 的 `createKvRateLimiter`；
- **超限响应**：必须复用既有闭集错误码（`ErrorResponse.code` 为受控 enum，不得新增未登记成员）；
- `GET` 端点同样限流（`maxAttempts = 60` / 300s），避免被用于高频拉取。

### 2.5 客户端合并规则（A-9 修正 · last-write-wins）

偏好画像**不得无条件覆盖**本地值。云端存的是上报时刻的**静态快照**，而本地画像是 7 天半衰期**实时衰减**的动态值；无条件覆盖会抹掉本地更新的偏好。

**合并判据**：
1. `GET` 返回的 `preferences.updatedAt` **大于**本地画像 `updatedAt` → 采用云端值；
2. 否则**保留本地值**，并在下一次离场上报时把本地值写回云端；
3. 观看断点：按 `contentId` 逐条比较 `updatedAt` 取较新者，**不做整表替换**。

**已知边界**：跨端画像最多滞后一个同步周期，期间各端画面可能略有差异。此边界须写入客户端交付说明。

---

## 三、 模块二：客观热度与 AI 剧标定 (HotScore & AI Tagging)

### 3.1 数据前置（A-5 修正 · 当前不可施工）

**核验事实**：`edge/scripts/process-harvest.mjs` 生成的批次仅写入 `vod_id / vod_name / vod_pic / vod_content / vod_play_url`，**未提取任何点击量字段**。因此 `HotScore` 公式在现有 D1 数据中**没有可用输入**。

**模块二拆为两阶段，Phase 2-A 完成前禁止实施 Phase 2-B：**

- **Phase 2-A（数据前置 · 必做）**：
  1. 扩充 harvest 脚本，从上游提取 `vod_hits_week` / `vod_hits`（字段名以上游实际返回为准，实施时须打印原始 JSON 核验）；
  2. 在 `content_items` 增加 `hits_week INTEGER NOT NULL DEFAULT 0` 与 `hits_total INTEGER NOT NULL DEFAULT 0`；
  3. 回填现有 8,874 部作品（可复用本地 `edge/cache/harvest/*.json` 快照，**无需重新抓取网络**）。
- **Phase 2-B（标定与透传）**：仅在 2-A 完成后启动。

### 3.2 HotScore 口径

$$HotScore = \log_{10}(hits_{week} + 1) \times 0.6 + \log_{10}(hits_{total} + 1) \times 0.2 + RecencyBoost$$

- `RecencyBoost`：`first_published_at` 落在 72 小时内的作品 `+0.8`；
- **`is_hot` 判定**：得分排名前 15% 置 1；
- **计算时机**：作为 Cron / Actions 批次任务的计算步骤，**不在请求路径上实时计算**。

### 3.3 `is_ai` 标定

命中以下任一特征置 `is_ai = 1`：上游 AI 漫剧专区（如 `type_id = 42`）、标题或简介命中 `AI漫剧 / AI短剧 / 虚拟人`、来源 Provider 登记为 AI 专线。

### 3.4 字段落地的 5 处必改点（A-6 修正 · 缺一即空转）

| # | 文件 | 改动 |
| :---: | :--- | :--- |
| 1 | `edge/migrations/0002_user_sync_schema.sql` | `ALTER TABLE content_items ADD COLUMN is_ai INTEGER NOT NULL DEFAULT 0 CHECK(is_ai IN (0,1));`（`is_hot`、`hot_score`、`hits_week`、`hits_total` 同） |
| 2 | `edge/src/db/content-repo.ts` | `ContentRow` 接口 + `CONTENT_SELECT` 字段列表 |
| 3 | `edge/src/types/api.ts` | `ContentItem` 接口新增 `isAi?: boolean; isHot?: boolean;` |
| 4 | `edge/src/http/serialize.ts:46` | `toContentItem()` 内按既有 `optional()` 模式条件赋值 |
| 5 | `docs/03-contracts/openapi.yaml` | `ContentItem` schema 同步 |

> **A-6 附带核实（有利结论）**：`tests/scan_p0.py:50-55` 的 `AI_TERMS` 正则仅拦截 `workers-ai / vectorize / bge-m3 / embeddings / 语义检索 / 向量`，**不拦截 `is_ai` 或前端 `AI精品` 文案**。模块二与海报角标**不触 M-5 红线**，已实测确认。

---

## 四、 模块三：JIT 穿透搜索（A-4 修正 · 已降级为待决策项）

### 4.1 当前状态：禁止施工

**冲突核验**：`edge/src/index.ts:109-113` 的既有架构声明为不可动摇前提：

> "Ingestion is adapter-injection only: **the Worker performs no upstream call and knows no URL**."

本模块原始设计要求 `/api/search` 在本地未命中时由边缘直连上游接口，这将：

1. 使 Worker 首次持有硬编码上游域名，推翻"上游身份零暴露"前提；
2. 使 openapi 中**免认证**的 `/api/search` 成为**免鉴权的开放出网代理**，被刷量时消耗我们的 Workers 请求配额；
3. 未经 ADR 流程即推翻既有架构前提，违反 `AGENTS.md` 二·4「文档即契约」。

### 4.2 放行条件（全部满足方可施工）

1. `docs/02-architecture/ADR-006-jit-upstream-search.md` 起草并获 Master 明确批准；
2. 穿透出网必须**复用** `edge/src/media/upstream.ts` 的 `assertAllowedTarget()` 与 `source_providers` 白名单（经 `listAllowedUpstreamOrigins()`），**不得新开绕过 SSRF 防护的旁路**；
3. 必须携带 1.5s 硬超时熔断（`AbortSignal.timeout(1500)`）、5 分钟空值负缓存、以及按 IP 的独立限流配额；
4. 去平台化的取证口径（日志与响应体中不得出现上游源名）须在 ADR 中写明。

### 4.3 保留的设计意图（待 ADR 通过后实施）

- 搜索阶段**只查不存**；
- 用户点击起播时（`/api/titles/:id` 或 `/api/episodes/:id/playback`）触发**惰性原子沉淀**，写入 `content_items` / `content_episodes` / `episode_sources`，并将媒体 Origin 追加至 `source_providers`。

---

## 五、 模块四：GitHub Actions 无人值守定时增量追新

1. **工作流**：`.github/workflows/content-sync.yml`，`schedule` 为 `cron: '0 19 * * *'`（UTC 19:00 = 北京时间次日 03:00）；
2. **运行环境**：`ubuntu-latest`，规避 Workers 50ms CPU 限制；
3. **工序**：增量抓取当日更新 → 映射 21 双字分类 → CJK 分词 → 批量写入 D1 → 签发自增 `public_catalog_changes` 修订号；
4. **约束**：单次运行写入行数须打印并**留档校验**，确保不与当日其他批次叠加越过 100,000 行/日上限。

---

## 六、 门禁与契约连带改动清单（A-2 / A-7 修正 · 施工必须先做）

**规格书新增 2 张表与 1 个端点（含 2 个 method），必须同步以下全部位置，缺一即门禁失败：**

| # | 位置 | 当前值 | 目标值 |
| :---: | :--- | :--- | :--- |
| 1 | `tests/verify_contracts.py:86` | 业务表期望 `20` | 改为 `22` |
| 2 | `tests/verify_contracts.py:74` | **只读** `0001_initial_schema.sql` | 改为按序读取 `edge/migrations/*.sql` **全部**迁移文件 |
| 3 | `tests/verify_contracts.py:22` | `expected_paths`（18 项） | 增加 `/api/user/sync` |
| 4 | `tests/verify_contracts.py:70、198` | 文案"18 个路由 / 20 业务表" | 同步为实际值 |
| 5 | `tests/edge/40-router.test.ts:15` | `MOUNTED` 硬编码夹具 | 增加 `/api/user/sync` 条目 |
| 6 | `docs/03-contracts/openapi.yaml` | 无该端点 | 补齐 GET / POST |
| 7 | `docs/04-spec/SPEC-v2.0.md` §5 | 端点清单 18 项 | 增加该端点 |
| 8 | `edge/src/index.ts:41` | `ROUTES` 数组 | 挂载 `{ pattern: ['api','user','sync'], allow: ['GET','POST'], handle: handleUserSync }` |

**新增门禁断言（A-3 要求）**：必须新增一条自动化测试，断言 §2.3 表中三种输入产生**字节一致**的响应。

**事实正本同步（A-13）**：
- `docs/02-architecture/CLOUDFLARE-BACKEND-FACTS.md:33、:65`（"20 张业务表"）；
- `docs/05-audit/BUILDER-DISPATCH-PACKAGE.md:40`；
- `docs/00-index/README.md` 权威链（纳入 0002 迁移与 ADR-006）。

---

## 七、 施工前置门禁（未全部满足则禁止动代码）

| 编号 | 前置条件 | 当前状态 |
| :---: | :--- | :--- |
| **P-1** | 本规格书 v2.2 获 Master 批准 | 待批准 |
| **P-2** | §六 的 8 处契约连带改动已纳入施工范围 | 待确认 |
| **P-3** | 模块三（JIT）保持待决策，`ADR-006` 起草并经 Master 批准 | 待起草 |
| **P-4** | 模块二 Phase 2-A 数据前置（A-5）完成 | 待施工 |
| **P-5** | 限流与负缓存常量口径已在 `edge/src/core/constants.ts` 登记 | 待施工 |

---

## 八、 工作包与量化（A-11 修正）

| 工作包 | 内容 | 预估 LOC | 预估 Token |
| :--- | :--- | ---: | ---: |
| **WP1** | D1 迁移 0002（2 新表 + `content_items` 扩列） | ~70 | ~6k |
| **WP2** | `handleUserSync` 路由 + 锚点解析 + 反探测顺序 + 限流 | ~150 | ~18k |
| **WP3** | 契约连带改动（§六 第 1~5 项）+ 反探测断言测试 | ~90 | ~12k |
| **WP4** | 事实正本与契约同步（§六 第 6~8 项 + A-13） | ~60 | ~8k |
| **WP5** | 模块二 Phase 2-A 数据前置（扩列 + harvest 扩字段 + 回填） | ~110 | ~14k |
| **WP6** | 模块二 Phase 2-B 标定与序列化透传（5 处改动） | ~90 | ~11k |
| **WP7** | 模块四 Actions 定时追新工作流 | ~80 | ~10k |
| **WP8** | `ADR-006` 起草（待决策项前置，不含实施） | ~70 | ~9k |
| **合计** | 不含模块三实施 | **~720 LOC** | **~88k Tokens** |

> 模块三（JIT 穿透）实施工作量**不计入本表**，待 `ADR-006` 批准后单独评估。
