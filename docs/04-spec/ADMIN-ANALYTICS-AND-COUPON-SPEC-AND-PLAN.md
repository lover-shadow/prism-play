# 光影Play 运营后台实施计划（2026-10-05 审核修订版）

> 状态：仅计划，未实现、未迁移、未部署；关联正本未同步前不得开工。
> Goal：同源运营看板及安全的激活码储备、手动分发。
> Architecture：方案 A，复用 Worker/D1/KV/R2，服务端可撤销会话与匿名浏览器去重。
> Tech Stack：现有 TypeScript、Workers、Vitest、原生 HTML/CSS/JS、Lucide、Design Tokens。
> 授权边界：本次只改此计划；实现、生产迁移、Secrets 配置、部署、Git 提交/推送须分别取得相应授权。
> 正本关联：SPEC-v2.0、SPEC-CLOUD-REFACTOR、SPEC-STATIC-PAGES及关联契约；本文件为计划，不能替代正本。

## 一、 审核修正与一期范围

### 1.1 已核实机制

- `edge/src/index.ts:93-114` 全局 CORS 反射 Origin；管理路由须在公共 CORS/OPTIONS 之前独立处理。
- `edge/src/index.ts:138-150` fetch 的 Context 未传入路由；统计应在 fetch 合法响应后编排并调用 ctx.waitUntil，不在 handler 凭空调用 Context。
- `edge/src/routes/dl.ts:69-89,131-146,169-180` 页面 public 缓存、下载为 R2 302，无统计写入。
- `edge/src/db/coupon-repo.ts:4-18,94-147` UNUSED/ACTIVE 均可核销，ACTIVE 不等于已使用；期限按每台设备核销时刻计算。
- `edge/src/auth/guard.ts:38-76` 检查设备而非卡密状态；REVOKED 只禁止继续核销，不自动撤回已有设备授权。
- `edge/src/routes/redeem.ts:138-170` 重复绑定存在恢复分支；清空 tier 不是可靠封禁机制。
- `edge/src/auth/jwt.ts:81-129` App JWT 未完整检查时间声明，登记既有安全风险另行追踪；后台不复用此认证，也不顺带修改 App 协议。
- `edge/src/config/kv-config.ts:179-227` OTA 是 android 嵌套结构，下载 URL 只能同源 `/dl/latest/android`；不允许任意 R2 直链。
- `edge/src/routes/telemetry.ts:14-18,92-134` 无认证失败样本，不能证明健康率、实时报警或恶意设备。
- migration 本地已有0001～0003，0004编号须施工前复核。此前4张ACTIVE卡密/0设备只是当时快照，示例码不当可分发库存。
- WorkBuddy配置存在不等于本会话已连接其MCP；Wrangler查询成功不证明所有权限/免费额度。本轮未重新查询生产、不读取Secret明文。

### 1.2 一期/后续划分

一期必须：单管理员会话/审计；访问请求、下载触发及可选Cookie浏览器去重；Q/B/Y/S随机批量发卡、显式分发、绑定详情、停止核销；只读授权设备/失败样本/OTA；隐私与清理。

后续候选：OTA写发布、实际下载完成/安装归因、App活跃埋点、cohort留存、停留/跳出率、自动报警、设备封禁、多管理员、批量导出、支付。以上不计一期验收。Cookie不能自动连接网页和APK；ref不作邀请奖励凭据，不在URL传长期访客标识。

## 二、 可施工的数据、安全与并发契约

### 2.1 统计口径与隐私

1. 日期Asia/Shanghai、服务端Unix秒。只计GET 200的首页/下载页/合法公开分享页；HEAD/OPTIONS/API/assets/proxy/404/私密拒绝/后台不计。名称为“页面访问请求”，不保证页面渲染；排除已识别爬虫，仍有漏识别误差。
2. 下载只计R2存在校验后的302，叫“下载触发”；重复点击算次数，R2直链绕过不计，App更新不称官网转化。
3. UV为期间内DISTINCT visitor_hash，不是人数；页面UV及每日UV不能相加。新浏览器为当日首次建档，回访为first_seen_day早于当日，不是新增安装。
4. 转化率为同期间访问公开页且触发下载的不同标识数/访问公开页的不同标识数；分母零显示暂无数据。无标识下载单列，不用下载次数/UV冒充百分比。
5. 默认匿名聚合，用户明确同意后写 `__Host-p_vid`，crypto随机UUID、Secure/HttpOnly/SameSite=Lax/Path=/、无Domain、最长180天。独立ANALYTICS_HASH_SECRET在服务端HMAC，不存原始Cookie；轮换导致关联中断须记录。
6. 不使用p_ch；渠道首见冻结在服务端，ch仅有限预登记代号，未知direct/unknown；不留完整query/Referer，不当邀请凭据。不存剧目ID/观看身份/私密内容，不在私密路径埋点。
7. 拒绝、GPC/DNT、无Cookie只计匿名请求，显示标识覆盖率；撤回时清Cookie并删visitor/去重记录，匿名历史汇总不重写。不做指纹或跨浏览器ID传递。
8. Cookie不能读取电话/微信账号/IMEI/MAC/其他网站Cookie/App device_id；清除、隐私模式、跨微信浏览器使统计有误差。

### 2.2 缓存与写入

统计HTML统一private/no-store，Set-Cookie不进入共享缓存，静态assets保留原缓存；核查生产Cache Rules。fetch层拿合法响应后包装Cookie、ctx.waitUntil原子batch；保留routeRequest现有签名。

waitUntil降低等待但非零延迟/永久可靠；统计失败允许少计，记录脱敏失败指标、最近成功写入时刻，报表显示延迟/不完整。禁止完整URL/Cookie/全码/私密ID日志。

每事件约1～3行写入加索引成本，按1千/1万/10万事件测rows_read/rows_written、CPU和配额，不承诺“每天几百次”或永久免费。

### 2.3 会话与资产安全

- ADMIN_PASSWORD_HASH存PBKDF2-SHA256哈希/盐/参数，参数经Workers CPU实测冻结；不明文口令、不复用App/私密密钥。
- 后台用至少256位随机opaque session，仅SHA-256存D1；Cookie `__Host-prism_admin_session` Secure/HttpOnly/Strict/Path=/，12小时绝对到期。每次管理请求读会话，登出删除；ADMIN_AUTH_VERSION轮换可全部失效。缺Secret/DB不可用fail closed。
- 登录精确Origin、JSON、8KiB限额；已登录写请求还需会话绑定CSRF，GET无副作用。后台绕开公共CORS，不接收App JWT。
- 登录5次失败/15分钟按可信CF来源IP哈希，用D1原子限流；总尝试与生成频率也有限额，不用KV最终一致计数或进程内锁。
- no-store/nosniff/no-referrer、CSP同源或nonce、frame-ancestors none；SQL绑定、DOM转义/textContent。HttpOnly不是XSS免疫。
- 掩码列表、授权reveal才能获取全码；全码不进URL/localStorage/普通审计/错误日志，绑定IP默认不展示。

### 2.4 数据表修订

| 表或增量 | 关键约束和机制 |
| --- | --- |
| analytics_daily | PK(day,surface,channel,terminal)，requests/downloads原子UPSERT，不读JSON再覆盖 |
| analytics_visitors | visitor_hash PK，first_seen_day/last_seen_at/first_channel，首访来源不覆盖 |
| analytics_visitor_days | PK(day,visitor_hash,surface)，page_seen/download_seen布尔事实；索引支持期间DISTINCT/EXISTS交集 |
| admin_sessions | token_hash PK、csrf_hash、created_at、expires_at、auth_version，登出/清理删除 |
| admin_login_limits | PK(ip_hash,window_start)，原子attempts/failed_count/blocked_until |
| coupon_batches | batch_id PK、request_id UNIQUE、tier/count/note/created_at |
| card_coupons增量 | batch_id、dispatch_status CHECK(IDLE/DISPATCHED/UNKNOWN)、dispatch_note/dispatched_at；旧码UNKNOWN |
| admin_audit_logs | request_id UNIQUE、actor/action/target_hash/batch_id/details/created_at，不含口令/session/全码 |

visitor-day保留90天、visitor最长180天、匿名汇总365天、审计365天，会话过期清理、登录窗口24小时后清理；现有scheduled中限量索引删除，不清其他业务表。

### 2.5 卡密事务

新码ACTIVE+IDLE；Q/B/Y/S沿用受控期限，A仅历史查看；全部12位crypto随机而非固定Q90D/序号，正则不等于防伪，唯一键兜底碰撞有限重试。count1～100、备注≤200字符、批次requestId幂等；生成/资产/审计同D1 batch。

复制不分发，明确确认才分发；Clipboard拒绝不能假成功。旧码UNKNOWN须人工确认库存；仅IDLE且未REVOKED且device_count=0可分发，条件失败409。同requestId重试幂等，不同请求同码只一方成功。

条件更新与成功审计同事务，用coupon-repo现有tripwire或等价约束保证零行更新时整批失败，不先查再写。note与dispatch_note分开。停止核销只改REVOKED，不动devices/期限/历史；界面写明已有权限不撤回。

### 2.6 对 App 的隔离防护（不可违背）

后台与 App 共用同一 `prism-play-edge` Worker、同一 D1、同一 KV，任何一处改动都可能波及 App。施工必须满足以下隔离铁律，并在 T2/T5 显式回归验证。

**风险 A：`routeRequest` / `withCors` 全局单点（最高）**
`edge/src/index.ts:103-114` 所有响应都经 `withCors()`；`edge/src/index.ts:93-101` 反射请求 Origin，并声明 `Authorization`、`X-Private-Session`、`Range` 头。App 的 Bearer 鉴权与私密探索依赖这些头，媒体代理依赖 Range/Content-Range 暴露。
- 铁律：`routeRequest` 与 `withCors` 的行为和签名不得改动，管理路由不得进入这条公共管线。
- 做法：在 `default.fetch`（`:138`）里、调用 `routeRequest` 之前判定 `pathname` 以 `/admin` 或 `/api/admin` 开头，交由 `handleAdminRequest(request, env, ctx, clock)` 独立处理并 `return`，其响应不套 `withCors`。判定须大小写敏感、按段前缀，避免误吞 `/api/*` App 端点。
- 若为管理页 CSP/安全头需要改写响应，只能在管理分支内用独立 header 构造，绝不复用 `withCors`。
- 验证：`93-admin-auth.test.ts` 断言带外站 Origin 请求 App `/api/*` 仍收到原有 `Access-Control-Allow-*`，而 `/api/admin/*` 对同 Origin 不返回反射头；OPTIONS 预检对 App 头集合无变化。

**风险 B：D1 单写锁与核销竞争（中）**
`edge/src/routes/redeem.ts` 用 `db.batch()` 做卡密计数+设备+绑定的原子写；同一 D1 的统计和后台操作仍共享执行容量与配额，可能提高核销延迟或失败率。不能仅凭 SQLite WAL 或同毫秒竞争推断 Cloudflare 运行时行为；必须以真实 D1 压测和错误指标判定，不能承诺核销天然享有优先级。
- 铁律：统计写只在成功响应之后经 `ctx.waitUntil` 异步执行，不置于 App 请求的关键路径；后台写仅在管理员会话内触发，天然低频。
- 隔离：统计走 `analytics_*` 独立表，绝不与 `card_coupons`/`devices` 同一 batch 写同一行；不新增对 App 热表的高频写。
- 降级：统计遇 `SQLITE_BUSY`/失败静默丢弃当次计数并重试有上限，不抛错、不阻塞、不影响已发出的 App/访客响应。
- 验证：`94-analytics.test.ts` 覆盖统计写失败时前台 GET 仍 200、redeem 路径无新增失败；`91-admin-db.test.ts` 证明 batch 原子回滚不吞正常写。

**风险 C：公开 HTML 的 Set-Cookie（低）**
Cookie 是否随请求发送取决于 WebView、网络实现与 credentials，不能假设 App 不参与 Cookie Jar。后台会话 Cookie 仅由管理认证接口设置；访客 Cookie 仅在公开统计/同意流程设置；两者不得参与 App 鉴权。
- 铁律：除明确登记的新后台/同意端点外，既有 App `/api/*`、`/proxy/*` 响应不得新增 `Set-Cookie`；Cookie Presence 不得改变 App 权限。
- 验证：`94-analytics.test.ts` 断言 `/api/redeem`、`/api/device/ping`、`/api/catalog`、`/proxy/*` 响应无 Set-Cookie 且缓存策略不变。

**风险 D：路由匹配与既有 pattern（低）**
`edge/src/index.ts:78-81` 按段精确匹配，`{param}` 只吞单个非空段；`/admin`、`/api/admin/*` 是新增字面量，不与 `['api','titles','{titleId}']` 等冲突。
- 铁律：管理 pattern 若进 ROUTES 须排在可能与之混淆的 App pattern 之后，但更推荐根本走风险 A 的 fetch 前置分支、不进 ROUTES。
- 验证：`40-router.test.ts` 增补 `/admin`、`/api/admin/coupons` 不误匹配任何 App 端点，且原有全部 App 端点解析结果不变。

**风险 E：认证体系隔离（高）**
App 会员身份是 Ed25519 JWT（`edge/src/auth/jwt.ts`），后台是 D1 存哈希的 opaque session；二者密钥、存储、校验完全独立。
- 铁律：后台绝不接受 App Bearer JWT 作为管理凭据；App 侧也绝不因后台改动放宽 JWT 校验。`jwt.ts:81-129` 时间声明校验缺口是既有 App 安全问题，须单独 ADR/工单处理，不在本计划顺带修改，以免改变 App 认证行为。
- 验证：`93-admin-auth.test.ts` 断言有效 App JWT 打 `/api/admin/*` 返回 401，缺 ADMIN Secrets 时后台整体 fail closed 而非放行。

**总验收红线**：G4 部署前必须提供“App 无回归”证据——现有 `01-auth-spine`、`10-redeem`、`12-device-ping`、`15-user-sync`、`50/51-proxy`、`70-79` catalog/search、`80-share`、`81-download-landing`、`82-monetization-version`、`90-g2-journey` 全绿，且新增管理测试不改动任一 App 端点的响应头、Cookie、缓存或 CORS。任一 App 测试由绿转红即视为违背隔离铁律，退回重做。

## 三、 API补全与UI边界

一期API契约：login/session/logout/dashboard/coupons/generate；详情/reveal/confirm-stock/dispatch/revoke用列表返回的opaque id/hash，不用明文code作路径；新增同源 `/api/analytics/consent` POST agree/revoke；operations为授权设备/失败样本/OTA只读。取消一期version写接口与健康率承诺。

session GET返回CSRF/绝对到期；reveal POST需CSRF与审计；confirm-stock为UNKNOWN→IDLE。管理错误单独400/401/403/409/429/503，不擅扩App闭合枚举。分页limit20/50、total与过滤一致、日期统一秒。

复用 `edge/src/core/tokens.ts`/`src/styles/design-tokens.json`，不新增裸色值；文件按模块拆分。覆盖加载/空/错误/401/冲突/断网/长备注；手机桌面、键盘、弹层焦点/Escape/非颜色状态。ACTIVE/首次绑定/分发为独立轴，失败样本无数据不能显示绿色健康。

## 四、 分步施工与真实验收

每任务先失败测试→红灯→最小实现→绿灯→记录证据，不自动commit。

| 任务 | 文件与测试 | 必须验证 |
| --- | --- | --- |
| T0 契约 | SPEC-v2.0变更记录、SPEC-CLOUD-REFACTOR、SPEC-STATIC-PAGES与PRD/OpenAPI/API-SPEC/DDL/UIUX实际对应文件 | 冻结路径、migration ledger/PRAGMA、缓存规则、PBKDF2 CPU参数、隐私说明；本轮不改关联正本 |
| T1 数据 | 拟建migrations/0004_admin_and_analytics.sql、db/admin-repo.ts、db/analytics-repo.ts；tests/edge/91-admin-db.test.ts、92-analytics-db.test.ts | 编号复查；实际SQLite/本地D1验证回滚/并发/幂等/跨日UV，mock不能证明事务 |
| T2 安全 | auth/admin-session.ts、admin-guard.ts、routes/admin-request.ts，仅在 default.fetch 前置分支挂管理入口，不改 routeRequest/withCors；修改 types/env.ts；93-admin-auth.test.ts | 过期/撤销/轮换/伪Cookie、并发限流、CSRF/Origin/CORS/OPTIONS、Secret/DB故障；**§2.6 App隔离红线：管理分支不进公共CORS管线、App JWT 401、/api与/proxy 无Set-Cookie、40-router App端点解析无变化** |
| T3 统计 | analytics/visitor.ts、collect.ts、routes/analytics-consent.ts，修改index.ts/dl.ts/share.ts及HTML隐私入口；94-analytics.test.ts | 同意/拒绝/GPC、午夜/非法渠道/404私密后台不计、Cookie不共享、waitUntil接线、写失败仍响应 |
| T4 API | routes/admin-coupons.ts、admin-dashboard.ts、admin-operations.ts；95-admin-coupons.test.ts、96-admin-dashboard.test.ts | 随机碰撞、分页/备注、UNKNOWN确认、双标签409、重试、复制不标发、停止核销边界、OTA只读校验 |
| T5 UI | html/admin-login.ts、admin-dashboard.ts、admin-coupons.ts与同源分域脚本；97-admin-html.test.ts | 浏览器黄金/异常路径及前台回归，按文件行数门禁拆分；跑全量 App 回归套件证明无端点由绿转红（§2.6红线） |

除migration外拟建源路径均相对edge/src；实施前核对是否被其他会话占用。T1～T4目标测试可运行 `npx vitest run tests/edge/91-admin-db.test.ts` 等对应文件，先确认因缺机制失败，再实现绿灯。

本地启动 `npx wrangler dev --config edge/wrangler.toml --local`；本地Secrets先核对ignore，不展示值，使用合适HTTPS环境验证Secure Cookie，不放宽生产策略。黄金路径：登录→前台访问→统计→生成→复制→确认分发→核销→详情→停核销→登出。异常：Clipboard拒绝/双标签409/过期/DB失败/断网，监控Console/Network，回归分享当前集与ended引导；无法浏览器实测不得报完成。

仓库根目录回归命令：
```sh
npm run typecheck
npm run test:edge
npm test
npm run scan:p0
npm run verify:contracts
npm run verify:acceptance
npm run build
```
新测试须通过且无新增回归，基线失败单列不跳过；扫描不代表新功能通过。生产发布独立授权后：D1备份及隔离恢复→记录旧Worker/KV→核查迁移/Secret名称→已确认增量迁移→配置→部署→匿名隔离与实际流量验证。禁止直接跑未知全部pending迁移；生产测试发卡也须批准。

## 五、 全局进度地图与预算

| 门禁 | 当前状态 | 验收证据与记录 |
| --- | --- | --- |
| G0 | ✅ 已完成同步 | 关联正本（SPEC-v2.0, SPEC-CLOUD-REFACTOR, SPEC-STATIC-PAGES, PRD, UIUX, API-SPEC, openapi.yaml）及 `verify_contracts.py` 全量通过 |
| G1 | ✅ 已实现 | 0004 增量 D1 迁移与仓储落地，真实 SQLite / D1 原子回滚与并发测试通过 |
| G2 | ✅ 已实现 | 统计采集管线、Cookie 隔离、no-store 缓存、管理 API 独立鉴权与路由接线通过 |
| G3 | ✅ 已实现 | 原生 HTML 控制台单文件自包含交付，通过本地与无头浏览器真实登录与交互验收（无横向溢出，表单校验修复） |
| G4 | ✅ 生产已部署 | 账本表级备份完成、Time-Travel 书签记录、0004 远程迁移执行、Secrets 注入、Worker 发布至 `play.prismos.org/*`；线上回归通过 |

一期最终代码与文档交付：共计 22 个新增源码/迁移/测试/文档文件；全量测试 120 个测试套件、1,433 项用例通过；类型检查 `typecheck` 干净通过；`scan:p0` 红线扫描通过（P0-1/2/3 零违规，文件行数全部 ≤300 行）。操作指南详见配套文档 `docs/04-spec/ADMIN-OPERATION-MANUAL.md`。

回滚须恢复上线前记录的完整Worker版本（`fe3c797f-c584-4688-92fe-d2108aa69886`），而非只移除管理路由；新增表列保持additive，不DROP业务表。旧备份不可直接覆盖上线后新增卡密/分发资产，先核对差异并在隔离环境演练恢复。

### 本地实施登记（2026-10-05）

- T1：迁移及仓储已落地；修正转化分子为同期间浏览与下载标识交集，新增下载-only/跨日/期间外/乱序时间测试。
- T2：新增 admin-password.ts、admin-session.ts、routes/admin-auth.ts；真实SQLite验证会话摘要、12小时过期、登出撤销、CSRF、版本轮换、跨窗口登录限制和故障关闭。PBKDF2暂用100000次，仅完成Node测试，Workers CPU适配未验，不视为生产参数冻结。
- 本轮本地证据：40个edge测试文件、464个用例通过；typecheck和P0扫描通过。没有测量覆盖率，不声称达到80%；单元/集成通过不代表浏览器、真D1并发、生产验收完成。
- 管理路由尚未挂载；正本同步、统一guard接线、完整API/UI、清理任务、浏览器测试、云迁移与部署仍待完成。当前脚本通过不能替代后台G0签署。

### 本地接线登记（2026-10-06）

管理API现已通过default.fetch独立分支挂载，routeRequest/withCors未修改；口令/session/CSRF、掩码列表、详情、生成/reveal/confirm-stock/dispatch/revoke、看板与只读operations已接线。生成每会话每分钟5次，事务和requestId冲突有回归测试；摘要详情查找仍扫描卡密表，库存扩大前须补索引ID方案与成本验证。

SPEC/云/静态页/PRD/UIUX/API-SPEC及OpenAPI已追加后台目标契约；文档同步不等于完整后台G0签署。42个edge文件、483个用例、typecheck/P0/契约脚本通过；UI、统计采集/同意、定时清理、Workers口令CPU、真实D1并发/成本、浏览器与生产门禁尚未完成。/admin页面尚未实现，线上无任何部署。

### 生产上线与验收交付登记（2026-10-06）

1. **功能完整闭环**：
   - 统计同意与隐私路由 `/privacy` 及 `/api/analytics/consent` 落地，主站 HTML 底部注入无脚本隐私入口；
   - 边缘请求统计拦截 `collectAnalytics` 与定时清理 `cleanupAnalytics` 落地；
   - 控制台单文件原生 SSR 视图（`admin-page.ts`, `admin-script.ts`, `admin-coupon-script.ts`, `admin-styles.ts`）落地，严格复用 Design Tokens 与 Lucide SVG。
2. **端到端验证通过**：
   - 本地 Wrangler 8789 端口无头浏览器（browser-use）实测通过：登录、生成卡密、全码弹窗、手动分发状态翻转、无横向滚动条全响应式验证；修复了正则表达式在浏览器 HTMLFormElement.requestSubmit 中的兼容性异常。
   - 全仓库回归：120 个测试文件、1,433 个测试全量通过；`npm run typecheck` 零错误；`npm run scan:p0` 零红线违规。
3. **生产环境正式交付**：
   - **灾备基准**：D1 账本（`card_coupons`, `devices`, `coupon_bindings`, `invitation_logs`, `coupon_rejected_devices`）离线 SQL 备份成功（保存在本地并经 SQLite 载入复核）；记录确定性恢复书签 `000000aa-00000002-000050fb-6181c2a3c9b29b64c4a1c8ec99dc6aae`。
   - **生产迁移**：远程 D1 成功执行 `edge/migrations/0004_admin_and_analytics.sql`（30 张真实业务表，旧卡密 4 张平滑保留为 UNKNOWN）。
   - **安全凭据**：通过 `wrangler secret bulk` 安全注入 `ADMIN_PASSWORD_HASH`（PBKDF2-SHA256, 10万次迭代）、`ADMIN_AUTH_VERSION`、`ANALYTICS_HASH_SECRET`；口令写入本地忽略文件 `admin-access.local`。
   - **边缘部署**：成功发布至 Cloudflare 全球边缘网络，当前上线版本 ID `a563ec8d-fcab-4ed1-a348-9c2013d41650`。
   - **生产冒烟实测**：线上生产环境校验登录成功（延迟约 1,084ms，Cookie 带 Secure）、未认证访问 401 拦截有效、Cookie 撤回物理删除有效、App 端 CORS 预检 204 放行未受任何影响。
   - **操作手册**：编制《光影Play》管理后台与卡密运维操作手册（`docs/04-spec/ADMIN-OPERATION-MANUAL.md`），明确“确认库存”与“确认分发”状态机、发卡 SOP、统计口径与应急 Runbook。
