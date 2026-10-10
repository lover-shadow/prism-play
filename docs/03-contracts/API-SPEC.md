# 客户端与 Cloudflare 边缘 API 契约规范

2026-10-09 系列修复r2补充：`GET /api/search/discoveries`端侧预算保持8秒；超时不提交cursor，播放让路与本地目录可用不变。`/api/search`搜索补缺预算失败时保留已成功校验卡片并返回discoveryFailed=true，不缓存完整成功；客户端pending/failed/部分分页结果不进入同进程成功缓存，失败页面不丢已取得卡片。接口与DTO不新增，公开准入校验不省略，执行收据见系列修复二合一文档。

## 2026-10-09 最小闭环当前契约

android新增可选artifact={key,bytes,sha256}，key为releases/android/<versionCode>/<sha256>.apk；版本读可缺，下载入口缺失或R2大小/元数据不匹配返回503。`GET /dl/latest/android`仅302到已核验同源 `/dl/artifacts/{versionCode}/{file}`，不再外域跳转。
artifact GET完整流式200，HEAD空body，APK MIME/Content-Length/文件名正确，Accept-Ranges:none；Range/If-Range忽略，不宣称续传。官网版本/大小取同一指针。
`GET /api/announcements?versionCode=`有效消息；Admin GET/POST `/api/admin/announcements`受现有会话/同源保护，人工全量替换/删除、读回核验。审计失败不继续发布，KV失败503，重复ID409要求对账，不宣称完整幂等状态机。
本批新版读取真实AndroidCode只做可选提醒，失败不阻塞、播放不弹；强制升级/公告中心/Admin发布UI延期。机读正本及二合一r2同步，历史不同下载描述在本批由本节取代。

> **基础域名**：`https://play.prismos.org`
> **服务承载**：Cloudflare Workers + Cron + D1 + KV + R2
> **认证方式**：Bearer Token（Ed25519 / EdDSA 签名的 JWT）+ 私密探索短时会话头
> **机读正本**：`docs/03-contracts/openapi.yaml`（OpenAPI 3.0.3）——本文件为文字说明，冲突时以 `openapi.yaml` 为准
> **施工总契约**：`docs/04-spec/SPEC-v2.0.md`

---

## 〇、 全链路通用约定

- **响应形状**：JSON 接口成功返回业务字段本体，失败统一返回 `ErrorResponse`（`success: false` + 机器可判别 `code` + 人读 `message`）。
- **错误码枚举 (全量 16 项闭集)**：
  `COUPON_NOT_FOUND`、`COUPON_REVOKED`、`COUPON_DEVICE_LIMIT_EXCEEDED`、`COUPON_INVALID_FORMAT`、`DEVICE_ID_INVALID`、`RATE_LIMITED`、`PRIVATE_SESSION_REQUIRED`、`TIER_INSUFFICIENT`、`NOT_FOUND`、`SERVICE_UNAVAILABLE`、`PLATFORM_UNSUPPORTED`、`CREDENTIAL_EXPIRED`、`VALIDATION_ERROR`、`PROXY_SIGNATURE_INVALID`、`CATALOG_REVISION_CONFLICT`、`CATALOG_CURSOR_EXPIRED`。
- **限流唯一口径**：`/api/redeem` 单 IP **1 分钟最多 10 次**，超限返回 429。该兑换口径不得出现第二个数值；prefetch 使用§一.3.2的独立具名限流，不改变兑换上限。
- **上游地址零暴露（2026-10-03 v2 修订）**：目录分片、频道/源拓扑、错误体、HTML 页面源码与一切 UI 文案**永不得**包含真实上游域名；海报与需要云端转发的资源仍走 `play.prismos.org/proxy/*`。**唯一例外**：剧集清单 `GET /api/titles/{titleId}` 的 `episodes[].lines[].mediaUrl` 携带真实播放地址，用于 App 与分享页**运行时直连**上游 CDN（实测 CORS `*` 开放；决策依据 SPEC-CLOUD-REFACTOR v2 §3.2、SPEC-APP-REFACTOR v2 A-7、SPEC-STATIC-PAGES v2 S-1）。该地址只存在于运行时网络层与内存，不得渲染进任何可见文案、DOM 静态结构或日志；`/proxy/media/*` 保留为旧客户端兼容通道直至退役。
- **失效即关闭**：私密相关接口在缺少当次会话凭据时一律按“不存在”处理（404 或空集），不返回“被拒绝”的差异化提示。

---

## 一、 频道、内容与播放源

### 1. 动态频道拓扑
- **`GET /api/channels`**｜认证：可选 Bearer
- 返回 `{ version, channels: ChannelItem[] }`。
- 客户端固定公开导航在综合首页之后显示【精彩短剧】、【电影仓库】、【人文纪录】、【动漫】，分别映射真实 `drama`、`movie`、`documentary`、`anime` ChannelItem；配置下发的 `name` 与这些显示名一致，`categories`仍是各真实频道分类。综合首页为本地跨频道视图，不对应响应节点或新API。
- **私密剥离规则（硬性）**：必须**同时**满足「有效 B/Y/S 授权」+「有效 `X-Private-Session`」才返回 `private` 节点与二级分类；否则该节点在响应中完全不存在。

### 2. 剧目列表
- **`GET /api/catalog`**｜认证：可选 Bearer
- 查询参数：`channel`（必填）、`category`、`page`（默认 1）、`pageSize`（公开facts分片为60；私密/真实旧代兼容单独验收，不把公开60误改搜索20条分页）
- 返回 `{ items: ContentItem[], page, pageSize, total, revision }`；后续页**必须**携带首页面的公开 `revision`，目录已变更时 409 并重新拉快照。仅完整同修订分页可原子提交本地，增量每页也须以持久化游标与数据同事务落盘；断电/进程中断保留上个完整快照与原游标，重复页按 revision 幂等应用；D1 不提供跨请求历史快照。
- `ContentItem`新增可选公开元数据：`synopsis`最多240 Unicode code points；`tags`最多6项、每项1–12 code points，仅可信受控题材/风格；`releaseYear`只用明确四位年份来源；`region`/`language`各最多64 code points。缺值省略，旧缓存仍可读取。公开字段不得携带来源品牌、URL或内部证据标识。
- 未同时具备有效 B/Y/S 授权与当次凭据时，请求私密分类返回不含任何私密元数据的 404；不得与通用说明中“不存在”口径冲突。

### 3. 剧目详情与分集
- **`GET /api/titles/{titleId}`**｜认证：可选 Bearer + 可选 `X-Private-Session`
- 公开返回 TitleAssetResponse（含兼容item、workId及完整episodes[].lines[]），episodeNumber身份为本作局部编号，禁止调用旧全局playback作为兜底。有workFacts时以当前generation投影，缺失/损坏不能回旧公开D1；私密原双准入路径不变。
- `EpisodeLine` / `PlaybackLine` 保留必填 `providerId:string`、`mediaUrl:string`，新增可选 `native?: { kind:'s1-cenc', videoId:string }`。仅 `providerId === 'provider_s1'` 可带 native；videoId 为1～32位 ASCII 数字字符串（`^[0-9]{1,32}$`），保留前导零，不转数字。native 对象严格只含 kind/videoId 两键，unknown-field reject：任何额外字段（包括 key、cencKeyHex，即使 null）、错误 kind/类型/长度、显式 null 或 undefined 均拒绝，不能丢弃 native 后当普通线路起播。此闭集裁定仅针对 native 描述符，不宣称整份响应所有层级已严格拒绝未知字段。
- native 的 `mediaUrl` 只是来源候选，不证明可由 ArtPlayer、Web 或电视直播。原生桥的来源输入仅接 vid（videoId；会话/进度控制参数另计），runtime resolver 在 Android 内部取实时地址与 key，key 不返回 JS，不进入 manifest、响应、缓存或日志。实际主链是 work manifest / 私有 R2 discovery fact 的按作投影，不是 D1 episode 旧 playback；私有 R2 是访问权限属性，不代表个人探索内容获准进入公开发现池。
- 实现边界：Android 本地 CENC DataSource + ExoPlayer 单集已获 Master 播放正常反馈；完整 HUD 集成代码已写并编译，但未真机通过。云端授权绑定的播放解析 handle 尚未实现，**Stage A 未完成**；旧生产 fact 无 native，需要刷新，本轮未部署。Web/native cast 对 native 线路须诚实拒绝，不把候选地址当明文流；不带 native 的合法普通线路保持既有能力。
- 本次只同步上述实现事实，不修改 OpenAPI 机读正本；新增字段的机读同步由主会话负责，未完成前不宣称全链路契约门禁通过。AGENTS authority、私密双准入与 SPEC-v2.0 AC-02 的 FLAG_SECURE 范围保持，不扩展到其他内容。
- 未同时具备有效 B/Y/S 授权与有效 `X-Private-Session` 的私密剧目、以及不存在或未发布的剧目一律返回 404，不区分差异以防探测；公开剧目或已获双重准入者正常返回详情。

### 3.1 目标集 bootstrap（2026-10-10 W3 现行契约）
- **`GET /api/titles/{titleId}/bootstrap?ep=`**｜认证：公开可选 Bearer，私密必须有效 B/Y/S Bearer + 有效 `X-Private-Session` 双准入。旧 title 完整响应不变。
- 查询只允许 `ep`，整数1..5000、缺省1，拒绝重复 ep、额外参数与 videoId/URL 等注入；未知、未准入及目标集不存在同构404（NOT_FOUND）且无元数据；非法、重复或额外参数400（VALIDATION_ERROR）且无作品信息。目标集空 lines 或完整事实不可用503（SERVICE_UNAVAILABLE）。所有响应 `Cache-Control: no-store`。
- 200 为正式 `TitleBootstrapResponse`：必填 `schema:1/workId/revision/factVersion/item/targetEpisode/catalogStatus/persistenceStatus/generatedAt/servedAt`。`revision` 是公开 manifest 版本；`factVersion` 为已核验完整 title 投影 SHA-256（64位小写hex），不是仅目标集摘要。`item` 是现行 ContentItem。
- `targetEpisode: BootstrapTargetEpisode` 必含 `episodeNumber` 与非空真实 `lines`，可选 `title/durationSeconds`。每条 `BootstrapLine` 为实际 ManifestLine（既有 EpisodeLine 的 providerId、可选mediaUrl/native）加 `lineIndex` 整数0..31，保持完整事实原索引、不重新编号；不是 lineSummary-only。native 不等于已解码媒体，仍需既有 native-playback 原生身份复核，不下发密钥。
- `catalogStatus='complete'` 表示当前已取得完整目录，不是持久化成功。`persistenceStatus='stored'` 表示完整事实已存；`'scheduled'` 只表示 `ctx.waitUntil` 已登记完整事实发布，不保证已持久化或未来必成。无 ctx 冷结果只能503，禁止同步存储阻塞首集。
- `generatedAt` 保留源事实生成UTC Unix秒；`servedAt` 是本次服务UTC Unix秒。provider 仍一次获取全目录，仅优化返回体与存储 critical path，不宣称 target-only 上游或秒起；聚合/季发现未实现；prefetch 使用以下独立公开契约。本节落约不证明部署、APP接入或验收。

### 3.2 公开元数据 prefetch（2026-10-10 W3 现行契约）
- **`POST /api/titles/{titleId}/prefetch`**｜公开可选 Bearer，但 Bearer 不是可信客户ID。仅公开作品；私密即使已有双准入也不进行后台存储，本期 scope 与未知作品统一同构404（NOT_FOUND），无元数据。旧接口不变。
- `TitlePrefetchRequest` 严格仅三键 `{requestId, episodeNumbers, reason}`，拒绝查询参数。requestId 为8..128位 ASCII `[A-Za-z0-9_-]`；episodeNumbers 是唯一1..4项整数1..5000，且 `max-min<=3`，只允许 `[K,K+3]` lookahead 或 resume 窗口；reason 仅 `lookahead|resume`。JSON 原始请求体≤4096 bytes；缺失/未知键、类型或窗口非法、body too large均400（VALIDATION_ERROR），不新增413。
- caller 只来自平台可信IP哈希，不信客户端ID/requestId/Bearer；每caller最多12次/60秒（重复请求也计数），429（RATE_LIMITED）带 `Retry-After` 秒数。同work原子lease30秒、每集30秒窗口去重；同work并发合并为202 `accepted:0/deduped:true`。
- 已有核验完整事实目录且所有目标集真实lines非空：200 `TitlePrefetchReadyResponse = {schema:1, requestId, accepted:0, deduped:false, reason:'already_ready', servedAt}`，不触上游，不代表媒体可播。
- 202 `TitlePrefetchAcceptedResponse = {schema:1, requestId, accepted:0..4, deduped:boolean, servedAt}`；accepted 是本次接受集号数量，不是准备完成数。只表示 `ctx.waitUntil` 已登记或请求已合并，不等于完成、持久化成功或保证可播；无ctx/DB临时故障503（SERVICE_UNAVAILABLE），不能同步准备挡请求或伪装成功。
- 仅候选card cold在后台实际准备完整事实；provider单次预算24次请求/25秒，最后保持owner + candidate/current manifest guard，禁止覆盖已变化/撤片/私密事实。后台失败记录并释锁。不下载视频，不计热门点击或活跃，与端侧媒体缓存分层。
- 所有响应 `Cache-Control: no-store`；servedAt为UTC Unix秒整数。响应schema严格闭集；登记不证明部署、APP接入或验收。

### 4. 分集播放解析（仅真实旧全局 episode ID 兼容，不是 native 主链）
- **`GET /api/episodes/{episodeId}/playback`**｜认证：可选 Bearer
- 返回 `{ episodeId, url, mimeType, durationSeconds, expiresInSeconds }`。
- `url` 必须是服务端从可用候选源中选出的单个同源代理短时句柄；源失效时客户端以同一 `episodeId` 最多重取两次并尝试恢复进度；候选穷尽返回 503，**绝不**返回真实上游媒体地址。

### 5. 健康播放源
- **`GET /api/sources`**｜认证：可选 Bearer｜查询：`channel`
- 返回 `{ updatedAt, providers: SourceProvider[] }`。
- `apiBase` 为同源受控代理地址（非上游域名）；私密频道的源同样受授权 + 会话双重约束。
- Cron 巡检时间：每日 **UTC 04:00 / 16:00**（北京时间 12:00 / 次日 00:00）。

---

## 二、 私密探索会话

### 1. 申请当次授权
- **`POST /api/private-sessions`**｜认证：需有效 B/Y/S Bearer
- 请求体：`{ acknowledged: true }`（未确认免责提示返回 400）
- 返回：`201` + `{ sessionToken, expiresInSeconds }`，随请求头 `X-Private-Session` 使用。
- **不落盘铁律**：客户端开启状态与凭据均不落盘，服务端不长期保存明文或开启状态；只保留不可逆摘要撤销墓碑直至原凭据到期，冷启动或完全退出失效。
- **诚实边界**：服务端只能证明收到显式开启请求，无法验证用户是否真的完成设备端点击。此局限必须写入交付说明。

### 2. 主动结束
- **`DELETE /api/private-sessions`**｜认证：需 Bearer + `X-Private-Session`
- 返回 `204`，服务端写入仅含 token 摘要与到期时刻的撤销墓碑，每次请求核查；凭据明文、开启状态与内容 ID 不持久化，过期后清理墓碑。

---

## 三、 商业化卡密核销

### 1. 卡密兑换
- **`POST /api/redeem`**
- 请求体：
  ```json
  {
    "code": "GY-Q90D-A7F2-8899",
    "deviceId": "GY-800DF614",
    "platform": "android",
    "appVersion": "2.0.0",
    "inviteRef": "GY-1024ABCD"
  }
  ```
- 成功响应（`200`）：
  ```json
  {
    "success": true,
    "tier": "Q",
    "tierName": "季度畅享卡",
    "expiresAt": 1823456789,
    "token": "eyJhbGciOiJFZERTQSIsImtpZCI6InAyMDI2In0...",
    "message": "激活成功（有效期至 2027-03-30）"
  }
  ```
- 失败响应（`400`）：
  ```json
  {
    "success": false,
    "code": "COUPON_DEVICE_LIMIT_EXCEEDED",
    "message": "该卡密绑定的共享设备已达上限（最多允许 10 台）"
  }
  ```
- **核销规则**：同设备重兑须核验当前卡密/设备有效后幂等，不发过期旧凭证；新设备须同时满足 `status IN ('UNUSED','ACTIVE')` 与 `device_count < max_devices`（默认 10），绑定流水与条件更新同一原子写入单元；被拒绝的**不同**设备累计 >20 触发异常。D1 并发语义必须用阶段 1 真实并发测试证明，不能仅凭文档推断。卡密格式兼容示例中的 5 位第二段；格式不决定档位，D1 正本决定。

### 2. 档位定义（唯一口径）

| 档位 | 名称 | 时长 | 个人探索 | 初期公开 |
| :---: | :--- | :--- | :---: | :---: |
| `Q` | 季度畅享卡 | 90 天 | 无 | 是（¥9.9 主推） |
| `A` | 普通激活卡（历史兼容） | 30 天 | 无 | 否 |
| `B` | 高级全源卡 | 视批次 | 有 | 否（暂隐，权限保留） |
| `Y` | 年度尊享卡 | 365 天 | 有 | 否（暂隐，权限保留） |
| `S` | 极客纪念卡 | 永久（`-1`） | 有 | 否（仅内部赠予） |

### 3. 动态商业配置
- **`GET /api/config/monetization`**｜免认证
- 返回 `{ activeTiers, nudgePolicy }`；`nudgePolicy` 含试用阈值、阶段 1/2 上界（`stage1UntilSeconds` / `stage2UntilSeconds`）、三个提醒间隔和文案。按累计真实播放秒数选择区间，只有切集自然间隙提醒，始终允许关闭；配置缺失/不合法时不显示付费提醒，不硬编码备份价格。

---

## 四、 系统与 OTA

### 1. 授权校验与续期
- **`GET /api/device/ping`**｜认证：需 Bearer
- 返回 `{ tier, expiresAt, token }`；设备重新联网后检查撤销与有效期，并签发新凭证。已失效凭证返回 401，不允许客户端凭旧凭证自行续期。

### 2. 版本公告牌
- **`GET /api/version`**｜免认证
- 本期仅返回 `{ android: { versionCode, versionName, changelog, downloadUrl, minVersionCode, force } }`；本期机读契约不含 `windows` 字段，不得返回假下载地址。

---

## 五、 分享与下载

### 1. 剧目分享
- **`GET /s/{drama_id}`**｜免认证｜查询：`ep`（默认 1）、`ref`
- **行为**：无论 UA 来源，直接渲染**当前单集**极简原生 HTML5 播放页（零第三方域名资源；仅允许同源自托管播放器组件 `/assets/hls.min.js` 作 MSE 兜底，见 SPEC-STATIC-PAGES v2 §1.3；极速秒开）；自动播放只作“尝试”，被浏览器策略拒绝时提供单次点击播放兜底；仅当前集 `ended` 时展示“继续看请下载【光影Play】”卡片。
- **404 铁律**：私密剧目与未知剧目一律 404，响应体不得泄露剧目元信息。

### 2. 下载引导（微信环境专属指引入口；不承诺防封）
- **`GET /dl`**｜免认证｜查询：`ref`
- UA 含 `MicroMessenger` → 合规下载引导页；Android → 指向 `/dl/latest/android`；Windows → 明示当前仅提供 Android 版，不返回 PC 假链接。

### 3. 安装包直链
- **`GET /dl/latest/android`** → 有经过校验且已发布的 APK 才 302 至 R2；无可用包返回 404
- **`GET /dl/latest/pc`** → 本期 404；Windows 安装包与桌面客户端均属后续版本。

---

## 六、 受控代理

- **`GET /proxy/{kind}/{handle}`**
- 海报及旧媒体兼容入口，非新公开客户端唯一媒体入口。**白名单 + 防 SSRF + 鉴权/短时签名**，禁止任意URL转发；新公开详情 `lines[].mediaUrl` 运行时直连例外见§〇，私密安全边界不放宽。
  - `kind`: `img`（缩略海报）或 `media`（HLS 流与分片）；
  - `handle`: 不透明安全资源句柄（如 `content_id` 或短时流 token）。
- HLS 清单、分片、海报及 Range 请求逐次核对内容 ID 与 D1 当前发布状态；私密请求须与有效 B/Y/S 及当次会话绑定，仅有代理 URL 不得放行，未准入返回不泄露差异的 404 且 `Cache-Control: no-store`。公开海报响应头统一为 `Cache-Control: public, max-age=300` 配合 ETag/版本指纹复用。HLS 主/子清单、分片、密钥 URI、字幕的相对与绝对路径均须重写为保留内容身份的受控 URL；私密 HLS 子请求须经同进程受控转发层逐次附当前会话与 Bearer；若改等效凭据须先更新 OpenAPI 并真机验证，未证实前私密取流保持关闭。支持 Range/206 及正确 Content-Type，不能只保证首个 m3u8 可取。

---

## 七、 离线能力边界与密钥策略（防误用）

- 客户端 JWT 由 **Ed25519 私钥**签发，客户端内置固定公钥（`kid=p2026`）离线验签；**严禁**下发对称签名密钥。
- 本期不设动态公钥下发端点；若私钥轮换，须通过版本更新强制升级 APK 替换内置公钥。
- 最长 14 天离线仅代表「授权可离线验证」；本期可浏览缓存的公开目录与缩略海报，但**不提供离线视频播放**，点播时必须明确提示需要网络。
- 个人探索内容**零磁盘缓存**，任何情况下都不参与离线播放。

---

## 八、 搜索、内容加工与公开增量缓存（2026-10-01 M-5 去 AI 落实）

- `GET /api/search/suggestions?q=`：只返回公开可见且未撤片的剧名、别名、拼音、题材或有限纠错候选；不对每次按键调用在线生成模型。输入边界 1～80 字，最多 10 条；详细 schema 以 OpenAPI 为准。
- `GET /api/search?q=&channel=&tag=&page=&pageSize=`：纯词法与全文倒排检索（精确剧名、拼音首字母缩写、别名、错字纠偏与题材同类关联）；本期不引入任何大模型与 Vectorize 向量依赖。每页以内容 ID 去重，客户端跨页去重。
- `GET /api/titles/{titleId}/related`：基于同一题材与分类标签的关联作品推荐，不返回源剧或私密/已撤片内容。
- `GET /api/catalog` 响应增加 `revision`；后续分页携带同一修订号，不符返回 409 重拉。`GET /api/catalog/changes?after=&limit=` 以稳定修订号返回公开目录 upsert/delete 变更（upsert 必带完整可公开 item；delete 仅内容 ID 和修订号）和 `nextRevision/hasMore`，过期游标返回 410 重拉快照。私密内容及其墓碑不入该端点。发布/撤片与变更记录必须同一原子提交；增量批次幂等、按返回顺序提交，revision 严格递增但可有数字空洞，空页 `nextRevision=after`；客户端每页以 `nextRevision` 续读，不自行加 1，游标大于当前版本返回 400、超出保留窗口返回 410；不能以任意时间戳替代版本。
- `ContentItem.coverVersion` 为封面更新指纹，公开缩略海报按稳定代理地址、该版本与 ETag 缓存，变化后只更新受影响的内容；私密响应与资源标记 `Cache-Control: no-store`，不写客户端持久层。
- 已配置来源经增量 Adapter、D1 来源记录与任务状态执行入库；本期按来源自带分类直接录入，跨源归并必须具备 `trusted_work_mappings` 可信依据。单记录最多自动重试 3 次，超限隔离并留错误码。

---

## 八.一、 统一错误码与端点 HTTP 状态映射表 (消除 R-5)

| 机器错误码 (`ErrorResponse.code`) | HTTP 状态码 | 触发端点 | 触发场景与业务含义 |
| :--- | :---: | :--- | :--- |
| `COUPON_NOT_FOUND` | 400 | `POST /api/redeem` | 卡密不存在或输错 |
| `COUPON_REVOKED` | 400 | `POST /api/redeem` | 卡密已被管理员作废/吊销 |
| `COUPON_DEVICE_LIMIT_EXCEEDED` | 400 | `POST /api/redeem` | 超过最大允许绑定的设备数（默认 10 台上限） |
| `COUPON_INVALID_FORMAT` | 400 | `POST /api/redeem` | 卡密字符串格式不符合 `^GY-...` 正则 |
| `DEVICE_ID_INVALID` | 400 | `POST /api/redeem` | 客户端提交的 deviceId 不合法 |
| `RATE_LIMITED` | 429 | `POST /api/redeem`、`GET /api/search` | 兑换单IP 1分钟超过10次；搜索按独立具名配置限流，不作为无结果或负缓存 |
| `PRIVATE_SESSION_REQUIRED` | 400 | `POST /api/private-sessions` | 请求体未确认免责声明 (`acknowledged: false`) |
| `TIER_INSUFFICIENT` | 403 | `POST /api/private-sessions` | 当前卡密未包含私密准入权限（非当前云端开放的有效档位） |
| `NOT_FOUND` | 404 | 详情/分集/代理/分享 | 资源不存在、已下架，或私密内容未获双重准入（统一返回 404 反探测） |
| `SERVICE_UNAVAILABLE` | 503 | `GET .../playback` | 该分集所有候选播放源均暂时不可用 |
| `PLATFORM_UNSUPPORTED` | 400 | `POST /api/redeem` | 提交了非当前支持的平台标识（如非 android） |
| `CREDENTIAL_EXPIRED` | 401 | `GET /api/device/ping` | 授权凭证已过期或签名无效，需重新核销 |
| `VALIDATION_ERROR` | 400 | 校验失败端点 | 必填字段缺失或格式校验未通过 |
| `PROXY_SIGNATURE_INVALID` | 403 | `GET /proxy/*` | 代理签名失效、时间过期或非白名单域名 |
| `CATALOG_REVISION_CONFLICT` | 409 | `GET /api/catalog` | 跨页读取期间公开目录修订版本发生变化 |
| `CATALOG_CURSOR_EXPIRED` | 410 | `GET /api/catalog/changes` | 客户端增量游标已超出服务端变更日志保留窗口 |

---

## 八.二、 v2.6修复同步规则（2026-10-04，未验收）

关联正本§10.1及 `D:/DEV/prism-play/docs/04-spec/SPEC-v2.6.3-REPAIR.md`。公开目录、搜索/补全/related候选、按作详情、分享及海报使用同一manifest generation公开事实及flags；搜索不得返回旧anime ID或已不可见作品，完整集表不得截两集。§八旧D1内容入库/公开变更原子写口径仅为旧代兼容描述，新公开代由完整facts产物与manifest发布驱动，私密D1消费者不得整体停用。

本地搜索hydrate完整feed、判fallback前等待init/queued sync并核验revision/count；仅SQLite真不可用可明确降级；2026-10-06起完整查询默认自动联网补充，无论有无本机命中，不以索引失败或手动点击作为前提。新公开详情允许缓存按作清单（替代§〇“地址仅内存”的公开限制），需随generation重验证，禁止媒体文件离线缓存；私密地址/清单仍仅内存no-store。旧playback仅用于真实旧全局episode ID，不能接本作局部集号。公开60条分片为目标契约，现源码20/50常量未在本文档任务修改，待B2回归。

商业计时按实际播放经过时间累计，seek/position/假duration不计，暂停缓冲不计、倍速不乘媒体位移；云配置阈值/间隔/价格/档位/文案无本地猜测，缺配置关闭提醒，仅自然切集可关闭。作者二维码允许host静态注入旧已确认 `D:/DEV/prism-play/public/images/author-contact.jpg` / `author-reward.jpg`，不新增虚构云QR字段或端点；放大/文件下载及微信手动辅助如实反馈，下载不等于相册保存。旧reward含历史“换长期通行证”文字，不构成当前购买/授权承诺，须附免责声明；价格/档位/提醒仍有效云配置控制。核销原子幂等、撤销、限流、设备绑定及Ed25519/离线边界保持。

内部manifest publicSearch描述 `{schema:1,count,key,bytes,sha256}`，key=`library/search/{sha256}.json`、上限16 MiB，对象 `{schema:1,revision,entries:[{item,aliases,pinyin,tags}]}` 与workFacts同代；验证bytes/hash/revision/count/公开频道总数并在返回前复核事实。此为Worker内部R2读取契约，不新增公网投影路由/客户端字段；现代workFacts代缺/坏投影503，不回旧D1，只有真实无workFacts旧代兼容。上线必须完整同代facts/目录/bundle/search blobs先校验上传，再切manifest pointer、Worker配套，禁止单独部署搜索Worker；旧拒覆盖不算日更成功。provider_s1元数据/空lines不是可播证明，真实线路及生产覆盖待证。

端侧按正本§6.1：local_following与history同prism_local.db含created_at Unix秒，独立收藏不受history500条LRU/清cache/history影响，不新增云sync；观看累计仅Preference `prism.watch_seconds_total` / `prism.watch_seconds_last_nudge` 标量无ID/凭据，private/unknown零计。`/api/user/sync`仍只同步既有公开断点/画像，不扩展收藏或观看累计字段。

私密隔离和CI secrets/备份另批，前缀不是安全边界。本次仅文档同步，已有局部业务模块不代表R26全完成；历史1040通过仅首批report，新全量/云响应复测/浏览器/原生/生产真实CI均待验，不以旧30项矩阵标本轮绿色。

## 八.二.一、真实来源搜索与发现增量（2026-10-06 已批准，待验）

依据 SPEC-v2.0 §10.1.1 / Accepted ADR-006：完整查询本机先显、默认自动联网补充，有无命中均执行，不逐键穿透。云端真实检索受控公开来源；保留白名单/逐跳SSRF/限流/超时和零品牌响应及日志（无原始URL/响应/域名）。private/exclude与public的查询、缓存、索引、持久层和日志隔离，私密双准入不变。

- `GET /api/search?q=&channel=&tag=&page=&pageSize=&discoveryPage=` 保留既有参数与 `items/page`，pageSize≤20；可选discoveryPage为1～200。`hasMore:boolean`可选，缺省未知而非false；响应含discoveryPending/discoveryFailed/retryAfterSeconds，App按等待秒数自动同词同页poll直到pending结束，切词取消旧poll及迟到响应。成功partial保留已核验结果，pending/failed不等于确认无结果，不伪装成功empty。跨页稳定ID去重、准确已加载数、三列全可达，不新增total。
- `GET /api/search/discoveries?after=&limit=`：after为独立seq cursor（初始0），limit默认60、最大100，但limit只是上界：服务端单页硬预算10条以守住免费档CPU预算，返回不足10且hasMore=false即已到当前游标末尾，客户端须按hasMore继续推进同一游标，游标单调不跳号；历史upsert若已撤回/过期/被基线接管则降级为withdraw返回。返回 `{changes:[{seq,workId,operation:upsert|withdraw,updatedAt,card?}],cursor,hasMore}`，updatedAt为Unix秒，card为可选ContentItem，不含播放地址。与 `/api/catalog/changes` revision独立；仅公开增量，无私密元数据/墓碑，数据与cursor同事务幂等提交。
- 查询缓存/同词并发合并包含规范化查询、频道/标签过滤、public边界与来源配置版本，分页不串；只复用新鲜核验结果，过期重验，跨实例合并范围需举证。成功确认无结果才短负缓存≤5分钟，超时/限流/来源或核验失败不写成功空集。补充失败保留本机结果并明确失败/重试；pending可返回200等待态，成功partial保留结果；仅已结束失败且无可用结果时按既有ErrorResponse返回503，不以200空集掩盖失败或宣称确认无结果；429使用既有RATE_LIMITED。
- 核验当前公开作品身份、可信映射、完整集表/季数与可用线路后幂等共享持久保存facts/发现索引，不等起播；共享永久剧库不随查询TTL删除。新集/新季、线路失效和撤片须重验更新，持久存在不等于永久可播。
- 静态全量基底仍按同generation校验发布，独立共享发现增量不每搜改整个manifest；搜索/详情/海报/分享复核基底或增量的版本及公开flags，禁止旧公开D1兜底掩盖损坏。客户端稳定ID/版本原子合并数据与同步进度，重启/整包更新保留发现，只有明确撤片/删除事实才移除。发现同步使用独立seq端点，不将catalog/changes当发现同步。当前基线disabled/private不能被增量覆盖。
- Schema增量：0005发现五表、0006 jobqueries/jobs两表，0001～0006总业务37表（不含FTS影子表）；D1存metadata/任务，R2存事实/cursor，独立DISCOVERY_BUCKET无r2.dev，不向公网提供事实对象。永久剧库metadata与播放事实24小时刷新不同，查询TTL不删metadata，持久存在不等于永久可播；本轮不执行迁移，verify_contracts由主会话更新。

必要云/CI/独立验收APK获准，官网APK/OTA仅验收后；本次仅文档同步，无部署或验收结论，不改运营后台目标。

## 八.三、 运营后台 additive API 目标（2026-10-05，planned）

本节独立于§〇/§八.一 App `ErrorResponse` 与16项闭集，不改既有端点计数、认证、CORS或错误码。依据 SPEC-v2.0 §12.3 与后台计划；部分本地模块已有，完整接线/验收待证，无部署、后台G0未签署；OpenAPI现已登记12个后台目标路径及独立AdminSession/AdminError；本地API已接线，统计/页面/清理和真实D1/浏览器/生产门禁仍待验。OTP/Cloudflare Access未实现。

### 路由与安全

所有路径同源，`/admin` 与 `/api/admin/*` 按段进入独立 guard，先于公共 CORS/OPTIONS；不接受 App JWT，不返回 Access-Control-Allow-*，管理响应 `Cache-Control: no-store`。口令使用独立 PBKDF2-SHA256 哈希（Workers CPU参数待冻结）；至少256位随机 opaque 会话，仅SHA-256摘要存D1。Cookie `__Host-prism_admin_session`：Secure/HttpOnly/SameSite=Strict/Path=/、无Domain、12小时绝对到期；每次查D1，登出撤销、认证版本轮换全失效，缺Secret/DB故障关闭。

登录POST精确Origin、JSON、≤8 KiB；其余已登录POST同时验证精确Origin与会话绑定 `X-CSRF-Token`。GET无状态变更；登录失败5次/15分钟按可信CF来源IP哈希D1原子限流，另限总尝试与生成频率。安全头/审计按计划§2.3，禁止记录口令、Cookie、CSRF或全码。

| Method | Path | 目标语义 |
| :--- | :--- | :--- |
| GET | `/admin` | 未登录仅登录壳；有效会话才显示后台，不泄露受保护数据 |
| POST | `/api/admin/login` | 校验口令，建立Cookie会话；不是GET登录 |
| GET | `/api/admin/session` | 返回 `csrf/expiresAt`（Unix秒），不续长绝对期限 |
| POST | `/api/admin/logout` | 撤销D1会话并清Cookie；不是GET登出 |
| GET | `/api/admin/dashboard` | 按Asia/Shanghai日期查看页面请求、浏览器UV及下载触发；披露标识覆盖率/延迟/不完整 |
| GET | `/api/admin/coupons` | 掩码分页列表与opaque id；limit仅20/50，total与筛选一致 |
| GET | `/api/admin/coupons/{id}` | 掩码详情及绑定/期限/分发状态；绑定IP默认不展示 |
| POST | `/api/admin/coupons/generate` | `{requestId,tier,count,note}`，Q/B/Y/S、count 1～100、note≤200字符，A仅历史查看 |
| POST | `/api/admin/coupons/{id}/reveal` | `{requestId}`，审计后受控返回全码，GET不得揭示 |
| POST | `/api/admin/coupons/{id}/confirm-stock` | `{requestId}`，人工确认UNKNOWN→IDLE |
| POST | `/api/admin/coupons/{id}/dispatch` | `{requestId,note}`（保存至独立dispatch_note），显式确认分发；备注≤200字符 |
| POST | `/api/admin/coupons/{id}/revoke` | `{requestId,reason}`，reason为1～200字符，只置REVOKED停止后续核销，不撤回已有会员权限 |
| GET | `/api/admin/operations` | 授权设备、线路失败样本及嵌套android OTA只读；无OTA写接口 |

`id = SHA-256(UTF-8(code))`小写hex，为不可解释的opaque查找标识，不是认证凭据；URL/错误/普通日志不含明文code，全码不得写localStorage。新码沿既有GY兑换格式，12位crypto随机载荷而非固定期限/序号，D1唯一键处理碰撞，初态ACTIVE+IDLE；ACTIVE不代表已使用，期限按设备核销时刻计算。

generate/reveal/confirm-stock/dispatch/revoke 均以 requestId 关联幂等记录与审计：同ID同动作/目标/载荷重试不重复资产或成功审计，同ID不同请求返回409。条件更新、资产变更与成功审计同D1事务；零行更新必须整批失败。dispatch仅IDLE、非REVOKED、device_count=0可成功，双标签不同requestId只一方成功，其余409；复制/reveal不改变分发状态。note与dispatchNote独立，旧码UNKNOWN不可直接当库存。

### 独立 AdminError

独立AdminError形状为 `{code}`，不得引用或扩大App ErrorResponse.code，不附带敏感资产或内部错误。映射：400 VALIDATION_ERROR；401 UNAUTHENTICATED；403 FORBIDDEN；404 NOT_FOUND；405 METHOD_NOT_ALLOWED；409 CONFLICT；429 RATE_LIMITED；503 UNAVAILABLE。管理域闭合集合与OpenAPI AdminError一致，不因同名代码复用App认证。部分动作冲突响应为 `{status:'conflict'|'needs_confirm'|'noop'}`，HTTP409；请求重试载荷冲突为 `{code:'CONFLICT'}`。

统计仅合法公开页GET 200及APK存在校验后的302下载触发，不称实际下载完成/安装；UV为同意Cookie浏览器标识DISTINCT，不是人数。期间转化为同期间访问与下载标识交集/访问标识数，零分母暂无数据，无标识单列。匿名默认、同意/撤回 `POST /api/analytics/consent`（agree/revoke）作为独立公开新增端点，非管理会话；Cookie/隐私/缓存规则见静态页增量，不改变既有App API Cookie行为。operations失败样本不支持健康率或实时报警结论，OTA下载仍仅同源 `/dl/latest/android`。

## 八.四、 变更记录（本轮限定同步）

| 日期 | 变更 | 范围与实现边界 |
| :--- | :--- | :--- |
| 2026-10-06 | §一.3新增 key-free native 描述符，§一.4标明旧 playback 兼容范围 | 仅 EpisodeLine/PlaybackLine 的 provider_s1、数字字符串1～32位、native unknown-field reject；work manifest/私有R2发现事实主链、原生 vid/runtime key 不返JS、Web/native cast拒绝。单集 Master 反馈不等于完整HUD真机通过；授权绑定handle未实现，Stage A未完成，旧fact待刷新、未部署。当前Java仅1～20位，21～32位执行缺口待接齐；OpenAPI等由主会话同步，AGENTS/FLAG_SECURE范围不扩大。 |

## 九、 本期不含

- `/api/ai/roleplay`（AI 角色扮演与平行剧情推演）属 **v2.1+**，已从机读契约移除，本期不得实现或对外承诺。
