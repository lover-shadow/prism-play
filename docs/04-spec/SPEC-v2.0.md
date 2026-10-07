# Spec - 《光影Play》(Prism Play) v2.0.0

> **生成日期**：2026-09-30（2026-09-30 夜间完成施工前契约收敛）  
> **基于文档**：`PRD-prism-play.md` + `ARCHITECTURE.md` + `UIUX-design-system.md` + `openapi.yaml`  
> **状态**：2026-10-01 编码前 G0 静态/合成契约复核完成；本版为施工与验收主依据，与 PRD/OpenAPI/SQL 冲突时同步修正；G1～G4 的真实 D1、AI、HLS 与 Android 行为尚未经实测，不得宣称完整交付门禁通过

---

## 2026-10-07 变更记录：新增发现与端侧按需播放

- 搜索仅取得并共享保存剧目卡片，不以完整媒体清单为卡片展示条件；不在搜索时逐集取流或解密。
- 新作品详情按需取得真实分集编号。provider_s1原生线路允许仅含providerId与native描述符，无需mediaUrl；普通线路仍须真实地址。编号在Android运行时按集取流、处理密钥及播放。
- 保留既有目录和有效地址，不因查询缓存过期而全库重抓。定时任务不续跑旧搜索逐集取流任务，S1目录更新只获取编号。
- `/api/version`可返回service.buildId/deployedAt（真实部署元数据），android字段仍是官网APK公告。本机版本从Android宿主读取，不硬编码或提前更新公告。
- 详细施工与待验收证据见`docs/plans/2026-10-07-search-cards-and-device-playback.md`；本记录不代表部署或真机验收已通过。

## 1. 产品定义
- **一句话描述**：基于 Capacitor 7 现代全栈容器与 Cloudflare Serverless 边缘云脑构建的工业级“大视界”全景流媒体终端（`play.prismos.org`）。
- **目标用户**：私域高净值观影用户、通勤碎片追剧群体与多端影音发烧友。
- **核心问题**：解决主流短剧平台套路化扣费与广告污染，以及民间开源聚合壳子“网页套壳感强、站源频繁失效、无移动端手势”的顽疾。

## 2. MVP 范围（锁定——不在此列表的功能一律不做）

| 优先级 | 功能编号 | 功能名称 | 验收标准摘要 | RICE 评分 |
| :---: | :---: | :--- | :--- | :---: |
| **P0** | F-01 | 云端动态“大视界”频道浏览 | 四个公开频道；私密频道在授权与当次开启均满足前双重隐形 | 12.00 |
| **P0** | F-02 | ArtPlayer 双滑手势播放器 | 左滑调亮度（0–48% 区）、右滑调音量（52–100% 区）、双击10秒快进退、HLS 起播 | 12.50 |
| **P0** | F-03 | 预制卡密 D1 原子核销与 14 天离线授权 | 条件原子绑定 DeviceID，签发非对称签名 JWT | 10.80 |
| **P0** | F-04 | 极简分享 H5 (点开即播、播完截流) | `/s/:id` 载入**当前单集**，`ended` 弹出下载引导卡；私密/未知剧目 404 | 10.80 |
| **P0** | F-05 | Android 原生后台与息屏保活播放 | `ForegroundService` + 通知栏控制卡片，锁屏不中断 | 7.11 |
| **P0** | F-06 | 首屏黄金续播常驻记忆卡片 | 秒级断点记忆，点击后从断点起播 | 8.10 |
| **P1** | F-07 | 四模海报排版无缝切换 | 3列紧凑(默认) / 2列大图 / 4列书架 / 单列图文列表 | 7.20 |
| **P1** | F-08 | 睡眠定时自动关闭 | 15/30/60分钟 / 播完本集 / **播完本剧**；归零前 3 秒淡出 | 7.88 |
| **P1** | F-09 | 黑曜石深色 / 象牙白双模主题 | `#080A10` 与 `#F5F6FA` 切换，琥珀金 `#E5A93C` 主色 | 6.00 |
| **P1** | F-10 | 系统级来电自动暂挂与挂断恢复 | `CALL_STATE_RINGING` 暂停并记录断点，`IDLE` 恢复 | 7.20 |
| **P0** | F-13 | 词法搜索与同类题材推荐 | 精确剧名/别名/拼音首字母/错字纠偏/题材同类词法检索；本期无 AI 语义 | 待样本评估 |
| **P0** | F-14 | 已配置来源增量接入与可信归并 | 幂等采集、按来源自带分类入库、trusted_work_mappings 跨源归并、失败重试 | 待样本评估 |
| **P0** | F-15 | 公开目录与缩略海报本地缓存 | 二次启动先显公开快照；增量变更与容量淘汰；个人探索零落盘 | 待真机评估 |

> **范围说明**：F-05 与 F-10 依赖 Android 原生能力，Web 端不作为验收对象；两项均在 MVP 范围内，不再列入 Backlog。


## 3. 明确不做（Out-of-Scope — 锁定）

| 不做的功能 | 原因 | 何时考虑 |
| :--- | :--- | :--- |
| 手机号/邮箱账号注册与登录 | 拒绝繁琐注册流程，全面采用 DeviceID + 预制卡密无感认证 | 永不引入 |
| 应用内第三方支付 SDK | 规避合规审查风险，商业变现 100% 走预制卡密核销 | 永不引入 |
| 评论区与弹幕社交系统 | 剔除 UGC 监管风险，保持纯粹个人观影工具属性 | 永不引入 |
| Go 本地子进程二进制拉起 | 彻底淘汰旧库 `juku_arm64` 方案，减重 15MB 并消除安卓沙箱查杀风险 | 已永久废弃 |
| AI 角色扮演与平行剧情推演 | 本期 AI 仅用于元数据加工与语义候选，交互剧情仍属高阶功能 | v2.1+ 阶段（**本期契约不含其端点**） |
| Windows 安装包与桌面客户端 | 本期仅 Android APK + 公开分享 H5，PC 下载路由不返回虚假包 | 桌面宿主和构建验证完成后 |
| 视频离线下载与离线播放 | 本期本地仅持久化公开目录与缩略海报，授权离线验签不等于媒体离线可播 | 单独确认缓存许可及媒体管线后 |
| 云端集中式转码与自建视频 CDN | 成本与合规均不成立，本期只做受控代理与分集解析 | 不计划 |
| 内容版权与分发权准入审查 | 本期作为技术原型与私域系统，工程不设内容授权准入闸门，合规由运营域承担 | 商业化公开上线前另行评估 |


## 4. 技术架构（锁定 — 含版本锚定）

| 层 | 技术 | 实际版本 | 锁定原因 |
| :--- | :--- | :---: | :--- |
| **跨端宿主** | Capacitor | `^7.0.0` | 标准 Android 工程与原生桥接；APK 体积 6~8MB 仅为待构建实测目标，不作保证 |
| **前端构建** | Vite + TypeScript | `^6.0.0 / ^5.6.3` | 与母站 `prismos.org` 技术血统统一，支持毫秒级 HMR 热重载 |
| **播放内核** | ArtPlayer.js + hls.js | `^5.2.1 / ^1.5.17` | HLS 播放候选；系统音量、窗口亮度与手势须自建原生桥并经真机验证，包体积待实测 |
| **边缘计算** | Cloudflare Workers + Cron | `ES2022` | 每天定时唤醒 2 次启动分批任务与源巡检；延迟/容量须按实际账户和环境验证，不承诺零冷启动 |
| **边缘数据库** | Cloudflare D1 + KV + R2 | `Serverless` | D1 为卡密与内容权威，KV 只加速公开可延迟数据，R2 存已核验 APK；费用和实际额度以账号核验为准 |
| **认证方案** | JWT 非对称签名（Ed25519 / EdDSA，`kid` 标识密钥） | `RFC 8037` | 边缘持私钥签发，客户端内置固定公钥（`kid=p2026`）离线验签；本期不设动态公钥下发端点，若私钥轮换需通过版本更新强制升级 APK 替换内置公钥；离线期最长 14 天仅代表授权可验证 |
| **内容解析** | 服务端受控代理 `play.prismos.org/proxy/{kind}/{handle}` | `Server` | 边缘选取单个有效代理句柄，失败时客户端按 episodeId 重解析；客户端不接触上游地址 |
| **全文检索库** | Cloudflare D1 FTS5 (`unicode61`) | SQLite 原生 | 负责剧名、全拼、拼音首字母缩写、题材与错字纠偏词法检索；Workers AI 与 Vectorize 语义检索移入 v2.1+ |
| **端侧公开缓存** | Android 持久化公开目录/海报 | 待实现验证 | 快照先显、修订号增量同步；个人探索不落盘，本期无视频离线播放 |


## 5. API 端点清单（锁定——以 `docs/03-contracts/openapi.yaml` 为唯一依据）

| Method | Path | 功能 | 认证 | 请求体 | 响应体 |
| :---: | :--- | :--- | :---: | :--- | :--- |
| `GET` | `/api/channels` | 获取云端动态“大视界”频道拓扑 | 可选 JWT | - | `{version, channels: ChannelItem[]}`（未满足授权+当次开启时物理剥离 private） |
| `GET` | `/api/sources` | 获取经 Cron 健康巡检排序的播放源 | 可选 JWT | `?channel=` | `{updatedAt, providers: SourceProvider[]}`（`apiBase` 为同源代理地址，非真实上游） |
| `GET` | `/api/catalog` | 分页获取频道/分类下的剧目卡片列表 | 可选 JWT | `?channel=&category=&page=` | `{items, page, pageSize, total, revision}` |
| `GET` | `/api/catalog/changes` | 公开目录增量 upsert/delete | 免认证 | `?after=&limit=` | `{changes, nextRevision, hasMore}`，游标过期 410 |
| `GET` | `/api/search/suggestions` | 公开词法补全 | 免认证 | `?q=` | `{query, suggestions}`，最多十条 |
| `GET` | `/api/search` | 公开词法+拼音+模糊检索 (本期无 AI) | 免认证 | `?q=&channel=&tag=&page=&pageSize=` | `{items, page}`；pageSize 默认/上限 20 |
| `GET` | `/api/titles/{titleId}/related` | 基于题材分类的同类公开推荐 | 免认证 | - | `{items}` |
| `GET` | `/api/titles/{titleId}` | 剧目详情与分集清单 | 可选 JWT | - | `TitleDetail`（含 `episodes[]`；未双重准入的私密/未知/未上架一律 404） |
| `GET` | `/api/episodes/{episodeId}/playback` | 服务端择源解析可播地址 | 可选 JWT | - | 单个 `PlaybackInfo`；无可用源 503，私密无权/不可播 404 |
| `POST` | `/api/private-sessions` | 申请当次私密探索授权（仅内存有效） | 需 B/Y/S JWT | `PrivateSessionRequest` | `PrivateSessionResponse`（短时凭据，不落盘） |
| `DELETE` | `/api/private-sessions` | 主动结束当次私密探索 | 需 B/Y/S JWT | - | `204` |
| `GET` | `/api/config/monetization` | 获取云端动态商业策略（含私密准入档位集合） | 免认证 | - | `MonetizationConfig`（初期仅展示季卡 ¥9.9） |
| `POST` | `/api/redeem` | 预制卡密条件原子核销与设备绑定 | 免认证 | `RedeemRequest` | `RedeemSuccessResponse`（含 JWT） |
| `GET` | `/api/device/ping` | 联网后校验授权状态并续期 | 需 JWT | - | `DevicePingResponse` |
| `GET` | `/api/version` | OTA 在线版本公告牌检测 | 免认证 | - | `VersionResponse` |
| `GET` | `/s/:drama_id` | 极简分享落地页（当前单集，播完截流；私密/未知 404） | 免认证 | `?ep=1&ref=` | 极简原生 HTML5 单集播放页 |
| `GET` | `/dl` | 下载引导页（微信 UA 引导、平台分流） | 免认证 | `?ref=` | HTML |
| `GET` | `/dl/latest/:platform` | 已发布 Android 安装包入口 | 免认证 | `android` | 有校验产物 302 至 R2；无包/pc 404 |
| `GET` | `/proxy/{kind}/{handle}` | 受控媒体与图片代理（白名单、防 SSRF、逐次准入） | 短时签名；私密还需有效 B/Y/S + 当次会话 | - | HLS 清单及分片/密钥/字幕 URI 重写、Range/206、私密 no-store |

> **不在本期契约内**：`/api/ai/roleplay`（v2.1+ 预留）已从 `openapi.yaml` 移除，避免实现期误当作可交付端点。

> **私密准入谓词（施工必须照此实现）**：`private` 数据可返回 ⟺ `有效 B/Y/S 授权` **AND** 有效 `X-Private-Session`（由 `POST /api/private-sessions` 签发）。任一缺失即视为“该资源不存在”。代理清单/分片/封面及 Range 每次请求同样复核 D1 与当次会话，短时 URL 不能独立绕过；私密 no-store。原生 HLS 子请求未必附自定义头；阶段 2/3 必须证明同进程受控请求转发逐次注入；若改用等效能力凭据须先更新 OpenAPI，未经真机验证私密取流保持关闭。


## 6. 数据库表清单（锁定——详见 `edge/migrations/0001_initial_schema.sql`）

| 表名 | 核心字段 | 索引 | 关联与职责 |
| :--- | :--- | :--- | :--- |
| `devices` | `device_id`, `tier`, `expires_at`, `bound_coupon` | `idx_devices_expires` | 本期仅 Android；device_id 为可变/可伪造安装标识，不可声称硬件唯一；记录授权档位与到期时间 |
| `card_coupons` | `code`, `tier`, `duration_days`, `status`, `max_devices`, `device_count`, `rejected_distinct_count`, `is_abnormal` | `idx_coupons_status`, `idx_coupons_abnormal` | 预制卡密池；CHECK 保证计数上限，绑定/计数还需原子提交及真实 D1 并发验证 |
| `coupon_bindings` | `coupon_code`, `device_id`, `bound_at`, `bound_ip` | `idx_bindings_coupon`, `idx_bindings_device` | 绑定流水，`UNIQUE(coupon_code, device_id)` 保证同设备幂等 |
| `coupon_rejected_devices` | `coupon_code`, `device_id`, `first_rejected_at` | PRIMARY KEY | 被拒绝的**不同**设备去重流水，`rejected_distinct_count > 20` 触发异常标记 |
| `channels` | `id`, `name`, `sort_order`, `requires_tier`, `categories_json` | PRIMARY KEY | 动态频道配置：公开 `'0'`→空数组，私密 `'ADVANCED'`→B/Y/S 加当次会话；D1 CHECK 限制其它组合 |
| `source_providers` | `id`, `channel_id`, `upstream_url`, `latency_ms`, `healthy` | `idx_sources_channel_healthy` | 去平台化播放源与 Cron 探针状态（真实上游仅服务端持有） |
| `content_items` | `id`, `channel_id`, `title`, `category`, `is_private`, `enabled`, `shareable`, `cover_version`, `first_published_at` | `idx_content_channel`, `idx_content_visible` | 服务端可信内容目录；默认禁发布/分享（enabled=0, shareable=0），经运营确认后上架；私密永不可分享 |
| `content_episodes` | `content_id`, `episode_number`, `title`, `duration_seconds` | `UNIQUE(content_id, episode_number)` | 分集清单，分享 `ep` 与续播断点均以此为准 |
| `episode_sources` | `episode_id`, `provider_id`, `upstream_media_url` | `UNIQUE(episode_id, provider_id)` | 分集 ↔ 源映射，播放解析只对外返回代理句柄 |
| `invitation_logs` | `inviter_device_id`, `invitee_device_id`, `reward_days` | `UNIQUE(invitee_device_id)` | 有可信邀请码时首次成功核销唯一结算；禁止自邀，跨 APK 安装不能凭 URL 自动归因 |
| `private_session_revocations` | `token_hash`, `expires_at`, `revoked_at` | PRIMARY KEY | 短时凭据摘要撤销墓碑；不存开启状态和内容身份，过期后清理 |
| `public_catalog_changes` | `revision`, `content_id`, `operation` | 自增 PRIMARY KEY | 发布/撤片与变更同一原子提交；upsert 必带可见条目、delete 只有 ID/版本；revision 可有数字空洞；仅公开目录同步 |
| `ingest_sources`, `source_records`, `source_episode_links`, `trusted_work_mappings` | 配置来源、游标、原始元数据、`attempt_count/next_attempt_at`、作品/分集映射、可信跨源证据引用 | 来源/项目/修订号唯一；可信映射来源 ID 唯一 | 增量摄取与最多三次自动重试，超过后隔离；跨源仅凭可信映射归并，不直接发布原始记录 |
| `content_aliases`, `content_tags`, `public_search_fts` | 作品别名/拼音、受控多标签、公开词法索引 | 内容与标签/别名复合主键 | 关键词候选索引，查询后按 D1 当前状态过滤；私密不进入公开 FTS |

> **不落盘边界**：私密探索的开启状态、内容身份与会话明文不持久化；客户端仅驻内存，服务端用短时凭据验证。`private_session_revocations` 仅保留不可逆 token 摘要及到期时间，供主动关闭立即作废，过期清理；这属于安全撤销记录，不可用来恢复开启状态。

### 6.1 端侧本地存储架构与追剧断点契约（新增正本，消除 R-14 / 落实 M-8）

客户端必须严格按以下四大安全存储域划分磁盘与内存资产，严禁各模块私设存储结构：

| 存储域 | 承载技术 | 核心数据资产 | 配额上限与淘汰 | 系统备份策略 (`dataExtractionRules`) | 一键清理语义 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **1. 安全凭证域** | Android Keystore 加密存储 | Ed25519 JWT、设备识别码 `deviceId` | 单记录覆盖 | **严格排除 (Exclude)**：密钥与硬件绑定，迁移无法解密将破坏授权 | 清除缓存**绝不**波及 |
| **2. 追剧与历史域** | 客户端 SQLite (`prism_local.db` -> `local_watch_history` / `local_following`) | 公开观看断点 + 独立显式收藏（created_at） | 历史最多500部按updated_at LRU；收藏无此淘汰 | **纳入备份目标 (Include)**：实际换机/覆盖安装恢复待真机证明 | 清空历史只删history，不删收藏；清缓存均不删，收藏仅显式取消/删除 |
| **3. 公开缓存域** | 本地文件系统 (`cache/posters/` + `cache/catalog/r{rev}/`) | 公开频道配置、目录分页快照分块 JSON、缩略海报图片 | 海报上限 512 MiB，目录上限 20 MiB；LRU 淘汰 | **严格排除 (Exclude)**：避免浪费用户云配额，换机联网自动重建 | 点击【清理缓存】立即清空海报与旧快照 |
| **4. 私密禁存域** | **RAM 纯内存** (无任何文件/数据库落地) | 个人探索的标题、海报、分集、断点、会话 token | 随进程结束/关闭开关即刻置空由 GC 回收 | **绝无磁盘文件，不参与备份** | 退出即焚 |

#### 本地追剧与历史物理表定义 (`prism_local.db`)：
```sql
CREATE TABLE IF NOT EXISTS local_watch_history (
    content_id TEXT PRIMARY KEY,           -- 公开剧目稳定 ID
    title TEXT NOT NULL,                   -- 剧目名
    cover_url TEXT,                        -- 封面缩略图地址
    last_episode_id INTEGER NOT NULL,      -- 最近观看分集内部 ID
    last_episode_number INTEGER NOT NULL,  -- 最近观看集数
    position_seconds INTEGER NOT NULL,     -- 播放进度断点秒数
    duration_seconds INTEGER NOT NULL,     -- 单集总时长
    total_episodes INTEGER,                -- 剧目总集数
    updated_at INTEGER NOT NULL            -- 最近观看时间戳 (Unix 秒级)
);
CREATE INDEX IF NOT EXISTS idx_watch_history_time ON local_watch_history(updated_at DESC);
```
- **写入闸门硬约束**：播放内核与历史管理服务底层，凡 `is_private = 1` 或 `channel_id = 'private'` 的记录，**物理拦截禁止执行 `INSERT/UPDATE` 进入 `local_watch_history` 与 `local_following`**。此约束在单元测试中必须提供自动化拦截用例。

#### 独立公开收藏与观看累计（R26-09/11，2026-10-04）

`D:/DEV/prism-play/src/core/storage/following-store.ts` 与历史共享 `prism_local.db` 连接，由存储宿主统一管理连接；幂等建表，不另建数据库：
```sql
CREATE TABLE IF NOT EXISTS local_following (
    content_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    cover_url TEXT,
    created_at INTEGER NOT NULL
);
```
`created_at` 为 Unix 整数秒；收藏是用户显式意图，不由播放历史推导，按 created_at 倒序、content_id 升序稳定排列。仅公开可写，事务提交成功才显示已收藏；写失败必须反馈。历史500条LRU、清空历史及清缓存均不删除收藏，仅显式取消/删除收藏才删除；收藏属于历史安全域的备份目标，覆盖安装/备份恢复仍须真机验证。本轮不新增收藏云同步，不扩展 `/api/user/sync`。

`D:/DEV/prism-play/src/core/watch-time.ts` 在 PreferenceStore 中只存非负有限数值字符串标量：`prism.watch_seconds_total` 与 `prism.watch_seconds_last_nudge`（后者不得大于前者），不含内容/分集ID、凭据或私密时长，不新增SQL表或云同步字段。先读取再接播放事件，损坏/读取失败不覆写旧值；写失败保留待保存状态并可重试。单调时钟仅累计公开实际playing且已有首帧的经过时间，暂停/缓冲/seek/异常/离场停计，恢复需新播放证据，不补未知区间；private/unknown零计。当前Web事件桥在blur/visibility变化停止计时，不宣称原生后台时长已验证；清缓存/历史不清这两个偏好标量。提醒仅有效云配置、未授权用户、ended→自动下一集自然间隙可关闭触发，手选集不触发。


## 7. 页面与视图清单（锁定）

| 视图/组件 | 源码路径 | 核心组件职责 | 对应 API |
| :--- | :--- | :--- | :--- |
| **大视界主视图** | `src/index.html` + `src/main.ts` | 顶部动态频道栏、二级吸顶横滑胶囊、首屏黄金续播卡、四模海报网格（含 loading/empty/error 态） | `GET /api/channels`, `GET /api/catalog` |
| **全手势播放视图** | `src/player/prism-player.ts` | ArtPlayer 实例、左滑亮度 HUD、右滑音量 HUD、双击快进退、选集抽屉、睡眠定时（含播完本剧） | `GET /api/episodes/{episodeId}/playback` |
| **独立设置中心** | `src/views/settings-view.ts` | 日夜双模切换、后台/息屏播放开关、来电自动暂停、卡密兑换、OTA 检测、个人探索开关（条件显现）、本地缓存清理附属功能 | `POST /api/redeem`, `GET /api/version` |
| **分享点开即播页** | `edge/src/routes/share.ts` | 边缘直出极简 H5，载入当前单集；自动播放被拒时提供手动播放兜底；`ended` 弹出下载截流卡 | `GET /s/:drama_id` |
| **搜索与结果视图** | `src/views/search-view.ts`（规划路径） | 本地公开热词快显、输入法组合、补全/关键词/语义/同类、筛选/纠错、降级提示与零结果 | `/api/search/suggestions`, `/api/search`, `/api/titles/{titleId}/related` |
| **追剧与历史视图** | `src/views/history-view.ts`（规划路径） | 正在追剧集（秒级进度条与一键起播）、观看历史清单、基于已看剧目的同类推荐流、多端接力同步 | 本地历史库 + `GET /api/titles/{titleId}/related`, `GET|POST /api/user/sync` |
| **公开目录缓存服务** | `src/core/catalog-cache.ts`（规划路径） | 快照版本增量同步、缩略海报缓存及 LRU（作为端侧基础服务运行，不设独立主界面）；私密请求零落盘 | `/api/catalog`, `/api/catalog/changes` |

> 上述七个视图/组件均须实现对应生命周期与异常状态（业务视图完整覆盖 `loading / empty / error / ready / disabled` 五态），未获双重准入的私密内容**不渲染**而非渲染空卡。


## 8. 设计 Token（锁定——详见 `src/styles/design-tokens.css`）
- **品牌主强调色**：流媒体院线级琥珀金 `--accent: #E5A93C`（严禁紫粉渐变）
- **黑曜石深色（默认）**：主背景 `--bg: #080A10`，卡片表面 `--surface: #12151F`，主字色 `--fg: #F4F6FB`
- **象牙纯白（浅色）**：主背景 `--bg: #F5F6FA`，卡片表面 `--surface: #FFFFFF`，主字色 `--fg: #131720`
- **图标系统**：100% 锁定 **Lucide Icons**（2px stroke 纯内联 SVG，16/20/24px），**严禁任何 Emoji 功能图标**

## 9. 验收标准（锁定——EARS 格式）

| 编号 | 功能 | EARS 格式验收标准 | 优先级 |
| :---: | :--- | :--- | :---: |
| **AC-01** | 大视界加载 | When 用户启动应用，若有四公开频道快照则先渲染本地快照、后台同步，若无则拉云端快照；历史频道默认定位口径由 HP-04 综合首页取代。首屏耗时须标注机型与网络真机实测（目标 ≤1.2s，未测不算通过） | P0 |
| **AC-02** | 个人探索绝密安全机制 | 1. 仅有效 `B/Y/S` 授权后才在设置露出【个人探索】开关，勾选时必须弹出“可能含成人内容、用户自行负责”免责提示；<br>2. **严禁持久化开启状态**：每次进入软件默认关闭，需每次手动开启；<br>3. **双层隐形**：未同时满足「有效高级授权 + 当次手动开启」时，频道节点、二级分类、海报、播放源与分享入口在 DOM 与接口响应中均不得出现；<br>4. **硬件级防截屏**：处于该频道或播放时 Android 动态挂载 `FLAG_SECURE`，退出即解除；**已知局限**须写入交付说明——该能力仅对 Android 原生生效，且无法防御外部摄像头拍摄；<br>5. **零磁盘留痕**：禁止写入播放历史与断点，媒体分片只在内存流转；<br>6. 该分类内容 100% 剔除分享按钮，边缘 `/s/:id` 对私密与未知剧目一律返回 404 | P0 |
| **AC-03** | 首屏黄金续播 | While 存在本地观看历史（私密内容除外），首屏顶部必须常驻展示剧名、集数与秒数；When 点击，系统必须从断点起播并记录起播耗时（目标 ≤800ms，须实测） | P0 |
| **AC-04** | 四模海报切换 | When 用户点击排版切换按钮，系统必须在窄屏（< 768px）3列紧凑/2列大图/4列书架/单列图文间无缝切换并持久化偏好，平板与桌面（≥768px）依据 design-tokens.json 断点网格自动扩展列数 | P1 |
| **AC-05** | 日夜双模主题 | When 切换深浅主题，背景色必须严格在 `#080A10` 与 `#F5F6FA` 间切换，零硬编码裸色值泄漏 | P1 |
| **AC-06** | 左滑亮度调节 | While 全屏播放，When 在屏幕左侧 `0%~48%` 区域垂直滑动，必须经原生 Bridge 调节窗口亮度并显示暖阳亮度 HUD；Web 无原生能力时明确受限，不以遮罩冒充硬件亮度 | P0 |
| **AC-07** | 右滑音量调节 | While 全屏播放，When 在屏幕右侧 `52%~100%` 区域垂直滑动，必须线性调节音量并显示冰蓝音量 HUD；Web 端仅调播放器音量，系统音量须原生 Bridge；中央 `48%~52%` 保留区不触发调节 | P0 |
| **AC-08** | 双击快进退 | While 播放中，When 双击左半区必须快退 10 秒，双击右半区必须快进 10 秒 | P0 |
| **AC-09** | 睡眠定时关闭 | When 定时归零前 3 秒，系统必须开始淡出音量并于归零瞬间暂停播放、释放播放句柄；选项含 15/30/60 分钟、播完本集、播完本剧 | P1 |
| **AC-10** | 后台与息屏播放 | While 开启“后台/息屏播放”，When 锁屏或切回桌面，Android `ForegroundService` 必须保持音频并在通知栏展示剧集标题与控制按钮 | P0 |
| **AC-11** | 来电自动暂挂 | When 收到 `CALL_STATE_RINGING` 必须立即暂停并记录断点；**恢复前置条件全部满足**时（通话前处于播放中 + 通话期间用户未主动暂停或切走 + 音频焦点已恢复）应自动恢复播放，否则**保持暂停**，避免抢占用户意图 | P1 |
| **AC-12** | 分享点开即播 | When 访问 `/s/:drama_id?ep=N`，必须跳过介绍页载入该集并**尝试**自动播放；被浏览器策略拒绝时必须提供单次点击播放入口 | P0 |
| **AC-13** | 播完截流引导 | When 该集触发 `ended`，必须淡出控件并弹出“本集已播放完毕，如果继续看，请下载【光影Play】”卡片 | P0 |
| **AC-14** | 卡密核销与共享风控 | When Android 提交卡密：已绑定设备核验当前卡密/设备状态后幂等返回；新设备仅当 status 有效且 `device_count < max_devices`（默认10）时原子绑定；第 11 台拒绝，吊销卡密即使未满也拒绝；被拒绝的不同设备数累计 >20 置异常；真实 D1 并发另验 | P0 |
| **AC-15** | 离线授权可验证 | While 断网，If 本地 Ed25519 JWT 未过期且距最后一次联网校验 ≤14 天，系统必须离线验签并显示档位；已缓存公开目录可浏览，但任何视频点播须提示需要网络，个人探索绝不离线播放。联网撤销无法即时通知离线设备 | P0 |
| **AC-16** | 词法搜索 | Given 公开与私密/撤片合成样本，When 查询名称/别名/中文单字及双字/拼音缩写/错字，Then 返回标明匹配类型的可见结果；无权及失效条目在补全和结果均不存在；同名异剧分别保留展示 | P0 |
| **AC-17** | 自动接入与可信归并 | Given 配置来源同名异剧、同剧多源和重试样本，When 增量任务执行，Then 幂等更新、按来源自带分类入库、trusted_work_mappings 跨源归并、同名异剧分立；单条失败最多重试 3 次后隔离；发布/撤片与公开变更记录原子提交 | P0 |
| **AC-18** | 本地公开缓存 | Given 已缓存的四公开频道，When Android 冷启/断网/恢复/同步中断，Then 先显示公开快照、同修订完整快照原子替换、增量游标与数据同事务更新，失败保留旧版且离线点播提示联网；海报上限 512 MiB、元数据 20 MiB，清缓存不清凭证/续播；个人探索在应用可控磁盘和搜索历史中零记录 | P0 |
| **AC-19** | 竖屏短剧全屏沉浸 | When 9:16 竖屏剧目进入沉浸全屏，系统必须保持竖直握持不强制旋转，以 `object-fit: contain` 零裁切呈现，舞台占满 100% 视口且留白由高斯模糊底片覆盖无纯黑死边；全屏状态的唯一权威为宿主 CSS 状态机，严禁调用 `art.fullscreenWeb` | P0 |
| **AC-20** | 横屏影视联动全屏 | When 16:9 横屏剧目进入沉浸全屏，系统必须经 `ScreenOrientation.lock` 联动旋转横屏、等比铺满视口宽度，原生隐藏状态栏与导航栏，并在退出全屏/关闭/异常路径恢复进入前系统栏与方向策略（释放方向锁，不强制覆盖用户原方向策略） | P0 |
| **AC-21** | 返回键级联退出 | When 按下系统返回键、侧滑或 Escape，系统必须先关闭最顶选集/倍速/投屏等浮层；无浮层时仅退出全屏并恢复详情台（不得关闭播放器）；无浮层且处于非全屏详情态再次返回时才关闭播放器 | P0 |
| **AC-22** | 永久签名覆盖安装 | When 任一次构建（本机或 CI）产出 APK，其签名证书 SHA-256 必须与 `GITHUB-DEVOPS-FACTS.md` 基线逐字节一致，使老版本无需卸载即可覆盖安装；密钥库必须位于 `android/app/debug.keystore` 并被 `signingConfigs.debug` 显式绑定 | P0 |
| **AC-23** | 有效公网分享 | When 用户发起分享，系统必须产出以常量主域 `https://play.prismos.org` 起始的 `/s/:id?ep=N` 链接且文案含剧名与集数，响应中零 `localhost` 残留；原生分享不可用时降级为剪贴板复制并提示 | P0 |
| **AC-24** | 局域网大屏投屏 | When 用户在操作岛点击【投屏】，系统必须经原生 SSDP 组播发现同网段 DLNA 设备（扫描期间持 `MulticastLock`、结束即释放），选定后推送公网代理流并可遥控暂停与退出；明文 SOAP 控制仅允许发往本机发现结果内的 RFC1918 地址 | P1 |
| **AC-25** | 顶栏居中与排版移顶 | When 外壳顶栏渲染，品牌区必须在 `--header-height` 容器内垂直居中，四模排版切换器常驻顶栏右侧工具槽且实例跨 Tab 复用（切换不丢 `aria-pressed` 与偏好态）；首页不得出现与一级频道重复的区块标题 | P1 |
| **AC-26** | 分类胶囊双口径收敛 | When 首页渲染筛选层级，一级频道字号必须为 `--text-md`，二级胶囊视觉高度必须为 `--capsule-height`（28px）且命中区高度必须达 `--capsule-hit`（≥44px），两条同时成立 | P1 |
| **AC-27** | 底部Tab栏宽度收缩 | 历史验收口径：底部导航内容承载区限宽 360px 并居中；HP-09进一步要求底栏背景承载区与内容一起收窄，安全区只计算一次。 | P1 |
| **AC-28** | 端侧推荐混排 | 旧验收口径：按 id 稳定序基线与 7 天半衰期本地画像分，编织20条一块（7 AI / 7 热门 / 6 探索）。该口径已由 HP-05 的综合首页60条独占推荐轨规则取代；本条保留用于历史追踪，不作为新首页验收依据。 | P1 |
| **AC-29** | 海报极简微光角标 | 历史角标口径：仅可信 `isAi === true` / `isHot === true` 可显示且消费 `--badge-*` Tokens。AI角标文案及质量边界按HP-10执行，AI制作类型不得表述为精品质量。 | P1 |
| **AC-30** | 端云状态多端同步 | When 播放器销毁或应用挂起（`isActive === false`），系统必须以 `keepalive` 上报 `/api/user/sync` 并在失败时由待发队列于下次冷启补传；When 进入【追剧】页或新设备激活，系统必须拉取云端断点按 `updatedAt` 取较新者合并并继承偏好画像；私密内容必须经 `assertWritable()` 拦截实现零上报；严禁心跳轮询 | P0 |

### HP-01～HP-12：2026-10-05 首页与播放器增量验收

本组为独立增量验收编号，不改变 AC-01～AC-30 的历史身份。与本组冲突的旧AC行为不得作为新行为验收依据；每条HP须有独立测试标题和本轮证据。

| 编号 | 必须行为 | 边界与证据 |
| :--- | :--- | :--- |
| HP-01 | 仅显式 `ended` 可自然推进一集；playing/seeked仅更新播放状态。 | 旧媒体事件、重复ended、未首帧、错误和未知时长不得导致扫集或污染新集进度；事件必须归属真实源代次。 |
| HP-02 | 热门榜打开时注册返回Layer，关闭/离页/销毁时注销并还原焦点。 | Back/手势/Escape先关榜，不退出应用；不得重复注册或被旧Layer截获。 |
| HP-03 | 点击作品后，在首个异步等待前显示无元信息loading宿主并注册返回。 | 每次await核代；取消、乱序、404/失败不得回显受保护身份、复活旧宿主或留下不可关闭空壳。 |
| HP-04 | 默认首页为综合视图；公开导航顺序为首页、精彩短剧、电影仓库、纪录片、动漫。 | 四频道保持真实内部ID与分类；综合首页跨公开候选，不造云频道或API；private永不进入。 |
| HP-05 | 每个完整60作品推荐页目标轨为AI短剧20、证据合格真人短剧4、电影12、纪录片与动漫6、跨公开偏好18。 | 全局去重；不伪造类型/口碑。缺额按本计划披露并补位，供给不足可返回不足60；普通频道目录不套首页配额。 |
| HP-06 | 一级/二级首个重复点击回顶，定义窗口内再次点击建立新推荐轮次；顶部下拉使用同一刷新入口。 | 重选公开候选并结合有效偏好/曝光；弱网仍可本地重编排，联网失败与本地成功分开反馈；不保证每项变化。 |
| HP-07 | 榜单在完整可见候选中先按频道与二级分类筛选，再按有可比证据的热度排序。 | 不把偏好或isHot当热度；缺少跨源可比证据须说明范围/不足，不随机洗牌、不伪称实时。 |
| HP-08 | 非全屏无画面内悬浮工具条；全屏使用透明紧凑控件层。 | 保留基本播放/进度可达性、选集与返回栈；视觉可紧凑但命中区≥44px，退出全屏清理隐藏计时。 |
| HP-09 | 底部导航背景承载区与按钮一起收窄居中，并只计算一次系统安全区。 | 小屏、横屏、大字、手势/三键导航及列表末项均须有效视口验证。 |
| HP-10 | 海报模式统一压缩横纵间距；AI制作类型角标文案为“Ai剧”。 | 仅可信isAi可显示；不得表示精品质量，不缩小导航命中区；尺寸须以真实视口样稿校准。 |
| HP-11 | 列表优先展示真实摘要；缺摘要时只展示有依据的年份/地区/语言并压缩信息块。 | 摘要最多240 Unicode code points；releaseYear只来自明确四位年份字段；region/language最多64 Unicode code points；不得用上架时间冒充年份。 |
| HP-12 | `category`保持主分类；多个副标签只接受可信受控题材/风格证据。 | 最多6个、每项最多12 Unicode code points；去空、去重、去外部品牌及无意义词，不从标题/搜索词/制作类型猜造。 |

> AC-01～AC-15 与 `PRD-prism-play.md` 第九章逐条对应；AC-16～AC-18 与 PRD 第十二章新增验收对应，编号、口径与边界必须一致；AC-19～AC-30 由 `PLAYER-FULLSCREEN-SIGNING-UPDATE-SPEC-AND-PLAN.md`（v2.5）波次新增，与 PRD §12.6 逐条对应。
>
> **编号纪律**：本节是 `AC-xx` 的唯一权威来源。测试标题只能署名本节存在的编号；新增验收必须占用未使用区段并同步本节与 PRD——撞号不会报错，只会把用例记到语义无关的条目上形成假绿。


## 10. 边界与约束

### 10.1 v2.6 修复正本规则（R26，未验收）

v2.6增量以 `D:/DEV/prism-play/docs/04-spec/SPEC-v2.6.3-REPAIR.md` R26-01～12 与 `REPAIR-v2.6.2-PLAN.md` 追踪；2026-10-05首页与播放器增量以本文件 HP-01～12 追踪，均不改变 AC-01～30 历史编号。旧AC矩阵不得作为R26/HP通过证明。新规则、局部业务实现、全量回归、浏览器、真机与生产状态分别登记；三轨架构、私密双准入和核销安全边界不变。

- **R26-01/02 搜索与事实**：完整公开快照 hydrate 必须发送全量索引 feed，search/suggestions 在判 fallback 前等待 init/queued sync，核验 revision 与实际公开 count；索引未就绪不能冒充零结果；2026-10-06 起，完整查询默认自动联网补充，无论本机是否命中，不以索引失败作为触发依据。目录、搜索/补全/related、详情、分享、海报使用同 generation 公开事实，禁止旧 anime ID 或两集截断、禁止有 workFacts 时回读旧公开 D1。来源覆盖以待证矩阵调查，不能将 provider_m3 部分合集不足推广为全部来源结论。
- **HP-01～03 播放与宿主**：显式ended与真实源代次为自然切集依据；热门榜参与返回Layer；点击即显示无元信息加载宿主，所有异步提交受打开代次约束。
- **HP-04～07 首页、刷新与榜单**：启动默认综合首页，固定展示顺序首页/精彩短剧/电影仓库/纪录片/动漫；四个真实频道ID和60条目录传输分页不变。推荐比例、发现刷新、曝光及先分类后排名按HP表执行；旧7/7/6 AC-28不适用于新首页。
- **HP-08～10 视觉**：非全屏不显示画面内悬浮条；全屏透明紧凑控制层、底栏背景与内容一起收窄、海报密度与Ai剧角标按HP执行。底栏宽度/间距试验不得冒充最终视觉验收。
- **HP-11～12 元数据**：摘要≤240 Unicode code points；年份只从明确年份字段生成；地区/语言各≤64 code points；多个展示副标签最多6个、每项≤12 Unicode code points，只允许可信受控题材/风格证据。所有字段贯通原料、目录/facts/search、种子、解析器与渲染；可选新字段缺失时旧缓存可读。


- **R26-03～06 播放**：左亮度右音量（AC-06/07已修），正常速度为1（正常）/1.25/1.5/1.75/2/2.5/3/4；长按临时倍率设置可改，松开/取消/失焦/离场恢复原正常倍率。独立选集可操作，返回浮层→全屏→播放器；横屏原生隐藏系统栏且退出恢复。全屏倍速/投屏/选集可达，当前集统一同步至详情、高亮、分享、投屏与续播。
- **R26-07/08 浏览**：当前频道/子类第一次重复点击滚头，连续第二次真实刷新，切新分类正常加载并重置重复状态，刷新防重入；每个公开频道顶部热门榜按可信同代热度排序，非仅 isHot+ID。无热度不假排名，不将累计榜称24小时实时榜。
- **R26-09～11 用户状态与提醒**：追剧真实持久化，正在追→同类推荐→完播有独立空间，缓存管理归“我的”；作者二维码可使用旧已确认本地资源 `D:/DEV/prism-play/public/images/author-contact.jpg`（联系）与 `D:/DEV/prism-play/public/images/author-reward.jpg`（自愿赞赏），由host静态注入，不要求虚构云QR字段；放大、文件下载与微信手动识别辅助必须如实反馈，下载不等于保存相册。旧reward图含“截图发微信换长期通行证”历史权益文字，不代表当前购买/授权承诺，须同时展示免责声明；价格、档位和提醒策略仍100%云端。真实累计观看按实际播放经过时间，不用position/seek/假duration，暂停缓冲不计、倍速不乘媒体位移；公开累计按§6.1两个Preference标量保存，private/unknown零计且零落盘。提醒由云配置在自然切集出现、可关闭，缺配置关闭，价格/阈值不猜；核销保持原安全边界。
- **R26-12 管线**：每日新完整 fact pack/目录/bundle/内部publicSearch/manifest 同代发布，blobs先校验上传，再切manifest指针，并配套Worker；禁止单独部署搜索Worker。内部投影描述为 `{schema:1,count,key,bytes,sha256}`，key=`library/search/{sha256}.json`，上限16 MiB；对象为 `{schema:1,revision,entries:[{item,aliases,pinyin,tags}]}`，仅公开同代事实，hash/bytes/count/频道总数一致且返回前复核workFacts，不新增公网路由或响应字段。现代workFacts代缺失/损坏投影一律503，不能回旧D1；仅真实无workFacts旧代可兼容。provider_s1目录/分集元数据不是可播证明，空lines不得发布；公开player解析候选仍须真实完整线路及健康证据。旧publisher拒覆盖不算日更完成。私密资源真实隔离、CI secrets/备份分别另批，不发布private objects，不自动Git或云上线。
- **三轨直接冲突收敛**：底栏3键【精选/追剧/我的】，搜索Overlay，分享仅播放器内；公开目录60条/分片（搜索分页不变）；海报512 MiB、目录20 MiB。公开按作详情多线路直连为受控例外，私密双准入/逐资源校验不因此放宽。
- **状态**：本地seed本轮统计20,163条、“末世”短剧5/AI3仅为seed样本；旧库约70部与另一来源多集、云搜索旧ID/两集、后台来源调查均待复核，不承诺来源数量。

### 10.1.1 真实来源搜索与共享发现（2026-10-06 已批准执行，待实现/验收）

ADR-006 已 Accepted。本节替代旧冻结、只查不存、仅零命中手动补充口径；不改变私密双准入、纯词法边界或运营后台既有目标。

- **端侧**：提交完整查询先显示本机公开结果，默认自动联网补充，无论有无命中；输入法组合/逐键建议不直接触发真实来源搜索。结果纵向三列，全部去重结果可通过继续滚动/加载更多到达；显示准确已展示/已加载计数，不把首批数、单页数或未知总数写成全量总数。本机/联网补充及真实匹配标签清晰，可信题材标签仍按 HP-12，不显示上游品牌。
- **云端**：真实搜索受配置白名单与逐跳 SSRF 校验限制的公开来源，保留独立限流/超时、日志脱敏和同词并发合并。查询键须含规范化查询、频道/标签过滤、public 边界及来源配置版本；并发合并的跨实例范围需实测。核验公开作品身份、可信映射、完整集表/季数与真实可用线路后，幂等共享持久保存 facts 和发现索引；不能同名即合并、空线路入可播库或等待起播才保存。
- **两种生命周期**：关键词查询缓存仅复用新鲜核验结果；共享永久剧库不随关键词 TTL 到期删除。过期须重验、更新新集/新季与线路/撤片事实，持久存在不等于永久可播。真实完成且无结果才短暂负缓存（≤5分钟），超时/限流/来源或核验失败不是无结果，不写成功空集缓存；保留本机结果并提示补充失败/可重试。
- **静态基底 + 共享发现增量**：不每搜重写全量 manifest。静态基底仍按同 generation 完整校验发布，已核验发现以独立持久增量追加/更新；搜索、详情、海报、分享复核所读基底/增量的版本和当前公开可见性。此为受控新事实层，不允许回旧公开 D1 掩盖损坏。客户端按稳定作品 ID/版本去重合并，数据与同步进度原子提交，重启/整包升级/同步失败不误删发现；删除只依据明确撤片/删除事实，整包不含该作品不是删除证明。
- **契约兼容与隔离**：`GET /api/search` 保留 `items/page`、pageSize≤20与可选hasMore（缺省未知）；增可选discoveryPage（1～200）及响应discoveryPending/discoveryFailed/retryAfterSeconds。App按等待秒数自动同词同页poll直到pending结束，切词取消旧poll及迟到响应；成功partial保留已有结果，不伪装empty或确认无结果。public/private/exclude查询、缓存、索引、持久层和日志严格隔离；响应元数据/错误/日志零外部品牌，日志零原始URL/响应/上游域名；仅已批准的播放清单 mediaUrl 运行时例外不扩大。
- **发现同步与Schema**：`GET /api/search/discoveries?after=&limit=`使用独立seq cursor（初始0），limit默认60/max100，返回changes[{seq,workId,operation:upsert|withdraw,updatedAt,card?}],cursor,hasMore；updatedAt为Unix秒，card为可选公开ContentItem。不可复用catalog revision。0005发现五表、0006 jobqueries/jobs两表，总业务37表（不含FTS影子表）；D1存metadata/任务，独立DISCOVERY_BUCKET无r2.dev，R2存事实/cursor。永久剧库metadata与播放事实24小时刷新分离，查询TTL不删metadata；当前基线disabled/private不能被发现覆盖，不回旧公开D1掩盖事实损坏。verify_contracts由主会话更新，本轮不改源码/执行迁移。
- **授权与验收**：必要云端施工/CI/独立验收 APK 已获准；正式官网 APK 与 OTA 仅验收后发布。本次仅七文件文档局部修改，不执行源码/云/权限/Git。G0检查契约门禁；G1验证真实来源与身份/线路/限流/脱敏/并发，G2验证共享持久增量/新季/故障/撤片和客户端原子合并，G3验证三列全部可达/计数/标签/重启与整包升级，G4取得验收证据后正式发布。并行未完工导致门禁失败应如实报告，不修无关代码、不把历史通过当本轮通过。

### 10.1.2 native manifest 与原生播放事实同步（2026-10-06，未完成 Stage A）

- **限定字段**：`EpisodeLine` / `PlaybackLine` 保留必填 `providerId:string` / `mediaUrl:string`，新增 `native?: {kind:'s1-cenc',videoId:string}`，仅 provider_s1 可带。videoId 为1～32位 ASCII 数字字符串（`^[0-9]{1,32}$`），不转数字、保留前导零。native 严格只有 kind/videoId 两键，unknown-field reject，包括 key/cencKeyHex（即使 null）、任意额外键、错误 kind/类型/长度、显式 null/undefined；不能删除 native 后冒充普通明文线路。闭集只针对 native 对象，不把整份响应所有层级说成已严格拒绝未知字段。
- **实际主链与密钥边界**：work manifest / 私有 R2 discovery fact 按作投影，不是 D1 episode 旧 playback。本作身份仍为 workId + episodeNumber；私有 R2 是访问权限属性，不放宽个人探索隔离。native mediaUrl 只是来源候选；原生桥的来源输入仅 vid（videoId，会话/进度控制参数另计），Android runtime resolver 获取实时地址/key，key 不返回 JS，不写 manifest、事实、响应、缓存或日志。Web/native cast 对 native 线路诚实拒绝，不以普通直连/投屏规则宣称 CENC 可播；无 native 的合法普通线路不受此特例扩大影响。
- **事实与未完成项**：Android 本地 CENC DataSource + ExoPlayer 单集已获 Master 播放正常反馈；完整 HUD 集成代码已写/编译但未真机通过。云端授权绑定的播放解析 handle 尚未实现，Stage A 未完成；旧生产 fact 无 native，需刷新，本轮未部署。manifest 支持1～32位，而当前 Java bridge/resolver 仅1～20位，21～32位原生执行仍待接齐，不能宣称全范围可播。单集反馈不证明完整 HUD、后台、授权云链或发布完成。
- **authority 与裁定范围**：AGENTS 仍为 authority，本节仅收窄 §4/§5/§7 历史“全部 ArtPlayer/旧 playback”和 AC-24 全线路投屏描述为普通无 native 线路；native 特例不重写历史 AC 编号、不扩张阶段授权。FLAG_SECURE 仍限 AC-02 个人探索频道/播放，退出解除，不扩大到其他内容。私密双准入、零落盘与 G0→G4 门禁保持。OpenAPI、ADR、index、专门 CENC 计划由主会话负责同步；本次五份文档同步不等于机读契约或任一整体门禁通过，未完成 todos 保留。

### 10.2 通用边界（未被本轮替代者继续有效）

- 响应式断点（唯一口径，与 `design-tokens.css` 一致）：窄屏 `< 768px`、平板/折叠屏 `768px ~ 1023px`、桌面/电视 `≥ 1024px` 四模网格自适应；
- 安全区适配：全面启用 CSS `env(safe-area-inset-top)` 与 `env(safe-area-inset-bottom)`；
- 代码组织红线：单文件 ≤ 300 行（生成契约/迁移文件可说明例外），严禁 Emoji 功能图标，严禁在业务样式硬编码颜色；
- 性能类指标（首屏渲染、起播延迟、内存占用）一律以带机型与网络条件的实测记录为准，未实测不得写为已验证结论；
- 请求级限流（唯一口径，与 PRD 第十/十一章一致）：`/api/redeem` 单 IP **1 分钟最多 10 次**，超限返回 `429` 并按策略临时封禁；
- 商业档位、价格、提醒阶段阈值/间隔、文案和展示档位 100% 由云端下发；接口无有效配置时不显示付费入口，不启用本地猜测价格。提醒只在真实累计播放秒数跨入配置区间且切集自然间隙出现，必须可关闭。
- 本期公开搜索端点仅检索四公开频道；个人探索当次会话只支持其受保护目录浏览，不接入公开补全、语义索引、热词和推荐。如需私密搜索另立不落盘、不共享索引/缓存/日志的准入契约。
- **排版取舍（已定，不再悬置）**：正文基准字号 `15px`、字体栈使用**系统字体**（不内置中文字体包），以保护 6~8MB 安装包目标；如需品牌字体须单独评估体积与授权，不在本期。
- **公开海报缓存策略（已定）**：公开缩略海报统一使用 `Cache-Control: public, max-age=300`，配合 ETag/coverVersion 实现 5 分钟端侧安全复用。
- **分享页资源策略（2026-10-03 v2 修订）**：`/s` 页面使用边缘直出的极简内联样式，不引入站点级 CSS/JS 资产，保证弱网首屏可用。**唯一例外（SPEC-STATIC-PAGES v2 §S-1/S-3 批准）**：允许加载一个**同源自托管**的播放器组件 `/assets/hls.min.js`（CI 上传 R2、immutable 长缓存、白名单文件名），用于非原生 HLS 环境的 MSE 软解；**禁止任何第三方 CDN 与第三方域名资源**，该例外不扩展到 CSS 与其它脚本。
- **可访问性下限**：可点击目标 ≥44px、相邻目标间距 ≥8px、`:focus-visible` 焦点环可见；交互态至少覆盖 `default/hover/focus/active/disabled/loading/error`。

## 11. 内嵌已知坑（防重蹈覆辙）

| 坑点 | 根因 | 标准修法 |
| :--- | :--- | :--- |
| 浏览器/WebView 跨域拦截上游流 | 第三方站源未配 CORS 响应头 | 走 `play.prismos.org/proxy/*` 同源受控代理（白名单 + 防 SSRF + 鉴权）；`CapacitorHttp` 随 `@capacitor/core` 提供且默认不 patch `fetch`，只能作为 JSON 小请求的补充，**不能假设它能解决 HLS 切片跨域与防盗链** |
| Android 挖孔屏顶栏重叠 | 未启用 `overlaysWebView` 与 CSS `safe-area` | 在 `capacitor.config.ts` 开启 `overlaysWebView: true` 并注入 `--safe-top` 变量 |
| 对称签名导致授权可伪造 | 用 HS256 并让客户端持有同一密钥 | 一律改用非对称签名（Ed25519），客户端只内置公钥 |
| 卡密并发超额绑定 | “先查计数再写入”两步决策存在竞态 | `status IN ('UNUSED','ACTIVE') AND device_count < max_devices` 条件更新，与绑定/设备写入同一原子单元；真实 D1 并发测第 10/11 台和失败回滚 |
| 分享页自动播放失败被当成 bug | 浏览器/微信对带声音自动播放有策略限制 | 自动播放只作“尝试”，必须有单次点击兜底与明确文案，不写成绝对承诺 |

## 12. 端到端验证步骤

> 当前 `src/` 与 `edge/src/` 业务源码尚未落地，以下步骤是**待实现的验收脚本**，在对应工作包完成后逐条执行并留存原始输出。

```bash
# 1. 依赖与基础校验
# 阶段 1 开始时选定包管理器并生成唯一 lockfile；不得混用 npm/pnpm
npm ci                          # 前提：已批准并提交 package-lock.json
npm run build                   # 包含 tsc + Vite；在 src/index.html 与业务源码落地后执行

# 2. 契约静态与模型一致性校验（CI 门禁命令）
npm run verify:contracts        # 执行 tests/verify_contracts.py，覆盖 OpenAPI/DDL/SPEC比对/Tokens

# 3. 边缘接口核心成功流（本地 wrangler dev）
curl -s http://localhost:8787/api/channels            # 断言：不含 private 节点
curl -s -X POST http://localhost:8787/api/redeem \
  -H 'Content-Type: application/json' \
  -d '{"code":"<测试卡密>","deviceId":"GY-TEST0001","platform":"android"}'
# 断言：200 且返回 token / expiresAt / tier

# 4. 关键错误流
#    4a. 第 11 台设备绑定 → 断言 400 + COUPON_DEVICE_LIMIT_EXCEEDED
#    4b. 同一设备重复兑换 → 断言幂等成功且 device_count 不增
#    4c. 已吊销卡密即使有剩余名额也拒绝；第 10/11 台并发时只有第 10 台成功
#    4d. 私密剧目分享 → 断言 /s/<private_id> 返回 404
#    4e. 未知剧目分享 → 断言 /s/<unknown_id> 返回 404

# 5. 测试套件（测试文件落地后）
npm test
```

## 12.1 本轮新增验收步骤（待实现，不构成已通过）
1. 用至少一组含同名异剧、可信跨源作品映射、重复批次和 AI 失败的合成来源验证 `source_records` 幂等与目录归并，人工不逐片审；记录任务积压与重试输出。可信映射必须记录依据引用，AI 相似分不得自动升级为映射。
2. 以精确标题、拼音首字母、中文单字及双字、错字、剧情描述、私密及撤片的固定查询集测试 `/api/search*`；禁用 AI 绑定时断言 `degraded=true` 且词法仍可用；所有语义命中回 D1 复核。中文单字仅验证预生成词元机制可命中，排序质量要等真实查询集。
3. Android 先联网缓存公开目录与缩略海报，再断网冷启断言快照快显且点播明确提示联网；制造分页中断、空间不足和 409/410 再恢复，断言本地旧快照/游标不乱；应用 upsert/delete 墓碑并清理旧海报；检查本地数据库、WebView 图片缓存及备份中无个人探索元数据。
4. 未携带有效私密会话逐一请求频道、搜索、目录、详情、分集、代理与分享，断言不可推断私密 ID；私密会话 DELETE 后立刻拒绝、冷启无凭据；HLS 每个子请求须携带双重准入。撤片后在线取流与分享立即拒绝，即使 KV/Vectorize 尚未收敛。
5. 本地测试优先；不在未授权时使用生产内容、写生产云资源或触发收费 AI。Cloudflare 账号套餐/实际配额仍未核实，本期免费降级策略在阶段 1 真实账户只读核对并以测试环境验证；在此之前不启用生产 AI/Vectorize 绑定。

## 12.2 施工前门禁与阶段依赖（2026-10-01）

阶段按依赖推进，三层（客户端/云端/传输）是架构分类，不是开发顺序。LOC 与 Token 为粗范围，详见 `ARCHITECTURE.md` 第五章；本轮仅文档与合成数据核对，业务代码仍为 0。

| 门禁 | 编码前已能验证的条件 | 留待对应阶段真实环境验证的条件 |
| :--- | :--- | :--- |
| **G0 契约复核（本轮已过静态/合成项）** | F/AC 与 API/DDL 核心链对齐；OpenAPI 引用、SQLite 新库初始化、卡密示例/约束、中文词元边界和修订号字段通过静态/内存测试；来源、许可、预算和未完成的行为测试明确标注 | Cloudflare 真实套餐及 AI 可用量未取得；中文搜索质量、目录跨请求原子性、搜索分页稳定性与真机行为尚未实现验证，不能假装通过 |
| **G1 云端事实与身份** | 已配置来源 Adapter 契约、三次重试隔离、D1 内容正本、核销/会话/撤片规则已写明 | 需授权来源样本、真实 D1 并发核销、Workers AI/BGE-M3/Vectorize 免费降级与单次任务成本实测；不接生产内容即止于合成样本 |
| **G2 传输与同步** | 公开分页 revision、增量墓碑、私密无权 404、HLS 子资源逐次鉴权和跨安装归因边界已写明 | 用授权 HLS 流验证 URI 重写/Range/206，私密 HLS 子请求凭据逐次传递与撤销，409/410 及撤片清理；任一未过不开放私密播放。无授权流时仅跑自制样本 |
| **G3 客户端宿主** | 公开快照/海报缓存上限与清理边界、私密零持久化、断网不可点播及真机测试路径已写明 | Android 输入法、缓存/备份隔离、来电/前台服务/FLAG_SECURE 和安装包尺寸均需真机证据 |
| **G4 交付** | 成功与失败场景覆盖 AC-01～18；不向外宣传未验能力 | P0 缺陷归零、授权内容和 APK 发布路径可核对；缺材料时可完成本地验证，不得声称对外上线 |

**剩余不由文档推断的输入**：Cloudflare 套餐/模型额度（此前只读资源列表为空，当前未重新核验），真实合法片单/流与权限范围、Android 真机与发布凭据，以及私密 HLS 逐请求携带当次会话的可行性。没有这些输入不阻止合成数据下的阶段 1 核心代码，但阻止实资源绑定、内容公开发布和最终验收。工程工作包应各自保留失败复试路径，不把后续阶段门禁提前标为已通过。

## 12.3 运营后台增量目标契约（2026-10-05，planned，未签署验收）

关联 `ADMIN-ANALYTICS-AND-COUPON-SPEC-AND-PLAN.md`；用户已授权继续后台实施。本节为 additive 目标，不改 App F/AC-01～30、HP 编号、既有端点/表/视图计数或历史门禁结论。计划顶部的“仅计划”是历史授权快照：已有部分本地数据/认证模块，不代表完整接线、浏览器验证或部署；后台 G0 未签署，G1～G4 不据此标绿。

- **隔离与认证**：同源 `/admin` 页面及 `/api/admin/*` 由 fetch 前置、按段匹配的独立 guard 处理，在公共 CORS/OPTIONS 之前返回；不改 App `routeRequest/withCors`、JWT、私密准入、缓存或 Cookie 行为。口令以 PBKDF2-SHA256 哈希/盐/参数存 `ADMIN_PASSWORD_HASH`，参数须经 Workers CPU 验证；OTP/Cloudflare Access 未实现，不作为已具备保护。
- **会话与防护**：至少256位随机 opaque 会话，D1 仅存 SHA-256 摘要与 CSRF 摘要；`__Host-prism_admin_session` 为 Secure/HttpOnly/SameSite=Strict/Path=/、无 Domain，12小时绝对到期，每次请求查 D1，登出删除，认证版本轮换全失效。缺配置/DB故障 fail closed。登录及写操作校验精确 Origin，登录 JSON ≤8 KiB，已登录 POST 还需会话绑定 CSRF；GET 无副作用。管理响应 no-store、不开放 CORS，安全头及限流按关联计划§2.3；不接受 App JWT。
- **目标接口**：GET `/admin`（登录页/受保护后台）、`/api/admin/session`、`dashboard`、`coupons`、`coupons/{id}`、`operations`；POST `/api/admin/login`、`logout`、`coupons/generate`、`coupons/{id}/reveal|confirm-stock|dispatch|revoke`。GET 不登录、不登出、不揭示全码。详情 id 为 SHA-256(code) opaque 标识，列表返回 id/掩码，全码不进 URL、日志或 localStorage。独立 `AdminError` 见 API-SPEC，不扩 App 闭合错误码。
- **资产一致性**：generate/reveal/confirm-stock/dispatch/revoke 必带 requestId；同请求同载荷重试幂等，复用不同载荷或状态竞争返回409；条件写、资产与成功审计同 D1 事务，零行更新整批回滚，不先查后无条件写。新码 Q/B/Y/S、12位 crypto 随机载荷并兼容既有兑换格式、ACTIVE+IDLE，1～100张/批、备注≤200字符；A只读历史。UNKNOWN 旧库存人工 confirm-stock 后才可 IDLE；仅 IDLE、未 REVOKED、device_count=0 可 dispatch，复制/reveal 不代表分发。REVOKED 仅停止继续核销，**不撤回已有设备会员权限**。
- **统计与运维边界**：页面访问请求仅合法公开页 GET 200；下载仅校验 APK 存在后的302“下载触发”，不是完成/安装。可选同意 Cookie UV 为浏览器标识去重，不是用户人数，不能自动关联 APK/device_id；无标识单列，私密/后台/404/API不计。operations 只读授权设备、失败样本、android OTA；无成功样本不能算健康率，**一期无 OTA 写发布**。隐私、缓存、清理及转化交集口径按关联计划§2.1～2.4和静态页增量执行。

后台独立待验项：会话到期/撤销/轮换、Origin/CSRF/无CORS/fail closed，真实D1并发/回滚/requestId冲突，全码脱敏与双标签409，Cookie同意/撤回及统计失败不阻断前台，浏览器黄金/异常路径及全量 App 无回归。静态契约同步不是这些行为通过或生产发布授权。

## 13. 变更记录
| 日期 | 变更内容 | 原因 | 影响范围 |
| :--- | :--- | :--- | :--- |
| 2026-10-06（native事实同步） | 新增§10.1.2，EpisodeLine/PlaybackLine保留providerId/mediaUrl并增key-free native；provider_s1限定、1～32位数字字符串、native未知字段严格拒绝；实际work manifest/私有R2 discovery fact，原生vid/runtime key不返JS、Web/native cast拒绝 | 单集Master反馈与完整HUD编译/未真机通过分离；授权绑定handle未实现，Stage A未完成，旧生产fact待刷新、未部署；当前Java仅1～20位执行缺口保留 | 仅本次五份限定文档；AGENTS authority、AC-02 FLAG_SECURE及G0→G4不扩大；OpenAPI/ADR/index/专门CENC计划由主会话同步，原todos保留 |
| 2026-10-06（真实搜索与共享发现） | ADR-006 Accepted；新增§10.1.1，本机先显/默认自动联网（有无命中均补充）、三列全可达/准确计数标签、真实来源核验后共享持久保存、查询新鲜缓存/并发合并/短负缓存、静态全量基底+独立发现增量、重启整包不误删、新集新季更新；GET /api/search 可选hasMore | 用户明确批准执行，替代冻结/只查不存/零命中手点；必要云/CI/独立验收APK获准，官网APK/OTA验收后；本次仅文档，不宣称部署验收 | ADR006、正本、云SPEC、PRD、UIUX、API-SPEC/OpenAPI局部同步：新增GET /api/search/discoveries独立seq，discoveryPage及pending/failed/retry轮询，0005/0006共37业务表，D1 metadata/R2事实cursor、无r2.dev独立bucket、基线disabled/private不可覆盖、metadata与24小时播放事实刷新分离；保留全部运营修改；verify_contracts由主会话更新，本次不宣称发布 |
| 2026-10-05（后台增量目标） | 新增§12.3同源独立后台guard、哈希口令/12小时D1 opaque会话、Origin/CSRF/no-CORS/no-store、卡密requestId事务/幂等/409与opaque详情ID、AdminError、浏览器UV/下载触发和OTA只读边界 | 用户授权继续后台实施后同步目标契约；局部源码不等于完整实现，后台G0未签署、无部署 | SPEC、云/静态页SPEC、PRD、UIUX、API-SPEC；OpenAPI由主任务另行同步，不改App AC及既有计数 |
| 2026-10-04（执行事实同步） | 完整读取已新增following-store/watch-time/settings-support及publicSearch generation/manifest/打包日更模块；补同库local_following DDL与created_at、独立收藏清理/无云sync、两项Preference标量/private零计；允许host注入旧已确认contact/reward资源并披露历史权益文字；内部投影同代blobs→pointer+Worker配套、现代缺投影503 | 用户已授权计划与完整修复；本次仅更新文档，不触碰业务/权限/AGENTS/Git写操作；纠正“全部未实现”和虚构云QR前置条件 | 正本、修复SPEC/计划、PRD/UIUX/API-SPEC/OpenAPI；局部实现不等于R26全完成，历史1040通过后新全量及浏览器/原生/生产仍待验 |
| 2026-10-04（v2.6修复契约） | §10.1关联R26-01～12；纠正F-02/视图/AC-06、07左亮右音，AC-20系统栏恢复、AC-21浮层优先；同步公开60条分片/三Tab/512 MiB及同代搜索，定义倍速、重复分类刷新、频道热榜、持久追剧、二维码与真实观看提醒；创建修复计划及增量SPEC | 用户授权仅写文档；源码冷启搜索接线缺口与seed已只读核实，来源/云响应/真机/日更待证，不改2.6.2 tag、不自动Git/部署 | 正本、PRD、UIUX、API-SPEC、OpenAPI、三轨SPEC；R项全部待实现/待验收，旧30项不作本轮通过证明 |
| 2026-09-30 | 创立 `D:\DEV\prism-play` 并冻结 v2.0.0 Spec | 品牌升维为《光影Play》，全面采用方案 B (Capacitor 7 + TS + ArtPlayer + Cloudflare) | 全局基线 |
| 2026-09-30（夜） | 施工前契约收敛：补入 F-05/F-10 与 AC-08~11；认证由 HS256 改 Ed25519；档位统一为 Q/A/B/Y/S 并明确个人探索仅 B/Y/S；卡密上限与异常计数改为可达口径；离线承诺收窄为“授权可验证”；新增内容目录/分集/播放解析/私密会话/设备 ping/受控代理端点；移除本期 AI 端点；断点统一 768px | 历史基线，部分范围已由 2026-10-01 变更修订 | PRD、SPEC、OpenAPI、API-SPEC、ARCHITECTURE、D1 Schema、UIUX、Design Tokens、工程配置 |
| 2026-10-01 | F-13～15 / AC-16～18：已配置来源 AI 自动加工、混合搜索、公开列表海报本地缓存；Windows 与离线视频后移；私密无权表现统一；单 URL 边缘择源；在线续期返回新 JWT。Workers AI/Vectorize 本期有限引入，套餐/用量未核，免费降级且不自动付费 | 按 Master 一次性选择同步补齐客户端、云端、传输与数据全链 | PRD、UIUX、ARCHITECTURE、ADR-003、OpenAPI、API-SPEC、D1 Schema、SPEC、项目索引、README、wrangler 注释 |
| 2026-10-01（施工前复核） | 修正卡密示例/频道 B/Y/S、会话撤销、公开目录原子变更、默认未发布、设备 ID 边界、HLS 子资源与私密凭据传递、跨安装归因及过期工作包；补缓存容量、可信跨源映射、来源重试上限和 G0～G4 门禁 | 消除编码直接撞上的矛盾，将静态/合成验证与真实资源门禁分开 | PRD、UIUX、ARCHITECTURE、ADR-001/002/003、OpenAPI、API-SPEC、D1 Schema、SPEC、wrangler、README、索引 |
| 2026-10-03 | §9 增补 **AC-19～AC-30** 十二条（全屏唯一权威与画幅零裁切、签名恒定、公网分享、DLNA 投屏、外壳视觉收敛、端侧混排、微光角标、端云同步），并确立"本节为 AC 编号唯一权威"纪律；同步 PRD §12.6 与 `tests/verify_acceptance.py`（18→30）、`tests/verify_contracts.py` AC 闭集 | 客户端波次 `PLAYER-FULLSCREEN-SIGNING-UPDATE-SPEC-AND-PLAN.md` v2.5 交付新验收；旧 v2.4 草案曾撞用 AC-01～12，会让门禁把新用例记到语义无关条目上形成假绿，故占用未使用区段并回写唯一权威 | SPEC §9/§13、PRD §9/§12.6、验收与契约门禁 |
| 2026-10-03（重构 v2 三轨） | 采纳 `SPEC-STATIC-PAGES/SPEC-CLOUD-REFACTOR/SPEC-APP-REFACTOR` v2：§10 分享页资源策略开**同源自托管 hls.min.js** 唯一例外（禁第三方 CDN）；API-SPEC §〇「上游地址零暴露」收窄为"目录/文案/页面源码零暴露"，剧集清单 `lines[].mediaUrl` 成为受控运行时例外（App/分享页直连上游 CDN，实测 CORS 开放），`/proxy/media` 保留为旧客户端兼容通道；目录读路径改 R2 分片（60 条/片）+ KV 清单，D1 内容大表标记 DEPRECATED（0003，不物理 DROP），新增 `line_health_signals` 遥测表与 `POST /api/telemetry/lines`；ContentItem 增补 `firstPublishedAt/hitsTotal`；私密定级双条款（五源全量私密 + 魔都 tid 6/39 归私密）；AGENTS.md 二·3 同步澄清 `/s` 手动蒙层不属自动跳出 | 免费配额三条熔断线（Workers 请求 10 万/天、D1 行读 500 万/天、上游封 Cloudflare IP）证明"云端代理一切"不可持续；第一性原理回摆为重客户端 + 最小云端 | SPEC §10/§13、API-SPEC §〇/§五、AGENTS.md 二·3、OpenAPI（22 路径）、D1 Schema（23 表）、三份 v2 SPEC、CI 管线 |
| 2026-10-05（首页与播放器HP增量） | 新增HP-01～12，不重用AC编号；同步综合首页/固定真实频道导航、60条推荐轨与供给回退、发现刷新/分类榜、播放器结束源代次/即刻loading/返回层、全屏控件/底栏承载区/海报角标与公开元数据可选字段边界 | 执行 `HOME-PLAYER-REPAIR-SPEC-AND-PLAN.md`；基于本地harvest字段覆盖，摘要240、年份严格字段、地区/语言64；原始tag不直接作为展示标签；未定的热度可比性、口碑门槛、曝光视口/停留值与最终间距不伪装为批准值 | SPEC及HP计划、PRD、UIUX、API-SPEC/OpenAPI、云/客户端三轨、Tokens；业务HP全部待实施/待验，静态门禁不等于行为完成 |

