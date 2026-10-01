# 《光影Play》（Prism Play）文档资产全景索引

> 本目录为《光影Play》（Prism Play · `play.prismos.org`）基于 DDAD（文档驱动开发）构建的单一事实来源（Single Source of Truth）文档资产库。

---

## 目录分层架构索引

| 编号目录 | 分类名称 | 核心文件与职责 |
| :--- | :--- | :--- |
| **`00-index/`** | 全景索引与规范 | `README.md`（本文件）：文档结构索引与维护规范 |
| **`01-prd/`** | 产品需求与设计系统 | • `PRD-prism-play.md`：《光影Play》全景需求规格书（含 15 条严格 EARS 验收标准、RICE 优先级、动态大视界拓扑及未来 AI 演进路线图）<br>• `UIUX-design-system.md`：工业级流媒体 UI/UX 规范与全手势设计标准 |
| **`02-architecture/`** | 系统架构与 ADR 决策集 | • `ARCHITECTURE.md`：总体架构设计规格书（Capacitor 7 + Vite + TS + ArtPlayer + Cloudflare 边缘计算）<br>• `ADR-001-capacitor-ts.md`：采用 Capacitor 7 工业跨端容器与纯 TS 架构<br>• `ADR-002-artplayer-core.md`：采用成熟开源播放器 ArtPlayer.js 作为手势播放内核<br>• `ADR-003-cloudflare-edge.md`：采用 Cloudflare Serverless 边缘云脑统一收口与动态源调度<br>• `ADR-004-brand-prism-play.md`：产品全称《光影Play》(Prism Play) 与统一主域 play.prismos.org<br>• `ADR-005-design-tokens-svg.md`：锁定 Lucide SVG 图标库与日夜双模 Design Tokens |
| **`03-contracts/`** | 机器可读接口契约 | • `openapi.yaml`：OpenAPI 3.0.3 规范正本（基础域名：`https://play.prismos.org`）<br>• `API-SPEC.md`：客户端与 Cloudflare 边缘 API 详细协议规范 |
| **`04-spec/`** | Phase 1.5 团队刚性总契约 | • `SPEC-v2.0.md`：施工与验收的**唯一法定依据**（含功能范围、API、数据模型、设计 Token、EARS 验收、已知坑与端到端验证步骤）。任一份其它文档与本文件冲突时，以本文件为准并同步修正冲突方。 |
| **`05-audit/`** | 独立审计与施工指令包 | • `G0-REDTEAM-2026-10-01.md`：独立红队对抗性复核报告<br>• `MASTER-DECISIONS-2026-10-01.md`：Master 决策台账与变更批次<br>• `BUILDER-DISPATCH-PACKAGE.md`：**工程实施总包指令包**（施工分工、阶段任务、避坑铁律与汇报报文模板） |

---

## 文档权威顺序（冲突时的裁决链）

1. `04-spec/SPEC-v2.0.md` —— 施工与验收总契约
2. `03-contracts/openapi.yaml` —— 接口机读正本（`API-SPEC.md` 为其文字说明）
3. `edge/migrations/0001_initial_schema.sql` —— 数据模型正本
4. `02-architecture/` —— 架构与 ADR 决策记录
5. `01-prd/` —— 产品需求与 UI/UX 规范
6. `src/styles/design-tokens.css` —— 样式真相源（`design-tokens.json` 须与之同源）

> 修改任一层的契约，必须同步检查其下游文档，并在 SPEC 的「变更记录」中留痕。
>
> **2026-10-01 修订范围**：F-13～F-15 / AC-16～AC-18 补入已配置来源增量接入与 AI 加工、词法＋BGE-M3/Vectorize 混合搜索、Android 公开目录与缩略海报本地缓存、公开增量目录协议；Windows 客户端和媒体离线下载后移。三层关联：客户端（PRD/UIUX/SPEC）→ 云端（ARCHITECTURE/ADR-003/D1）→ 传输（OpenAPI/API-SPEC），权威顺序不变。Cloudflare 账号套餐与 AI 实际用量未知，既有资源查询结果属于前次会话，云资源绑定待阶段 1 重新核验，不得误当已落地。
>
> **施工门禁**：`SPEC-v2.0.md` §12.2 定义 G0～G4；`ARCHITECTURE.md` 第五章定义对应工作包的 LOC/Token 粗范围。G0 静态/合成项已核对，仅表示收到下一步指令后可从合成数据启动阶段 1 的实现，不代表 Cloudflare 实际资源、授权内容或 Android 真机已完成交付验收。
