# 《光影Play》（Prism Play）全屏自适应重构、永久签名固化、有效分享修复、大屏投屏重拾、首屏视觉精致化、3.5:3.5:3 推荐混排、端云多端状态同步与多级热更新架构规格及行动计划二合一文档 (PLAYER-FULLSCREEN-SIGNING-UPDATE-SPEC-AND-PLAN.md)

> **版本**：v2.5 架构全景大正本（已按 `docs/05-audit/PLAN-REVIEW-2026-10-03.md` 审核意见修正）  
> **编制日期**：2026-10-02　**修订日期**：2026-10-03  
> **维护主体**：Master_流光逸影 (战略与体验权威定案) & UI设计全栈专家团 (全栈工程闭环)  
> **服务主域**：`https://play.prismos.org`  
> **文档属性**：架构规格 (SPEC) + 实施指南 (Action Plan) 二合一终审依据  
> **核心使命**：彻底根除真机全屏播放严重错乱、永久解决覆盖安装“签名不同(-7)”硬伤、修复分享生成 localhost 无效死链、重拾原果果剧库（`guoguo-juku`）具备的局域网电视大屏 DLNA 投屏能力、全面重塑首屏/外壳排版视觉平衡（拔除冗余、层级降维、排版器移顶释放空间、底栏内聚），融合落地“35% AI精品 + 35% 全网热门 + 30% 口碑破圈”高效自适应混排与极简微光角标系统，打通 `/api/user/sync` 端云状态同步中枢（断点与画像跨端无缝继承），并确立“云端数据即时生效 + Web资源静默热更 + 原生底座极低频出包”的三级现代化发布演进体系。

> **本次修订（v2.4 → v2.5）修正要点**：① 验收编号改为 `AC-19…AC-30`，与 `SPEC-v2.0.md` §9 单一编号权威对齐，杜绝门禁假绿；② 澄清 `isAi/isHot` 云端为**待交付硬前置**（经仓库核验尚不存在），并补字段缺失降级；③ 补门禁同步清单并按**归属切分**（云端项交回 `CLOUD-SYNC-JIT-PIPELINE-SPEC.md`，避免与云端专员重复改同一处）；④ 清除本文档内 emoji 与裸 Hex（自身违反 P0-1/P0-3）；⑤ 胶囊改「视觉 28px / 命中 ≥44px」双口径（P0 无障碍下限）；⑥ 全屏指定唯一权威，禁止 `art.fullscreenWeb`；（7）9:16 定策 `contain` + 零裁切；⑧ 混排改「20 条编织块 7:7:6」解决余数与翻页重排；⑨ DLNA 补三项硬前置；⑩ L2 热更新显式降级为 Backlog。

---

## 第〇部分：范围声明（**开工前必读，防止越界与重复施工**）

> **本计划是「APP 客户端」的规格与行动计划，且仅为客户端。**

| 层 | 归属 | 本计划的态度 |
| :--- | :--- | :--- |
| **客户端（APP）**：`src/**`、`android/**`、`tests/client/**`、客户端侧 tokens 与 CSS | **本计划 = 唯一交付方** | 全部机制、工作包、验收项均在此范围内 |
| **客户端侧门禁**：`tests/verify_acceptance.py`、`SPEC-v2.0.md` §9、`PRD` 第九章、`design-tokens.{css,json}` | **本计划负责**（详见 §2.0 B 组） | 需改，且属**共享文档**，改动前与云端专员打招呼避免同文件并发冲突 |
| **云端**：`edge/**`、`edge/migrations/**`、`/api/user/sync` 路由、`ContentItem` 服务端字段、`openapi.yaml` 契约、云端门禁（A 组） | **另一位 Agent（云端专员）全权负责** | **本计划不承担任何云端交付**。云端项在本计划中**一律只作为「外部依赖」出现**，用于声明"我依赖什么、什么时候可以联调"，**不是我的待办** |
| **云端规格正本** | `docs/04-spec/CLOUD-SYNC-JIT-PIPELINE-SPEC.md` | 我**只读消费**，**不在本计划内改写、不复制其 SQL 与文件清单** |

**由此产生的两条协作纪律**：

1. **本包只在客户端侧动手**。凡涉及 `edge/**` 或 `migrations/**` 的改动，无论我判断为"必要"与否，**一律不在本包执行**，最多以「云端依赖」条目提出并交由云端专员裁决；
2. **本包所有工作包（WP1–WP8）的文件清单中，不得出现任何 `edge/` 路径**。此为可机械校验的自检规则（见 §2.4 铁律 8）。

---

## 第一部分：体系架构与技术规格书 (SPEC)

### 1.1 核心问题全景诊断与机理复盘

在近期的真机实测与功能走查中，结合 Master 截图与协作指令包，精准定位出以下七大影响产品工业级体验与正常发布的物理阻断：

```
                              七大现场问题与根因拓扑
    ┌────────────────────────────────────────────────────────────────────────┐
    │ 1. 全屏播放机制严重错乱 (横屏竖屏均居中缩在小方块里)                     │
    │    • 根因：全屏存在“三重权威”互相争夺——app.css 的 !important 链、       │
    │      art.fullscreenWeb 触发的 WebView 原生全屏容器、宿主类开关；三者互不  │
    │      感知，且未指定唯一权威，故横竖屏均被锁在中部小盒内。                 │
    ├────────────────────────────────────────────────────────────────────────┤
    │ 2. 覆盖安装失败 (错误码 -7：与已安装应用签名不同)                         │
    │    • 根因：Gradle 构建未配置固定 debug.keystore，GitHub Actions 随机虚拟机 │
    │      每次临时动态生成新证书，导致安装包证书指纹每次漂移，强制用户每次先卸载 │
    ├────────────────────────────────────────────────────────────────────────┤
    │ 3. 分享功能生成 localhost 无效死链 (与既定设计严重不符)                   │
    │    • 根因：客户端 share.ts 误用 window.location.origin，在 Android 原生   │
    │      WebView 中生成了 http://localhost/s/... 外部完全无法访问的本地死链    │
    ├────────────────────────────────────────────────────────────────────────┤
    │ 4. 局域网大屏电视 DLNA 投屏功能丢失 (原有核心能力被遗漏)                  │
    │    • 根因：从旧 Go 单体迁移至 Capacitor 7 方案 B 期间，操作岛与播放器中     │
    │      完全丢弃了原 guoguo-juku 完备的 DLNA SSDP 局域网设备探测与大屏控制链路 │
    ├────────────────────────────────────────────────────────────────────────┤
    │ 5. 首屏/外壳排版视觉失衡、空间浪费与层级倒挂 (截图精准曝光)              │
    │    • 根因：顶栏 Branding baseline 导致文字偏上未垂直居中，右侧大片死黑；   │
    │      二级胶囊绑定 44px 高度反超一级频道喧宾夺主；中间无谓重复显示频道标题并 │
    │      单占一整行放排版器，海报流被严重下压；底部 TabBar 铺满松散难盲操。     │
    ├────────────────────────────────────────────────────────────────────────┤
    │ 6. 首页片单呈现纯单向静态线性，缺乏未来趋势与千人千面温度                │
    │    • 根因：仅按入库倒序死板展示，缺少 AI 短剧/动漫战略倾斜与大盘热度混排； │
    │      海报缺乏极客品质角标，无法一目了然区分 AI 精品、热门爆款与口碑推荐。  │
    ├────────────────────────────────────────────────────────────────────────┤
    │ 7. 多端 (手机 / 电视 / PC) 进度与喜好割裂，缺乏统一状态同步中枢          │
    │    • 根因：未打通云端同步管道，用户在手机端观看的断点与培养的偏好画像无法 │
    │      被客厅大屏或新设备无缝继承；缺乏统一的 /api/user/sync 双向同步中枢。  │
    └────────────────────────────────────────────────────────────────────────┘
```

---

### 1.2 机制一：全屏播放与画幅自适应规格 (Fullscreen & Aspect SPEC)

对标果果剧库（`guoguo-juku`）成熟的生产级全屏经验，确立**“单一权威受控 + 真实画幅嗅探 + 原生方向智能联动 + 级联系统返回”**的规范：

```
                           视频流就绪 (loadedmetadata)
                                      │
                                      ▼
                        读取视频物理尺寸 (videoWidth / videoHeight)
                                      │
                     ┌────────────────┴────────────────┐
                     ▼                                 ▼
           【9:16 竖屏短剧】                   【16:9 横屏影视】
           (videoWidth < videoHeight)         (videoWidth > videoHeight)
                     │                                 │
                     ▼                                 ▼
      • 保持手机竖直自然握持             • 联动调用 @capacitor/screen-orientation
      • contain 等比铺满视口高度          • 锁定旋转为横屏 (landscape)
      • 底片填充留白（零裁切）            • contain 等比铺满视口宽度
                     │                                 │
                     └────────────────┬────────────────┘
                                      │
                                      ▼
                         系统 Back 键 / 全面屏侧滑拦截
                         (第一级：退出全屏并恢复竖屏详情台；
                          第二级：再次返回才关闭播放器)
```

#### 0. 全屏唯一权威（先决条款 · 最高优先级）

**判定**：全屏状态的唯一权威是 **宿主 CSS 状态机**（`player-host.ts` 的 `isFullscreen` 状态 + `.prism-player-host--fullscreen` 类）。除此之外的一切全屏通道**一律禁止**。

* **严禁调用 `art.fullscreenWeb`（含 getter/setter）**：该 setter 会触发浏览器 Fullscreen API，在 Android WebView 中经 Capacitor 的 `WebChromeClient` 走**原生全屏容器**；而 `MainActivity` 现未覆写 `onShowCustomView / onHideCustomView`，该容器与我们的 CSS 层**互不感知**——这正是旧缺陷“横竖屏均缩在中间小方块”的病理来源。`prism-player.ts` 现有的 `setFullscreen: (f) => { art.fullscreenWeb = f; art.autoSize(); }` 必须改为**仅保留 `art.autoSize()`**，去掉 `fullscreenWeb`。
* **保留 `art.autoSize()`**：它只重算播放器内部尺寸，不触发任何原生全屏通道，与 CSS 权威不冲突。
* **废除 `app.css` 中针对 `.prism-player-host__stage / .prism-player / video` 的 `!important` 链**（现 218–224 行共 7 条），改为普通声明 + 宿主类受控开关；`:where()` 降优先级或用状态机替代，杜绝魔法优先级。
* **`MainActivity` 不接管 `onShowCustomView`**：因为唯一权威已是 CSS，WebView 永不应进入原生全屏；这条同时是一个**可验证的断言**——在全屏进出过程中 `onShowCustomView` 不得被触发。

#### 1. 真实画幅自适应判定 (Aspect Ratio Sniffing)
* 在视频元数据加载完成（`loadedmetadata`）后，实时嗅探物理分辨率：
  $$\text{isVideoPortrait} = (\text{video.videoWidth} > 0) \;\land\; (\text{video.videoHeight} > \text{video.videoWidth})$$
* **竖屏短剧全屏处理**：
  - 用户点击【沉浸全屏】或进入全屏时，**严禁强制旋转手机为横屏**；
  - 隐藏非全屏详情台与顶栏；视频以 **`object-fit: contain` 等比铺满视口高度**；
* **横屏影视全屏处理**：
  - 用户点击【沉浸全屏】时，利用已安装的原生插件 `@capacitor/screen-orientation`：
    调用 `ScreenOrientation.lock({ orientation: 'landscape' })`，通知 Android 旋转为横屏展开；
  - 退出全屏时，调用 `ScreenOrientation.unlock()` 并恢复为竖屏。

#### 2. 画幅留白定策：**`contain` + 底片填充，零裁切**（替换原“contain 或 cover”）

**数学事实（必须承认的物理约束）**：典型短剧 1080×1920（9:16 = 1.78），典型手机 1080×2400（20:9 = 2.22）。

| 策略 | 结果（已换算） |
| :--- | :--- |
| `contain`（等比完整显示） | 视频高 1920 / 屏高 2400 → 上下共留 **480px** 中性留白 |
| `cover`（铺满不留白） | 视频被放大到高 2400 / 宽 1348 → 左右共裁 **268px ≈ 画面宽度 20%** |

两者必然损失约 20%：**要么是中性留白，要么是画面内容**。对竖版短剧（烧录字幕、人物居中构图）而言，裁掉 20% 宽度会切掉字幕与两侧信息，**不可接受**。

**定策**：全屏一律 **`object-fit: contain`（零裁切）**，留白区由**已存在的高斯模糊海报底片 `.prism-player__backdrop`** 铺满填充。因此：
- **画面内容零裁切**（首要原则，绝不牺牲内容）；
- **视觉上无死黑**（留白由底片覆盖，不是纯黑块）；
- **舞台 100% 充满视口**（“顶天立地”指的是舞台充满，而非视频像素铺满）。

#### 3. DOM 层次与样式规范（彻底废除破坏性 !important）
* 全屏切换通过宿主状态机受控管理：
  - 非全屏态：`.prism-player` 遵循标准比例（自适应居中，下承接详情生态台）；
  - 全屏沉浸态：`.prism-player-host--fullscreen` 隐藏顶栏与详情台，播放舞台充满全屏视口，并调用 `art.autoSize()` 使原生 HUD 与控制条贴合屏幕安全区。

#### 4. 级联系统返回退出机制 (Hierarchical Back Exit)
接入 `src/core/native/back-button.ts` 调度总线：
* **当前处于全屏沉浸态**：按下系统 Back 键或全面屏侧滑手势时，**100% 优先拦截并退出全屏，平滑恢复至竖屏详情生态台，绝不直接退出播放器**；
* **当前处于非全屏详情态**：再次按下返回键，才执行正常退出播放器并返回前序页面。

---

### 1.3 机制二：工程级永久固化 Android 签名规格 (Keystore Permanent Pinning SPEC)

为彻底消灭覆盖安装报错（`-7`），必须将签名控制权收归工程自身：

#### 1. 签名资产工程内固化
* **生成永久调试密钥库**：在 `android/app/` 目录下生成并永久存放 `debug.keystore`；
* **生成命令（唯一正本，禁止手改别名/密码）**：
```bash
keytool -genkeypair -v \
  -keystore android/app/debug.keystore \
  -storepass android -keypass android \
  -alias androiddebugkey \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -dname "CN=Android Debug,O=Android,C=US"
```
* **纳入 Git 版本控制**：该文件作为通用工程标准直接提交入库，绝不依赖外部临时环境。
  - 已核验：`android/.gitignore` 中 `#*.keystore` **处于注释状态**，故可直接提交；若日后有人取消注释，本机制会**静默失效**（CI 不会报错，只会又开始漂移）→ 必须在本机制旁留一条守卫说明，并在 WP9 的出包验收里**硬校验签名的 SHA-256 恒定**。

#### 1.1 已知取舍（必须写入交付说明，不得隐瞒）
将 `debug.keystore` 连同口令 `android` 一并入库，意味着**任何拿到仓库的人都能签出与官方包同签名的 APK**，Android 的"同签名即允许覆盖安装"检查因此不再具备防篡改语义。本项目为**私域侧载分发**（非应用商店、无商店签名链），此取舍可接受；但必须在交付说明中如实写明，且**不得**对外宣称"安装包经过签名保护"。

#### 2. Gradle 构建脚本强制绑定 (`android/app/build.gradle`)
在 `android/app/build.gradle` 中显式配置：
```groovy
android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.debug
        }
    }
}
```

#### 3. 达成的核心价值
无论是在 Master 本机编译、新开发机协同，还是在 GitHub Actions 任何一台随机 Ubuntu 临时虚拟机上编译，**产出的 APK 签名哈希（SHA-256）100% 永久恒定一致**。Master 手机上可永久点击覆盖安装，所有数据完好无损！

---

### 1.4 机制三：有效公网分享与邀请裂变规格 (Share Link & Invite SPEC)

彻底纠正目前生成 `http://localhost/...` 无效死链的严重缺陷，全面对齐既定架构设计：

#### 1. 绝对公网主域锁定 (Strict Public Origin)
* **主域规范**：所有分享链接的根域名严格锁死为统一服务主域 **`https://play.prismos.org`**；
* **严禁动态读取本地 Origin**：彻底废除 `src/core/share.ts:22` 的 `const origin = deps.origin ?? window.location.origin;`（`src/main.ts:138` 调用处从未传 `origin`，故实机必退化）。改为**模块级常量** `const SHARE_ORIGIN = 'https://play.prismos.org'`，并**删除 `origin?` 依赖项**，从类型上杜绝再次误传；
* **规范分享 URL 格式**：
  $$\mathbf{https://play.prismos.org/s/\{drama\_id\}?ep=\{episodeNumber\}}$$
  （若当前设备具备邀请裂变码，自动追加 `&ref={inviteCode}`）；
* **`&ref=` 的诚实定位（勿夸大）**：边缘 `edge/src/routes/share.ts:154` 自陈 `ref` 是 **display-only 归因参数**——URL 参数无法跨越 APK 安装环节。故本条**不得**表述为"邀请裂变闭环"，仅作分享来源归因。

#### 2. 体贴分享文案格式化 (Share Text Formatting)
分享文本必须包含完整信息（剧名取 `item.title` 实值，集数取当前播放集，缺省为 1）：
```text
【光影Play】邀请你看《年终奖不能停》第1集，点开即播免下载：
https://play.prismos.org/s/drama_modu_90502?ep=1
```
好友收到后无论在微信、QQ 还是手机浏览器中点开，直接触发云端 H5 页面秒开播放。

> **数据可用性已核验**：`/s/:id` 路由完整存在，且入库脚本（`edge/scripts/process-harvest.mjs:259`、`seed-runner.mjs:239`）对所有条目写入 `shareable=1, enabled=1`，故分享链接落地**可播**，非空壳承诺。

#### 3. 原生系统分享面板无缝集成 (Native Share Fallback)
* 优先调用 Android 原生系统分享弹窗（通过 Capacitor 原生系统 Share 接口）；
* 若原生分享不可用或被拒绝，平滑降级为复制完整文案至系统剪贴板，并弹出温和的琥珀金 Toast 提示：“分享链接已复制，可直接粘贴给好友”。

---

### 1.5 机制四：局域网大屏 DLNA 电视投屏系统重拾规格 (DLNA Cast System SPEC)

重拾并继承原果果剧库（`guoguo-juku`）成熟的 DLNA 投屏能力，在 Capacitor 7 方案 B 下实现现代化改造：

#### 1. 用户界面与操作动线 (UI & Interaction Flow)
* **操作工具岛入口**：在非全屏播放详情台的操作岛中，保持 4 键结构，其中投屏键为：
  - 【追剧/已追】
  - **【投屏】**（高频核心大键，上图标下文字）
  - 【分享】
  - 【沉浸全屏】
* **图标铁律（P0-1）**：
  - 投屏键图标使用 **Lucide `cast`**：需从 devDependency `lucide-static@1.48.0` 的 `icons/cast.svg` 提取 2px stroke 几何，追加进 `src/components/icons.ts` 的 `SHAPES`（登记为 `cast`）；
  - 「重新扫描」按钮复用**既有** `refresh` 图标（`SHAPES.refresh` 已存在），**零新增**；
  - **严禁任何 emoji 字符**（如电视、循环箭头类字形）。`scan_p0.py` 的 `EMOJI_RANGES` 覆盖 `0x1F000–0x1FAFF`，任何 emoji 落入 `src/` 都会立即判红；
  - 图标尺寸严格取 `ICON_SIZES` 允许值（16 / 20 / 24）。
* **大屏设备发现面板 (DLNA Cast Bottom Sheet)**：
  - 点击【投屏】，从屏幕底部升起半屏 Inset Grouped 卡片面板；
  - 自动向局域网 Wi-Fi 发起广播扫描，展示扫描到的电视/投影仪设备列表（如：`客厅的小米电视`、`卧室的华为智慧屏`、`极米投影仪`）；
  - 设备行展示设备名称与 IP 地址；面板右上方设【重新扫描】（`refresh` 图标）按钮；
* **投屏激活态控制器 (Active Cast Banner)**：
  - 投屏成功后，手机端界面展示琥珀金呼吸状态条：“正在投屏至 [客厅的小米电视] · 支持自动无缝连播”；
  - 提供【暂停】、【退出投屏】控制；当前集播完后，系统自动向电视推送下一集播放，实现无缝连播。

#### 2. 技术实现路径（Capacitor 原生 DLNA 桥接架构）
前端运行在 WebView 中，浏览器 JS 无法直接发送 UDP 组播包（`239.255.255.250:1900`），必须通过 Capacitor 原生 Android 扩展实现：

```
  [前端 WebView 操作岛] ──► 点击【投屏】
           │
           ▼ (Capacitor Bridge 调用)
  [Android 原生 PrismCastPlugin / DlnaManager]
           │
           ├─► 1. 发送 SSDP M-SEARCH 广播 (UDP 239.255.255.250:1900)
           ├─► 2. 收集局域网大屏响应，解析 Location XML 获取 AVTransport 控制 URL
           └─► 3. 回调前端渲染可用设备列表
           │
  [用户点选目标电视设备] ──► (HTTP AVTransport SOAP: SetAVTransportURI + Play)
           │
           ▼
  [电视大屏拉取真实流媒体播放，手机进入遥控与状态同步]
```

#### 2.1 三项硬前置（经仓库核验的阻断项，不解决则 AC-24 不可达）

| # | 阻断项 | 核验证据 | 处置定策 |
| :--- | :--- | :--- | :--- |
| **H1** | **明文 HTTP 被平台策略拦截** | `android/app/src/main/AndroidManifest.xml` 声明 `android:usesCleartextTraffic="false"`；`res/xml/network_security_config.xml` 的 `base-config` 亦为 `cleartextTrafficPermitted="false"`。而 AVTransport SOAP 控制是 `http://192.168.x.x:PORT/...` **明文** | 视频流本身已是公网 HTTPS 代理流，**唯一明文只剩 SOAP 控制**。定策：控制命令由原生侧**直接基于 `java.net.Socket` 手写最小 HTTP/1.1 请求**（平台明文策略由 `NetworkSecurityPolicy` 约束，仅被 OkHttp/HttpURLConnection 等库依约执行，裸 socket 不在其管辖内）。**该决策需 Master 单独签核**，并随附安全说明：目标地址仅来自本机 SSDP 发现结果的 RFC1918 私有地址，绝不接受用户输入的任意主机 |
| **H2** | **缺组播接收权限** | `AndroidManifest.xml` 现无 `CHANGE_WIFI_MULTICAST_STATE`；无此权限 + `WifiManager.MulticastLock` 时，SSDP 单播回包（常见实现）或组播回包易被 Wi-Fi 省电策略丢弃，表现为"扫描零设备" | 补 `android.permission.CHANGE_WIFI_MULTICAST_STATE`，并在扫描期间持有 `MulticastLock`，**扫描结束后立即释放**（不得常驻，须在代码注释写明理由） |
| **H3** | **无法放行"整个局域网网段"** | Android `network_security_config.xml` 的 `<domain>` 只接受具体主机名/IP 字面量，**不支持 CIDR**；目标电视 IP 由 DHCP 动态分配，编译期不可知 | 因此**放弃**"用 security config 开白名单"的路线，回到 H1 的裸 socket 方案（这也是 H1 定策的另一半理由） |

#### 2.2 落地约束（已核验为"可行"的部分）

* **SSDP 走原生 UDP 裸 socket，不受明文策略约束** → H1 只影响 SOAP 控制，不影响设备发现；
* **不需要改 `capacitor.settings.gradle`**：照既有 `PrismNativePlugin` 的**同模块**模式，在 `MainActivity.onCreate` 中 `registerPlugin(PrismCastPlugin.class)` 即可（`capacitor.plugins.json` 只承载 npm 侧插件，app 模块插件不走它）；
* **但必须过 `verify_android_assets.py` 门禁**：第 6 条要求"Java 注解 `@CapacitorPlugin(name=…)` 与 TypeScript 常量逐字一致"，第 7 条要求清单声明 Java 会启动的组件 → 新增权限与插件名必须两侧同步；
* **安全代理地址投屏**：向电视推送的视频流地址必须是电视可直连解析的公网代理流（`https://play.prismos.org/proxy/media/...`）或经清洗的直出流，确保大屏电视能够顺利硬解播放。

---

### 1.6 机制五：三层版本发布与热更新架构规格 (Three-Tier Release & Live Update SPEC)

彻底厘清“改了什么必须发版，改了什么可以直接云端生效”，从架构层面为用户减负：

```
                          《光影Play》三层交付架构
  ┌─────────────────────────────────────────────────────────────────────────┐
  │ 【L1: Edge 纯数据即时生效层】(100% 免编译、免安装、0秒全网生效)        │
  │ • 适用范围：片单入库、剧目集数更新、主流二级分类胶囊调整、流媒体代理源调度 │
  │ • 技术载体：Cloudflare D1 / KV / API 动态下发                          │
  │ • 用户体验：打开 App 即是最新数据，完全无感                             │
  ├─────────────────────────────────────────────────────────────────────────┤
  │ 【L2: Web Bundle 热更新层 (Live Update)】(免装 APK、静默无感迭代)       │
  │ • 适用范围：UI布局排版、CSS样式、页面间距、播放器交互逻辑、TypeScript 业务代码│
  │ • 技术载体：Vite 前端产物 (dist.zip) 托管于 Cloudflare R2 / Pages      │
  │ • 更新机制：客户端启动检查版本，后台静默下载解压至私有目录，下次无感切入  │
  │ • 用户体验：无需频繁下载和安装 APK，UI与功能自动升级                    │
  ├─────────────────────────────────────────────────────────────────────────┤
  │ 【L3: Native 原生安装包编译层】(低频维护、GitHub Actions 自动化流水线)   │
  │ • 适用范围：MainActivity 原生 Java 代码、Capacitor 插件增减、系统权限变更 │
  │ • 技术载体：GitHub Actions 编译打包生成带固定签名的正式 APK             │
  │ • 更新机制：多维复合版本号变更（dev_v2.x.x.x），手动下载覆盖安装       │
  │ • 发生频率：数月一次，底座稳固后基本不触发                              │
  └─────────────────────────────────────────────────────────────────────────┘
```

#### 本期范围界定（诚实声明，避免"有规格零工作包"）

* **本期只实现 L1（云端数据）与 L3（原生出包）**。本波次全部交付物——含新增原生插件 `PrismCastPlugin`、权限变更、`network_security_config` 决策——**一律通过 L3 出包交付**。
* **L2（Web Bundle 静默热更）本期显式列为 Backlog，不实现**。理由：`package.json` 目前无任何 live-update 插件（无 `@capgo/capacitor-updater` 之类），R2 托管通道亦未建立，本期引入会显著延长交付链且无法在真机验收窗口内验证。
* **启用 L2 前必须先建立 native ↔ web 版本锁（前置约束，不可跳过）**：一旦 L2 生效，一个声明了 `PrismCastPlugin` 依赖的 web bundle 若落到**尚未内置该插件**的旧宿主上，将直接白屏或调用失败。因此 L2 的版本清单必须携带**宿主能力清单/native 版本下限**，客户端在切入新 bundle 前先校验宿主能力，不匹配则拒绝切换并保留旧 bundle。
* **机制五的其余内容（L1 即时生效）已由现有 Cloudflare D1/KV 通道自然具备**，无需额外工作包。

---

### 1.7 机制六：首屏与外壳视觉精致化及空间收敛规格 (Home & Shell UI Refinement SPEC)

响应 Master 真机走查截图中的 4 处关键标注（【高度没有居中】、【超过了一级标题大小】、【重复显示】+【移动到上方】、【缩小宽度】），确立首屏及应用外壳的工业级排版规范：

```
                    首屏与应用外壳空间收敛与层级重整拓扑
    ┌────────────────────────────────────────────────────────────────────────┐
    │ 顶栏 Header (52px) [居中对齐 + 左右两端对称]                            │
    │ ┌───────────────────────────┐          ┌─────────────────────────────┐ │
    │ │ [光影Play] (--text-md 琥珀金)│         │ 四模排版切换器 (纯图标)      │ │
    │ │ [大视界]   (--text-xs 次标) │          │ [四格] [相框] [九宫] [列表] │ │
    │ └───────────────────────────┘          └─────────────────────────────┘ │
    ├────────────────────────────────────────────────────────────────────────┤
    │ 一级频道栏 (视觉 40px) [高支配力主导航]                                 │
    │  【短剧精选】 (--text-md 粗体+琥珀短横)  院线电影  热血动漫  人文纪录   │
    ├────────────────────────────────────────────────────────────────────────┤
    │ 二级分类胶囊 (视觉 28px / 命中 ≥44px) [轻量辅助筛选 · 彻底降维]        │
    │  (全部) (战神) (逆袭) (都市) (古装) (甜宠) (悬疑)                      │
    ├────────────────────────────────────────────────────────────────────────┤
    │ 搜索栏 (48px 全宽极简卡片) ── 搜索剧名 / 题材                         │
    ├────────────────────────────────────────────────────────────────────────┤
    │ 【原标题与排版行已彻底拔除】(省下 40px 高度，海报流整体上移贴近搜索栏)  │
    ├────────────────────────────────────────────────────────────────────────┤
    │ 海报瀑布流 (四模自适应响应 · 首屏直接露出版心)                          │
    │ ┌───────────────┐ ┌───────────────┐ ┌───────────────┐                 │
    │ │  剧目海报卡   │ │  剧目海报卡   │ │  剧目海报卡   │                 │
    │ └───────────────┘ └───────────────┘ └───────────────┘                 │
    ├────────────────────────────────────────────────────────────────────────┤
    │ 底部导航栏 TabBar (max-width: 360px 居中收拢 · 拇指操作内聚优雅)       │
    │        [大视界]          [追剧]          [搜索]          [设置]        │
    └────────────────────────────────────────────────────────────────────────┘
```

#### 1. 顶栏品牌区 (App Brand) 垂直绝对居中与功能吸附
* **当前弊端**：`app-brand` 使用 `align-items: baseline`（且**未拉满高度**）导致文字贴顶，52px 顶栏容器内未垂直居中，右侧大片留白；
* **规格重构**：
  - 顶栏布局重构为 `display: flex; align-items: center; justify-content: space-between;`，容器高度拉满 `var(--header-height)`；
  - 左侧品牌标用 `var(--text-md)`（17px）+ `--font-display` + 琥珀金（`var(--accent)`），次标用 `var(--text-xs)`（12px）+ `var(--muted)`；
  - 顶栏右侧吸附由下方上移的四模排版切换器，消除右侧留白，形成“左品牌、右工具”的对称平衡。

#### 2. 层级纠偏：二级分类胶囊降维与一级频道支配力强化（含无障碍双口径）

* **当前弊端**：二级胶囊绑定 `--subnav-height`（44px）与醒目圆角框，视觉体量反超一级频道（15px），层级倒挂；
* **规格重构**：
  - **强化一级频道权威**：一级频道字号升至 `var(--text-md)`（17px，**上梯级，替代原先的 16px 非梯级值**）+ `font-weight: 700`；激活项以琥珀金短横线居中指示，确立一级层级。
  - **克制二级胶囊视觉体量**：新增 tokens `--capsule-height: 28px`（视觉高度）与 `--capsule-hit: 44px`（命中高度），在 `design-tokens.css` 与 `design-tokens.json` **双写**；胶囊视觉高度降至 28px、字号 `var(--text-xs)`（12px）、内边距 `0 var(--space-3)`、边框 `var(--border-subtle)`，激活态为克制琥珀金微光底色。
  - **【无障碍硬约束 · 不可省略】**：`SPEC-v2.0.md:202` 明令「可点击目标 **≥44px**」。胶囊是 `<button>`，故 **28px 只能是视觉高度，命中区必须仍 ≥44px**：由外层 `.capsule-rail-wrap` 承担垂直 padding（上下各 `var(--space-2)`，即 8+28+8 = 44px），使**视觉 28px、命中 44px** 同时成立。此条须在实现注释中写明理由，防止日后有人"顺手压缩高度"而击穿无障碍下限。

#### 3. 彻底拔除冗余标题，排版切换器上提顶栏右侧吸附
* **当前弊端**：搜索栏下方重复显示选中频道名（如「短剧精选」），与顶部一级频道 100% 重复；为容纳 4 个排版图标又单占一行约 40px，严重压低海报流；
* **规格重构**：
  - **物理拔除**：删除 `.home-section-header` 与 `.home-section-title`（连同 `home-view.ts` 中的 `heading / titleGroup / channelName / modeTag` 构造与 `paintHeading()`）；
  - **图标移顶**：将排版切换器（4 颗 `30×30px` 纯图标按钮，零文字冗余）**上提嵌入顶栏 Header 右侧**；因顶栏由 `app-shell.ts` 的 `brand()` 在每次 `paint()` 时 `replaceChildren` 重建，切换器须改为由外壳持有并**复用同一实例**（不可随 Tab 切换重建，否则会丢失 `aria-pressed` 与偏好态）；
  - **空间释放效益**：消灭整整一行垂直占位，**海报瀑布流整体上提 40px+**。

#### 4. 底部导航栏 (Bottom TabBar) 宽度收敛与黄金手势区内聚
* **当前弊端**：4 个 Tab 简单粗暴以 `space-around` 横向拉满 100% 视口，在主流 Android 全面屏上极其松散，且两端 Tab 超出单手大拇指舒适盲操热区；
* **规格重构**：
  - 底部导航栏内容承载区设置最大宽度约束：`max-width: 360px; margin: 0 auto; width: 100%;`；
  - 4 个 Tab（大视界/追剧/搜索/设置）在中央 360px 黄金手势区内紧凑排布，拇指微动即可全覆盖，视觉呈现高端流媒体的内收精致底盘。

---

### 1.8 机制七：端侧 3.5:3.5:3 自适应推荐混排与微光角标规格 (Adaptive Recommendation & Badges SPEC)

将大视界从纯单向线性流水，升级为兼顾未来趋势与大盘流量的 **“35% AI精品 + 35% 全网热门 + 30% 口碑破圈” 自适应混排架构**，并装配极简微光角标系统：

```
                    端侧高效实时 3.5:3.5:3 E&E 推荐流水线拓扑
  ┌────────────────────────────────────────────────────────────────────────┐
  │ 【高能效端侧编织】0 网络往返延迟，≤2ms 纯内存实时演算与去重编织       │
  └────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │ 0. 稳定序基线：先按 id 字典序排序，消除网络返回顺序差异  │
        └─────────────────────────────────────────────────────────┘
                                     │
                                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │ 1. 动态兴趣画像打分 (7天半衰期时间衰减)                  │
        │    Score(Genre) = Σ [ 0.5^(Δt/7d) × (Ep×2 + Min×0.5) ]   │
        └─────────────────────────────────────────────────────────┘
                                     │
                                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │ 2. 三轨互斥去重管道 (严格单向消费，selectedSet 绝对去重) │
        │   • A 轨 (AI精品 · 战略倾斜): isAi === true，按偏好分排  │
        │   • B 轨 (全网热门 · 大盘主流): isHot 优先 + 稳定序     │
        │   • C 轨 (口碑破圈 · 异质探索): 低频题材优先，防信息茧房 │
        └─────────────────────────────────────────────────────────┘
                                     │
                                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │ 3. 20 条编织块交错组装 (7 AI · 7 H · 6 E，整数整除)      │
        │    块内序列: A H E A H E A H E A H E A H E A H E A H     │
        └─────────────────────────────────────────────────────────┘
                                     │
                                     ▼
        ┌─────────────────────────────────────────────────────────┐
        │ 4. 海报左上角极简微光角标 (与右下角集数对角呼应)         │
        │   • 【AI精品】: 冰蓝 (--badge-ai)   深浅双模同值       │
        │   • 【热门】  : 琥珀 (--badge-hot)  深浅双模同值       │
        │   • 【推荐】  : 象牙 (--badge-recommend) 双模同值      │
        │   • 留白美学  : 未命中不贴标，保持海报纯净               │
        └─────────────────────────────────────────────────────────┘
```

#### 0. 外部依赖：云端字段（**非本包交付**，仅声明等待条件）

**【归属声明】** 云端侧的一切改动（D1 迁移、字段落库、序列化下发、OpenAPI 契约、`/api/user/sync` 路由、云端门禁 A 组）**由云端专员全权负责**，正本为 **`docs/04-spec/CLOUD-SYNC-JIT-PIPELINE-SPEC.md`（v2.2）**。**本包（APP）不做这些事**，只声明"依赖什么"以便判断联调时机。

**本包依赖的线上契约（消费口径，由云端定义，本包无权改写）**：

| 依赖项 | 本包消费的契约形状 | 不满足时的端侧行为 |
| :--- | :--- | :--- |
| 剧目属性字段 | `ContentItem.isAi?: boolean`、`ContentItem.isHot?: boolean` | 走 §1.8.1 降级表（**不贴对应角标**，绝不虚构） |
| 同步端点 | `/api/user/sync`（GET 拉取 + POST 上报） | §1.9 全部功能**挂起不启用**，不影响其余交付（见下） |

**经仓库核验的事实（2026-10-03）**：`isAi` / `isHot` 在当前 `edge/src` 与 `edge/migrations` 中**零命中**，`/api/user/sync` 路由亦不存在 → **上述依赖当前尚未就绪**。

**【关键解耦承诺（本包风险控制）】**：本包**不阻塞在云端进度上**。
- WP6（推荐混排）在字段缺失时按降级路径交付，**角标不显示但整机可用**，绝非半成品；
- WP7（端云同步）**不依赖任何云端字段**即可完成客户端侧的完整实现与单测（上报管道、待发队列、字段映射、私密拦截、拉取合并均可基于 mock 验证），真机联调再等 `/api/user/sync` 就绪；
- 因此**云端进度不影响本包的开发、门禁与出包**，只影响"端到端联调"那一道最终验证。

> **口径修正（与云端契约对齐）**：早期草案曾让 B 轨按 `hotScore` 数值降序排。但云端线上契约只暴露 **`isHot?: boolean`**（`hot_score` 仅在 D1 内部，不下发）。端侧 B 轨排序键据此改为 **`isHot === true` 优先 + id 稳定序**，**不得依赖 `hotScore`**（它不在线上契约内）。

#### 1. 字段缺失降级策略（**保证端侧不被云端阻塞，且绝不虚构角标**）

端侧实现必须对缺失字段**确定性降级**，且降级过程中**绝不贴出无依据的角标**（坚守"零虚假 UI"）：

| 缺失字段 | A 轨（AI精品）降级 | B 轨（热门）降级 | 角标后果 |
| :--- | :--- | :--- | :--- |
| `isAi` 缺失/全 false | 回退为「本地画像得分最高的题材候选池」，按偏好分排序 | 不受影响 | **不贴【AI精品】标**（贴标唯一判据是 `isAi === true`，禁止用 tags 或猜测定性） |
| `isHot` 缺失/全 false | 不受影响 | 回退为「`first_published_at` 倒序（最新上线）」 | **不贴【热门】标** |
| 两者皆缺 | 三轨比例形态仍维持（保证排布节奏一致） | 同上 | 仅贴有依据的【推荐】标 |
| 本地历史为空（新装/新设备） | 画像全 0 → A 轨按 id 稳定序取前 N | 按 `isHot` 正常 | 正常贴标 |

**说明**：`tags` 兜底路径**明确废弃**——`ContentItem` 不下发 tags，写进代码就是永远走不到的死分支，属"死代码 + 空壳 UI"双重违规。

#### 2. 本地兴趣画像打分模型 (Preference Scoring)
引入 **7 天半衰期时间衰减模型**：
$$\text{Score}(\text{Genre}) = \sum \left[ 0.5^{\frac{\Delta t}{7\text{天}}} \times (\text{WatchedEpisodes} \times 2 + \text{WatchMinutes} \times 0.5 - \text{SkipPenalty}) \right]$$
- `WatchedEpisodes` / `WatchMinutes` / `updated_at` 取自本地 `local_watch_history`（`content_id / last_episode_number / position_seconds / duration_seconds / updated_at`）；
- `SkipPenalty` 定义为「`position_seconds / duration_seconds < 0.2` 时计 1」的轻量惩罚项（快速划过不计入正偏好）；
- 输出 21 个双字分类的偏好向量（如 `{ 战神: 18.5, 逆袭: 12.0, 科幻: 6.2 ... }`）。

#### 3. 三轨严格互斥去重管道 (Mutual Exclusion Pipeline)

```ts
const selectedSet = new Set<string>(); // 全局去重集合

// 0. 稳定序基线：先按 id 排序，消除网络返回顺序差异（保证跨页一致）
const stable = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

// 1. A 轨 (35% 偏好 · AI精品，战略倾斜)
// 唯一判据：item.isAi === true；排序键：所属题材的本地偏好分降序
const poolAI = stable.filter(x => x.isAi === true).sort((a, b) => pref(b.category) - pref(a.category));
// 2. B 轨 (35% 大盘 · 全网热门爆款，主流共识)
// 排序键：isHot === true 优先（线上契约只暴露布尔值，故不得依赖 hotScore 数值）
const poolHot = stable.filter(x => x.isAi !== true).sort((a, b) => Number(b.isHot === true) - Number(a.isHot === true));
// 3. C 轨 (30% 口碑 · 异质破圈探索，防信息茧房)
// 排序键：本地偏好分【升序】(低频题材优先)，次级键 firstPublishedAt 降序
const poolExplore = stable.filter(x => x.isAi !== true).sort((a, b) => pref(a.category) - pref(b.category));
```

**C 轨定义纠偏（原文"冷门高分"无数据依据已废止）**：`content_items` 既无 rating 也无 popularity 列，catalog 亦不下发，故"高分"无来源。C 轨改为**纯端侧可导出**的定义——**本地画像得分最低的题材优先**（= 用户最少涉足的题材），次级键取新近度。这样"破圈探索"的目标（打破信息茧房）依然成立，且无需任何新数据字段。

#### 4. 20 条编织块交错组装（替换原"步长交错 + 百分比切片"，解决余数与翻页重排）

**原方案的两个缺陷**：① `slice(0, targetCount * 0.35)` 对 24 条会 `floor` 成 8+8+7=**23 条，凭空少 1 条**；② 按"当前页"重排会破坏与 `page / revision / 游标 / 加载更多` 的一致性，翻页时同一条目可能换轨或跨页重复。

**修正后的定策**：

* **编织块 = 20 条 = 7 AI + 7 热门 + 6 探索**（35%×20 = 7，30%×20 = 6，**整数整除，零余数**）；
* **块内固定序列**：`A H E A H E A H E A H E A H E A H E A H`（= `[A,H,E]×6 + [A,H]`，恰好 7A / 7H / 6E）；
* **稳定序切块（保证永不重排）**：对**已加载的累积集合**（不是单页）按 id 稳定序排列为 `S`，则**块 c 消费 `S[20c, 20c+20)`**。某块一旦凑满 20 条即**内容固化、永不再变**，因此：
  - 「加载更多」只会在**尾部追加新块**，已渲染区域**零重排**；
  - `page / revision / 游标` 的语义**完全不变**，混排纯粹是**展示层重排**；
* **尾块规则**：不足 20 条的尾块，按 `A H E` 循环尽力填充、允许比例偏离，并**明确接受"尾块会随下一页数据到达而重排"**——重排范围严格限于尾块（≤19 条），不波及已固化块；
* **当 A/B 轨候选不足 7 条时**：缺额由 C 轨（或按比例最接近的轨）补齐，保证每块恒为 20 条；缺额补偿必须在实现里显式计数，禁止静默少渲染。

#### 5. 海报左上角极简微光角标规范 (P0 绝对铁律)
* **对角呼应布局**：微光角标绝对定位于海报**左上角**，与海报右下角既有 `.poster-ep-badge` 形成黄金对角呼应；
* **P0 色值铁律（原方案中的冰蓝裸 Hex 字面量与深色 rgba 字面量**已作废**（此处刻意不复制其字面值，避免被施工方直接拷走））**：
  - 三个角标前景色必须定义为 **theme-invariant（深浅双模同值）** tokens —— `--badge-ai`（冰蓝）、`--badge-hot`（琥珀）、`--badge-recommend`（象牙），同时在 `src/styles/design-tokens.css` 与 `src/styles/design-tokens.json` **双写**（`check_design_tokens` 只校验 json→css 单向覆盖，css 侧新 token 须人工保证同源）；
  - **为何必须双模同值**：角标底板恒为深色，而 `--fg` 在浅色模为近黑、`--accent` 在浅色模为深琥珀 —— 若沿用主题相关 token，浅色模式下会出现"近黑字压深底"（不可读）与"深琥珀对深底 ≈3.7:1"（低于小字 4.5:1）。项目已有正确先例：`--player-accent` 在深浅两模取值**完全相同**，正是"深底不变"场景的标准做法；
  - 底板同样落为 token（如 `--badge-bg`，含透明度的高斯磨砂底），**业务 CSS 内零字面色值**；
* **尺寸映射到既有梯级（替代 10.5px / 18px / 2px / 6px 等散落数值）**：字号 `var(--text-2xs)`（10px）、圆角 `var(--radius-xs)`（4px）、水平内边距 `var(--space-2)`（8px）、垂直内边距 2px（与既有 `.poster-ep-badge` 同款先例，收敛为 `--badge-pad-y` token）、字重 500；整体高度由 padding + `--leading-tight` 自然撑出，**不硬编码 18px**；
* **对角呼应布局**：绝对定位于海报左上角；新类名 `.poster-corner-badge` / `.poster-corner-badge--ai|hot|recommend`；
* **克制与留白美学**：未命中上述三轨特征的普通剧目**绝不强行贴标**，海报保持干净通透；
* **P0 红线**：**严禁任何 Emoji 图标**（`scan_p0.py` 的 `0x1F000–0x1FAFF` 区间会直接判红），严禁荧光地摊色，100% 消费 Design Tokens。

---

### 1.9 机制八：端云状态同步中枢规格 (User Sync SPEC)

为实现会员用户在手机、电视（TV 大屏）与 PC 间无缝同步观看进度，并跨端继承 3.5:3.5:3 推荐喜好，确立**“统一端点 · 单载荷提交 · 严格离场触发”**的工业级同步中枢：

```
                    端云状态同步中枢 (User Sync Pipeline) 拓扑
  ┌────────────────────────────────────────────────────────────────────────┐
  │ 【单端点设计】POST/GET /api/user/sync 统一打包“观看断点”与“偏好画像”    │
  └────────────────────────────────────────────────────────────────────────┘
                                     │
           ┌─────────────────────────┴─────────────────────────┐
           ▼                                                   ▼
 【上报时机 (杜绝心跳轮询)】                           【拉取时机 (按需静默)】
 • 节点 ①：退出播放页/关闭播放器/Back返回            • 场景 ①：换新设备 (电视/PC) 首次登录
 • 节点 ②：APP 挂起/切到后台 (appStateChange)        • 场景 ②：卡密核销成功或进入【追剧】页
           │                                                   │
           ▼ (POST /api/user/sync)                             ▼ (GET /api/user/sync)
 ┌───────────────────────────────────┐               ┌───────────────────────────────────┐
 │ 请求载荷 (JSON)                   │               │ 响应载荷 (JSON)                   │
 │ {                                 │               │ {                                 │
 │   "history": {                    │               │   "history": [                    │
 │     "contentId": "drama_90567",   │               │     { "contentId": "drama_90567", │
 │     "episodeNumber": 12,          │               │       "episodeNumber": 12,        │
 │     "positionSeconds": 145.5,     │               │       "positionSeconds": 145.5,   │
 │     "durationSeconds": 300.0      │               │       "updatedAt": 1790945000 }   │
 │   },                              │               │   ],                              │
 │   "preferences": {                │               │   "preferences": {                │
 │     "genres": { "战神": 24.5 ...},│               │     "genres": { "战神": 24.5 ...},│
 │     "totalPlays": 48              │               │     "totalPlays": 48,             │
 │   }                               │               │     "updatedAt": 1790945000 }     │
 │ }                                 │               │ }                                 │
 └───────────────────────────────────┘               └───────────────────────────────────┘
           │                                                   │
           ▼                                                   ▼
 ┌───────────────────────────────────┐               ┌───────────────────────────────────┐
 │ 云端 D1 数据库持久化存储          │               │ 端侧双轨融合消费                  │
 │ 1. cloud_watch_history (断点)     │               │ 1. 历史比对: updatedAt 取最新秒续 │
 │ 2. cloud_user_profile  (喜好画像) │               │ 2. 画像注入: 跨端即享 3.5:3.5:3   │
 └───────────────────────────────────┘               └───────────────────────────────────┘
```

#### 1. 外部依赖：云端同步数据模型（**非本包交付**）

> **归属声明**：两张表的权威定义（含 CHECK 约束与索引）在 **`docs/04-spec/CLOUD-SYNC-JIT-PIPELINE-SPEC.md`（v2.2）§2.1**，落盘与迁移读取器的改造均由**云端专员**执行。**本包不改 `edge/**`、不新建迁移文件、不动云端门禁**；此处仅登记"本包依赖的数据形状"，供联调前核对。

```sql
-- 端侧只读消费的形状示意（权威定义见云端规格书 §2.1，此处不是待办）
-- cloud_watch_history : (coupon_code, content_id) 主键，单剧单行幂等覆盖
-- cloud_user_profile  : coupon_code 主键，preferences_json + total_plays
```

> **早期草案已撤销**：本计划曾提出"把两张表并入 `0001_initial_schema.sql`"。该口径**撤销**——① 迁移演进属云端范围，非本包职责；② 云端规格书 §6-2 的方案（保留 `0002`，把门禁读取器改为按序读取全部迁移文件）本身更优。本包对此**只依赖、不置评、不改动**。

#### 2. 字段映射表（三套命名必须显式对账，否则首次联调必错）

| 语义 | 本地 SQLite (`local_watch_history`) | 云端 D1 (`cloud_watch_history`) | 接口载荷 (JSON) |
| :--- | :--- | :--- | :--- |
| 剧目 | `content_id` | `content_id` | `contentId` |
| 集数 | `last_episode_number` | `episode_number` | `episodeNumber` |
| 断点秒 | `position_seconds` | `position_seconds` | `positionSeconds` |
| 总时长 | `duration_seconds` | `duration_seconds` | `durationSeconds` |
| 更新时间 | `updated_at` | `updated_at` | `updatedAt` |

> 注意 **`last_episode_number` → `episode_number` 的改名**：本地列名带 `last_` 前缀，云端与载荷均不带。映射必须在 `user-sync.ts` 一处集中完成，禁止散落两处各写一套。

#### 3. 上报触发时机（严格受控，绝不引入轮询开销）
* **坚决禁止心跳轮询**：播放过程中严禁以每 5 秒/10 秒心跳方式向云端频繁发请求，绝不制造网络风暴与服务器并发压力；
* **仅限两大离场节点上报**：
  - **节点 ①（退出播放）**：在 `player-host` 触发返回、关闭播放器或响应系统 Back 键的销毁钩子中，就地上报本次刚退出的剧集断点与最新偏好向量；
  - **节点 ②（应用挂起）**：监听 `@capacitor/app` 的 `App.addListener('appStateChange')`，当 `isActive === false` 时触发一次静默上报。

#### 3.1 挂起上报的可靠性要求（原方案缺此段：**发不出去**是常态而非例外）

Android 在 `appStateChange(isActive=false)` 之后会很快冻结 WebView 渲染进程，**普通 `fetch` 极可能被直接掐断**。因此：

* **必须使用 `fetch(url, { keepalive: true })`**（或 `navigator.sendBeacon`）以允许请求脱离页面生命周期继续完成；
* **必须实现"待发队列"兜底**：上报前先把载荷写入本地（**仅公开内容**，私密内容禁止落盘，见下），标记 `pending`；成功回执后清除。下次冷启动时**先补传 pending 队列**再拉取云端数据。这样即使挂起时请求被掐断，数据也不会丢——下次启动自动续传；
* **幂等要求**：`POST /api/user/sync` 必须按 `(coupon_code, content_id)` 幂等 upsert，允许同一断点重复提交（补传场景天然重复）。

#### 4. 接口契约与请求规范
* **接口 A：上报断点与偏好画像 (`POST /api/user/sync`)**
  - **鉴权**：请求头携带会员 JWT `Authorization: Bearer <token>`（未激活卡密的访客设备不触发上报，保持纯本地运行）；
  - **内容载荷**：`history`（当前剧目断点，若未在播放状态仅切后台传 `null`）+ `preferences`（本地 21 个双字分类的打分向量与总播放数）；
  - **私密内容红线**：若当前播放的是【个人探索（私密内容）】，客户端**禁止携带该 history 断点**。实现路径**复用既有拦截器** `assertWritable()`（`src/core/storage/storage-domains.ts:71`）——它按 `isPrivate` / `channelId==='private'` 判定，**不依赖调用方自述**，因此私密内容在写入待发队列的那一刻就被物理拒绝，不存在"两处各写一套私密规则"的漂移风险。**禁止**在 `user-sync.ts` 另起一套私密判定。
* **接口 B：拉取云端历史与画像 (`GET /api/user/sync`)**
  - **鉴权**：`Authorization: Bearer <token>`；
  - **触发时机**：新设备首次激活/核销成功、用户点击进入【追剧】主 Tab、或应用热启动时静默拉取一次；
  - **端侧双轨合并**：
    1. **历史断点**：按 `updatedAt` 与本地记录逐条比对，取较新者生效，续播大卡呈现最新进度；
    2. **偏好画像**：注入本地推荐引擎，使新设备或电视端在"冷启动零观看"状态下，首页即可继承手机端偏好，展开 3.5:3.5:3 混排。

#### 5. 身份模型与诚实边界（必须写入交付说明，不得含糊）

* **身份键 = `coupon_code`（卡密），而非用户账号**。由此产生两条必须在交付说明中如实公示的限制：
  1. **换卡即失去历史**：用户购买新卡后，云端断点与画像不会自动迁移；
  2. **同卡多设备共享同一份画像**：一张卡上限 10 台设备（`max_devices`），若这些设备分属不同家人，画像会互相影响（例如孩子的观看偏好会推高家长的推荐权重）。这不是缺陷而是当前产品模型的必然结果；若日后需要按人隔离，须引入「卡 + 设备」或独立账号体系，届时再评估。**本期不做**，但不得隐瞒。

---

## 第二部分：工程实施行动计划 (Action Plan)

### 2.0 施工前门禁同步清单（**WP0 · 仅本包范围内执行**）

本项目的四道 Python 门禁是**精确闭集**式断言，任何"加一个端点/加两张表/加一条验收"都必须**同步改门禁本身**。但**门禁文件的归属是分裂的**，因此必须严格切分，**本包只做 B 组**：

**A 组（云端范围 · 本包不执行，仅登记以便联调前核对进度）**

| # | 位置 | 云端需改什么 | 归属 |
| :--- | :--- | :--- | :--- |
| A1 | `verify_contracts.py` 的 `expected_paths` | 精确 18 条 → +1（`/api/user/sync`） | 云端规格书 §6-3 |
| A2 | `verify_contracts.py::check_sqlite_schema` | 业务表 20 → 22；读取器改为**按序读取 `edge/migrations/*.sql` 全部文件** | 云端规格书 §6-1/2 |
| A3 | `verify_contracts.py` 横幅；`tests/edge/40-router.test.ts` 的 `MOUNTED` 夹具；`SPEC-v2.0.md` §5；`edge/src/index.ts` 的 `ROUTES` | 同步为实际值 | 云端规格书 §6-4/5/7/8 |
| A4 | `openapi.yaml`（端点 + `ContentItem` schema + `ErrorResponse.code`） | 补齐 | 云端规格书 §3.4-5 / §6-6 |

> **本包对 A 组的唯一动作**：**等**。A 组未完成时，`verify_contracts.py` 会因端点/表数不匹配而报红——**这不是本包的缺陷**，属云端交付未就绪，按 §2.4 铁律 9 登记为"外部阻塞"而非"本包返工"。

**B 组（本包范围 · WP0 必须执行）**

| # | 位置 | 现状 | 必改内容 | 不改的后果 |
| :--- | :--- | :--- | :--- | :--- |
| **B1** | `tests/verify_acceptance.py` | `if len(rows) != 18: FAIL`；SPEC §9 硬锁 18 条 | 断言改 **30**；横幅"18/18 条"改 **30/30** | 报红（扩展 SPEC 时）／**假绿**（沿用 v2.4 撞号时） |
| **B2** | `docs/04-spec/SPEC-v2.0.md` §9 | 18 条 | 增补 **AC-19…AC-30** 十二行，格式必须为 `| **AC-xx** | 名称 | EARS 句 | P0/P1 |`（否则 `AC_ROW` 正则解析不到） | B1 无法通过 |
| **B3** | `docs/01-prd/PRD-prism-play.md` 第九章 | 与 SPEC §9 对应 | 增补同 12 条（`check_cross_documents` 只断言 AC-01~18 存在，扩展不破门禁，但五源对齐纪律要求同步） | 文档漂移 |
| **B4** | `tests/verify_android_assets.py` 第 6/7 条 | Java `@CapacitorPlugin(name)` 与 TS 常量须逐字一致；清单须声明 Java 启动的组件与权限 | 新增 `PrismCastPlugin` 名称两侧同步；新增 `CHANGE_WIFI_MULTICAST_STATE` 写入清单 | Gate G4 失败 |
| **B5** | `src/styles/design-tokens.css` + `design-tokens.json` | 新增 token 须双写 | 写入 `--badge-ai` / `--badge-hot` / `--badge-recommend`（**双模同值**）、`--capsule-height` / `--capsule-hit` / `--badge-bg` / `--badge-pad-y` | `check_design_tokens` 报红 |
| **B6** | `docs/00-index/README.md` | 如含统计数字 | 本包相关的部分同步（端点/表数等云端口径由 A 组一并处理） | 文档漂移 |

> **共享文件并发纪律**：`SPEC-v2.0.md`、`PRD-prism-play.md`、`00-index/README.md` 三份文档**两边都可能改**。本包改动前**先在计划里声明改哪几行**，改完即提交，**不与云端改动混在同一次提交**，避免合并冲突与互相覆盖。

---

### 2.1 任务拆解与工时量化估算看板

按照 Master 定案的工程量化铁律（代码行数 LOC + Token 消耗），本期实施分为 **1 个前置包 + 8 个实施包**：

| 工作包 (WP) | 核心施工内容 | 预计代码/配置变动 (LOC) | 预计 Token 消耗 | 涉及文件/模块 |
| :--- | :--- | :---: | :---: | :--- |
| **WP0: 客户端契约与门禁前置（仅 B 组）** | 1. 定验收编号族（AC-19…AC-30）并写入 SPEC §9 + PRD 第九章<br>2. 同步 `verify_acceptance.py`（验收 18→30、横幅）<br>3. `design-tokens.css` + `.json` 双写新 tokens<br>4. 共享文档单独提交（不与云端改动混提）<br>5. 跑门禁；`verify_contracts.py` 若因云端 A 组未就绪而红，登记为外部阻塞 | ~110 行 (文档/契约) | ~11k Tokens | `docs/04-spec/SPEC-v2.0.md`<br>`docs/01-prd/PRD-prism-play.md`<br>`tests/verify_acceptance.py`<br>`src/styles/design-tokens.{css,json}` |
| **WP1: 签名永久固化** | 1. 生成并提交 `android/app/debug.keystore`（keytool 正本命令）<br>2. `build.gradle` 显式绑定 `signingConfigs.debug`（复用既有 `buildTypes` 块）<br>3. **硬校验**：连续两次 CI 出包 SHA-256 恒定 | ~35 行 (配置/密钥) | ~6k Tokens | `android/app/build.gradle`<br>`android/app/debug.keystore` |
| **WP2: 全屏自适应重塑** | 1. **指定唯一权威**：删除 `app.css` 218–224 行 7 条 `!important` 链<br>2. **移除 `art.fullscreenWeb`**，仅保留 `art.autoSize()`<br>3. 画幅嗅探 + 9:16 `contain` + 底片填充（零裁切）<br>4. ScreenOrientation 联动 + 级联 Back 调度<br>5. 断言 `onShowCustomView` 全程未被触发 | ~140 行 (TS/CSS) | ~18k Tokens | `src/player-host.ts`<br>`src/player/prism-player.ts`<br>`src/styles/app.css` |
| **WP3: 有效公网分享修复** | 1. 删除 `origin?` 依赖，锁定模块级常量主域<br>2. 格式化带剧名与集数的分享文案<br>3. 原生系统分享 + 剪贴板兜底 | ~40 行 (TS) | ~6k Tokens | `src/core/share.ts`<br>`src/main.ts` |
| **WP4: 大屏投屏系统重拾** | 1. 原生 `PrismCastPlugin`：SSDP M-SEARCH + Location 解析 + SOAP 控制<br>2. **H1/H2/H3 三项硬前置**（裸 socket 控制、组播权限、放弃 CIDR 白名单）<br>3. `cast` 图标入 `SHAPES`；操作岛【投屏】大键<br>4. 半屏设备发现面板 + 投屏控制条 | ~320 行 (Java/TS/CSS) | ~32k Tokens | `android/.../PrismCastPlugin.java`<br>`android/app/src/main/AndroidManifest.xml`<br>`src/components/icons.ts`<br>`src/player/player-detail.ts`<br>`src/styles/app.css` |
| **WP5: 首屏/外壳视觉精致化** | 1. 顶栏品牌垂直居中 + 排版器上提并**实例复用**<br>2. 一级频道 `--text-md`；胶囊「视觉 28px / 命中 ≥44px」双口径<br>3. 拔除 `.home-section-header` 与重复标题<br>4. TabBar `max-width: 360px` 居中 | ~95 行 (TS/CSS) | ~11k Tokens | `src/styles/app.css`<br>`src/styles/home.css`<br>`src/views/home-view.ts`<br>`src/app-shell.ts` |
| **WP6: 3.5:3.5:3混排与微光角标** | 1. 落地 `src/core/recommendation.ts`（稳定序 + 打分 + 三轨互斥 + 20 条块 7:7:6）<br>2. **字段缺失降级**（缺 isAi/isHot 时不贴标，绝不虚构）<br>3. 海报左上角微光角标（tokens 双模同值）<br>4. 首页挂接混排（仅展示层，不动 page/revision） | ~150 行 (TS/CSS) | ~17k Tokens | `src/core/recommendation.ts`<br>`src/components/poster-grid.ts`<br>`src/styles/home.css`<br>`src/views/home-view.ts` |
| **WP7: 端云状态同步中枢** | 1. `src/core/user-sync.ts` 双向管道 + 字段映射表集中一处<br>2. 两级离场上报（`keepalive` + 待发队列兜底）<br>3. 私密内容复用 `assertWritable()` 拦截<br>4. 追剧页与推荐引擎接入拉取合并 | ~140 行 (TS) | ~15k Tokens | `src/core/user-sync.ts`<br>`src/player-host.ts`<br>`src/main.ts`<br>`src/views/history-view.ts` |
| **WP8: 全量回归与出包出厂** | 1. 为 **AC-19…AC-30** 逐条补署名断言用例<br>2. 全量 55 套测试 + 4 道门禁全绿<br>3. GitHub Actions 编译出厂唯一签名 APK<br>4. **签名哈希恒定硬校验**（跨两次构建比对） | ~120 行 (测试) | ~18k Tokens | `tests/client/*.test.ts`<br>GitHub Actions CI |
| **合计** | **九包完整闭环交付** | **约 1150 行** | **约 134k Tokens** | **全端源码、契约、原生工程与 CI 体系** |

> **估算前提**：WP4 的 320 行属"首个可信估算"——SSDP 发现 + Location XML 解析 + SOAP 控制 + 半屏面板 + 状态机，同类开源实现仅发现层就不止 220 行（原 v2.4 的 220 行估计明显偏乐观）。**联调完成后须回填实际值。**

---

### 2.2 实施步骤与工序排期 (SOP)

```
[Master 评审批准本 SPEC & PLAN]
               │
               ▼
[Step 0: 客户端侧契约与门禁前置同步 (WP0 · 仅 B 组) —— 未完成不得开工]
  ├─ 定验收编号族（AC-19…AC-30）并写入 SPEC-v2.0 §9 与 PRD 第九章
  ├─ 同步 verify_acceptance.py（验收 18→30、横幅）
  ├─ design-tokens.css + design-tokens.json 双写新 tokens
  ├─ 共享文档（SPEC/PRD/README）单独提交，不与云端改动混提，避免并发冲突
  └─ 跑四道门禁；【注意】verify_contracts.py 此时可能因云端 A 组未就绪而报红
     → 属"外部阻塞"，登记待办交由云端专员，不视为本包返工
               │
               ▼
[Step 1: 固化 Android 调试签名密钥库 (WP1)]
  ├─ keytool 生成并提交 android/app/debug.keystore (RSA 2048 / 10000 天)
  ├─ android/app/build.gradle 显式锁定 signingConfigs.debug
  └─ 立刻跑一次 CI，记录签名 SHA-256 作为后续恒定比对的基线
               │
               ▼
[Step 2: 修复公网分享链接与文案 (WP3)]
  ├─ 删除 origin? 依赖，模块级常量锁死 https://play.prismos.org
  └─ 格式化输出带剧名与集数的完整分享文案，打通原生系统分享
               │
               ▼
[Step 3: 彻底重构播放器全屏自适应机制 (WP2)]
  ├─ ① 指定唯一权威：删除 app.css 218–224 行 7 条 !important 链
  ├─ ② 移除 art.fullscreenWeb（严禁触发 WebView 原生全屏容器），仅保留 autoSize()
  ├─ ③ loadedmetadata 真实分辨率嗅探 (区分 9:16 短剧与 16:9 影视)
  ├─ ④ 全屏一律 contain 零裁切 + 高斯模糊底片填充留白
  ├─ ⑤ 横屏影视联动 ScreenOrientation 旋转，竖屏短剧保持竖直
  └─ ⑥ 完善级联 Back 键调度 (全屏先退全屏，非全屏才退播放器)
               │
               ▼
[Step 4: 重拾局域网电视大屏 DLNA 投屏能力 (WP4)]
  ├─ 先解三项硬前置：H1 裸 socket 控制（避开明文策略）/ H2 组播权限+MulticastLock
  │                  / H3 放弃 CIDR 白名单（技术上不可行）
  ├─ 原生 PrismCastPlugin：SSDP M-SEARCH + Location 解析 + AVTransport SOAP
  ├─ 从 lucide-static 提取 cast 图标入 SHAPES；操作岛呈现【投屏】核心入口
  └─ 落地半屏设备选择面板与大屏无缝连播状态机
               │
               ▼
[Step 5: 首屏与外壳视觉精致化重构 (WP5)]
  ├─ 顶栏弹性居中；排版切换器上提顶栏右侧并实例复用（不随 Tab 重复重建）
  ├─ 一级频道 --text-md；胶囊「视觉 28px / 命中 ≥44px」双口径（守无障碍下限）
  ├─ 拔除 .home-section-header 与重复频道标题，海报流直接上提 40px+
  └─ 底部导航栏 TabBar 增加 max-width: 360px 居中收敛
               │
               ▼
[Step 6: 落地 3.5:3.5:3 推荐混排与海报微光角标 (WP6)]
  ├─ 封装 src/core/recommendation.ts：稳定序 + 7 天半衰期打分 + 三轨互斥
  ├─ 实现 20 条编织块 (7A/7H/6E 整数整除) + 尾块规则，耗时 ≤ 2ms
  ├─ 字段缺失降级：缺 isAi/isHot 时不贴标，绝不虚构角标
  ├─ 海报卡左上角装配微光角标 (tokens 双模同值)，与右下角集数对角呼应
  └─ 单测覆盖：块比例、去重互斥、半衰期衰减、降级路径、尾块
               │
               ▼
[Step 7: 打通端云多端状态同步中枢 (WP7)]
  ├─ 封装 src/core/user-sync.ts (POST/GET /api/user/sync) + 字段映射集中一处
  ├─ 播放器退出与应用挂起两级离场静默上报 (keepalive + 待发队列兜底，严禁轮询)
  ├─ 私密内容复用既有 assertWritable() 拦截，禁止另起一套私密判定
  └─ 追剧页与首页挂接云端历史与偏好拉取合并
               │
               ▼
[Step 8: 严格测试与门禁验证 (WP8)]
  ├─ 为 AC-19…AC-30 逐条补署名断言用例
  ├─ 运行 python tests/scan_p0.py (0 emoji / 0 裸色值 / 0 超长文件)
  ├─ 运行 python tests/verify_contracts.py (契约 100% 对齐)
  ├─ 运行 python tests/verify_acceptance.py (30/30 条署名到位)
  ├─ 运行 python tests/verify_android_assets.py (插件名与清单一致)
  └─ 运行 npm test (全量 55 套测试 100% 保持绿色全通)
               │
               ▼
[Step 9: 提交代码并触发云端构建出厂]
  ├─ Git Commit: feat(core): overhaul fullscreen, pin keystore, fix share, restore cast, refine UI, add recommendation and user sync
  ├─ 更新 Git Tag: dev_v2.1.1.1 并推送
  └─ GitHub Actions 自动编译出厂带固定签名的正式 APK
               │
               ▼
[Step 10: 真实真机覆盖安装与全景实测]
  ├─ 硬校验：本次签名 SHA-256 与 Step 1 基线**完全一致**
  └─ 将最新 APK 交付 Master，真机直接点击覆盖安装（验证无需卸载），实测全屏、分享、大屏投屏、精致首屏与多端同步！
```

---

### 2.3 严格验收标准清单 (Acceptance Criteria)

> **【编号口径 · v2.5 修正】**：本波次验收编号为 **AC-19…AC-30**，与 `docs/04-spec/SPEC-v2.0.md` §9 的 **单一编号权威**对齐。
> **v2.4 曾使用 `AC-01…AC-12`，与 SPEC 现有编号重叠但语义完全不同**（例如 v2.4 的 AC-11 是"微光角标"，而 SPEC AC-11 是"来电自动暂挂"；v2.4 的 AC-12 是"端云同步"，而 SPEC AC-12 是"分享点开即播"）。`tests/verify_acceptance.py` 会把测试标题里的 `AC-xx` 归到 SPEC 同名条目上，因此沿用撞号会让**角标用例冒充"来电自动暂挂"已覆盖**，制造假绿。故编号一律重排至未占用区间，并须在 WP0 同步写回 SPEC §9 / PRD 第九章。

**v2.4 → v2.5 编号映射（供历史文档追溯，仅作对照，不得再用于测试署名）**

| v2.4 旧号 | v2.5 新号 | 验收项 |
| :--- | :--- | :--- |
| AC-01 | **AC-19** | 竖屏短剧全屏沉浸 |
| AC-02 | **AC-20** | 横屏影视联动全屏 |
| AC-03 | **AC-21** | 返回键级联退出 |
| AC-04 | **AC-22** | 永久签名覆盖安装 |
| AC-05 | **AC-23** | 有效公网分享 |
| AC-06 | **AC-24** | 局域网大屏投屏 |
| AC-07 | **AC-25** | 顶栏居中与排版移顶 |
| AC-08 | **AC-26** | 分类胶囊层级收敛（视觉/命中双口径） |
| AC-09 | **AC-27** | 底部 Tab 栏宽度收缩 |
| AC-10 | **AC-28** | 端侧 3.5:3.5:3 推荐混排 |
| AC-11 | **AC-29** | 海报极简微光角标 |
| AC-12 | **AC-30** | 端云状态多端同步 |

| 验收编号 | 验收项 | 验收操作与预期结果（均可量化、可复测） |
| :--- | :--- | :--- |
| **AC-19** | **竖屏短剧全屏沉浸（零裁切）** | 播放 9:16 竖屏短剧进入【沉浸全屏】：① 手机保持竖屏不强制旋转；② 视频 `object-fit: contain` **内容零裁切**；③ 舞台占满 100% 视口，留白区由高斯模糊底片覆盖，**无纯黑死边**；④ 手势可用。 |
| **AC-20** | **横屏影视联动全屏** | 播放 16:9 院线电影进入【沉浸全屏】：系统旋转为横屏，视频等比铺满视口宽度、留白由底片填充；退出全屏自动恢复竖屏。 |
| **AC-21** | **返回键级联退出** | 全屏态按系统返回键/侧滑：第一下平滑退出全屏恢复竖屏详情台；详情台再次返回才关闭播放器。 |
| **AC-22** | **永久签名覆盖安装** | 本次 APK 无需卸载老版本即可直接覆盖安装，不再提示"-7 签名不同"；且本次签名 **SHA-256 与 WP1 基线完全一致**（跨构建恒定）。 |
| **AC-23** | **有效公网分享** | 分享产出的链接严格为 `https://play.prismos.org/s/:id?ep=N`，第三方设备打开可正常播放；**零 `localhost` 残留**；分享文案含剧名与集数。 |
| **AC-24** | **局域网大屏投屏** | 手机连家庭 Wi-Fi，点击操作岛【投屏】可发现局域网电视设备并推送当前剧集至大屏播放，支持自动连播；**并须证明 H1/H2/H3 三项硬前置已解**（明文策略未放宽、组播锁已释放）。 |
| **AC-25** | **顶栏居中与排版移顶** | 顶栏左侧品牌名在 52px 容器内**垂直绝对居中**；排版切换器吸附右侧；海报流上方**无重复频道标题**，整体较改前上提 ≥40px（可用像素差实测）。 |
| **AC-26** | **分类胶囊双口径收敛** | 一级频道字号 = `--text-md`；二级胶囊**视觉高度 28px** 且**命中高度 ≥44px**（须用可点击区域实测，两条同时成立）。 |
| **AC-27** | **底部 Tab 栏宽度收缩** | Tab 栏内容区居中且实际宽度 ≤ 360px，两端无过度拉伸。 |
| **AC-28** | **端侧 3.5:3.5:3 推荐混排** | 基于本地历史完成 7 天半衰期打分；每 20 条编织块内严格 **7 AI / 7 热门 / 6 探索**且三轨互斥零重复；**「加载更多」后已固化块零重排**；耗时 ≤ 2ms。 |
| **AC-29** | **海报极简微光角标** | 左下（左上）角标按依据展示（【AI精品】冰蓝 / 【热门】琥珀 / 【推荐】象牙），与右下角集数对角呼应；**字段缺失时留白不贴标**；深浅双模下对比度均 ≥4.5:1；P0 零 Emoji、零裸色值。 |
| **AC-30** | **端云状态多端同步** | 退出播放与程序挂起两级离场触发 `POST /api/user/sync`（`keepalive`，挂起被掐断时下次启动补传）；新端或追剧页拉取 `GET /api/user/sync` 比对最新断点续播并继承画像；私密内容经 `assertWritable()` 拦截，**零上报**。 |

---

### 2.4 实施铁律与红线承诺

1. **功能保真与零虚构**：严格遵循既定架构规范，每一个入口与能力均有真实业务状态机与代码支撑，绝不输出死代码与空壳 UI；
2. **P0 红线绝对遵守**：所有新增样式 100% 消费 Design Tokens，严格禁止任何内联裸色值（Raw Hex），**严禁任何 emoji 作为功能图标**，单文件行数死守 300 行上限；
3. **保持门禁全绿**：全量 55 套测试（675+ 个测试）与 4 道 Python 门禁在重构前后必须保持 100% 通过；
4. **【门禁同步铁律 · v2.5 新增，最高优先】**：本项目门禁为**精确闭集**断言。任何新增端点、新增数据表、新增验收条目，**必须在同一提交内同步修改门禁脚本本身**（`verify_contracts.py` / `verify_acceptance.py`）。**严禁**只改业务与契约而把门禁留在旧数上——那会导致两种后果：要么 Gate 直接失败阻塞 CI，要么门禁被绕过形成盲区。本条为 WP0 的存在理由。
5. **【验收编号唯一权威铁律 · v2.5 新增】**：验收编号**只有一个权威来源** = `SPEC-v2.0.md` §9。任何文档、计划、测试**禁止自造 `AC-xx` 编号**。`tests/verify_acceptance.py` 会拒绝 SPEC §9 外的编号，但更危险的是**编号撞号会造成假绿**（测试署名被错记到语义无关的既有条目上）。新增验收必须占用未使用区段，并同步 SPEC §9 与 PRD 第九章。
6. **【外部前提必须回源核验铁律 · v2.5 新增】**：计划中凡涉及"某方已就绪 / 某字段已下发 / 某接口已存在"的断言，**必须以仓库源码为证据**，不得转述上游文档或口头结论。v2.4 曾据指令包转述"云端已就绪"，而 `isAi/isHot` 实际零源码命中；同轮修正中本计划又一度自行定义了与云端规格书重复的 D1 改动——两次都是同一种病。
7. **【单一权威铁律 · v2.5 新增】**：同一种状态（如全屏）**只能有一个权威来源**。多权威并存（CSS 类 / 框架 API / 原生容器三方争夺）必然产生"每修一次换一种错"的死循环，这是本项目全屏缺陷反复复发的根本机制。
8. **【端云范围隔离铁律 · v2.5 新增】**：本计划唯一范围 = **APP 客户端**。**任何工作包的文件清单都不得出现 `edge/` 路径**（可机械校验）。凡涉及云端的改动，无论本包判断为多必要，**一律不得在客户端侧代做**——最多以「外部依赖」条目提出，交由云端专员实现。越界代做会产生"两份真相 + 互相覆盖"的耦合债。
9. **【外部阻塞不算返工铁律 · v2.5 新增】**：当门禁或联调失败的直接原因是"云端依赖未就绪"（如云端未增 `/api/user/sync` 端点、未下发 `isAi`/`isHot` 字段）时，须**登记为外部阻塞并移交云端专员**，不得为"让门禁变绿"而在客户端侧伪造字段或绕过断言——那是把阻塞转成缺陷。

---

## 第三部分：本次修订对照（v2.4 → v2.5）

| 审核编号 | 问题 | 修正方式 | 落点 |
| :--- | :--- | :--- | :--- |
| P0-1 | 验收编号与 SPEC §9 撞号 → 假绿 | 重排为 AC-19…AC-30，附映射表；WP0 同步 SPEC/PRD/门禁 | §2.0 / §2.3 |
| P0-2 | `isAi/isHot` 云端不存在的虚假前提 | 澄清为"待交付硬前置"，补字段缺失降级表；**云端交付物归属交还 `CLOUD-SYNC-JIT-PIPELINE-SPEC.md`**，本计划只保留端侧消费 | §1.8.0 / §1.8.1 |
| P0-3 | OpenAPI 精确闭集门禁未同步 | 新增 §2.0 门禁清单，并**按归属切分为 A 组（云端范围，本包不执行）/ B 组（本包 WP0 执行）** | §2.0 |
| P0-4 | 业务表 ==20 断言与新建 0002 的盲区 | **采纳云端规格书 §6-2 的更优方案**：0002 保留，门禁读取器改为按序读取全部迁移文件；**撤销本计划早期"并入 0001"草案** | §1.9.1 / §2.0 |
| P0-5 | 文档自身含 emoji 与裸 Hex | 投屏改 Lucide `cast`/`refresh`；色值全部落 tokens 双写 | §1.5.1 / §1.8.5 |
| P0-6 | 胶囊 26~28px 违反 SPEC §10 的 44px | 改「视觉 28px / 命中 ≥44px」双口径 + 新增 tokens | §1.7.2 / AC-26 |
| P1-1 | 全屏三重权威未收口 | 新增"唯一权威先决条款"，禁用 `art.fullscreenWeb`，保留 `autoSize()` | §1.2.0 |
| P1-2 | 9:16 数学矛盾 | 定策 `contain` + 底片填充，零裁切，AC 可量化 | §1.2.2 / AC-19 |
| P1-3 | 混排与分页冲突、余数丢条 | 改 20 条编织块 7:7:6 + 稳定序切块 + 尾块规则 | §1.8.4 / AC-28 |
| P1-4 | C 轨"高分"无字段依据 | 改为"本地画像得分最低题材优先" | §1.8.3 |
| P1-5 | 角标色用主题相关 token 会失效 | 改双模同值 `--badge-*` tokens，尺寸映射梯级 | §1.8.5 / AC-29 |
| P1-6 | 同步三处工程尾巴 | 补 `keepalive`+待发队列、字段映射表、身份诚实边界 | §1.9.2/3/5 |
| P1-7 | DLNA 明文策略等三硬前置 | 新增 H1/H2/H3 表 + 已核验可行项 | §1.5.2.1 |
| P1-8 | L2 热更新"有规格零工作包" | 显式降级为 Backlog，并写明 native↔web 版本锁前置 | §1.6 |
| P2 | 陈旧文案/日期/估算乐观/规则重复/ref 夸大 | 收尾段落已更新；日期补修订；WP4 估算上调并声明回填；私密复用 `assertWritable()`；`&ref=` 定位为 display-only | 全文 |

---

Master，本篇二合一正本已按 `docs/05-audit/PLAN-REVIEW-2026-10-03.md` 的 **6 项 P0 + 8 项 P1 + 5 项 P2** 全部意见修正完毕，升级为 **v2.5**。

### 一、范围界定（本包 = APP 客户端，且仅此）

| 范围 | 内容 | 归属 |
| :--- | :--- | :--- |
| **本包交付** | `src/**`、`android/**`、`tests/client/**`、客户端 tokens/CSS、客户端门禁（§2.0 B 组） | **本计划全权负责** |
| **外部依赖（非本包）** | `edge/**`、`edge/migrations/**`、`/api/user/sync`、`ContentItem` 服务端字段、`openapi.yaml`、云端门禁（§2.0 A 组） | **云端专员**（正本 `CLOUD-SYNC-JIT-PIPELINE-SPEC.md`） |

**本包不阻塞在云端进度上**：WP6 在字段缺失时按降级路径交付（角标不显示但整机可用）；WP7 的客户端侧全部逻辑（上报管道 / 待发队列 / 字段映射 / 私密拦截 / 拉取合并）均可基于 mock 完成并过单测。云端未就绪**只影响端到端联调那一道最终验证**，不影响本包的开发、门禁与出包。

### 二、交付概览

- **八大机制**（全屏自适应 / 永久签名 / 有效分享 / DLNA 投屏 / 三级发布 / 首屏精致化 / 推荐混排 / 端云同步 · 客户端侧）规格齐备；
- **九包工作包**（WP0 客户端门禁前置 + WP1–WP8），量化口径约 **1150 行 / 134k Tokens**，**全部工作包文件清单零 `edge/` 路径**；
- **12 条验收（AC-19…AC-30）**，全部可量化、可复测；
- **6 条新增铁律**：门禁同步 / 编号唯一权威 / 外部前提回源核验 / 单一权威 / **端云范围隔离** / **外部阻塞不算返工**。

### 三、需 Master 决策与需云端配合的事项

1. **需 Master 签核（1 项）**：WP4 中 H1 方案（LAN 明文 SOAP 控制改由原生裸 socket 发出，以绕开平台 `cleartextTrafficPermitted="false"` 策略）涉及"有意规避一项平台安全策略"，需您单独批准。
2. **需云端配合（不属本包，仅提请）**：① `/api/user/sync` 端点 + 2 张表（云端规格书 §2.1）；② `ContentItem` 下发 `isAi`/`isHot`（云端规格书 §3.4）；③ 云端门禁 A 组（端点 18→19、业务表 20→22、迁移读取器改全量）；④ 共享文档（`SPEC-v2.0.md` §5 端点清单 / `README` / `openapi.yaml`）由云端维护，本包只改 §9 与第九/十二章。

文档正本已落盘于：
`D:\DEV\prism-play\docs-spec\PLAYER-FULLSCREEN-SIGNING-UPDATE-SPEC-AND-PLAN.md`

请 Master 审阅！
