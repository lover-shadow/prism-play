# 《光影Play》（Prism Play）云端多端同步中枢、JIT穿透引擎与定时追新工程规格书 (CLOUD-SYNC-JIT-PIPELINE-SPEC.md)

> **版本**：v2.1 施工总规格书 (Construction Baseline)  
> **生效日期**：2026-10-02  
> **维护主体**：Master_流光逸影 (战略定案) & MVP开发专家团 (云端专员全栈闭环)  
> **服务主域**：`https://play.prismos.org`  
> **文档属性**：云端施工与验收唯一法定依据（由云端专员全权承接施工）  
> **编制目的**：响应 Master 战略决策，将云端必须闭环的“多端云同步中枢（手机/TV/PC 接力）”、“客观热度与 AI 剧标定”、“全网 3.5 万+ JIT 穿透搜索”以及“GitHub Actions 无人值守增量定时追新流水线”白纸黑字固化为可施工正本，作为施工前绝对不可逾越的技术宪法。

---

## 第一部分：业务场景与系统边界 (Context & Boundaries)

### 1.1 业务诉求与商业价值
1. **多端家庭互联（手机 / TV / PC 接力）**：
   - 会员卡密（Q季卡、B高级卡、Y年卡、S极客卡）天然支持 10 台家庭设备共享（`card_coupons.max_devices = 10`）；
   - 用户在手机上看一半，回家打开电视（Android TV）或书房电脑（PC/Web），凭借同一卡密签发的非对称 JWT 凭证，**无缝继承观看断点与喜好画像**，无需繁琐的手机号注册与密码验证。
2. **AI 剧战略倾斜与大盘支撑**：
   - 响应“AI剧是未来主流”的战略定调，云端为每部剧标定客观题材与形式属性（`is_ai`、`is_hot`、`hot_score`），为端侧纯离线 3.5(AI) : 3.5(热门) : 3(探索) 自适应推荐提供权威基准。
3. **海量长尾即搜即看（JIT 穿透）**：
   - 告别单体静态库硬塞几百万行数据的瓶颈，全网 3.5 万部短剧与影视即搜即看，真实用户点击起播时无感原子沉淀入库。

### 1.2 绝对法律合规与隐私红线 (P0 物理隔离)
1. **个人探索（成人私密内容）绝对不同步**：
   - 同一卡密支持家庭多设备共享，为了保护用户在家庭公共大屏（电视）面前的体面与绝对合规，**个人探索内容 100% 物理禁止同步到云端**！
   - 服务端物理强校验：凡上报的 `content_id` 属于 `is_private = 1`，云端一律拒绝写入并静默忽略。
2. **未激活免登录设备纯本地离线**：
   - 未核销卡密的免登录试用设备，不享有且不触发多端云同步，严格保持纯本地 SQLite 存储。

---

## 第二部分：四大核心工程规格 (Technical Specifications)

### 2.1 模块一：多端云同步中枢规格 (User Sync Hub SPEC)

#### 1. D1 数据库扩展定义 (`migrations/0002_user_sync_schema.sql`)
```sql
-- 云端多端同步观看历史表 (主键覆盖 coupon + content，单剧永远只占 1 行)
CREATE TABLE IF NOT EXISTS cloud_watch_history (
    coupon_code TEXT NOT NULL REFERENCES card_coupons(code),
    content_id TEXT NOT NULL REFERENCES content_items(id),
    episode_number INTEGER NOT NULL,
    position_seconds REAL NOT NULL,
    duration_seconds REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(coupon_code, content_id)
);
CREATE INDEX IF NOT EXISTS idx_cloud_history_coupon ON cloud_watch_history(coupon_code, updated_at DESC);

-- 云端多端同步用户偏好画像表 (每个卡密唯一持有 1 行偏好向量)
CREATE TABLE IF NOT EXISTS cloud_user_profile (
    coupon_code TEXT PRIMARY KEY REFERENCES card_coupons(code),
    preferences_json TEXT NOT NULL,  -- 存储用户在 21 个双字分类上的偏好得分向量 JSON
    total_plays INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);
```

#### 2. 服务端状态同步端点 (`/api/user/sync`)
- **路由方法**：`POST /api/user/sync`（上报断点与偏好）与 `GET /api/user/sync`（拉取云端状态）；
- **鉴权要求**：强制校验 `Authorization: Bearer <Ed25519_JWT>`，提取 JWS Payload 中的 `couponCode`（或由绑定表反查）；
- **上报数据结构 (`POST`)**：
  ```json
  {
    "history": {
      "contentId": "drama_modu_90567",
      "episodeNumber": 12,
      "positionSeconds": 145.5,
      "durationSeconds": 300.0
    },
    "preferences": {
      "genres": { "战神": 24.5, "逆袭": 18.0, "科幻": 12.0, "都市": 6.5 },
      "totalPlays": 48
    }
  }
  ```
- **服务端处理逻辑**：
  1. 若 `history` 存在，先查 `content_items`：若 `is_private = 1` 或剧目不存在，直接跳过历史写入（物理除外）；
  2. 执行 `INSERT OR REPLACE INTO cloud_watch_history`，保证单剧单用户单条记录，自动更新 `position_seconds` 与 `updated_at`；
  3. 执行 `INSERT OR REPLACE INTO cloud_user_profile`，更新偏好向量与总播放数；
  4. 返回 `HTTP 200 { "success": true, "syncedAt": now }`。
- **拉取数据结构 (`GET`)**：
  - 查询 `cloud_watch_history WHERE coupon_code = ? ORDER BY updated_at DESC LIMIT 50`；
  - 查询 `cloud_user_profile WHERE coupon_code = ?`；
  - 返回最近 50 条历史与最新偏好向量，供新设备秒级初始化。

---

### 2.2 模块二：客观热度与 AI 剧标定规格 (HotScore & AI Tagging SPEC)

1. **客观综合热度分（HotScore）量化数学公式**：
   $$HotScore = \log_{10}(Hits_{week} + 1) \times 0.6 + \log_{10}(Hits_{total} + 1) \times 0.2 + RecencyBoost$$
   - `Hits_{week}`：成熟站源返回的周点击量（权重 60%）；
   - `Hits_{total}`：全网累计总点击量（权重 20%）；
   - `RecencyBoost`：72 小时内新上架或连载更新的剧目，赋予 `+0.8` 的时效性额外加权，打破老剧长久霸榜；
   - **判定标准**：综合得分排名前 15% 的作品打上 `is_hot = 1`。
2. **AI 短剧 / 漫剧形式标定**：
   - 凡来自 AI 漫剧专区、标题/简介命中 `AI漫剧`、`AI短剧`、`虚拟人` 等特征的作品，标定 `is_ai = 1`；
3. **API 序列化透传**：
   - `/api/catalog`、`/api/search` 与 `/api/titles/:id` 的 `ContentItem` 响应体中增加 `isAi: boolean` 与 `isHot: boolean`，供客户端纯离线做 3.5:3.5:3 混排与贴微光角标。

---

### 2.3 模块三：全网 3.5 万+ JIT 穿透搜索与即时沉淀规格 (JIT Ingest SPEC)

1. **搜索端点双模流水线 (`GET /api/search`)**：
   - **第一级（本地优先）**：检索 D1 `public_search_fts`，命中条目在 0.2ms 内返回；
   - **第二级（穿透兜底）**：若 D1 结果数 `< 3`，边缘异步穿透成熟源接口（`moduapi?ac=detail&wd={keyword}`）；
   - **第三级（熔断与负缓存）**：
     - 请求绑定 `AbortSignal.timeout(1500)`（1.5 秒硬超时），超时优雅降级仅显本地；
     - 搜索未命中的生僻乱码词在 Workers 内存维持 5 分钟 LRU 负缓存，防恶意刷词击穿；
   - **原则**：搜索阶段“只查不存”，清洗后返回给客户端。
2. **点击播放 JIT 惰性入库 (`GET /api/titles/:id` & `playback`)**：
   - 用户在客户端点击穿透结果起播时，边缘检测到该剧不存在于 D1 时，异步触发同一事务：
     ① 提取剧目信息清洗并写入 `content_items`（归入 21 主流双字分类）；  
     ② 提取分集与播放流写入 `content_episodes` 与 `episode_sources`；  
     ③ 将其 Origin 自动追加至 `source_providers` 白名单；  
     ④ 签发正常受控代理流媒体句柄。

---

### 2.4 模块四：GitHub Actions 无人值守定时增量追新流水线规格 (Scheduled Pipeline SPEC)

1. **工作流配置 (`.github/workflows/content-sync.yml`)**：
   - **调度机制**：GitHub Actions 定时 Cron，设定每日北京时间凌晨 03:00（`cron: '0 19 * * *'` UTC）自动触发；
   - **运行环境**：标准 `ubuntu-latest` 容器，突破 Cloudflare Workers 50ms CPU 时间限制与网络超时限制；
2. **任务工序**：
   - 调度专用抓取脚本，增量拉取当天最新更新的 50~100 部热门新作；
   - 自动映射 21 个双字分类、生成 CJK 倒排分词、批量写入线上 D1；
   - 签发递增目录版本号 `public_catalog_changes`，使已装机 APP 打开即无感增量热更新；
   - 运行结果自动沉淀至 Actions 运行日志与看板。

---

## 第三部分：工程实施步骤与质量门禁 (Milestones & Gates)

### 3.1 实施步骤排期
- **Step 1（D1 表结构与数据迁移）**：编写 `edge/migrations/0002_user_sync_schema.sql`，执行线上 D1 迁移建表；
- **Step 2（多端同步端点实现）**：新建 `edge/src/routes/user-sync.ts`，在 `edge/src/index.ts` 中挂载 `/api/user/sync` 路由；
- **Step 3（热度打标与 API 透传）**：更新 `edge/src/http/serialize.ts`，将 `isAi` 与 `isHot` 注入 `toContentItem`；
- **Step 4（JIT 穿透搜索实现）**：升级 `edge/src/routes/search.ts` 接入上游穿透、1.5s 熔断与点击入库；
- **Step 5（GitHub Actions 定时工作流）**：落地 `.github/workflows/content-sync.yml`；
- **Step 6（全量门禁与部署）**：运行 `npm test`（确保 55 套测试全绿）、`verify:contracts`、`scan:p0`，执行 `npx wrangler deploy` 上线。

### 3.2 质量门禁指标
- **G-SYNC-1**：未带有效会员 JWT 的请求调用 `/api/user/sync` 必须严格返回 `401 Unauthorized`；
- **G-SYNC-2**：上报私密内容（`is_private = 1`）断点必须被服务端物理拦截，`cloud_watch_history` 0 私密记录；
- **G-SYNC-3**：JIT 穿透外部源超时强制 ≤1.5s 熔断，绝不卡死客户端；
- **G-SYNC-4**：全仓 55 套自动化测试 100% PASS，P0 红线扫描 100% 达标。
