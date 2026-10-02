# 《光影Play》（Prism Play）云端同步 / JIT / 定时追新 规格书独立复审报告 (AUDIT-CLOUD-SYNC-JIT-SPEC-2026-10-03.md)

> **复审对象**：`docs/04-spec/CLOUD-SYNC-JIT-PIPELINE-SPEC.md`（v2.1，2026-10-02 编制）
> **复审日期**：2026-10-03
> **复审主体**：云端基础设施专员（独立复审，不对原编制结论背书）
> **复审方式**：以当前仓库真实代码、真实迁移、真实门禁脚本为唯一证据源，逐条对抗性核验，不采信规格书自身的断言
> **复审结论**：**规格书方向正确，但存在 4 项 P0 阻断缺陷、6 项 P1 缺陷。当前状态不得进入施工。**

---

## 一、 复审方法与证据源

本次复审未依赖规格书的任何自述，全部结论均来自以下可复现的一手证据：

| 证据类别 | 具体文件 |
| :--- | :--- |
| 认证凭据构造 | `edge/src/auth/jwt.ts`、`edge/src/routes/redeem.ts`、`edge/src/auth/guard.ts` |
| 真实数据模型 | `edge/migrations/0001_initial_schema.sql`（现有唯一迁移正本） |
| 契约门禁脚本 | `tests/verify_contracts.py`、`tests/scan_p0.py` |
| 边缘入口与挂载 | `edge/src/index.ts` |
| API 类型与序列化 | `edge/src/types/api.ts`、`edge/src/http/serialize.ts` |
| 限流与准入 | `edge/src/core/rate-limit.ts` |
| 采集原始数据 | `edge/scripts/process-harvest.mjs` 及本地 harvest 快照字段 |

---

## 二、 P0 阻断级缺陷（必须修正，否则门禁必挂或产生安全漏洞）

### A-1 [P0] 同步身份锚点定义悬空且与真实凭据不符

**规格书原文**（模块一 §2）："强制校验 `Authorization: Bearer <Ed25519_JWT>`，提取 JWS Payload 中的 `couponCode`（或由绑定表反查）"。

**核验事实**：`edge/src/auth/jwt.ts:56-72` 的 `buildClaims()` 实际声明为：

```ts
{ iss, aud, sub: deviceId, tier, exp, iat, jti }
```

**JWT Payload 中根本不存在 `couponCode` 字段。** 全文检索 `edge/src/**` 未发现任何把卡密写入 claims 的路径。规格书把一个不存在的字段当作主路径，把真正可用的路径写成括号里的备选，属于方向性错误。

**真实可行的锚点链路**：

```
Authorization: Bearer <JWT>
  → jwt.ts verifyJwt() → claims.sub (deviceId)
  → devices.device_id = sub → devices.bound_coupon（0001_initial_schema.sql:13）
  → card_coupons.code
```

**衍生问题（规格书完全未覆盖）**：`devices.bound_coupon` 的注释是"**最近一次**绑定的预制卡密代码"，即该列会被新卡密**覆盖**。规格书未定义"设备换绑新卡密后，旧卡密的历史归属与迁移规则"，这会在用户续费换卡时产生静默数据割裂（旧历史滞留旧卡密，用户看到"记录消失"）。

**修正要求**：
1. 锚点解析必须改为"`sub` → `devices.bound_coupon` → `card_coupons.code`"，并在规格书中写明这条链路的每个 SQL；
2. 必须明确定义换绑语义（建议：以 `devices.bound_coupon` 当前值为准，同设备换绑即跟随新卡密；同时在事实正本登记该行为为已知边界）。

---

### A-2 [P0] 契约门禁硬编码常量，新增表与端点后必然挂掉

**核验事实**（`tests/verify_contracts.py`）：

- 第 44 行：`assert len(paths) == len(expected_paths)`，`expected_paths` 精确列出 **18** 个路径；
- 第 86 行：`assert len(business_tables) == 20, "业务表数量不符: 期望 20"`；
- 第 74 行：**只读取 `edge/migrations/0001_initial_schema.sql` 这一个文件**。

**规格书要求新增 2 张表（`cloud_watch_history`、`cloud_user_profile`）与 1 个新端点（`/api/user/sync`），但全文未提及需要同步修改这道门禁。** 施工完成后 `npm run verify:contracts` 将 100% 失败。

**更严重的是第 74 行**：门禁只解析 0001。如果按规格书新建 `0002_user_sync_schema.sql`，则**迁移正本被劈成两个文件，而门禁只认其中一个**——这会在项目里制造"两套真相"，且新表的 CHECK / FK 约束永远不会被自动化校验覆盖。这直接违反 `AGENTS.md` 二·4「文档即契约」与 SPEC §10 的单源原则。

**修正要求**：规格书必须显式列出以下连带改动，且缺一不可：
1. `tests/verify_contracts.py` 第 86 行业务表期望值由 20 改为 22；
2. `tests/verify_contracts.py` 第 74 行改为**按序读取 `edge/migrations/*.sql` 全部迁移文件**（而非只读 0001），并同步更新第 70/198 行的"18 个路由 / 20 业务表"结论文案；
3. `openapi.yaml` 补齐 `/api/user/sync`（含 GET/POST 两个 method），并同步 SPEC §5 端点清单表；
4. 门禁新增断言：`cloud_watch_history` 的私密拦截能力（见 A-3 的可测化要求）。

---

### A-3 [P0] 私密内容探测侧信道——直接违反 AC-02-3 反枚举要求

**规格书原文**（模块一 §3 服务端处理逻辑）："若 `history` 存在，先查 `content_items`：若 `is_private = 1` 或剧目不存在，直接跳过历史写入（物理除外）"。

**漏洞机理**：`cloud_watch_history.content_id` 带 `REFERENCES content_items(id)` 外键。当客户端上报一个**不存在**的 `contentId` 时，`INSERT` 会因外键约束失败并抛出异常；而按规格书所述"**静默跳过**"私密内容时，该路径不产生异常。

于是两种情况的**响应体、状态码或耗时**（静默 200 vs 抛错 500/400）产生可区分差异。攻击者只要持有一个有效会员 JWT（自己买的卡即可），就能构造上报来**判定某个 content_id 是否为真实存在的私密作品**——这精确命中 `SPEC §5` 与 AC-02-3 明令禁止的"通过响应差异探测私密资源存在性"。

**这是本次复审发现的最高危缺陷。**

**修正要求**：
1. 服务端必须让"私密已存在"与"完全不存在"两条路径返回**字节完全相同**的响应（统一 `200 {success:true}`）；
2. 私密判定必须在**外键写入之前**完成（先查 `content_items`，命中私密则直接返回成功且不写库），避免外键异常成为差异来源；
3. 必须补充一条自动化测试：断言两种输入的 `response.status`、`response.text()` 与响应头完全一致（参照 `tests/edge/70-catalog.test.ts` 中 `NOT_FOUND_BYTES` 的既有做法）。

---

### A-4 [P0] JIT 穿透搜索与既有架构原则根本冲突，属契约外施工

**核验事实**（`edge/src/index.ts:109-113`）现有代码注释为不可动摇的架构声明：

> "Ingestion is adapter-injection only: **the Worker performs no upstream call and knows no URL**, so the registry stays empty until Stage 2 registers an authorized source adapter."

**规格书模块三**却要求 `/api/search` 在本地未命中时"边缘异步穿透成熟源接口（`moduapi?ac=detail&wd={keyword}`）"。这意味着：

1. Worker 内部首次出现**硬编码上游域名**，直接推翻"客户端/边缘零上游身份暴露"原则，且与 `AGENTS.md` 二·1「彻底去平台化，上游源名严禁暴露」的取证边界产生张力；
2. `/api/search` 在 openapi 中声明为**免认证**，一旦它具备对外发起任意关键字的网络能力，等于把边缘变成一个**免鉴权的开放代理**，被刷量时消耗的是我们的 Workers 请求配额，风险面显著扩大；
3. 该行为**未走 ADR 流程**。项目已建立 ADR-001~005 序列，此类"推翻既有架构前提"的决策按纪律必须先立 ADR。

**修正要求**：规格书不得把这一条写成既定施工项，必须降级为**待决策项**，并前置产出：
1. 新增 `ADR-006-jit-upstream-search.md`，明确"边缘持有上游身份的边界条件、免认证端点的滥用防护（限流+负缓存配额上限）、以及去平台化的取证口径";
2. 明确 JIT 穿透必须**走既有 `source_providers` 白名单与 `media/upstream.ts` 的 `assertAllowedTarget` 校验**，不得新开一条绕过 SSRF 防护的旁路；
3. 未获 Master 批准 ADR 前，模块三不得进入施工。

---

## 三、 P1 重要缺陷（会导致功能不成立或数据不可用）

### A-5 [P1] HotScore 公式无输入数据，模块二当前不可实现

**核验事实**：`edge/scripts/process-harvest.mjs` 生成的 SQL 仅写入 `vod_id / vod_name / vod_pic / vod_content / vod_play_url`，**未写入任何点击量字段**（`vod_hits_week` / `vod_hits` / `vod_hits_day`）。

**结论**：规格书的 `HotScore = log10(Hits_week)*0.6 + log10(Hits_total)*0.2 + RecencyBoost` 在现有 D1 数据中**没有任何可计算的输入**，公式是一纸空文。

**修正要求**：规格书必须补一步前置工作——重新执行 harvest 以提取上游点击量字段并落盘，或在 `content_items` 增加 `hits_week / hits_total` 两列并回填；否则模块二应诚实标注为"依赖数据回填，暂不可施工"。

---

### A-6 [P1] `is_ai` / `is_hot` 的 DDL 与三处消费端均缺失

规格书只说"显式支持 `is_ai` 与 `is_hot`"，未给出任何 DDL 与改动点。真实需要同步的位置至少 5 处（缺任何一处都会导致字段空转或类型报错）：

1. `edge/migrations/` 新增列：`ALTER TABLE content_items ADD COLUMN is_ai INTEGER NOT NULL DEFAULT 0 CHECK(is_ai IN (0,1));`（`is_hot`、`hot_score` 同）；
2. `edge/src/db/content-repo.ts` 的 `ContentRow` 接口与 `CONTENT_SELECT` 字段列表；
3. `edge/src/types/api.ts` 的 `ContentItem` 接口（当前 12 个字段，无此二者）；
4. `edge/src/http/serialize.ts:46` 的 `toContentItem()`；
5. `docs/03-contracts/openapi.yaml` 的 `ContentItem` schema。

**附带核实（有利结论）**：`tests/scan_p0.py:50-55` 的 `AI_TERMS` 正则仅拦截 `workers-ai / vectorize / bge-m3 / embeddings / 语义检索 / 向量`，**不拦截 `is_ai` 或前端 `AI精品` 文案**。模块二与海报 `AI` 角标**不触 M-5 红线**，此项无阻塞，但规格书应把该核实结论写入以避免后续施工方误判。

---

### A-7 [P1] 新端点未纳入路由挂载与顺序约束

`edge/src/index.ts:41-60` 的 `ROUTES` 数组为**有序精确匹配**，规格书未指明新端点的挂载位置。`/api/user/sync` 为两级固定路径，无前缀吞并风险，但仍必须显式登记，并同步以下 4 处：

1. `openapi.yaml`；
2. `SPEC-v2.0.md` §5 端点清单表；
3. `tests/edge/40-router.test.ts:15` 的 `MOUNTED` 硬编码夹具（该测试逐条断言每个端点的 405 兜底与 `Allow` 头，若不加则新端点永远不受路由回归保护）；
4. `tests/verify_contracts.py:22` 的 `expected_paths` 列表（见 A-2）。

---

### A-8 [P1] `/api/user/sync` 无限流，存在 D1 写入配额击穿风险

**核验事实**：`edge/src/core/rate-limit.ts` 已提供 `createKvRateLimiter` / `redeemRateLimiter`，但规格书完全未对该端点提出限流要求。

**风险量化**：单卡密支持 10 台设备（`max_devices BETWEEN 1 AND 10`）。若任一设备以脚本高频调用 `POST /api/user/sync`，`INSERT OR REPLACE` **每次都是一次真实写入行**，可直接打穿 D1 免费层 100,000 行/日上限，导致**全站数据服务不可用**（D1 超限后所有查询被拒绝）。

**修正要求**：必须为该端点指定限流策略（建议按 deviceId 计数，窗口 300s、上限 20 次，复用既有 KV 限流器），并对超限返回既有闭集错误码。

---

### A-9 [P1] 偏好画像的"云端覆盖本地"存在数据回退风险

规格书要求 GET 后"偏好画像直接注入本地推荐引擎"。但本地画像是 7 天半衰期**实时衰减**的动态值，云端存的是**某次上报时刻的快照**。若简单覆盖：

- 用户昨天上报了画像快照，今天在本地又看了 10 集新剧（本地画像已更新），此时 GET 拉回**旧快照**并覆盖 → 最新偏好被抹掉；
- 规格书未定义合并方向与时间戳仲裁规则。

**修正要求**：必须明确 last-write-wins 判据（比较 `cloud_user_profile.updated_at` 与本地画像的 `updatedAt`，仅当云端更新更晚时才覆盖），并诚实登记"跨端画像可能滞后一次同步周期"为已知边界。

---

### A-10 [P1] 试用设备的 FK 落空未处理

`devices.bound_coupon` 允许为 `NULL`（未核销卡密的试用设备）。规格书虽写了"未激活设备不触发同步"，但未定义**服务端防护**：若免登录设备伪造 JWT（不可能）或已过期设备在换绑前调用，`coupon_code = NULL` 会导致 `cloud_watch_history` 的 FK 写入失败。服务端必须显式拒绝并返回统一响应，而不是依赖外键抛错。

---

## 四、 P2 完善性缺陷

- **A-11 [P2] 工作量量化缺失**：按 `USER.md` 与 `AGENTS.md` 一·3 铁律，所有方案必须给出 **LOC + Token** 口径的工作包拆解。本规格书通篇无此内容。
- **A-12 [P2] ADR 缺失**：至少两项决策需立 ADR——多端同步的身份锚点选型（卡密 vs 设备）、以及 A-4 的边缘上游访问边界。
- **A-13 [P2] 事实正本未同步**：`CLOUDFLARE-BACKEND-FACTS.md:33` 与 `:65` 均写死"20 张业务表"，`00-index/README.md` 权威链未纳入新增迁移文件，`docs/05-audit/BUILDER-DISPATCH-PACKAGE.md:40` 亦写"包含 20 张业务表"。三处需同步。
- **A-14 [P2] 措辞纪律**：规格书反复使用"绝对法律合规红线""P0 物理隔离"等表述。私密内容不同步**本身是必要且正确的**（家庭共用卡密下避免大屏社死），但应基于**产品体验与用户体面**的理由陈述，而非自我加码的假想合规铁律——此项与 Master 此前的纠偏精神一致（见 `BUILDER-HANDOFF-RECOMMENDATION-AND-BADGES.md` 相关修订）。

---

## 五、 复审已确认成立的部分（无需修改）

以下条目经一手核验，事实成立，可作为施工依据：

| 条目 | 核验结论 | 证据 |
| :--- | :--- | :--- |
| 表结构可扩展性 | `cloud_watch_history` 以 `(coupon_code, content_id)` 为主键，可实现"单剧单行"幂等覆盖，设计正确 | 与 `coupon_bindings` 的 `UNIQUE(coupon_code, device_id)` 同构 |
| 迁移文件命名 | `0002_user_sync_schema.sql` 命名与 0001 序列一致；且 `.sql` **不在** `scan_p0.py` 的 `SCAN_SUFFIXES` 内，不受 §10 的 300 行限制 | `tests/scan_p0.py:18` |
| 文档不参与 P0 扫描 | `SCAN_DIRS` 的 `SKIP_NAMES` 含 `docs`，新增规格文档不影响门禁 | `tests/scan_p0.py:19` |
| 认证与鉴权接缝存在 | 可直接复用 `authenticate()`（返回 `{status:'anonymous'|'invalid'|'ok'}`）与 `hasEntitlement()`，无需新造鉴权 | `edge/src/auth/guard.ts:67-81` |
| 私密不同步的产品理由 | 家庭成员共用一张卡密（10 台额度）时，私密内容同步到客厅大屏会造成严重社死，必须物理阻断 | `0001_initial_schema.sql:32` |
| AI 相关命名不触 P0 | `is_ai` / `AI精品` 不在 `AI_TERMS` 正则的拦截范围内 | `tests/scan_p0.py:50-55` |

---

## 六、 复审裁定

| 项目 | 裁定 |
| :--- | :--- |
| 规格书方向 | **正确**。多端同步、客观热度打标、JIT 穿透、定时追新的四大模块划分与产品目标一致 |
| 规格书可施工性 | **不通过**。存在 A-1~A-4 四项 P0 阻断缺陷，其中 A-2（门禁常量）与 A-3（探测侧信道）为确定性失败/漏洞 |
| 后续动作 | **暂停施工**。需先按本报告修正规格书（补齐 A-1/A-2/A-3 的具体实现路径、将 A-4 降级为待决策并前置 ADR、补 A-5/A-6 的 DDL 与 5 处消费端改动、补 A-8 限流、补 A-11 量化），再由 Master 审定后方可进入施工 |
