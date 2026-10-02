# 《光影Play》（Prism Play）客户端工程总包实施指令包 (Builder Dispatch Package)

> **版本**：v1.0  
> **生效日期**：2026-10-03  
> **制定主体**：项目监理与架构审查官 (Chief Architect & Audit Director)  
> **接收主体**：工程实施总包 Agent (Chief Builder & App Engineering Swarm)  
> **法定契约正本**：`docs/04-spec/PLAYER-FULLSCREEN-SIGNING-UPDATE-SPEC-AND-PLAN.md`（v2.5 架构全景大正本）  
> **任务使命**：全权负责《光影Play》移动端（Android / Capacitor 7 / Vite / TypeScript）剩余工作包的代码实现、质量门禁闭环与出厂构建。

---

## 〇、 角色定位与端云范围铁律（开工必读）

### 1. 唯一专责范围：APP 客户端
你是本项目的**移动客户端总包（Client Chief Builder）**。
- **你的代码领地**：`src/**`、`android/**`、`tests/client/**`、客户端样式与 Design Tokens；
- **你的交付物**：高质量客户端源码、全绿单元测试、以及经 GitHub Actions 编译出厂的唯一固定签名 APK。

### 2. 严禁越界：零云端代码干预 (Zero Cloud Touch)
- 云端开发（Cloudflare Workers、D1 迁移、边缘路由 `/api/user/sync`、上游抓取流）**由另一位独立的云端专员 Agent 全权负责**，正本为 `docs/04-spec/CLOUD-SYNC-JIT-PIPELINE-SPEC.md`；
- **总包红线**：你的任何工作包、提交和文件改动中，**严禁修改 `edge/**` 或 `edge/migrations/**` 下的任何文件**；
- 云端能力一律作为**外部依赖**对待。若云端端点尚未就绪，客户端按既定降级路径实现（见下文），**严禁在客户端侧代写云端逻辑或为追求门禁全绿而伪造字段**。

---

## 一、 当前工程基线与已完成进度交接

在本次派发前，监理层已完成前序基础设施固化与代码级修复，当前分支健康度为 **100% PASS**：

### 1. 已闭环交付项（总包无需重做）
1. **WP1 永久签名固化已完成**：
   - 密钥库 `android/app/debug.keystore`（PKCS12 / RSA 2048 / 10000天）已入库；
   - `android/app/build.gradle` 已显式锁定 `signingConfigs.debug`；
   - 证书 SHA-256 指纹基线已固化于 `docs/02-architecture/GITHUB-DEVOPS-FACTS.md`（`8B:C2:28:B3:D4:5E:2A:FA:0F:BA:9F:27:67:6D:13:B6:0C:D0:DC:FB:05:37:12:1B:F1:47:66:FF:E5:F4:D2:9D`）。
2. **WP3 公网分享死链修复已完成**：
   - `src/core/share.ts` 已彻底拔除 `origin?` 依赖，锁死常量 `SHARE_ORIGIN = 'https://play.prismos.org'`；
   - 增加剧名与分集文案格式化（`shareTextFor`）；
   - `tests/client/52-share-notice.test.ts` 7 项测试全通。
3. **设计系统 Tokens 已双写就绪**：
   - `src/styles/design-tokens.css` 与 `design-tokens.json` 已补齐 `--badge-ai`、`--badge-hot`、`--badge-recommend`（深浅双模同值）、`--capsule-height: 28px`、`--capsule-hit: 44px`。
4. **外壳顶栏架构改造已前半程落地**：
   - `src/app-shell.ts` 已实现 `headerAccessory()` 常驻工具槽；
   - `src/views/home-view.ts` 已拔除 `.home-section-header` 与重复标题，排版切换器已接入外壳槽位；
   - `src/main.ts` 已透传槽位引用。

### 2. 当前门禁基线状态
- `python tests/scan_p0.py`：**通过**（197 文件零破口）；
- `python tests/verify_contracts.py`：**通过**（19 API / 22 业务表 / Gate G0 全绿）；
- `python tests/verify_acceptance.py`：**通过**（18/18 基础验收全绿）；
- `npx vitest run tests/client`：**通过**（25 文件 / 317 项用例全绿）。

---

## 二、 总包后续任务拆解与实施指南

总包 Agent 需依次推进完成以下任务：

```
                    总包后续施工流水线 (Sequential SOP)
  ┌────────────────────────────────────────────────────────────────────────┐
  │ Task 1 (收尾 WP5): 首屏与外壳视觉 CSS 精致化                           │
  │ • 顶栏 flex 居中、胶囊 28px/44px 双口径、频道 17px、TabBar max-width  │
  ├────────────────────────────────────────────────────────────────────────┤
  │ Task 2 (实施 WP2): 播放器全屏自适应与画幅重塑                          │
  │ • 单一 CSS 权威、拔除 art.fullscreenWeb、contain 零裁切、横屏联动旋转 │
  ├────────────────────────────────────────────────────────────────────────┤
  │ Task 3 (实施 WP4): 局域网大屏电视 DLNA 投屏能力重拾                    │
  │ • Android 原生 PrismCastPlugin (裸 socket SOAP + 组播锁)、操作岛 [投屏]│
  ├────────────────────────────────────────────────────────────────────────┤
  │ Task 4 (实施 WP6): 纯离线 3.5:3.5:3 推荐混排与海报微光角标             │
  │ • recommendation.ts 20 条编织块算法、角标渲染、字段缺失降级          │
  ├────────────────────────────────────────────────────────────────────────┤
  │ Task 5 (实施 WP7): 端云状态同步中枢客户端对接                          │
  │ • user-sync.ts 离场上报 (keepalive + 待发队列)、私密拦截、拉取合并    │
  ├────────────────────────────────────────────────────────────────────────┤
  │ Task 6 (实施 WP0/8): 验收编号扩充、全量回归与出厂构建                  │
  │ • 补齐 AC-19~AC-30 用例、门禁全通、GitHub Actions 编译验证签名一致性  │
  └────────────────────────────────────────────────────────────────────────┘
```

---

### Task 1: 收尾 WP5 · 首屏与外壳视觉 CSS 精致化
- **对应验收**：AC-25（顶栏居中）、AC-26（胶囊层级）、AC-27（底栏收缩）
- **涉及文件**：`src/styles/app.css`、`src/styles/home.css`
- **核心规格**：
  1. **顶栏居中** (`app.css`)：
     - `.app-header-row`：`display: flex; align-items: center; justify-content: space-between; height: var(--header-height); padding: 0 var(--space-4);`；
     - `.app-brand`：垂直居中对齐，文字零贴顶。
  2. **一级频道权威** (`home.css`)：
     - `.channel-tab`：字号提升至 `var(--text-md)`（17px），激活项加粗（`font-weight: 700`），琥珀金短横线居中指示。
  3. **二级胶囊双口径** (`home.css`)：
     - `.capsule`：视觉高度 `var(--capsule-height)`（28px），内边距 `0 var(--space-3)`，字号 `var(--text-xs)`（12px）；
     - `.capsule-rail-wrap`：垂直内边距补足，使点击热区达到 `var(--capsule-hit)`（44px），严格满足 SPEC §10 无障碍下限。
  4. **底部导航栏收拢** (`app.css`)：
     - `.app-tabbar` 内容限制 `max-width: 360px; margin: 0 auto; width: 100%;`，消除全面屏过度拉伸。

---

### Task 2: 实施 WP2 · 播放器全屏自适应与画幅重塑
- **对应验收**：AC-19（竖屏短剧全屏）、AC-20（横屏影视全屏）、AC-21（级联返回）
- **涉及文件**：`src/styles/app.css`、`src/player/prism-player.ts`、`src/player-host.ts`
- **核心规格**：
  1. **收口唯一权威（废除破坏性冲突）**：
     - 删除 `app.css` 218–224 行原有的 7 条 `!important` 链；
     - 在 `src/player/prism-player.ts` 中**彻底移除 `art.fullscreenWeb = f` 调用**（它会触发 WebView 原生全屏容器，脱离 CSS 控制）；仅保留 `art.autoSize()`。全屏状态 100% 由 `player-host.ts` 的 CSS 类 `.prism-player-host--fullscreen` 统一受控。
  2. **画幅嗅探与留白定策**：
     - 监听 `video.loadedmetadata`，计算 `video.videoHeight > video.videoWidth` 判断竖屏/横屏；
     - 视频统一样式：`object-fit: contain; width: 100%; height: 100%;`，**坚持零裁切**；
     - 留白区域由已存在的 `.prism-player__backdrop` 高斯模糊底片填充，绝无纯黑死边。
  3. **方向智能联动**：
     - 若为 16:9 横屏影视全屏：调用 `@capacitor/screen-orientation` 的 `ScreenOrientation.lock({ orientation: 'landscape' })`；退出时调用 `unlock()`；
     - 若为 9:16 竖屏短剧全屏：保持手机竖直自然握持，严禁强制旋转。
  4. **级联返回键拦截**：
     - 在全屏态下响应返回键/侧滑手势时，第一级只退出全屏、恢复竖屏详情台；在非全屏态再次返回才关闭播放器。

---

### Task 3: 实施 WP4 · 局域网大屏电视 DLNA 投屏能力重拾
- **对应验收**：AC-24（局域网大屏投屏）
- **涉及文件**：
  - `android/app/src/main/java/org/prismos/play/PrismCastPlugin.java`（新增）
  - `android/app/src/main/java/org/prismos/play/MainActivity.java`（注册插件）
  - `android/app/src/main/AndroidManifest.xml`（增加权限）
  - `src/components/icons.ts`（增加 `cast` 图标）
  - `src/player/player-detail.ts`（操作岛增设【投屏】键）
  - `src/styles/app.css`（半屏发现抽屉样式）
- **核心规格**：
  1. **解决三项硬前置 (H1/H2/H3)**：
     - **H1（绕开明文拦截）**：SOAP 控制请求由原生 Java 通过 `java.net.Socket` 直接发送原始 HTTP 请求文本，避免走平台受限的 HTTPClient 触发 `cleartextTrafficPermitted=false` 拦截；
     - **H2（组播权限）**：清单补 `android.permission.CHANGE_WIFI_MULTICAST_STATE`，扫描时获取 `WifiManager.MulticastLock`，扫描结束立即释放；
     - **H3（放弃 CIDR）**：目标 IP 动态由 SSDP 发现，不修改 security config。
  2. **原生插件实现**：
     - 插件名 `@CapacitorPlugin(name = "PrismCast")`；在 `MainActivity.java` 中 `registerPlugin(PrismCastPlugin.class)`；
     - 实现 `startDiscovery()`、`stopDiscovery()`、`castMedia(ip, port, url, title)`、`controlMedia(action)`。
  3. **前端图标与动线**：
     - 从 `node_modules/lucide-static/icons/cast.svg` 提取 2px 几何加入 `SHAPES`；
     - 操作岛第 2 键固定为【投屏】；点击弹出底部半屏卡片列表，展示局域网电视；选择后向电视推公网代理流，手机显示琥珀金呼吸控制条。

---

### Task 4: 实施 WP6 · 纯离线 3.5:3.5:3 推荐混排与海报微光角标
- **对应验收**：AC-28（推荐混排）、AC-29（微光角标）
- **涉及文件**：`src/core/recommendation.ts`（新增）、`src/components/poster-grid.ts`、`src/styles/home.css`、`src/views/home-view.ts`
- **核心规格**：
  1. **算法引擎 (`recommendation.ts`)**：
     - 本地 7 天半衰期时间衰减打分：提取 `local_watch_history` 计算 21 分类偏好分；
     - 稳定序基线：候选列表先按 `id` 字典序排序；
     - A 轨（AI精品 35%）：`item.isAi === true`，按画像分降序；
     - B 轨（全网热门 35%）：`item.isHot === true` 优先（注意：云端不暴露数值 `hotScore`，不得依赖）；
     - C 轨（口碑破圈 30%）：按本地画像分**升序**（低频涉足题材优先），防信息茧房；
     - **20 条固定编织块**：每块严格为 `7 AI + 7 热门 + 6 探索`（整数整除），块满即固化，分页加载更多已渲染块**零重排**。
  2. **字段缺失降级策略**：
     - 若服务端未下发 `isAi` 或全 false：A 轨降级为偏好题材最高片单，**但不贴【AI精品】角标**；
     - 若未下发 `isHot`：B 轨降级为最新上线，**但不贴【热门】角标**。
  3. **微光角标 UI**：
     - 定位于海报左上角（类名 `.poster-corner-badge`）；
     - 使用已注册的 tokens：`--badge-ai`（冰蓝）、`--badge-hot`（琥珀）、`--badge-recommend`（象牙），背景 `--badge-bg`；
     - 普通剧目留白不贴标；**绝对零 Emoji**。

---

### Task 5: 实施 WP7 · 端云状态同步中枢客户端对接
- **对应验收**：AC-30（端云状态多端同步）
- **涉及文件**：`src/core/user-sync.ts`（新增）、`src/player-host.ts`、`src/main.ts`、`src/views/history-view.ts`
- **核心规格**：
  1. **两级受控离场触发（严禁心跳轮询）**：
     - 播放退出时（`player-host` 销毁钩子）与应用挂起时（`App.addListener('appStateChange')` 且 `isActive === false`）触发 `POST /api/user/sync`；
     - 请求携带 `fetch(url, { keepalive: true })`；挂起前写入本地待发队列，下次启动补传。
  2. **私密内容物理脱敏**：
     - 上报前必须通过既有 `assertWritable('sync', item)`（`src/core/storage/storage-domains.ts`）校验；个人探索私密剧目**绝对禁止上报**。
  3. **拉取与合并**：
     - 登录/换设备或进入【追剧】页时触发 `GET /api/user/sync`；
     - 断点按 `updatedAt` 时间戳取较新者合并入 SQLite；偏好画像注入推荐引擎，新端冷启动即享精准混排。

---

### Task 6: 实施 WP0 / WP8 · 验收编号对齐、全量回归与出厂构建
- **对应验收**：AC-19 ~ AC-30 全部
- **涉及文件**：`docs/04-spec/SPEC-v2.0.md`、`docs/01-prd/PRD-prism-play.md`、`tests/verify_acceptance.py`、`tests/client/*.test.ts`
- **核心规格**：
  1. **扩展验收编号**：
     - 在 `SPEC-v2.0.md` §9 补齐 **AC-19 ~ AC-30**（表格必须保持 `| **AC-xx** | 名称 | EARS | 优先级 |` 格式）；
     - 同步 `tests/verify_acceptance.py`：断言行数 `== 30`，横幅文案更新为 `30/30`；
     - 补齐对应的单元测试署名用例（每个测试标题必须带 `AC-xx`）。
  2. **全流程门禁跑通**：
     - `python tests/scan_p0.py` 必须全绿（单文件 ≤ 300 行）；
     - `python tests/verify_contracts.py` 必须全绿；
     - `python tests/verify_acceptance.py` 必须全绿（30/30 条）；
     - `python tests/verify_android_assets.py` 必须全绿；
     - `npx vitest run` 全量测试必须通过。
  3. **出厂编译与签名校验**：
     - 提交 Git 并推送到远程触发 GitHub Actions；
     - 下载编译出的 APK，核验签名证书指纹必须与 WP1 基线一致（`8B:C2:28...`），实现覆盖安装零报错。

---

## 三、 验收编号映射总表 (AC-19 ~ AC-30)

| 验收编号 | 名称 | 验收断言核心标准 | 负责工作包 |
| :--- | :--- | :--- | :--- |
| **AC-19** | 竖屏短剧全屏沉浸 | 9:16 短剧全屏：保持竖屏，`object-fit: contain` 零裁切，底片铺满无黑边 | WP2 |
| **AC-20** | 横屏影视联动全屏 | 16:9 影视全屏：联动 ScreenOrientation 旋转横屏展开，退出恢复竖屏 | WP2 |
| **AC-21** | 返回键级联退出 | 全屏按返回键：第一下仅退出全屏恢复详情台，再按才退出播放器 | WP2 |
| **AC-22** | 永久签名覆盖安装 | APK 无需卸载直接覆盖安装，签名 SHA-256 跨构建 100% 恒定一致 | WP1 (已就绪) |
| **AC-23** | 有效公网分享 | 分享链接锁死 `https://play.prismos.org/s/:id?ep=N`，含剧名集数，零 localhost | WP3 (已就绪) |
| **AC-24** | 局域网大屏投屏 | 发现 Wi-Fi 电视设备并推送流播放；H1~H3 方案合规落地 | WP4 |
| **AC-25** | 顶栏居中与排版移顶 | 顶栏品牌垂直居中；四模切换器吸附顶栏右侧；彻底消除重复频道标题 | WP5 |
| **AC-26** | 分类胶囊双口径收敛 | 一级频道 17px；胶囊视觉高度 28px、点击命中区 ≥44px | WP5 |
| **AC-27** | 底部Tab栏宽度收缩 | 底部 Tab 栏内容区限宽 360px 居中收紧，手势内聚舒适 | WP5 |
| **AC-28** | 端侧 3.5:3.5:3 推荐混排 | 本地 7 天半衰期打分；20 条块严格 7A/7H/6E；追加分页零重排；耗时 ≤ 2ms | WP6 |
| **AC-29** | 海报极简微光角标 | 左上角角标双模同值 tokens；缺字段留白不贴标；P0 零 Emoji | WP6 |
| **AC-30** | 端云状态多端同步 | 退出与切后台静默上报；新端比对时间戳秒级续播；私密内容零上报 | WP7 |

---

## 四、 施工总包交付确认清单

总包 Agent 施工完成后，向监理方交付需附带以下凭证：
1. `git status` 确认工作区干净，且**零 `edge/**` 修改痕迹**；
2. 四道门禁脚本本地全绿截图/控制台输出（P0扫描、G0契约、AC矩阵 30/30、Android资产）；
3. 全量测试通过报告；
4. CI 构建生成的最新正式 APK 产物。
