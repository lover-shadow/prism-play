# 《光影Play》（Prism Play）

> **官方全称**：《光影Play》（英文标识：**Prism Play**）  
> **统一服务主域**：`https://play.prismos.org`（PrismOS 矩阵成员）  
> **核心技术栈**：**Capacitor 7 + Vite + TypeScript + ArtPlayer.js + Cloudflare Serverless (Workers / Cron / D1 / KV / R2)**  
> **施工与验收依据**：`docs/04-spec/SPEC-v2.0.md`（与 PRD、OpenAPI、D1 Schema、UIUX、Tokens 逐条对齐）  
> **架构主理人**：Master_流光逸影  
> **协作与工程执行**：MVP开发专家团（项目总监：大湾区靓仔）

---

## 一、 核心架构四大支柱

```
┌────────────────────────────────────────────────────────────────────────┐
│                   【光影Play (Prism Play) 2.0 全景架构】               │
├────────────────────────────────────────────────────────────────────────┤
│ 【支柱一：现代流媒体门面与原生手感 (Capacitor 7 + ArtPlayer.js)】      │
│  • 全面去 Go 化，TypeScript + Capacitor 7；包体积须以构建测量          │
│  • Android Edge-to-Edge 边到边物理真全屏（彻底利用状态栏与挖孔屏区域） │
│  • 黑曜石夜空 (#080A10) / 象牙纯白 (#F5F6FA) + 琥珀金 (#E5A93C) 双模   │
│  • 云端动态下发四公开频道；个人探索仅当次双重准入后出现             │
│  • 海报密度四模切换：中图紧凑(3列·默认) / 大图(2列) / 书架(4列) / 列表 │
│  • ArtPlayer 全手势内核：左滑调音量、右滑调亮度、双击快进退、定时关闭  │
├────────────────────────────────────────────────────────────────────────┤
│ 【支柱二：极简高转化分享裂变体系 (play.prismos.org/s/:id)】            │
│  • 短剧分享（点开即播）：好友点开链接零废话直接网页播放本集，          │
│    本集播放结束瞬间弹出：“如果继续看，请下载【光影Play】”一键引导下载  │
│  • /dl 提供微信环境下载指引；本期仅 Android APK，不提供 PC 假直链      │
│    平台计费、下载可用性须以实际账号及发布产物核实                      │
├────────────────────────────────────────────────────────────────────────┤
│ 【支柱三：Cloudflare 边缘空中调度大脑 (Workers + Cron + KV)】          │
│  • Scheduled Cron 自动巡检：每天定时刷新 2 次 (分栏目轮询测速并熔断死源) │
│  • 客户端不写死上游域名；已配置来源与频道经云端受控更新                │
│  • 全文检索采用 D1 原生 FTS5 倒排索引；Workers AI 与向量检索收归 v2.1+ │
├────────────────────────────────────────────────────────────────────────┤
│ 【支柱四：预制卡密与云端自动核销 (Cloudflare D1 Monetization)】        │
│  • 彻底告别“用户报设备码、人工算号”的传统离线模式                      │
│  • 标准卡网核销：预制卡密入库 D1，用户输入卡密自动绑定 DeviceID 核销   │
│  • Ed25519 私钥签发 JWT + 客户端固定公钥离线验签（14 天仅授权可验证） │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 施工前范围修订（2026-10-01 Master 定案版）
- 本期 Android APK + 公开分享 H5；Windows 安装包与视频离线播放后移。
- 搜索采用 D1 原生 FTS5 词法全文检索（精确剧名、全拼、拼音缩写、别名、模糊纠错）；本期不引入 Workers AI 语义搜索与 Vectorize，彻底避免外部配额与异步延迟风险。
- 本地公开目录与缩略海报端侧缓存；底栏升级为【视界】【发现】【追剧】【设置】四主 Tab，个人探索与追剧断点严格实施四大存储域物理隔离。
- 阶段门禁见 `docs/04-spec/SPEC-v2.0.md` §12.2，粗工作包估算见 `docs/02-architecture/ARCHITECTURE.md` 第五章。静态契约复核通过仅允许从合成数据启动阶段 1 开发；真实账号权限、合法片单、Android 真机在后续阶段分批验收。

---

## 二、 标准化现代全栈目录结构

```text
D:\DEV\prism-play\
├── AGENTS.md                        # 多 Agent 协作契约、工程铁律与进度看板规范
├── README.md                        # 项目总览与架构导引（本文件）
├── TIMELINE.md                      # 工程演进编年史与里程碑记录
├── package.json                     # 前端与 Capacitor 7 依赖管理
├── capacitor.config.ts              # Capacitor 7 跨端配置 (appId: org.prismos.play)
├── vite.config.ts                   # Vite 构建配置
├── tsconfig.json                    # TypeScript 严格配置
│
├── docs/                            # 【DDAD 文档驱动开发单源事实库】
│   ├── 00-index/                    # 文档全景索引
│   ├── 01-prd/                      # 产品需求规格书 (含 EARS 验收标准 + AI 路线图) + UI/UX 规范
│   ├── 02-architecture/             # 总体架构规格书 + ADR-001 ~ ADR-005 决策集
│   ├── 03-contracts/                # OpenAPI 3.0.3 (openapi.yaml) + API 契约
│   └── 04-spec/                     # Phase 1.5 团队总契约 (SPEC-v2.0.md)
│
├── src/                             # 【客户端核心源码层 (Vite + TS + ArtPlayer)】
│   ├── index.html                   # 边到边真全屏主入口
│   ├── main.ts                      # 应用启动与生命周期挂载
│   ├── styles/                      # 琥珀金日夜双模 Tokens 与布局样式
│   ├── core/                        # API客户端、故障重解析、离线公钥验签、公开缓存
│   ├── components/                  # 大视界频道导航、四模海报网格、续播卡、Lucide SVG 图标集
│   ├── player/                      # ArtPlayer 封装 (左音量/右亮度/双击/定时关闭)
│   └── views/                       # 设置中心 (主题/后台播放/卡密兑换/OTA检测)
│
├── edge/                            # 【Cloudflare Serverless 边缘云脑层 (play.prismos.org)】
│   ├── wrangler.toml                # Workers / D1 / KV / R2 编排配置
│   ├── migrations/                  # D1 边缘数据库 Schema
│   └── src/                         # 边缘网关、定时源巡检 Cron、D1 卡密核销、分享落地页
│
├── android/                         # 【Capacitor 7 标准 Android 原生工程】
└── tests/                           # 【自动化单元与集成测试套件】
```
