# Track 2: Cloudflare 云端与 CI 管线重构施工规格书 v2 (SPEC-CLOUD-REFACTOR)

2026-10-09 本批按二合一r2最小闭环：manifest轻量读取，config:version新增artifact并核对R2元数据，latest同域跳转，消息人工配置/读回，失败不假成功。自动发布/回退平台、Admin UI延期；不增加资源或迁移D1；本批已部署，生产版本与下载收据见CLOUDFLARE-BACKEND-FACTS及二合一r2。

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

### 3.2.1 native 线路增量与云端边界（2026-10-06）

`EpisodeLine` / `PlaybackLine` 保持必填 providerId/mediaUrl，新增 `native?: {kind:'s1-cenc',videoId:string}`。仅 provider_s1 可带；videoId 是1～32位 ASCII 数字字符串（`^[0-9]{1,32}$`），保留前导零，不转数字。native 对象严格只允许 kind/videoId，unknown-field reject：key/cencKeyHex（即使 null）、任何额外键、错误 kind/类型/长度及显式 null/undefined 均拒绝，不丢掉 native 后当普通线路。严格闭集只针对 native，不宣称整个响应所有层级均已严格拒绝未知字段。

实际主链为 work manifest 与私有 R2 discovery fact，经按作详情投影传递无 key 身份，不是 D1 episode 旧 playback。DISCOVERY_BUCKET 私有是访问权限属性，不是个人探索准入；公开发现池仍不得收入私密内容。native mediaUrl 仅为来源候选，不是明文可播证明；原生桥的来源输入仅 vid（videoId，会话/进度控制参数另计），Android runtime resolver 取实时地址/key，key 不返回 JS，不入 manifest/事实/响应/缓存/日志。Web/native cast 必须诚实拒绝 native 线路；普通无 native 线路沿用既有直连规则，不据此承诺分享 H5 可播 CENC。

Android 本地 CENC DataSource + ExoPlayer 单集已获 Master 正常播放反馈；完整 HUD 集成代码已写/编译但未真机通过。云端授权绑定的播放解析 handle 尚未实现，Stage A 未完成；旧生产 fact 无 native，必须刷新，本轮未部署。manifest 支持1～32位不代表原生执行已同范围：当前 Java bridge/resolver 仅1～20位，21～32位仍待接齐。现有 C-2/C-3b、发现刷新与真实 CI/发布 todos 均保留，字段落地不等于事实刷新或生产完成。

裁定仅同步 provider_s1 native 特例；AGENTS authority 与私密双准入不变，FLAG_SECURE 仍限正本 AC-02 个人探索频道/播放，不扩大到其他内容。旧“所有线路直连”受本节收窄；OpenAPI/ADR/index/专门 CENC 计划由主会话同步，本次不修改、不宣称 G0～G4 全通过。

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

## 6.1.1 真实来源搜索与共享发现增量（2026-10-06 已批准，待验）

以 SPEC-v2.0 §10.1.1 与 Accepted ADR-006 为准，替代旧 JIT 冻结/只查不存/仅零命中手点。完整查询本机先显，默认自动联网补充，有无本机命中都执行；真实来源检索与核验不是旧库搜索的别称。

- 仅配置中公开来源出网，保留白名单、逐跳 SSRF、保留IP拒绝、独立限流/硬超时与脱敏日志；private/exclude 不进入公开查询、缓存、共享索引和持久层。响应元数据/错误/日志零品牌，日志无上游域名/原始URL/响应；播放清单已批准的 mediaUrl 例外不扩大。
- 规范化查询 + 频道/标签 + public边界 + 来源配置版本作为查询缓存/同词在途合并依据；分页不串结果，跨实例合并覆盖需举证。缓存只复用新鲜核验结果，过期重验。成功确认无结果才短负缓存≤5分钟，超时/限流/来源及核验失败不写空集，不冒充搜无结果。
- 核验公开身份、可信作品映射、完整集数/季数和真实可用线路后幂等共享持久保存作品 facts/发现索引，不等起播；永久剧库不是关键词缓存，TTL到期不删作品，新集/新季、线路与撤片持续更新。空lines不构成可播核验，同名不构成归并依据。
- 静态全量基底 + 独立共享发现增量，不每搜改整个manifest；基底仍blobs先指针后、同generation校验，发现独立版本化提交。搜索/title/share/poster读基底或增量均复核版本与当前公开flags，不回旧公开D1。客户端稳定ID/版本幂等合并、数据与同步进度同事务，重启/整包升级不误删发现，只有明确撤片/删除事实才移除。旧 C-5 不能停用仍被白名单/发现/私密消费者依赖的表，当前基线disabled/private不能被发现覆盖。D1只存metadata/任务，独立DISCOVERY_BUCKET无r2.dev，R2存事实/cursor；0005发现五表、0006 jobqueries/jobs两表，总业务37表（不含FTS影子表），不因旧C-5停用发现依赖。永久剧库metadata与播放事实24小时刷新分离，查询TTL不删metadata；本次不执行迁移。
- `GET /api/search` 保留可选hasMore、items/page与pageSize≤20；增可选discoveryPage（1～200），响应discoveryPending/discoveryFailed/retryAfterSeconds。App按等待秒数自动同词同页poll至pending结束，切词取消旧poll及迟到响应；成功partial保留结果，不伪装成功empty。目录60分片、三列全可达与准确已加载计数不变，缺hasMore不是false。
- `GET /api/search/discoveries?after=&limit=`使用独立seq cursor（初始0），limit默认60/max100，返回changes[{seq,workId,operation:upsert|withdraw,updatedAt,card?}],cursor,hasMore（Unix秒、可选公开ContentItem）；非catalog revision，无私密元数据/墓碑。客户端数据与cursor同事务，verify_contracts由主会话更新。

必要云施工/CI/独立验收APK已获用户授权，正式官网APK/OTA须验收后。本次仅文档；G0静态检查不等于G1真实检索核验/并发脱敏、G2持久增量更新与故障恢复、G3真机重启升级/可达性或G4正式发布通过。

## 6.1.2 免费档 CPU 预算下的在线读路径资源规则（2026-10-08 实施）

依据 `wrangler tail` 与生产拨测：1102 的实测原因是 `exceededCpu`（搜索与发现同步各耗满约 2,020ms；免费档 HTTP 预算 10ms 含突发额度，亦观测到 10ms 即终止），**不是**子请求超限（1019）。平台强杀的 1102 页面由 Cloudflare 生成，应用层无法为其补 CORS 头，因此在线路径必须把 CPU 控制在预算内，而不是靠端侧兜错。

- **事实包（`edge/src/library/work-facts.ts`）**：整包字节数与 SHA-256 必须与 KV 清单声明一致；逐部作品的剧集/线路只在被请求时解析（`parseFact` 惰性化），小样本包（≤4 条）仍逐条校验哈希叶归属，大包由包级哈希与打包器前缀校验担保。缺失、损坏、未启用仍不回退旧公开 D1。
- **搜索投影（`edge/src/search/generation.ts`）**：投影条目就地逐条校验，禁止把全量条目 `JSON.stringify` 后再 `parse` 回读；候选核验（`verifiedItems`）并发执行，任一条目不可核验即整体失败关闭，不得降级为部分可信。
- **发现账本（`edge/src/search/discovery-store.ts`、`routes/search-discovery.ts`）**：变更页用单条 `LEFT JOIN`（changes × works × cards）一次取回可见性所需字段，撤回行不再触发权限重核；同一页内重复 workId 只核验一次；服务端把单页预算硬夹到 10 条（`limit` 入参契约仍为默认 60/上限 100，超预算分批推进，游标严格连续不跳号）。
- **诚实边界**：以上只降低单次请求 CPU 与子请求数，不消除突发额度耗尽后的 1102。2026-10-08 复测实证其**间歇性**：同一查询「人到中年」首拉 200（19 条 / 22.1 秒），紧接两次 503（2.6 秒 / 13.8 秒，响应无 CORS 头）；「持械入宋」200（10 条 / 6.6 秒）、「末世」「斗罗」200（14~20 秒）。搜索墙钟 6~25 秒波动，不得宣称秒级或资源安全；免费档约束下若需彻底稳定，须以测量证据决定是否重设计在线路径（预计算/离线索引），不默认升套餐。

## 6.2 运营后台与统计云端增量目标（2026-10-05，planned）

本节 additive，不改 C-1～C-6、App端点/表计数或三轨公开facts规则。依据 SPEC-v2.0 §12.3、API-SPEC §八.三及后台计划；用户授权继续实施，已有局部本地数据/认证模块，完整接线与真实D1验收待证，无部署、后台G0未签署。OTP/Cloudflare Access 未实现。

- fetch 在公共 routeRequest/withCors/OPTIONS 之前按段处理同源 `/admin`、`/api/admin/*`，独立guard；不改公共管线签名、App JWT/私密准入、CORS/缓存/Set-Cookie。登录PBKDF2-SHA256哈希，Workers CPU参数待冻结；D1存至少256位随机opaque session的SHA-256摘要及CSRF摘要，Cookie `__Host-prism_admin_session` Secure/HttpOnly/Strict/Path=/、无Domain、12小时绝对到期，每次复核、登出撤销/版本轮换失效。Origin/CSRF/no-CORS/no-store及故障关闭按API-SPEC执行。
- 目标GET session/dashboard/coupons/opaque详情/operations，POST login/logout/generate/reveal/confirm-stock/dispatch/revoke；路径及独立AdminError以API-SPEC §八.三为准，不扩App闭合错误码。卡密id为SHA-256(code)，全码不进URL或日志。资产动作requestId幂等，载荷复用/竞争409；条件写+资产+成功审计同D1 batch，零行更新整批回滚。REVOKED不撤回已有设备会员，operations仅授权设备/失败样本/android OTA只读，无OTA写发布。
- additive数据目标：analytics_daily/visitors/visitor_days、admin_sessions/login_limits、coupon_batches/admin_audit_logs，以及card_coupons批次/dispatch_status(IDLE/DISPATCHED/UNKNOWN)/独立分发备注字段；详细约束按计划§2.4，施工前核对migration ledger，不据本文执行迁移或DROP既有表。旧码UNKNOWN人工确认，新码ACTIVE+IDLE；复制不是dispatch。
- fetch取得合法公开响应后通过ctx.waitUntil原子统计batch，不阻塞核销/前台响应、不与App资产同batch。只计公开GET 200页面请求与APK存在后302下载触发；同意Cookie UV是浏览器标识不是用户/安装，期间转化用访问与下载标识交集。匿名默认，不计私密/后台/API/404；失败允许少计并展示延迟/不完整，不承诺永久免费或永久可靠。
- 清理目标：visitor-day90天、visitor最长180天、匿名汇总/审计365天，过期session清理、登录窗口24小时后清理；scheduled限量索引删除，不清其他业务表。Secrets/生产迁移/Cache Rules/部署需各自授权与证据；真实D1竞争、回滚、配额及App全量无回归是独立待验门禁。

## 七、变更记录与交付门禁

| 日期 | 变更 | 状态/边界 |
| :--- | :--- | :--- |
| 2026-10-08 | 新增§6.1.2：以测量确认 1102 为 CPU 超限（非子请求数），固化事实包按需解析、搜索投影零二次序列化、发现账本单条 JOIN + 同页去重 + 单页预算 10 条 | 已实施并部署 Worker 版本 `b5ba77bf-7980-4fcb-a43c-937f230e558d`；发现同步 CPU 2,020ms→528ms，titles/related/discoveries 与部分搜索查询生产回 200；**1102 仍间歇复发**（同一查询先 200 后 503，503 响应不带 CORS 头），搜索墙钟 6~25 秒，不宣布资源安全；未升套餐、未改准入与私密边界 |
| 2026-10-06 | 新增§3.2.1，native字段与work manifest/私有R2 discovery fact主链边界 | provider_s1、1～32位数字字符串、native严格unknown-field reject且无key；原生vid/runtime key不返JS、Web/native cast拒绝。单集Master反馈不代表完整HUD真机通过；授权绑定handle未实现，Stage A未完成，旧生产fact待刷新、未部署，Java仅1～20位执行缺口待接齐。AGENTS/FLAG_SECURE不扩大，原todos保留，OpenAPI等主会话同步。 |
| 2026-10-06 | ADR-006 Accepted，§6.1.1真实来源核验后共享持久发现、查询新鲜缓存/并发合并/短负缓存、静态基底+独立增量，search可选hasMore | 本次局部同步discoveries独立seq、search发现分页/自动轮询、0005/0006共37业务表、独立无r2.dev bucket与metadata/24小时播放事实分离，基线disabled/private不可覆盖；运营修改保留；仅文档，无部署验收，verify_contracts由主会话更新，官网APK/OTA验收后 |
| 2026-10-03 | v2 审计后重写 | 原任务基线保留 |
| 2026-10-04 | 新公开事实 pack：UTF-8 id 哈希前缀叶索引、512 KiB blob / 64 KiB manifest、显式 coverOrigins、同 generation 目录/title/share/poster、无旧公开 D1 fallback；显式递增 revision、blob 后 manifest、稳定 bundle 禁 immutable；旧日更 publisher 禁覆盖 workFacts | 本次仅修订本 SPEC 与 SPEC-APP-REFACTOR；不执行代码/CI/Git/云端修改或发布 |
| 2026-10-04 | 私密原双准入保留，本次不发布任何 private objects；公开 bucket 风险确认先于后续私密发布 | 用户已批准必要工程步骤与新 APK，但此文档任务不执行构建/签名/部署；不得据此标记生产完成 |

**只读代码核查**：已有 `edge/scripts/work-fact-packs.mjs`、`edge/src/library/work-facts.ts`、`edge/scripts/library-catalog.mjs` 与打包器/路由接线可作为施工依据，不重复实现。打包器已有显式 revision 参数检查与 blobs 后 KV 发布；“比线上 revision 递增”仍为发布验收门禁，不因参数检查存在而视为已闭环。

**全局进度地图（2026-10-08 与代码/生产实测对齐）**：

| 门禁 | 当前结论 | 下一证据 |
| :--- | :--- | :--- |
| G0 | 三轨 SPEC 与 `verify:contracts` 通过（24 App API / 38 业务表 / 13 功能 / 30 AC）；§6.1.2 资源规则入册 | 待校准参数与新增端点须先改契约再施工 |
| G1 | 公开基底已发布 generation revision 4 / 21,963 部并逐对象回读一致；发现卡片迁移 0007 已上线；Worker `b5ba77bf-7980-4fcb-a43c-937f230e558d` 部署后，titles / related / discoveries 与部分搜索查询（「持械入宋」200 / 10 条 / 6.6 秒，「末世」「斗罗」200 / 14~20 秒）生产回 200，发现同步 CPU 由 2,020ms 降至 528ms。**同一查询可先 200 后 503**：「人到中年」首拉 200（19 条 / 22.1 秒）后紧接两次 503（2.6 秒 / 13.8 秒，503 页面 `access-control-allow-origin` 为空），「归墟」503 | 免费档突发额度下 1102 已实测间歇复发，须长期复发率监控；搜索墙钟 6~25 秒波动的进一步压缩证据（预计算/离线索引方向，不默认升套餐） |
| G2 | 采集与打包机制存在（`daily-facts` / `package-and-publish-library`）；按需发现与 24 小时刷新已接线并有单测 | **日更真实周期未闭环**：定时 ingest 注册表仍为空（`edge/src/index.ts:130`），scheduled 发现刷新的线上稳定性未证 |
| G3 | v2.6.5 修订包 Master 真机验收通过（原生 CENC 起播、默认 1× 与已保存倍率生效、分享复制提示、作者二维码保存与手动打开微信） | DLNA 投屏、FLAG_SECURE 边界、缺供元数据与其余真机项继续复测 |
| G4 | 官网下载已发布：`prism-play-v2.6.5-20261008.apk`（36,303,231 字节，SHA-256 `67e07a5a…`）与验收包逐字节一致，`config:version` 公告同步；`versionCode` 仍 21605，老用户须手动覆盖安装 | 下一次正式发布须递增 versionCode 或明确不提示的取舍；内容日更闭环前不得宣称生产完成 |

未取得证据不得跨门禁宣称完成；本文档中的历史「已配置/已通过」条目不推导为当前可用性。
