# 《光影Play》（Prism Play）

> **官方全称**：《光影Play》（英文标识：**Prism Play**）  
> **统一服务主域**：`https://play.prismos.org`（PrismOS 矩阵成员）  
> **核心技术栈**：**Capacitor 7 + Vite + TypeScript + ArtPlayer.js/hls.js（网页内核）+ ExoPlayer/Media3 原生 CENC 内核 + Cloudflare Serverless (Workers / Cron / D1 / KV / R2)**  
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
│  • 双内核：ArtPlayer + hls.js 承接普通线路；Android ExoPlayer/Media3 承接 CENC 加密线路（本机派生密钥、AES-CTR 流式解密）  │
│  • 全手势：左滑音量、右滑亮度、双击快进退、定时关闭、后台/息屏播放与来电暂停；已保存倍率在起播时生效（默认 1×）  │
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
│  • 公开目录与播放事实走 R2 静态资产 + KV 清单；检索未命中由独立「共享发现增量」（D1 账本 + 私有 R2 事实桶）补全  │
│  • 免费档 CPU 突发额度约束下持续做资源治理：事实包按需解析、搜索投影零二次序列化、发现账本批量读取与单页预算  │
├────────────────────────────────────────────────────────────────────────┤
│ 【支柱四：预制卡密与云端自动核销 (Cloudflare D1 Monetization)】        │
│  • 彻底告别“用户报设备码、人工算号”的传统离线模式                      │
│  • 标准卡网核销：预制卡密入库 D1，用户输入卡密自动绑定 DeviceID 核销   │
│  • Ed25519 私钥签发 JWT + 客户端固定公钥离线验签（14 天仅授权可验证） │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 当前工程交付状态与里程碑（v2.6.7 正式版已发布）

- **线上版本**：Android `2.6.7 / versionCode 21607`，官网下载 `prism-play-v2.6.7-series-playback-review-fixed-20261009.apk`（36,382,007 字节，SHA-256 `2d2363b2a1739c6238d89a6c888a82c84a09e373d8038a50abebb651cef9bba8`，与真机预检包逐字节一致）；`/dl/latest/android` → R2 直连同域分发。
- **播放内核双轨**：普通线路由 ArtPlayer + hls.js 在 WebView 直连上游；`provider_s1` 的 1080p HEVC + CENC 加密线路改由 **Android 原生 ExoPlayer/Media3 + 本机 AES-CTR 流式解密**承接（密钥在本机派生，不进清单、缓存、响应与日志），加密线路起播前须经云端「播放身份复核」接口确认剧目/集号/线路/视频标识四项一致；全屏原生播放时海报底片 100% 物理隐藏，消除遮挡。
- **系列聚合与异步补季**：统一采用 NFKC 标点归组，无编号首季与多版本同季号完整保留；后台异步有界单飞补季，起播零阻塞，未完成或超时不锁死缓存。
- **内容供给与曝光**：公开目录与播放事实走「R2 静态资产 + KV 清单 + 边缘缓存」静态基底；两段合一启动确认公告与设置中心常驻作者反馈上线；边缘直出 `robots.txt`、`sitemap.xml` 与官网结构化 TDK，完成品牌 SEO 基础设施落地。
- **端云发布流水线沉淀**：确立 `docs/04-spec/RELEASE-SOP-AND-PIPELINE.md`，注册 `npm run release:*` 系列标准指令，一键实现预检、上传校验、Worker 部署、指针切换与一键灾备回滚 (`release:rollback`)。
- **自动化门禁**：**170 套 / 1,813 项**测试通过；`verify:contracts`（Gate G0，28 App API / 38 业务表 / 13 功能 / 30 AC）、`verify:acceptance`（AC 30/30，188 条署名用例）、`scan:p0`（527 文件零 Emoji / 零紫粉渐变 / 零裸 Hex / 单文件 ≤300 行）、`verify:android`、双端 TypeScript 与本地 Gradle 编译 + 签名核验全绿。
- **诚实边界**：`versionCode` 已递增至 21607，支持可选更新提示；云端搜索与发现耗时仍受 Cloudflare 免费档突发额度与上游网络波动制约；DLNA 投屏等部分真机边界项仍待持续复核。

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
│   ├── 02-architecture/             # 总体架构规格书 + ADR-001 ~ 007 + 三份事实白皮书 (Cloudflare / GitHub DevOps / 内容目录)
│   ├── 03-contracts/                # OpenAPI 3.0.3 (openapi.yaml) + API 契约
│   ├── 04-spec/                     # Phase 1.5 团队总契约 (SPEC-v2.0.md) 与三轨重构 SPEC
│   ├── plans/                       # 阶段性施工看板（云端搜索瘦身、端侧韧性与操作反馈，随代码同代更新）
│   ├── qgraphflow/                  # 证据化架构图：离线 HTML 四视图 + graph.json（节点带 文件:行号 源码锚点）
│   ├── prototypes/                  # 早期 UI 原型留档（视觉真相以 design-tokens.css 为准）
│
├── src/                             # 【客户端核心源码层 (Vite + TS + 双播放内核)】
│   ├── index.html                   # 边到边真全屏主入口（no-referrer 防上游盗链拒绝）
│   ├── main.ts                      # 应用启动与生命周期挂载（含发现同步让路调度）
│   ├── styles/                      # 琥珀金日夜双模 Tokens 与布局样式
│   ├── core/                        # API 客户端（有界重试/超时/取消）、离线公钥验签、公开缓存与发现增量游标
│   ├── components/                  # 大视界频道导航、四模海报网格、续播卡、Lucide SVG 图标集
│   ├── player/                      # 双内核适配（ArtPlayer+hls.js / ExoPlayer+CENC）、线路编排与手势 HUD
│   └── views/                       # 设置中心（主题/后台播放/倍率偏好/卡密兑换/OTA 检测/作者支持）
│
├── edge/                            # 【Cloudflare Serverless 边缘云脑层 (play.prismos.org)】
│   ├── wrangler.toml                # Workers / D1 / KV / R2 编排配置
│   ├── migrations/                  # D1 边缘数据库 Schema（0001~0007 增量）
│   └── src/                         # 边缘路由、静态目录与发现账本读取、卡密核销、管理后台与分享落地页
│
├── android/                         # 【Capacitor 7 原生工程：播放会话、CENC 解密、投屏与作者支持插件】
└── tests/                           # 【自动化单元与集成测试套件】
```
