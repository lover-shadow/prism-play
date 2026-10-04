# Spec - 《光影Play》(Prism Play) v2.0.0

> **生成日期**：2026-09-30（2026-09-30 夜间完成施工前契约收敛）  
> **基于文档**：`PRD-prism-play.md` + `ARCHITECTURE.md` + `UIUX-design-system.md` + `openapi.yaml`  
> **状态**：2026-10-01 编码前 G0 静态/合成契约复核完成；本版为施工与验收主依据，与 PRD/OpenAPI/SQL 冲突时同步修正；G1～G4 的真实 D1、AI、HLS 与 Android 行为尚未经实测，不得宣称完整交付门禁通过

---

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
| **AC-01** | 大视界加载 | When 用户启动应用，若有四公开频道快照则先渲染本地快照、后台同步，若无则拉云端快照；默认高亮【短剧精选】。首屏耗时须标注机型与网络真机实测（目标 ≤1.2s，未测不算通过） | P0 |
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
| **AC-27** | 底部Tab栏宽度收缩 | When 底部导航栏渲染，其内容承载区必须限宽 360px 并水平居中，杜绝全面屏上的过度横向拉伸 | P1 |
| **AC-28** | 端侧推荐混排 | When 首页片单落定，系统必须按 id 稳定序基线与 7 天半衰期本地画像分，编织出严格 20 条一块（7 AI / 7 热门 / 6 探索）的混排序列，三轨互斥零重复，且「加载更多」只追加尾块、已固化块零重排，单块计算耗时目标 ≤2ms | P1 |
| **AC-29** | 海报极简微光角标 | When 海报卡渲染，角标必须只在有依据时出现（贴标唯一判据为 `isAi === true` / `isHot === true`），字段缺失或全 false 时留白不贴标；前景色必须取自深浅双模同值的 `--badge-*` tokens，业务 CSS 零字面色值、零 emoji | P1 |
| **AC-30** | 端云状态多端同步 | When 播放器销毁或应用挂起（`isActive === false`），系统必须以 `keepalive` 上报 `/api/user/sync` 并在失败时由待发队列于下次冷启补传；When 进入【追剧】页或新设备激活，系统必须拉取云端断点按 `updatedAt` 取较新者合并并继承偏好画像；私密内容必须经 `assertWritable()` 拦截实现零上报；严禁心跳轮询 | P0 |

> AC-01～AC-15 与 `PRD-prism-play.md` 第九章逐条对应；AC-16～AC-18 与 PRD 第十二章新增验收对应，编号、口径与边界必须一致；AC-19～AC-30 由 `PLAYER-FULLSCREEN-SIGNING-UPDATE-SPEC-AND-PLAN.md`（v2.5）波次新增，与 PRD §12.6 逐条对应。
>
> **编号纪律**：本节是 `AC-xx` 的唯一权威来源。测试标题只能署名本节存在的编号；新增验收必须占用未使用区段并同步本节与 PRD——撞号不会报错，只会把用例记到语义无关的条目上形成假绿。


## 10. 边界与约束

### 10.1 v2.6 修复正本规则（R26，未验收）

本轮增量以 `D:/DEV/prism-play/docs/04-spec/SPEC-v2.6.3-REPAIR.md` R26-01～12 和 `REPAIR-v2.6.2-PLAN.md` 分批落实，不改变 v2.6.2 tag，不新增 AC 编号。已有 AC-01～30 矩阵不得作为这些修复通过的证明；本地业务修复已局部落地，新全量回归、浏览器、真机与生产日更均待验；历史1040项通过只属于首批代码快照。旧章节中云端公开 D1/代理唯一入口、四主Tab及128 MiB海报口径由三轨 v2 与下列规则取代；私密旧双准入路径和核销安全边界不变。

- **R26-01/02 搜索与事实**：完整公开快照 hydrate 必须发送全量索引 feed，search/suggestions 在判 fallback 前等待 init/queued sync，核验 revision 与实际公开 count；索引未就绪不能冒充零结果或默认联网。目录、搜索/补全/related、详情、分享、海报使用同 generation 公开事实，禁止旧 anime ID 或两集截断、禁止有 workFacts 时回读旧公开 D1。来源覆盖以待证矩阵调查，不能将 provider_m3 部分合集不足推广为全部来源结论。
- **R26-03～06 播放**：左亮度右音量（AC-06/07已修），正常速度为1（正常）/1.25/1.5/1.75/2/2.5/3/4；长按临时倍率设置可改，松开/取消/失焦/离场恢复原正常倍率。独立选集可操作，返回浮层→全屏→播放器；横屏原生隐藏系统栏且退出恢复。全屏倍速/投屏/选集可达，当前集统一同步至详情、高亮、分享、投屏与续播。
- **R26-07/08 浏览**：当前频道/子类第一次重复点击滚头，连续第二次真实刷新，切新分类正常加载并重置重复状态，刷新防重入；每个公开频道顶部热门榜按可信同代热度排序，非仅 isHot+ID。无热度不假排名，不将累计榜称24小时实时榜。
- **R26-09～11 用户状态与提醒**：追剧真实持久化，正在追→同类推荐→完播有独立空间，缓存管理归“我的”；作者二维码可使用旧已确认本地资源 `D:/DEV/prism-play/public/images/author-contact.jpg`（联系）与 `D:/DEV/prism-play/public/images/author-reward.jpg`（自愿赞赏），由host静态注入，不要求虚构云QR字段；放大、文件下载与微信手动识别辅助必须如实反馈，下载不等于保存相册。旧reward图含“截图发微信换长期通行证”历史权益文字，不代表当前购买/授权承诺，须同时展示免责声明；价格、档位和提醒策略仍100%云端。真实累计观看按实际播放经过时间，不用position/seek/假duration，暂停缓冲不计、倍速不乘媒体位移；公开累计按§6.1两个Preference标量保存，private/unknown零计且零落盘。提醒由云配置在自然切集出现、可关闭，缺配置关闭，价格/阈值不猜；核销保持原安全边界。
- **R26-12 管线**：每日新完整 fact pack/目录/bundle/内部publicSearch/manifest 同代发布，blobs先校验上传，再切manifest指针，并配套Worker；禁止单独部署搜索Worker。内部投影描述为 `{schema:1,count,key,bytes,sha256}`，key=`library/search/{sha256}.json`，上限16 MiB；对象为 `{schema:1,revision,entries:[{item,aliases,pinyin,tags}]}`，仅公开同代事实，hash/bytes/count/频道总数一致且返回前复核workFacts，不新增公网路由或响应字段。现代workFacts代缺失/损坏投影一律503，不能回旧D1；仅真实无workFacts旧代可兼容。provider_s1目录/分集元数据不是可播证明，空lines不得发布；公开player解析候选仍须真实完整线路及健康证据。旧publisher拒覆盖不算日更完成。私密资源真实隔离、CI secrets/备份分别另批，不发布private objects，不自动Git或云上线。
- **三轨直接冲突收敛**：底栏3键【精选/追剧/我的】，搜索Overlay，分享仅播放器内；公开目录60条/分片（搜索分页不变）；海报512 MiB、目录20 MiB。公开按作详情多线路直连为受控例外，私密双准入/逐资源校验不因此放宽。
- **状态**：本地seed本轮统计20,163条、“末世”短剧5/AI3仅为seed样本；旧库约70部与另一来源多集、云搜索旧ID/两集、后台来源调查均待复核，不承诺来源数量。

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

## 13. 变更记录
| 日期 | 变更内容 | 原因 | 影响范围 |
| :--- | :--- | :--- | :--- |
| 2026-10-04（执行事实同步） | 完整读取已新增following-store/watch-time/settings-support及publicSearch generation/manifest/打包日更模块；补同库local_following DDL与created_at、独立收藏清理/无云sync、两项Preference标量/private零计；允许host注入旧已确认contact/reward资源并披露历史权益文字；内部投影同代blobs→pointer+Worker配套、现代缺投影503 | 用户已授权计划与完整修复；本次仅更新文档，不触碰业务/权限/AGENTS/Git写操作；纠正“全部未实现”和虚构云QR前置条件 | 正本、修复SPEC/计划、PRD/UIUX/API-SPEC/OpenAPI；局部实现不等于R26全完成，历史1040通过后新全量及浏览器/原生/生产仍待验 |
| 2026-10-04（v2.6修复契约） | §10.1关联R26-01～12；纠正F-02/视图/AC-06、07左亮右音，AC-20系统栏恢复、AC-21浮层优先；同步公开60条分片/三Tab/512 MiB及同代搜索，定义倍速、重复分类刷新、频道热榜、持久追剧、二维码与真实观看提醒；创建修复计划及增量SPEC | 用户授权仅写文档；源码冷启搜索接线缺口与seed已只读核实，来源/云响应/真机/日更待证，不改2.6.2 tag、不自动Git/部署 | 正本、PRD、UIUX、API-SPEC、OpenAPI、三轨SPEC；R项全部待实现/待验收，旧30项不作本轮通过证明 |
| 2026-09-30 | 创立 `D:\DEV\prism-play` 并冻结 v2.0.0 Spec | 品牌升维为《光影Play》，全面采用方案 B (Capacitor 7 + TS + ArtPlayer + Cloudflare) | 全局基线 |
| 2026-09-30（夜） | 施工前契约收敛：补入 F-05/F-10 与 AC-08~11；认证由 HS256 改 Ed25519；档位统一为 Q/A/B/Y/S 并明确个人探索仅 B/Y/S；卡密上限与异常计数改为可达口径；离线承诺收窄为“授权可验证”；新增内容目录/分集/播放解析/私密会话/设备 ping/受控代理端点；移除本期 AI 端点；断点统一 768px | 历史基线，部分范围已由 2026-10-01 变更修订 | PRD、SPEC、OpenAPI、API-SPEC、ARCHITECTURE、D1 Schema、UIUX、Design Tokens、工程配置 |
| 2026-10-01 | F-13～15 / AC-16～18：已配置来源 AI 自动加工、混合搜索、公开列表海报本地缓存；Windows 与离线视频后移；私密无权表现统一；单 URL 边缘择源；在线续期返回新 JWT。Workers AI/Vectorize 本期有限引入，套餐/用量未核，免费降级且不自动付费 | 按 Master 一次性选择同步补齐客户端、云端、传输与数据全链 | PRD、UIUX、ARCHITECTURE、ADR-003、OpenAPI、API-SPEC、D1 Schema、SPEC、项目索引、README、wrangler 注释 |
| 2026-10-01（施工前复核） | 修正卡密示例/频道 B/Y/S、会话撤销、公开目录原子变更、默认未发布、设备 ID 边界、HLS 子资源与私密凭据传递、跨安装归因及过期工作包；补缓存容量、可信跨源映射、来源重试上限和 G0～G4 门禁 | 消除编码直接撞上的矛盾，将静态/合成验证与真实资源门禁分开 | PRD、UIUX、ARCHITECTURE、ADR-001/002/003、OpenAPI、API-SPEC、D1 Schema、SPEC、wrangler、README、索引 |
| 2026-10-03 | §9 增补 **AC-19～AC-30** 十二条（全屏唯一权威与画幅零裁切、签名恒定、公网分享、DLNA 投屏、外壳视觉收敛、端侧混排、微光角标、端云同步），并确立"本节为 AC 编号唯一权威"纪律；同步 PRD §12.6 与 `tests/verify_acceptance.py`（18→30）、`tests/verify_contracts.py` AC 闭集 | 客户端波次 `PLAYER-FULLSCREEN-SIGNING-UPDATE-SPEC-AND-PLAN.md` v2.5 交付新验收；旧 v2.4 草案曾撞用 AC-01～12，会让门禁把新用例记到语义无关条目上形成假绿，故占用未使用区段并回写唯一权威 | SPEC §9/§13、PRD §9/§12.6、验收与契约门禁 |
| 2026-10-03（重构 v2 三轨） | 采纳 `SPEC-STATIC-PAGES/SPEC-CLOUD-REFACTOR/SPEC-APP-REFACTOR` v2：§10 分享页资源策略开**同源自托管 hls.min.js** 唯一例外（禁第三方 CDN）；API-SPEC §〇「上游地址零暴露」收窄为"目录/文案/页面源码零暴露"，剧集清单 `lines[].mediaUrl` 成为受控运行时例外（App/分享页直连上游 CDN，实测 CORS 开放），`/proxy/media` 保留为旧客户端兼容通道；目录读路径改 R2 分片（60 条/片）+ KV 清单，D1 内容大表标记 DEPRECATED（0003，不物理 DROP），新增 `line_health_signals` 遥测表与 `POST /api/telemetry/lines`；ContentItem 增补 `firstPublishedAt/hitsTotal`；私密定级双条款（五源全量私密 + 魔都 tid 6/39 归私密）；AGENTS.md 二·3 同步澄清 `/s` 手动蒙层不属自动跳出 | 免费配额三条熔断线（Workers 请求 10 万/天、D1 行读 500 万/天、上游封 Cloudflare IP）证明"云端代理一切"不可持续；第一性原理回摆为重客户端 + 最小云端 | SPEC §10/§13、API-SPEC §〇/§五、AGENTS.md 二·3、OpenAPI（22 路径）、D1 Schema（23 表）、三份 v2 SPEC、CI 管线 |

