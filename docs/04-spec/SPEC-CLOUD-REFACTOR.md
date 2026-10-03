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

1. **D1 从"仓库"退回"账本"**：内容目录与剧集行整体移出 D1；仅保留卡密/设备/断点/画像/归一映射/遥测。
2. **目录与剧集清单改走 R2 静态资产 + KV 清单 + 边缘缓存**：浏览路径 D1 行读 = 0。
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
- 私密内容生成**物理隔离的另一套 R2 资产**（前缀 `private/`），永不混入公开分片；
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
      "synopsis": "≤30字短简介",         // 分片内恒为短文本；长简介不入分片（体积主凶）
      "episodeCount": 82,
      "isAi": true, "isHot": false,
      "firstPublishedAt": 1790000000,   // 新增：供端侧【实时新剧榜】本地排序
      "hitsTotal": 9867                 // 新增：供端侧【总热播榜】本地排序
    }
  ],
  "page": 1, "pageSize": 60, "total": 820, "revision": 12
}
```

> 契约变更声明：`firstPublishedAt` / `hitsTotal` 为对 `ContentItem` 的**新增可选字段**，覆盖 SPEC-v2.0 §1.8 的字段闭集；`verify_contracts.py` 与 `docs/03-contracts/openapi.yaml` 须同步增补（属本 Track 交付物）。

### 3.2 剧集清单（按剧目，含播放地址）

路径：公开 `library/v{revision}/titles/{workId}.json`；私密 `private/v{revision}/titles/{workId}.json`

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

- **播放地址只存在于剧集清单**，不存在于目录分片；
- 公开清单可 CDN 长缓存；**私密清单必须经 Worker 路由双重准入校验后 `no-store` 返回**（见 C-3b）；
- 单部约 80 集 ≈ 12 KB，端侧打开剧目时惰性拉取并本地缓存。

### 3.3 KV 清单 `catalog:manifest`

```jsonc
{
  "revision": 12,
  "pageSize": 60,
  "channels": { "drama": { "chunks": 14, "total": 820 }, "movie": {…}, "anime": {…}, "documentary": {…} },
  "generatedAt": 1790000000,
  "taxonomyVersion": "modu-2026-10-03"
}
```

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
2. 产物：按 §3.1 生成 60 条/片分片 + §3.2 剧集清单；`wrangler r2 object put` 上传。
3. 刷新 KV `catalog:manifest`（§3.3）。
4. **删除** `content-sync.yml` 中 `wrangler d1 execute …sync-incremental.sql` 步骤。
5. 归一映射表（`content_aliases`/`trusted_work_mappings`）INSERT 仍走 D1。

**验收**: AC-C2-1 R2 出现 `library/v{N}/drama/chunk-0.json`；AC-C2-2 KV manifest 可读且 revision 递增；AC-C2-3 本次运行 D1 无 `content_items` 写入；AC-C2-4 CI 日志页间隔 ≥1s。

### C-2b: 私密资产独立管线

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

1. `/api/titles/{id}`：公开 work → 读 R2 公开清单，`Cache-Control: public, max-age=86400`；私密 work → 双重准入校验后读 R2 私密清单，`no-store`。
2. 未命中/未知/私密未准入 → 三者字节一致的 404。
3. `/api/episodes/{id}/playback` 保留为**兼容重定向**：返回 302 至剧集清单中对应 `mediaUrl`（供旧版 APK 过渡），新客户端不再调用。

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
- 路由层停止查询停用表（C-3/C-3b 已完成切换后才执行本项）。

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
C-1(映射修正) → C-6(配置化) → C-2/C-2b(R2资产生成)
        → C-3/C-3b(读路径切换) → [稳定验证 ≥ 1 个 CI 周期] → C-5(D1 停写停用)
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
