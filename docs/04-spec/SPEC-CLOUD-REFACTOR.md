# Track 2: Cloudflare 云端与 CI 管线重构施工规格书 v2 (SPEC-CLOUD-REFACTOR)

**版本**: v2（2026-10-03 审计后重写，取代 v1）
**生效日期**: 2026-10-03
**物理隔离边界**: `edge/scripts/**`, `.github/workflows/**`, `edge/src/routes/catalog.ts`, `edge/src/routes/titles.ts`, `edge/src/routes/telemetry.ts`(新建), `edge/migrations/**`, `edge/src/config/kv-config.ts`
**严禁触碰**: `src/**`, `android/**`, `edge/src/html/**`（Track 1 领地）

---

## 〇、施工红线速查表（独立 Agent 必读，违反即 CI 拒签）

| 红线 | 内容 |
| :--- | :--- |
| P0-1 | 零 Emoji 功能图标；统一 Lucide Icons（内联 2px stroke SVG），尺寸仅 16/20/24px |
| P0-2 | 零紫色→粉色渐变；主强调色 `--accent: #E5A93C`；夜间背景 `#080A10`；日间背景 `#F5F6FA` |
| P0-3 | 零裸 Hex 色值、零占位空洞文案；100% 消费 Design Tokens |
| 文件 | 单文件 ≤ 300 行（含测试文件） |
| 去平台化 | 界面/公开文案/分享页零上游站源名；代码内仅抽象 Provider 编号（`provider_m1` 式） |
| 私密 | `is_private=1` 的内容**永不**进入公开 R2 资产；私密资产物理隔离 |

**自测命令（真实存在，勿改）**：
```bash
npm run typecheck          # edge TypeScript 编译
npm test                   # vitest 全量（tests/edge + tests/client）
npm run verify:contracts   # 契约一致性门禁
npm run scan:p0            # P0 红线静态扫描
```

---

## 一、背景与决策依据

### 1.1 三条独立熔断线（为何必须重构）

| 熔断线 | 免费额度 | 当前消耗机理 | 撞墙点 |
| :--- | :--- | :--- | :--- |
| Workers 请求数 | 10 万/天 | 每集视频流代理 20-30 次分片请求 | 约 300-400 日活 |
| D1 行读 | 500 万行/天 | 全量目录重同步 436 次/设备 + 每分片授权重推导 | 约 60 台设备全量同步 |
| 上游 IP 封锁 | — | 全部视频流量集中 Cloudflare 出口 IP | 一次封禁 = 全站播放死 |

### 1.2 架构决策（2026-10-03 定案）

1. **D1 从"仓库"退回"账本"**：公开内容读路径迁往 facts；私密原路径依赖仍保留，不能整体停用其内容/剧集表。账本继续保留卡密/设备/断点/画像/归一映射/遥测。
2. **公开目录与事实改走 R2 静态资产 + KV 清单 + 边缘缓存**：新 generation 公开浏览事实读取 D1 行读 = 0；不包含私密双准入鉴权的 D1 读取。
3. **采集产物不再灌 D1**：CI 生成 JSON 资产推 R2 + 刷 KV 清单。
4. **每日增量用 `h=24`**：实测全网单日更新仅 162 部/9 页，全天约 10 个温和请求。
5. **视频流不经云端代理**：App 与分享页均直连上游（CORS `*` 已实测）。
6. **私密内容按源定级**（Master 2026-10-03 拍板）：见 §2.2。

### 1.3 GitHub Actions ↔ Cloudflare 联动（已就绪，零新增基建）

```
GitHub Actions (ubuntu-latest, cron 0 19 * * * UTC = 北京 03:00)
  │ secrets.CLOUDFLARE_API_TOKEN + secrets.CLOUDFLARE_ACCOUNT_ID（已配置）
  ├─ npx wrangler r2 object put prism-play-releases <file> --key=<path>   ← 分片/清单/剧集资产
  ├─ npx wrangler kv:key put --binding=KV <key> <value>                   ← 版本清单/源配置
  └─ npx wrangler d1 execute prism-play-db --remote --file=<sql>          ← 仅归一映射小表
```

### 1.4 基础设施绑定（`edge/wrangler.toml` 现状，勿改绑定名）

| 绑定 | 资源 | 用途（本 SPEC 后） |
| :--- | :--- | :--- |
| `DB` | D1 `prism-play-db` | 账本表 + 归一映射 + 遥测 |
| `KV` | KV `7a8d672743d6462f8d2ae13d9416f0da` | `catalog:manifest` / `config:sources` / 商业化 / 版本号 |
| `APK_BUCKET` | R2 `prism-play-releases` | APK + **library 分片 + 剧集清单 + 私密资产** |

---

## 二、上游分类实测表与私密定级规则（执行依据，勿自行推测）

### 2.1 魔都 `caiji.moduapi.cc` 真实分类表（2026-10-03 现场查询 `?ac=list`）

```
1=国产动漫  2=日韩动漫  3=欧美动漫  4=港台动漫  5=动漫电影  6=里番动漫
7=电影      8=连续剧    9=综艺      10=动作片   11=喜剧片   12=爱情片
13=科幻片   14=恐怖片   15=剧情片   16=战争片   17=惊悚片   18=家庭片
19=古装片   20=历史片   21=悬疑片   22=犯罪片   23=灾难片   24=记录片
25=短片     26=国产剧   27=香港剧   28=韩国剧   29=欧美剧   30=台湾剧
31=日本剧   32=海外剧   33=泰国剧   34-37=综艺子类  38=短剧
39=伦理片   40=体育     41=足球     42=AI漫剧
```

### 2.2 私密定级双条款（Master 拍板，2026-10-03）

| 条款 | 规则 | 实测依据 |
| :--- | :--- | :--- |
| **源级** | 黄果 / 黄豆 / 剧果 / 野果 / 帝果 五个源的**全部内容** = 个人探索（`is_private=1`，channel=`private`） | guoguo 源选择器中该五源已被分隔线独立分组 |
| **分类级** | 公开源中的成人分类同样归入个人探索：魔都 `tid 6`（里番动漫，实测 1,712 部）、`tid 39`（伦理片，实测 31 部） | 2026-10-03 现场查询，样本标题确认为成人内容 |

**工程后果（必须实现）**：
- 私密内容永不混入公开分片或 public pack；未来私密资产须真实访问隔离，**仅 `private/` 前缀不构成安全边界**。本次不发布任何 private objects，保留原双准入读取路径；公开 bucket 风险确认与私密发布批准为前置门禁；
- 可扫描验收判据：公开资产中 `is_private=1` 计数恒为 0；
- 该规则写入 KV `config:sources`（见 §C-6），"归入私密"与"完全排除"两种策略可配置切换，默认**归入私密**。

### 2.3 正确的频道映射（取代两个脚本中互相矛盾的旧映射）

| 内部频道 | 魔都 tid | 说明 |
| :--- | :--- | :--- |
| `drama` 短剧精选 | 38, 42 | **42=AI漫剧 归入短剧**（修复 P0 bug）；42 强制 `is_ai=1` |
| `movie` 院线电影 | 7, 10-23 | 旧代码误用 tid 1（实为国产动漫） |
| `anime` 热血动漫 | 1, 2, 3, 4 | 旧代码仅取 tid 3（欧美动漫），漏三块 |
| `documentary` 人文纪录 | 24 | 旧代码误用 tid 4（实为港台动漫） |
| `private` 个人探索 | 6, 39 + 五源全部 | 见 §2.2 |

> **旧代码缺陷清单（修复对象）**：`sync-incremental.mjs:10-13` 的 CHANNELS 中 movie←1、anime←3、documentary←4 全部错误；`harvest-all.mjs:24` 的 42→anime 错误且从不采集 tid 7。两脚本映射互相矛盾。

---

## 三、R2 资产与 KV 清单的数据契约（Track 1/3 共同消费，Schema 即契约）

### 3.1 目录分片（公开，work 级）

路径：`library/v{revision}/{channelId}/chunk-{pageIndex0}.json`
**分片大小 = 60 条 = 客户端分页大小**（`chunk-N` 与 `page=N+1` 一一对应，Worker 零拼接原样返回）。

```jsonc
// chunk 文件内容 = CatalogResponse 兼容超集
{
  "items": [
    {
      "id": "drama_m_90431",            // 归一 work id
      "channelId": "drama",
      "title": "…",
      "category": "逆袭",
      "isPrivate": false,               // 公开分片恒为 false
      "coverUrl": "/proxy/img/…",       // 仅同源代理句柄，绝不含上游地址
      "coverVersion": "v1",
      "synopsis": "清洗后的真实列表摘要，最多240个Unicode code points；无摘要时省略",
      "episodeCount": 82,
      "isAi": true, "isHot": false,
      "firstPublishedAt": 1790000000,
      "hitsTotal": 9867,
      "tags": ["逆袭", "悬疑"],       // 可选：可信受控展示标签，最多6项，每项最多12 code points
      "releaseYear": 2024,              // 可选：仅来源明确年份
      "region": "中国大陆",             // 可选：来源明确，最多64 code points
      "language": "普通话"              // 可选：来源明确，最多64 code points
    }
  ],
  "page": 1, "pageSize": 60, "total": 820, "revision": 12
}
```

> 契约变更声明：`firstPublishedAt` / `hitsTotal` 为对 `ContentItem` 的**新增可选字段**，覆盖 SPEC-v2.0 §1.8 的字段闭集；`verify_contracts.py` 与 `docs/03-contracts/openapi.yaml` 须同步增补（属本 Track 交付物）。

### 3.2 公开事实 pack 与剧目投影（按 generation，含播放地址）

新公开事实以 §3.3 manifest 的 `workFacts` 为权威，不再要求每部单独发布 title 对象。pack 为 `{ "schema": 1, "works": { "<workId>": <fact> } }`；fact 包含真实 `coverTargetUrl`、`enabled` / `shareable` / `isPrivate:false` flags、目录字段与完整 `episodes[].lines[]` 多线路。公开目录可选元数据按 API-SPEC / OpenAPI：清洗摘要≤240 Unicode code points；可信受控展示标签最多6项、每项最多12 code points；releaseYear只来自明确年份字段，region/language最多64 code points。新字段须经目录、facts、search、bundle及客户端同代校验；真实封面与播放地址仅由 Worker 按请求投影，不在目录、启动 bundle、分享 HTML 中泄露整个 pack、pack key 或索引。

以下为 `/api/titles/{workId}` 的公开投影示意（另含 `item` 供客户端边界适配），不是 pack 下载接口。无 `workFacts` 的旧 generation 才沿用公开 `library/v{revision}/titles/{workId}.json`；私密原有双准入路径保留，本次不发布 `private/` 对象。

```jsonc
{
  "workId": "drama_m_90431",
  "title": "…", "channelId": "drama", "isPrivate": false,
  "episodes": [
    {
      "episodeNumber": 1,
      "title": "第1集",
      "durationSeconds": 120,
      "lines": [
        { "providerId": "provider_m1", "mediaUrl": "https://play.modujx11.com/…/index.m3u8" }
      ]
    }
  ],
  "generatedAt": 1790000000
}
```

- **播放地址只存在于内部事实 pack 与按作投影的剧集清单**，不存在于目录分片；
- 内容寻址 pack 可长缓存；无 revision 的详情/分享/海报入口须随 generation 重验证，不能以长期缓存保留旧 flags；**私密清单必须经 Worker 路由双重准入校验后 `no-store` 返回**（见 C-3b）；
- 单部约 80 集 ≈ 12 KB，端侧打开剧目时惰性拉取并本地缓存。

### 3.3 KV 清单 `catalog:manifest`

```jsonc
{
  "revision": 12,
  "pageSize": 60,
  "channels": { "drama": { "chunks": 14, "total": 820 }, "movie": {…}, "anime": {…}, "documentary": {…} },
  "generatedAt": 1790000000,
  "taxonomyVersion": "modu-2026-10-03",
  "workFacts": {
    "schema": 1,
    "maxBytes": 524288,
    "packs": {
      "ab": { "key": "library/facts/<sha>.json", "bytes": 12345, "sha256": "<64位小写hex>" }
    }
  },
  "coverOrigins": ["https://<经核验的封面域名>"]
}
```

**新公开 generation 强制规则**：
- 用 `SHA-256(UTF-8(workId))` 的小写 hex 前缀定位叶 pack；前缀长度为 2..64，叶索引无父子重叠。初始 2 位，超限逐位拆分；单个 work 无法装入时拒绝发布，不截断剧集或线路。
- 单 pack 最终序列化 UTF-8 字节数（含 schema/works 包装）≤524288；`key` 为 `library/facts/<sha256>.json`，`bytes` / `sha256` 必须与实际 blob 一致，读取校验失败即拒绝。
- 完整 manifest 序列化 UTF-8 ≤65536 byte（64 KiB），不是仅限制 `workFacts`；`coverOrigins` 必须为显式 HTTPS origin 名单，禁止通配或从请求动态放行。
- 目录、title、share、poster 使用同一 manifest generation 的公开事实与 flags。存在 `workFacts` 时，缺失、损坏、未启用的公开事实不得回读旧 D1 或稳定 title 资产；私密仍只走原有效高级授权 + 当次手动开启的双准入路径。
- 发布必须显式指定正整数 `revision` 且比当前已发布 revision 递增；先上传并校验本代全部 blobs，再切换 manifest 指针。内容寻址 blobs 可长缓存，但稳定 `assets/catalog-bundle.json(.gz)` URL 不能 `immutable`，须可重验证并检查 revision；不可把 KV 最后写误称为跨节点瞬时原子切换。
- `library/facts/` 不开放 pack 下载路由；公开 bucket 若有直链，Worker 不开放路由不等于 bucket 私有。此次不发布任何 private objects（含私密清单/快照）；须先确认公开 bucket 风险及真实访问隔离，再另行批准私密发布。

---

## 四、施工任务清单

### C-1: AI 漫剧归位 + 全量频道映射修正 (P0)

**文件**: `edge/scripts/harvest-all.mjs`, `edge/scripts/sync-incremental.mjs`, `edge/scripts/compute-hotscore.mjs`
**预估 LOC**: ~40 行

1. 按 §2.3 表修正两脚本的频道映射（不再各自硬编码，改读 §C-6 配置）。
2. `tid 42` 条目强制 `is_ai = 1`（不再仅靠标题正则猜测）；标题正则保留为辅助信号。
3. 采集循环**跳过** §2.2 私密分类进入公开管线（私密走独立产物，见 C-2b）。

**验收**: AC-C1-1 单次增量后 `drama` 频道 `is_ai=1` 行数 > 100；AC-C1-2 `movie`/`documentary` 频道不再新增动漫类标题（抽样人工核对 20 条）。

### C-2: 每日增量温和化 + 公开资产推 R2/KV

**文件**: `edge/scripts/sync-incremental.mjs`, `.github/workflows/content-sync.yml`
**预估 LOC**: ~180 行

1. 增量请求追加 `&h=24`；页间 `await sleep(1000 + Math.random()*1000)`。
2. 新 generation 产物：按 §3.1 生成 60 条/片目录 + §3.2/§3.3 完整公开事实 packs，保证真实封面、flags、剧集多线路同代；先上传 blobs。
3. 按 §3.3 校验显式递增 revision 后最后刷新 KV `catalog:manifest`。旧日更 publisher 若发现当前 manifest 有 `workFacts`，必须拒绝覆盖并保留现有 generation；该保护不是日更闭环完成，支持新 packs 的日更生成与真实 CI 周期仍待验收。
4. **删除** `content-sync.yml` 中 `wrangler d1 execute …sync-incremental.sql` 步骤。
5. 归一映射表（`content_aliases`/`trusted_work_mappings`）INSERT 仍走 D1。

**验收**: AC-C2-1 R2 出现 `library/v{N}/drama/chunk-0.json`；AC-C2-2 KV manifest 可读且 revision 递增；AC-C2-3 本次运行 D1 无 `content_items` 写入；AC-C2-4 CI 日志页间隔 ≥1s。

### C-2b: 私密资产独立管线（后续门禁，本次禁止发布）

**文件**: `edge/scripts/sync-private.mjs`(新建), `.github/workflows/content-sync.yml`
**预估 LOC**: ~90 行

1. 按 §2.2 双条款采集私密内容，生成 `private/v{rev}/titles/{workId}.json`（**仅剧集清单，不生成私密目录分片**——私密频道不做批量目录下发）。
2. 私密 KV 键 `catalog:private-manifest` 与公开 manifest 分离。
3. 可扫描判据脚本：遍历公开前缀全部对象，断言 `is_private=1` 计数为 0。

**验收**: AC-C2b-1 公开前缀扫描判据通过；AC-C2b-2 私密清单仅能经准入路由读取（未带凭据请求返回 404 且响应体与未知剧目字节一致）。

### C-3: 目录路由 0 行读改造

**文件**: `edge/src/routes/catalog.ts`
**预估 LOC**: ~120 行

1. `/api/catalog`：读 KV manifest → 计算 `chunk-{page-1}` 路径 → 读 R2 → 原样返回；首屏（page=1）额外写 Cache API（TTL 300s）。
2. 响应保持 §3.1 Schema（`CatalogResponse` 超集兼容）。
3. `/api/catalog/changes`：改为比对相邻 revision 的分片差异生成 diff；保留现有 400/410/修订空洞语义。
4. **删除 D1 降级回读**（v1 的"兼容期回退"与 C-5 冲突，改为靠施工顺序保证，见 §五）。

**验收**: AC-C3-1 连续 50 次请求 D1 行读增量 = 0；AC-C3-2 首屏 <200ms（缓存命中）。

### C-3b: 剧目详情路由改读 R2 剧集清单

**文件**: `edge/src/routes/titles.ts`
**预估 LOC**: ~70 行

1. `/api/titles/{id}`：有 `workFacts` 时公开 work 从当前 generation pack 投影详情（含 `item`、`workId` 与剧集多线路）；无 packs 的旧代才沿用旧 title 读取。私密保留原双重准入路径，`no-store`；本次不新增私密发布。
2. 未命中/未知/私密未准入 → 三者字节一致的 404。pack 校验错误须按完整性错误拒绝，不能以旧 D1 事实掩盖；share 与 poster 同样按本代 facts 判定可见性、分享 flags 与真实封面，封面 origin 限于 manifest 显式名单。
3. 旧 `/api/episodes/{id}/playback` 仅属于真实旧全局 episode id 的兼容边界；新详情的 `episodeNumber` 是本作局部编号，禁止把它送进旧 playback/proxy fallback。新客户端只消费详情线路，空线路/坏响应必须落错误态，不伪造旧代理兜底。

**验收**: AC-C3b-1 公开剧目详情 D1 行读 = 0；AC-C3b-2 私密剧目未准入时响应与未知剧目字节一致。

### C-4: 线路健康遥测

**文件**: `edge/src/routes/telemetry.ts`(新建), `edge/src/index.ts`, `edge/migrations/0003_lean_schema.sql`
**预估 LOC**: ~70 行

1. `POST /api/telemetry/lines`，免鉴权；body 为数组（单请求 >20 条静默截断）：
   ```jsonc
   [{ "providerId": "provider_m1", "workId": "drama_m_1", "lineIndex": 0,
      "failureCode": "timeout|http_error|decode_error", "deviceHash": "…", "reportedAt": 1790000000 }]
   ```
2. 写入 D1 `line_health_signals(id, provider_id, work_id, line_index, failure_code, device_hash, reported_at)`。
3. **不做每设备限额**（v1 的限额需查 D1 反而耗行读）；靠端侧离场批量自律 + 服务端截断。
4. 拉取：`wrangler d1 execute --remote --command="SELECT * FROM line_health_signals WHERE reported_at > …"` 导 CSV 本地分析。

**验收**: AC-C4-1 单条落库成功；AC-C4-2 25 条仅前 20 条落库；AC-C4-3 响应 <100ms。

### C-5: D1 瘦身（最后执行，见 §五顺序）

**文件**: `edge/migrations/0003_lean_schema.sql`
**预估 LOC**: ~60 行 SQL

- **保留**: devices, card_coupons, coupon_bindings, coupon_rejected_devices, cloud_watch_history, cloud_user_profile, content_aliases, trusted_work_mappings, invitation_logs, private_session_revocations, line_health_signals
- **停用（标记 DEPRECATED，不物理 DROP）**: content_items, content_episodes, episode_sources, public_search_fts, public_catalog_changes, source_records, ingest_sources, source_episode_links, content_tags, channels, channel_tier_audit_logs, source_providers
- 公开新 generation 路由停止查询旧公开内容事实表；私密原双准入路径依赖的 D1 表不得因公开 packs 切换而停用。只有相关消费者全部迁移并验收后，才可执行对应停用（本次不执行 migration）。

**验收**: AC-C5-1 migration 执行成功；AC-C5-2 核销/断点/私密会话三流程回归通过。

### C-6: 源映射与私密规则配置化

**文件**: `edge/src/config/kv-config.ts`, 两个采集脚本
**预估 LOC**: ~90 行

KV `config:sources`：
```jsonc
{
  "providers": [
    { "id": "provider_m1", "baseUrl": "https://caiji.moduapi.cc/api.php/provide/vod",
      "privacy": "public",
      "channels": [
        { "channelId": "drama", "typeIds": [38], "forceAi": false },
        { "channelId": "drama", "typeIds": [42], "forceAi": true },
        { "channelId": "movie", "typeIds": [7,10,11,12,13,14,15,16,17,18,19,20,21,22,23] },
        { "channelId": "anime", "typeIds": [1,2,3,4] },
        { "channelId": "documentary", "typeIds": [24] },
        { "channelId": "private", "typeIds": [6,39] }
      ] },
    { "id": "provider_hg1", "baseUrl": "…", "privacy": "private-all", "channels": [] }
    // 黄果/黄豆/剧果/野果/帝果：privacy = "private-all"（全部内容归私密）
  ]
}
```
- `privacy: "private-all"` = 源级私密；`channels` 中 `channelId: "private"` = 分类级私密；
- 未来新增源 = 改此配置 + 部署 KV，**采集脚本与 App 零改动**。

**验收**: AC-C6-1 两脚本中无硬编码 tid/源 URL；AC-C6-2 改配置即可把某分类在 public/private/exclude 三态间切换。

---

## 五、施工顺序硬依赖（违反即产生脏状态）

```
C-1(映射修正) → C-6(配置化) → C-2(公开 packs/目录生成)
        → C-3/C-3b(同代读路径切换) → [稳定验证 ≥ 1 个 CI 周期，日更待闭环] → C-5(D1 停写停用)
C-2b(私密发布) 本次不执行；先确认公开 bucket 风险与访问隔离，再另行批准
C-4(遥测) 独立，任意时点可施工
```

**禁止**：C-5 先于 C-3/C-3b 执行（否则读路径无兜底即断）。

---

## 六、与其他 Track 的接口约定

| 方向 | 接口 | 约定 |
| :--- | :--- | :--- |
| → Track 1 | 分享页取剧集清单 | `GET /api/titles/{id}`（C-3b），公开走 CDN、私密走准入 |
| → Track 3 | 目录与增量 | `/api/catalog`、`/api/catalog/changes`，Schema 见 §3.1；pageSize 恒 60 |
| ← Track 3 | 遥测上报 | `POST /api/telemetry/lines`（C-4） |
| → 契约文档 | 字段增补 | `firstPublishedAt`/`hitsTotal` 入 `ContentItem`；同步 openapi.yaml 与 verify_contracts |

---

## 6.1 v2.6修复增量（当前规则，全部待验）

关联正本§10.1与 `D:/DEV/prism-play/docs/04-spec/SPEC-v2.6.3-REPAIR.md` R26-02/08/11/12。搜索、补全及related候选必须复核当前generation公开facts，与目录/title/share/poster同代；禁止旧anime ID、两集截断、有workFacts回旧公开D1。完整集数与真实热度缺失明确不足，不制造来源数量、集数或热度。

每日增量必须产新完整fact packs、目录、bundle、manifest，显式递增revision、校验后blobs先指针后；旧publisher拒覆盖workFacts仅防退化，不标日更完成。完整基库与当天touched不得混淆；来源覆盖按待证矩阵逐provider调查，旧库另一来源多集与provider_m3部分合集分别记录，后台调查未完。

私密原双准入读取及D1消费者保持，本次不发布private objects；真实bucket访问隔离和CI secrets/备份分别后续批，无权限/密钥写入授权，不从历史“已配置”推导当前可用性。二维码字段与公开计时持久模型待先立契约，云商业配置和核销安全边界不变。

## 七、变更记录与交付门禁

| 日期 | 变更 | 状态/边界 |
| :--- | :--- | :--- |
| 2026-10-03 | v2 审计后重写 | 原任务基线保留 |
| 2026-10-04 | 新公开事实 pack：UTF-8 id 哈希前缀叶索引、512 KiB blob / 64 KiB manifest、显式 coverOrigins、同 generation 目录/title/share/poster、无旧公开 D1 fallback；显式递增 revision、blob 后 manifest、稳定 bundle 禁 immutable；旧日更 publisher 禁覆盖 workFacts | 本次仅修订本 SPEC 与 SPEC-APP-REFACTOR；不执行代码/CI/Git/云端修改或发布 |
| 2026-10-04 | 私密原双准入保留，本次不发布任何 private objects；公开 bucket 风险确认先于后续私密发布 | 用户已批准必要工程步骤与新 APK，但此文档任务不执行构建/签名/部署；不得据此标记生产完成 |

**只读代码核查**：已有 `edge/scripts/work-fact-packs.mjs`、`edge/src/library/work-facts.ts`、`edge/scripts/library-catalog.mjs` 与打包器/路由接线可作为施工依据，不重复实现。打包器已有显式 revision 参数检查与 blobs 后 KV 发布；“比线上 revision 递增”仍为发布验收门禁，不因参数检查存在而视为已闭环。

**全局进度地图**：G0 本次两份相关 SPEC 对齐；G1 生产 packs/manifest/封面与 flags 一致性待验；G2 新 packs 日更真实周期待闭环（旧 publisher 拒绝覆盖仅防退化）；G3 新 APK 真机播放/搜索/海报/手动目录检查待验；G4 集中交付与生产完成结论待上述证据。未取得证据不得跨门禁宣称完成。
