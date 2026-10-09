# 《光影Play》（Prism Play）文档资产全景索引

当前端云优化正本：`docs/plans/2026-10-08-cloud-apk-foundation-spec-and-plan.md` r2（2026-10-09）。只按MIN-01～06最小闭环验收；增强延期清单不作本批门禁，旧r1完成勾选已撤回；生产与真机状态独立记录。

> 本目录为《光影Play》（Prism Play · `play.prismos.org`）基于 DDAD（文档驱动开发）构建的单一事实来源（Single Source of Truth）文档资产库。

---

## 目录分层架构索引

| 编号目录 | 分类名称 | 核心文件与职责 |
| :--- | :--- | :--- |
| **`00-index/`** | 全景索引与规范 | `README.md`（本文件）：文档结构索引与维护规范 |
| **`01-prd/`** | 产品需求与设计系统 | • `PRD-prism-play.md`：《光影Play》全景需求规格书（含 15 条严格 EARS 验收标准、RICE 优先级、动态大视界拓扑及未来 AI 演进路线图）<br>• `UIUX-design-system.md`：工业级流媒体 UI/UX 规范与全手势设计标准 |
| **`02-architecture/`** | 系统架构与 ADR 决策集 | • `REFACTOR-REBOOT-PLAN.md`：**《光影Play》系统重构与架构校准蓝图**（来龙去脉、客观缺陷剖析、五大业务需求、四层云端资源配额映射与四阶段重构落地方案）<br>• `ARCHITECTURE.md`：总体架构设计规格书（Capacitor 7 + Vite + TS + 双播放内核〔ArtPlayer/hls.js 与 ExoPlayer/CENC 本机解密〕+ Cloudflare 边缘计算）<br>• `CLOUDFLARE-BACKEND-FACTS.md`：**Cloudflare 边缘云脑白皮书与事实正本**（资产总账、密钥体系、30张D1表物理结构、Cron定时、CORS隔离代理、管理后台路由与运维手册）<br>• `GITHUB-DEVOPS-FACTS.md`：**GitHub 运维与 CI/CD 事实正本**（免密鉴权、Playwriter接管、Actions云端打包全工序与实战避坑）<br>• `CONTENT-CATALOG-FACTS.md`：**大视界内容拓扑、分类规范与数据运维事实正本**（资产总账、主流双字分类、防SSRF白名单与运维脚本）<br>• `ADR-001-capacitor-ts.md`：采用 Capacitor 7 工业跨端容器与纯 TS 架构<br>• `ADR-002-artplayer-core.md`：采用成熟开源播放器 ArtPlayer.js 作为手势播放内核<br>• `ADR-003-cloudflare-edge.md`：采用 Cloudflare Serverless 边缘云脑统一收口与动态源调度<br>• `ADR-004-brand-prism-play.md`：产品全称《光影Play》(Prism Play) 与统一主域 play.prismos.org<br>• `ADR-005-design-tokens-svg.md`：锁定 Lucide SVG 图标库与日夜双模 Design Tokens<br>• `ADR-006-jit-upstream-search.md`：**边缘 JIT 穿透搜索的上游访问边界（Accepted 2026-10-06）** —— 已批准云端受控联网检索与共享入库；`ADR-007-cenc-playback-kernel.md`：**CENC 加密媒体的播放内核路线与解密落点（Accepted，v1.2 2026-10-06）** —— P0 实测后修正：App 加密路径（1080p HEVC + 音视频双 CENC）改由**方案 3 ExoPlayer/Media3** 承接，方案 1 本地中继降级为窄场景备选，方案 4 FFmpeg 保底，方案 2 边缘流式解密为技术储备；v1.2 三条范围裁定（R-1 不为低端机 HEVC 过度设计、R-2 移除 FLAG_SECURE 功能优先、R-3 只选 1080p HEVC 弃 bytevc2）+ 单集 spike go/no-go 闸门 |
| **`03-contracts/`** | 机器可读接口契约 | • `openapi.yaml`：OpenAPI 3.0.3 规范正本（基础域名：`https://play.prismos.org`；当前共 38 条路径：24 条 App/静态与页面路由、12 条后台目标路由、2 条隐私路由；`verify:contracts` 对路径集合做全等断言，漂移即失败）<br>• `API-SPEC.md`：客户端与 Cloudflare 边缘 API 详细协议规范（含独立 AdminError 与管理会话协议） |
| **`04-spec/`** | Phase 1.5 团队刚性总契约 | • `SPEC-v2.0.md`：施工与验收的**唯一法定依据**（含功能范围、API、数据模型、设计 Token、EARS 验收、已知坑与端到端验证步骤；含 §12.3 运营后台增量目标）。任一份其它文档与本文件冲突时，以本文件为准并同步修正冲突方。<br>• `RELEASE-SOP-AND-PIPELINE.md`：**端云一体生产发布标准操作手册与流水线 SOP**（preflight 预检、不可变 R2 上传回核、Worker 保护部署、KV 指针原子切换、全链路端到端验收与一键回滚命令）<br>• `SPEC-CENC-EXOPLAYER-PLAYBACK-PROGRAM.md`：**CENC 加密媒体原生播放内核施工总计划（自完备交接文档，含 A/B/C/D/E 五阶段 todo 看板与 LOC/Token 估算）** —— 云端每次播放签名句柄+密钥下发、ExoPlayer 单集 spike（go/no-go 闸门）、方案3 完整集成 WS1–WS8、普适发现补完与部署验收<br>• `SPEC-UNIVERSAL-DISCOVERY-INGESTION-AND-SERIES.md`：**全网内容自演进、多阶取流、多季聚合与共享剧库规格+计划**（滑动窗口任务队列、系列归一化、连载追更、纵向三列网格）<br>• `ANALYSIS-S1-NATIVE-PROTOCOL-GAP.md`：**S1 原生协议取流全链路差异分析与真实播放验收标准**（含 §6 P0 实测：编码/加密真相）<br>• `ADMIN-ANALYTICS-AND-COUPON-SPEC-AND-PLAN.md`：**运营后台、卡密资产中心与全链路数据统计规格及实施全记录**（双层 Cookie、防抢分发、原子 tripwire、真实 D1 压测与生产上线验收总记录）<br>• `ADMIN-OPERATION-MANUAL.md`：**管理后台与卡密运维操作手册**（口令安全取用、确认库存与确认分发状态机 SOP、统计指标诚实口径、运行信息监控与应急 Runbook）<br>• `CONTENT-PIPELINE-SPEC-AND-ACTION-PLAN.md`：**长效自运转内容生态体系：海量采集、JIT即时入库与启动大库行动计划与规格二合一文档**（防封并发、多源择优合并、成人私密四重绝缘、全网 3.5 万+ JIT 穿透规格与四阶段推进计划）<br>• `CLOUD-SYNC-JIT-PIPELINE-SPEC.md`：**云端多端同步中枢、JIT穿透引擎与定时追新工程规格书**（多端接力续播、客观热度HotScore、AI剧标定、JIT穿透与GitHub Actions无人值守流水线施工总依据） |
| **`05-audit/`** | 独立审计与施工指令包 | • `G0-REDTEAM-2026-10-01.md`：独立红队对抗性复核报告<br>• `MASTER-DECISIONS-2026-10-01.md`：Master 决策台账与变更批次<br>• `BUILDER-DISPATCH-PACKAGE.md`：**工程实施总包指令包**（施工分工、阶段任务、避坑铁律与汇报报文模板）<br>• `G1 ~ G4-*.md`：五级阶段门禁审查与准出签发决定书正本<br>• `DUAL-AGENT-COLLABORATION-METHODOLOGY.md`：**双 Agent 协同监理模式与工程治理方法论**（跨项目通用多代理编排体系）<br>• `AUDIT-CLOUD-SYNC-JIT-SPEC-2026-10-03.md`：**云端同步/JIT 规格书独立复审报告**（查出 4 项 P0 阻断、6 项 P1；A-1~A-14 已由该规格书 v2.2 逐条修正） |
| **`plans/`** | 阶段性施工看板（与代码同代更新） | • `2026-10-07-search-cards-and-device-playback.md`：**云端搜索瘦身与端侧按需播放看板**（卡片发现、按需分集目录、原生取流解密、UI 校准、部署与有界验证）<br>• `2026-10-08-client-playback-resilience-and-hardening.md`：**端侧点播韧性与操作反馈看板**（有界重试/超时/取消、连接与离线分流、冷启同步让路、默认倍率、分享提示、作者二维码原生保存与手动微信；含真机验收与官网发布记录） |
| **`qgraphflow/`** | 证据化架构图（离线 HTML） | • `prism-play-overview/index.html` + `graph.json`：**四视图系统全景**（系统分工 architecture / 点开影片播放流程 flowchart / 开始观看时序 sequence / 内容更新数据流 dataflow），节点与关系携带 `文件:行号` 源码锚点并在生成时对工作树逐条校验；只画代码中存在的机制，不等于线上运行证明 |
| **`prototypes/`** | 历史 UI 原型留档 | `ui-prototype.html`、`ui-v2-interactive-prototype.html` 等为早期原型，视觉与交互真相以 `01-prd/UIUX-design-system.md` 与 `src/styles/design-tokens.css` 为准 |

---

## 文档权威顺序（冲突时的裁决链）

1. `04-spec/SPEC-v2.0.md` —— 施工与验收总契约
2. `03-contracts/openapi.yaml` —— 接口机读正本（`API-SPEC.md` 为其文字说明）
3. `edge/migrations/` —— 数据模型正本（按序全量读取，含 `0001_initial_schema.sql` 与后续增量迁移）
4. `02-architecture/` —— 架构与 ADR 决策记录
5. `01-prd/` —— 产品需求与 UI/UX 规范
6. `src/styles/design-tokens.css` —— 样式真相源（`design-tokens.json` 须与之同源）

> 修改任一层的契约，必须同步检查其下游文档，并在 SPEC 的「变更记录」中留痕。
>
> **2026-10-08 云端资源治理、端侧韧性与 v2.6.5 修订发布**：以 `wrangler tail` 与生产拨测为准，确认 1102 的真实原因是 Cloudflare HTTP CPU 超限（免费档 10ms 含突发，实测 2,020ms 撞顶），**不是**子请求超限，且平台强杀的 1102 页面无法由应用层补 CORS 头；云端改为事实包按需解析、搜索投影去二次序列化、发现账本单条 JOIN + 同页去重 + 单页预算 10 条（不升套餐、不放宽私密与完整性校验）。端侧新增播放 GET 的有界重试/8 秒超时/退出取消、「连接暂不可用」与「需要网络」分流、冷启发现同步让路；默认常规倍率保持 1×，已保存倍率在原生起播前生效；分享复制提示层级修正；作者联系/赞赏二维码接入原生保存与用户主动「打开微信」。全量 156 套 / 1,755 项测试与 G0 契约、AC 30/30 门禁通过，真机复验通过后发布 `prism-play-v2.6.5-20261008.apk`（`versionCode` 仍 21605，老用户须官网覆盖安装）。**搜索线上仍不稳定**：同日复测「人到中年」首拉 200（19 条 / 22.1 秒）后紧接两次 503（2.6 秒 / 13.8 秒，503 页面不带 CORS 头），证实免费档突发额度下 1102 会复发，未宣布资源安全。**同批文档对齐**：撤下各进度地图中「故障端点全部恢复 200」「1102 已修复」的过度表述，`verify:contracts` 汇总横幅改为从实测推导（24 App API / 38 业务表 / 13 功能 / 30 AC），`qgraphflow/prism-play-overview/` 四视图重生成并补入 API 传输层、错误态分流、作者支持原生保存三个节点（41 处源码锚点对工作树校验通过）。
>
> **2026-10-07 CENC原生硬解、轻量卡片搜索与UI校准验收交付**：落地 Android 原生 ExoPlayer 硬件解码与本地 CENC AES-128-CTR 样本流式解密；云端搜索瘦身解耦为轻量独立卡片（D1 0007 迁移新增 `discovery_cards` 表），详情按需拉取分集 `videoId` 纯原生描述符（彻底剔除虚假 `mediaUrl`）；前端增加 `no-referrer` 解决上游防盗链 403 拒流；选季框紧贴选集上方，全屏手势 HUD 层级置顶至 50 且精简为竖向进度指示；常驻展示本机与云端服务版本。149 套测试 1,723 项全绿，交付最新验收包 `build/apk265/prism-play-v2.6.5-acceptance-20261007.apk`（当时等待 Master 真机实测验收，WEB 下载保持未发布；**后续状态见 2026-10-08 条目：已发布 v2.6.5 及修订包**）。
>
> **2026-10-06 运营后台与全链路分析增量交付**：完成了同源管理后台（`/admin` 与 `/api/admin/*`）、D1 0004 增量迁移（该批后为 30 张真实业务表，叠加 0005～0007 后当前 38 张）、卡密生命周期（确认库存/确认分发/查看全码/停止核销）、全链路访问与下载触发分析、用户隐私同意流程（`/privacy`）与定时自动留存清理。新增实施规范与交付全记录 `docs/04-spec/ADMIN-ANALYTICS-AND-COUPON-SPEC-AND-PLAN.md` 及配套《管理后台与卡密运维操作手册》`docs/04-spec/ADMIN-OPERATION-MANUAL.md`。本地凭据存放于根目录被 Git 忽略的 `admin-access.local`。生产已上线并完成真实环境端到端验证。
>
> **2026-10-01 修订范围**：F-13～F-15 / AC-16～AC-18 补入已配置来源增量接入与 AI 加工、词法＋BGE-M3/Vectorize 混合搜索、Android 公开目录与缩略海报本地缓存、公开增量目录协议；Windows 客户端和媒体离线下载后移。三层关联：客户端（PRD/UIUX/SPEC）→ 云端（ARCHITECTURE/ADR-003/D1）→ 传输（OpenAPI/API-SPEC），权威顺序不变。Cloudflare 账号套餐与 AI 实际用量未知，既有资源查询结果属于前次会话，云资源绑定待阶段 1 重新核验，不得误当已落地。
>
> **施工门禁**：`SPEC-v2.0.md` §12.2 定义 G0～G4；`ARCHITECTURE.md` 第五章定义对应工作包的 LOC/Token 粗范围。G0 静态/合成项已核对，仅表示收到下一步指令后可从合成数据启动阶段 1 的实现，不代表 Cloudflare 实际资源、授权内容或 Android 真机已完成交付验收。
