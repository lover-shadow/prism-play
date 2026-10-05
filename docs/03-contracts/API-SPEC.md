# 客户端与 Cloudflare 边缘 API 契约规范

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
- **限流唯一口径**：`/api/redeem` 单 IP **1 分钟最多 10 次**，超限返回 429。全工程不得出现第二个数值。
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
- 未同时具备有效 B/Y/S 授权与有效 `X-Private-Session` 的私密剧目、以及不存在或未发布的剧目一律返回 404，不区分差异以防探测；公开剧目或已获双重准入者正常返回详情。

### 4. 分集播放解析
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
| `RATE_LIMITED` | 429 | `POST /api/redeem` | 单 IP 兑换频次超限（1 分钟超过 10 次） |
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

本地搜索hydrate完整feed、判fallback前等待init/queued sync并核验revision/count；仅SQLite真不可用可明确降级，联网补充须用户手动。新公开详情允许缓存按作清单（替代§〇“地址仅内存”的公开限制），需随generation重验证，禁止媒体文件离线缓存；私密地址/清单仍仅内存no-store。旧playback仅用于真实旧全局episode ID，不能接本作局部集号。公开60条分片为目标契约，现源码20/50常量未在本文档任务修改，待B2回归。

商业计时按实际播放经过时间累计，seek/position/假duration不计，暂停缓冲不计、倍速不乘媒体位移；云配置阈值/间隔/价格/档位/文案无本地猜测，缺配置关闭提醒，仅自然切集可关闭。作者二维码允许host静态注入旧已确认 `D:/DEV/prism-play/public/images/author-contact.jpg` / `author-reward.jpg`，不新增虚构云QR字段或端点；放大/文件下载及微信手动辅助如实反馈，下载不等于相册保存。旧reward含历史“换长期通行证”文字，不构成当前购买/授权承诺，须附免责声明；价格/档位/提醒仍有效云配置控制。核销原子幂等、撤销、限流、设备绑定及Ed25519/离线边界保持。

内部manifest publicSearch描述 `{schema:1,count,key,bytes,sha256}`，key=`library/search/{sha256}.json`、上限16 MiB，对象 `{schema:1,revision,entries:[{item,aliases,pinyin,tags}]}` 与workFacts同代；验证bytes/hash/revision/count/公开频道总数并在返回前复核事实。此为Worker内部R2读取契约，不新增公网投影路由/客户端字段；现代workFacts代缺/坏投影503，不回旧D1，只有真实无workFacts旧代兼容。上线必须完整同代facts/目录/bundle/search blobs先校验上传，再切manifest pointer、Worker配套，禁止单独部署搜索Worker；旧拒覆盖不算日更成功。provider_s1元数据/空lines不是可播证明，真实线路及生产覆盖待证。

端侧按正本§6.1：local_following与history同prism_local.db含created_at Unix秒，独立收藏不受history500条LRU/清cache/history影响，不新增云sync；观看累计仅Preference `prism.watch_seconds_total` / `prism.watch_seconds_last_nudge` 标量无ID/凭据，private/unknown零计。`/api/user/sync`仍只同步既有公开断点/画像，不扩展收藏或观看累计字段。

私密隔离和CI secrets/备份另批，前缀不是安全边界。本次仅文档同步，已有局部业务模块不代表R26全完成；历史1040通过仅首批report，新全量/云响应复测/浏览器/原生/生产真实CI均待验，不以旧30项矩阵标本轮绿色。

## 九、 本期不含

- `/api/ai/roleplay`（AI 角色扮演与平行剧情推演）属 **v2.1+**，已从机读契约移除，本期不得实现或对外承诺。
