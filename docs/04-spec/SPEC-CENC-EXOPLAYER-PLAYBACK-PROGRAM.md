# 《光影Play》CENC 加密媒体原生播放内核：技术规格书与执行计划 (SPEC + PLAN)

> 日期：2026-10-06　状态：现行施工图（Accepted）　维护：MVP开发专家团
> 定位：**自完备交接文档**。会话中断后，新 agent 只读本文件即可接手 A/B/C/D/E 全部剩余任务，无需依赖对话上下文。
> 关联决策：`docs/02-architecture/ADR-007-cenc-playback-kernel.md`（v1.2，路线与三条范围裁定）
> 关联证据：`docs/04-spec/ANALYSIS-S1-NATIVE-PROTOCOL-GAP.md`（§6 P0 实测：编码/加密真相）
> 关联规格：`docs/04-spec/SPEC-UNIVERSAL-DISCOVERY-INGESTION-AND-SERIES.md`（阶段 D 的设计正本）
> 关联代码：`edge/src/search/providers/s1-native.ts`、`edge/src/routes/playback.ts`、`src/player/engine-seam.ts`、`android/app/src/main/java/org/prismos/play/*`

---

## 0. 新会话导读（先读这一节）

### 0.1 这份文档要解决什么

上游移动端（`provider_s1`，如《持械入宋》第 4 集起）的完整正片是 **CENC(AES-128-CTR) 加密的 1080p HEVC，且音频轨同样加密**。光影Play 现有内核是 ArtPlayer.js + hls.js 跑在 WebView 的 MSE 上，**MSE 不支持 CENC 样本级解密，也不保证 HEVC 硬解**，因此这部分内容当前完全播不了。本文档给出把它打通的完整施工计划：云端如何把密钥安全送到设备（阶段 A）、如何用一集真机验证原生内核可行（阶段 B，go/no-go 闸门）、如何把原生内核接进现有播放器 UI（阶段 C），以及并行的普适发现功能补完（阶段 D）与部署验收（阶段 E）。

### 0.2 一页纸现状

| 工作包 | 当前真实状态（2026-10-06交接基线） |
| :--- | :--- |
| B 单集验证 | Master确认“真机测试通过，播放正常”；验证APK和收据在build/apk265，非正式集成包 |
| A 清单契约 | native非密钥描述子贯穿R2 fact/checkpoint/client manifest；40新增契约测试通过；云端权威播放授权未实现 |
| C 正式内核 | PrismPlayerPlugin/Session/Surface + exo-engine已写，Android编译通过；TextureView在透明WebView下，非ClearKey路径 |
| C 控制条 | native-controls已实现并挂载，6项控制/适配测试通过，浏览器用假内核核验暂停/播放/seek与44px触点；不是原生叠层真机验收 |
| C 未完成 | 后台音频/MediaSession、授权绑定、完整叠层/全屏/生命周期及正式集成真机回归 |
| D 普适发现 | 季聚合卡、切季、连载追更、cron未完成；失败的只读调查不算产出 |
| E 完整交付 | 未出新完整集成APK；未部署、未提交、未正式发布 |

后续由主Agent直接完成，**禁止继续调用子代理**（Master已明确要求）。不需要让Master选择技术分叉；其职责是安装验收APK并反馈。代码与本地构建已授权，Git/生产部署/官网发布不据此自动获准。

### 0.3 铁律与授权边界（新 agent 必须遵守）

- **P0 红线**（AGENTS.md 三）：零 emoji 图标（用 Lucide 内联 SVG）、零紫粉渐变、零裸 Hex 颜色（消费 Design Tokens）、单文件 ≤ 300 行。**测试文件同样被 `scan:p0` 扫描**。
- **密钥安全不变量**：`spade_a`/CENC 密钥**绝不**进 D1 目录、断点缓存、种子包、日志。`transport.ts` 的 `protectedData()` 与 `resumeState()` 已在架构层强制拒绝含 `key`/`spade_a`/`encrypt*`/`kid`/`license` 等字段的持久化状态——**不得绕过**。密钥只在取流时新鲜解析、经 `no-store` 响应直达设备内存。
- **上游身份零暴露**（AGENTS.md 二·1）：界面、日志、响应体不得出现上游站源名/域名/品牌。
- **授权边界**：Agent 可自主写代码、跑本地测试/类型检查/P0 扫描。**Git 提交、CI 出 APK、Worker/配置密钥部署、官网发布一律需 Master 显式放行**。真机验证判据由 Master 掌握。
- **诚实边界**：不以"拿到 HTTP 地址 / Range 206 / 单测绿灯"冒充"能播"。播放成功 = 真机 `playing` 事件 + 画面 + 声音 + 完整时长（非 30s 试看）。

### 0.4 本地验证命令（改完必跑）

```bash
npm run typecheck                                   # tsc -p edge/tsconfig.json，退出码 0
npm test -- tests/edge/107-s1-native-cipher.test.ts # 协议/密钥/夹具
npm run test:edge                                   # 云端全套
npm run scan:p0                                     # P0 红线扫描，全绿
npm test                                            # 全量回归（阶段 C/D 收口时）
```

---

## 1. 决策与证据锚点（为什么是 ExoPlayer）

来自 `ANALYSIS-S1-NATIVE-PROTOCOL-GAP.md` §6 的真实探测（非推断）：

| 变体 | 标称 codec | 真实样本编码 | 音频 | 可用性 |
| :--- | :--- | :--- | :--- | :--- |
| 360/480/540/720p | bytevc2 | `encv`→`bvc2`（字节私有）| `enca` | **永久不可解，丢弃（R-3）** |
| 1080p | bytevc1 | `encv`→`hvc1`(HEVC) | `enca`（也加密）| **唯一可用目标** |
| Web 播放页 | H.264 | `avc1` 明文 | `mp4a` 明文 | 前 3 集，现有内核直接可播，零成本 |

结论：App 加密路径需要**同时**做 CENC 解封装（含音视频双轨）+ HEVC 硬解，只有 Android 原生 **ExoPlayer/Media3** 一次解决（ADR-007 v1.1）。方案1（仅本地 CENC 中继）不足以覆盖 HEVC+加密音频，已降级。

**三条范围裁定（ADR-007 v1.2，不可逾越）**：
- **R-1**：不为低端机 HEVC 做软解回退矩阵（主流机型硬解 1080p HEVC 无障碍）。
- **R-2**：FLAG_SECURE 防截屏从新内核移除，功能跑通优先，不作验收项。
- **R-3**：只选 1080p HEVC(bytevc1/hvc1)，bytevc2 永久丢弃。

**Go/No-Go 闸门**：阶段 C 完整集成之前，**必须**先过阶段 B 单集 spike（真机一集出画面+声音+完整时长）。不过则停下重估，不盲改播放器 UI。

---

## 2. 目标架构：3A 混合内核（原生画面 + 保留 Web HUD）

**核心思想**：不把播放器 UI 重写到原生侧。底层放一个原生 `SurfaceView`（ExoPlayer 渲染画面+声音），上层盖一个**透明 WebView** 承载现有全部 HTML/CSS HUD（手势、控件、选集抽屉、倍速、定时、投屏 UI、结束卡、琥珀金 Tokens）。两层通过既有 `PlayerEngine` 注入缝（`src/player/engine-seam.ts`）对接——新增一个 `createExoEngine` 实现同一接口，宿主按内容是否加密选择 `createArtEngine`（明文/HLS）或 `createExoEngine`（CENC）。

```
┌─────────────────────────────────────────┐
│  透明 WebView（z 上层）                    │  ← 现有 HUD/手势/抽屉/Tokens 全保留
│  host-layer.ts stage 槽 · 手势层 · 控件     │     仅把 <video> 换成"驱动原生的空壳"
├─────────────────────────────────────────┤
│  原生 TextureView（正式集成底层）          │  ← ExoPlayer 出画面
│  本地CENC Range解密 → HEVC/AAC解码         │     MediaSession仍待实现
└─────────────────────────────────────────┘
        ▲ 桥接：PrismPlayerPlugin（新）
        │ setSource(sessionId, videoId) / play / pause / seek / on(events)
        │ key仅在Android resolver/DataSource内存，不经过JS桥
```

`PlayerEngine` 接口（已存在，勿破坏）：`play/pause/playing/destroy/currentTime/setCurrentTime/duration/volume/setVolume/setSource(url,mime)/toggleControls/on(MediaEvent)`，可选 `resize/playbackRate/setPlaybackRate/failureCode`。`createExoEngine` 把这些调用转发到原生桥；`on('timeupdate'|'ended'|'error'|...)` 由原生事件回吐。

**UI 保留清单（零重写）**：手势带、HUD 控件、选集抽屉 30 段、倍速、定时关闭、投屏 UI、结束截流卡、nudge、Design Tokens、`host-layer.ts` 三态外壳、进度上报。
**UI 必须适配清单**：① `media-frame.ts` 的画面内在尺寸来源（当前读 `container.querySelector('video').videoWidth`，原生路径无 `<video>`，需由桥回吐 `videoWidth/Height`）；② 原生 surface 几何/z-order/透明 WebView 背景；③ 后台音频+通知转原生 MediaSession（现 `PlaybackService` 依赖 WebView media element）；④ 投屏对加密内容的处理；⑤ 全屏 surface resize。

---

## 3. 阶段 A：云端每次播放签名句柄 + 密钥下发

### 3.1 问题

实际主链是作品清单，不是D1 numeric episode播放接口。原生解析身份必须穿过fact发布和manifest缓存而不夹带密钥；正式起播还需绑定权威作品/集号/线路及现有私密双准入。

### 3.2 当前实现与待实现边界

1. s1解析得到CENC密钥后，仅把数字vid写入线路native标记，不写密钥。
2. 客户端先读线路，再选择原生引擎；Android内运行时取流、解析密钥、按Range本地解密并交ExoPlayer播放。
3. JS桥目前仅接收vid，不接收或回传key。该路径功能已经单集验证，但**尚未实现云端权威授权绑定**。
4. A3下一批必须以服务端权威fact的workId/episodeNumber/lineIndex查证描述子，复用私密准入规则，短时授权不得进长期清单缓存。端点和授权载荷需先同步OpenAPI及测试；不擅自采用旧numeric episode接口，也不将当前裸vid路径宣称为完整准入证明。

### 3.3 已实现的清单契约

```ts
interface PlaybackLine {
  providerId: string;
  mediaUrl: string;
  native?: { kind: 's1-cenc'; videoId: string };
}
```

native仅允许provider_s1，videoId为1～32位数字字符串，内部未知字段/key拒绝。定义分别在 `edge/src/types/manifest.ts` 与服务端 `edge/src/library/title-asset.ts`；客户端缓存白名单在 `src/player/title-manifest.ts`。旧PlaybackInfo不加key字段，本批不实施旧方案的D1元数据迁移或ClearKey直接播放。

### 3.4 当前有效数据链（2026-10-06 修正，覆盖上文旧D1方案）

正式主链是 work manifest，集号为客户端局部ID，不能送往旧D1 playback端点。共享发现完整fact存在私有R2，D1仅保存作品索引和fact指针，不新增episode密钥列。

线路新增非密钥字段 `native?: { kind: 's1-cenc'; videoId: string }`，限定provider_s1与数字字符串vid；经服务端title-asset、checkpoint与客户端title-manifest的白名单解析保留。密钥字段及native内部未知字段一律拒绝。起播/切线先读Surface.native，再选择原生引擎。当前批原生桥仅接收vid，在Android内调用已真机通过的resolver取得URL和key；密钥不返回JS、不落目录/清单/日志。原生运行时路径已经实现；云端授权绑定的解析句柄仍是未完成工作，不宣称当前路径完成云端准入绑定。

当前旧云端已缓存fact不含native标记，不能自动视为已修好。部署与fact刷新是独立待办，未部署时新增解析标记不会凭空出现在生产清单。非原生线路维持ArtPlayer；native线路Web明确拒绝播放，投屏明确拒绝而非透传密文。透明WebView与TextureView叠层、背景音频、全集覆盖仍需集成验收。

### 3.5 代码触点

- `edge/src/library/title-asset.ts`、`edge/src/types/manifest.ts`、`edge/src/search/providers/s1.ts`/`transport.ts`：非密钥描述子与checkpoint
- `edge/src/routes/titles.ts`、`edge/src/search/discovery-store.ts`：权威manifest/fact读取与准入复用点
- `src/player/title-manifest.ts`、`line-runner.ts`、`prism-player.ts`、`exo-engine.ts`：读取native、选引擎、起播
- `PrismPlayerPlugin.java`、`PrismPlayerSession.java`、`ProbeNativeResolver.java`：原生起播入口；A3绑定待实现
- 不新增旧D1 episode列，不经旧numeric playback端点传局部episodeId，不在PlaybackInfo或manifest加key字段。

### 3.6 阶段 A todo

- [x] A1 核实正式work manifest链：共享发现fact在私有R2，D1存索引，无需新增旧episode元数据列
- [x] A2 native非密钥描述子贯穿server/checkpoint/client parser；新增40项契约测试通过，OpenAPI已更新，其他契约同步进行中
- [ ] A3 播放授权绑定：仍未完成；Master最新裁定：个人探索新入口的专项准入测试与完善后移，不作为本轮公开播放交付阻塞，既有双准入保护不删除、不放宽。后面的私密专项测试属于延期项，不能重新列为主线前置。已新增 `GET /api/titles/{titleId}/episodes/{episodeNumber}/native-playback?line={index}`（`edge/src/routes/native-playback.ts`），复用handleTitles准入并重读权威清单，只接受line参数，不接受客户端vid；返回no-store非密钥native身份和checkedAt，不是签名授权凭据。9项selector测试+router/foundation共25项、edge类型、契约/P0通过。公开APP起播现经PrismApiClient.nativePlayback(no-store)复核work/episode/line和vid匹配再调用原生桥，复核拒绝不触发setSource/play、取消后不继续；5项exo适配测试通过。此为JS正式消费链，不是Android内强制授权验证，裸vid插件接口仍在，保持未完成。待：真实私密双准入集成测试、短时授权消费设计/实现、Android强制按work/episode/line调用且禁止直接裸vid正式起播、端侧缓存/会话失效回归。当前PrismPlayerPlugin仍接受vid，禁止标完成。
- [x] A4 server/client parser拒绝native中的key和未知字段；runtime key仅在Android内存，不返回JS清单
- [x] A5 `prism-player.ts`先读取Surface，再按native选引擎；不把局部ID交给旧D1播放端点
- [ ] A6 最终契约与回归收口：native字段现有回归138文件/1644项通过；A3未实现，后台/多季未完成，因此整阶段不可标完成。待剩余功能落地后重新同步契约、运行全量回归。

**规模**：250–400 LOC / 12k–20k tokens。

---

## 4. 阶段 B：ExoPlayer 单集 spike（Go/No-Go 闸门）

**唯一目标**：真机上把**一集** 1080p HEVC + CENC 端到端跑通，回答"ExoPlayer + ClearKey 能否解上游的 encv/enca"。不追求集成完整 UI，可用最小胶水 + 侧载单集 url+key。

### 4.1 判据（全满足才算过闸）

- [ ] 真机加载一集：画面出现、声音正常、`duration ≈ 上游标注`（如 135s，非 30s 试看）
- [ ] `Player.State.READY` + `playWhenReady` 后 `isPlaying=true`
- [ ] seek/暂停/恢复基本可用
- [ ] 无 DRM/解码器致命错误日志（`ExoPlaybackException` 为空）

### 4.2 原生插件面（新增 `PrismPlayerPlugin`）

在 `android/app/src/main/java/org/prismos/play/` 新增插件（Java 或 Kotlin，与现有 `PrismNativePlugin` 同风格；`MainActivity.registerPlugin(...)` 在 `super.onCreate()` **之前**注册）：

- 依赖：`androidx.media3:media3-exoplayer`、`media3-ui`、`media3-exoplayer-dash`（按需）、`media3-common`（版本在 `android/variables.gradle` 定，随 Capacitor 7 / compileSdk 对齐）。
- 视图：一个 `SurfaceView`（或 `PlayerView` 用 `surface` 模式），加到 `BridgeActivity` 根布局底层，WebView 置透明背景盖其上。
- 方法（`@PluginMethod`，跑在 UI 线程用 `withWindow` 同款纪律）：
  - `setSource({ url, keyHex, scheme })`：构建 `MediaItem` + `DrmSessionManager`（ClearKey），`setMediaItem` + `prepare`。
  - `play / pause / seekTo(seconds) / getDuration / getCurrentTime / setVolume / release`
  - `getVideoSize()` → `{width,height}`（喂 `media-frame.ts`）
  - 事件回吐：`notifyListeners('state'|'timeupdate'|'ended'|'error', ...)`

### 4.3 加密普通 MP4 的适配闸门（不能直接承诺 ClearKey）

2026-10-06 查阅 Media3 官方 DRM 支持表（`https://developer.android.com/media/media3/exoplayer/drm`）：ClearKey 的明确支持格式是 DASH；普通 MP4 可播放不等于加密 progressive MP4 可经 ClearKey 播放。此前“给 ExoPlayer 密钥即可解封装”的表述不成立，必须先验证提取器与加密元数据路径。

验证包主攻路线调整为：移植前代本地 CENC 区间解密算法到 Android 数据源，在设备内存中把音视频样本解密并修补 moov，交给 ExoPlayer 按普通 HEVC/AAC MP4 硬解。无需转码，也不改变正式播放器 HUD。ClearKey 作为有正确 DASH/初始化数据时的候选，不作为普通 MP4 的默认成功假设。

上游是 `cenc-aes-ctr` + `spade_a` 解出的 16 字节密钥。若另行验证 ClearKey，需 `DefaultDrmSessionManager` + `C.CLEARKEY_UUID`，并提供正确的 key/KID 配对与 DRM 初始化数据。密钥不得硬编码进源码或 APK；调试入口也必须运行时获取，仅保留于内存。

- **kid 来源**：CENC 的 `pssh`/`tenc` 盒里的默认 KID。spike 需先从一集的 `moov` 明文区读出 default_KID（`enca/encv` 的 `sinf>schi>tenc` 或 `pssh`），确认与密钥配对。
- **风险**：ClearKey 在部分 Android 版本对 `cenc` 直连 MP4 的支持度、subsample 加密、音轨独立 KID——这些**正是 spike 要证伪/证实的未知数**。若 ClearKey 路径受阻，回退到"本地解密代理喂明文给 ExoPlayer"（方案1 与方案3 的混合），在 spike 报告里定档。
- 参考实现锚点：`D:/DEV/guoguo-juku/internal/app/cenc_mp4.go`（`buildCENCStreamIndex`/`DecryptRange`/`xorCTRAtOffset`）——若走本地解密回退，直接移植这套 AES-CTR 区间异或。

### 4.4 透明 WebView 叠层

- WebView 背景透明：`webView.setBackgroundColor(Color.TRANSPARENT)`，页面根在"原生播放态"下把 stage 区留空/透明（HUD 仍渲染）。
- z-order：`SurfaceView.setZOrderMediaOverlay(true)` 或用 `TextureView` 权衡（SurfaceView 性能好但打孔；TextureView 可透明叠加但功耗高）。spike 先用 SurfaceView + 透明 WebView 验证画面可见。
- 触摸：WebView 在上层吃手势，原生日志确认不被 SurfaceView 抢占。

### 4.5 最小 Web 胶水

- `src/player/exo-engine.ts`：实现 `PlayerEngine`，方法转发到 `PrismPlayerPlugin`，事件映射回 `MediaEvent`。spike 可先只接 `setSource/play/pause/on`。
- 一个仅调试用的入口：给定 `{url, keyHex}` 直接起原生播放（可临时用侧载常量，不进生产目录）。

### 4.6 APK 构建步骤（验证包优先本地，不需 Git 写入）

2026-10-06 重新核查发现：工程已有 `build/android-tools/jdk-21.0.12.1+1`、`sdk` 和 `gradle-cache`；旧的“本地无 JDK/SDK”信息已过时。已用这套工具成功解析 Media3 依赖。

1. 本地 `npm run build` + `npx cap sync android`。
2. 设置 `JAVA_HOME` 为上述 JDK、`ANDROID_HOME` 为上述 sdk、`GRADLE_USER_HOME` 为上述 gradle-cache，进入 `android` 运行 `./gradlew testDebugUnitTest assembleDebug -PplaybackProbe=true`。
3. 该参数启用 `BuildConfig.PLAYBACK_PROBE`、独立包名 `org.prismos.play.probe` 和版本后缀；安装后进入独立原生验证页，不覆盖正式 App。普通构建默认不启用入口。
4. 产物存 `build/apk265/`，生成 SHA-256。密钥和临时媒体地址运行时获取，禁止放入源码、资源或 APK。验证包不推送、不部署、不替换官网下载。

### 4.7 真机验收脚本（Master 执行）

- [ ] 装 APK → 进调试入口 → 载入侧载的一集 url+key
- [ ] 观察：画面/声音/时长/seek；抓 `adb logcat` 确认无 DRM/解码致命错误
- [ ] 记录机型/Android 版本/芯片（回填 ADR-007 R-1 的硬解覆盖证据）

### 4.8 阶段 B todo

- [x] B1 加 Media3 1.5.1 依赖，本地 JDK21/SDK 成功解析依赖
- [x] B2 `PrismPlaybackProbeActivity`：独立原生 PlayerView + ExoPlayer 生命周期，编译通过；正式桥接移至 C，真机待验
- [x] B3 本地 CENC 解密索引 + Range DataSource：双轨、子样本、IV8/16、非对齐读取与异常拒绝测试通过（12项CENC测试）；未证明真实媒体可播
- [x] B4 独立包名 `org.prismos.play.probe` + 仅验证构建启动入口，aapt核验通过；透明 WebView 叠层移至 C
- [x] B5 原生运行时取流/签名/spade解析 + 1080p HEVC筛选：2026-10-06 Master反馈“真机测试通过，播放正常”，单集实际播放链路通过
- [x] B6 前端 `npm run build` + `cap sync` 已完成；采用工程内工具链本地编译，不需 Git/CI
- [x] B7 单集真机播放验收：Master于2026-10-06反馈“真机测试通过，播放正常”；收据 `build/apk265/native-playback-probe-receipt.json`。未单独反馈机型、暂停/拖动和完整播完，不据此勾选完整回归。
- [x] B8 基础播放可行性闸门放行，可推进 A/C 正式集成；完整时长、暂停/拖动、全屏/HUD与生命周期仍由 C/WS8 验收，不代表正式发布获批

**规模**：600–900 LOC（原生为主）/ 25k–40k tokens。

---

## 5. 阶段 C：方案3 完整集成（WS1–WS8，闸门通过后才启动）

把 spike 的最小路径产品化，覆盖全部播放器能力，UI 全保留。**每个 WS 独立可测，逐个勾选。**

- [x] **WS1 引擎选择代码**：`prism-player.ts`先读取Surface.native再选`createExoEngine`/`createArtEngine`，不使用旧PlaybackInfo.encryption方案；正式真机验收仍在WS8。
- [x] **基础控制条代码**：`native-controls.ts`接入播放/暂停/进度/时间；与宿主控件显隐联动，6项适配测试及浏览器假内核检查通过。
- [x] **锁定与取消回归（本地代码）**：锁定禁用播放/拖动并取消预览，换集继承锁定；destroy立即release，迟到权威复核/取流不再play。原生准备期间seek先于play、暂停意图取消自动播放；后台允许更新不排在网络队列后。14项exo适配（含网络期间geometry即时更新、pending seek位置保留、缺复核拒绝、listener/create失败清理）、6项native控件（含隐藏/重显后迟到change拒绝）、2项后台竞争及7项source-isolation定向通过；TS/P0通过。阶段真机验收仍未完成。
- [ ] **基础控制条最终收口**：原生叠层/全屏/拖动手势互斥及真实生命周期完整回归，不能用假内核测试替代真机；后台/A3/D仍未完成，不出新验收APK。
- [x] **WS2 画面几何（代码）**：原生事件回吐 `width/height` 写入 `container.dataset.nativeVideo*`，`media-frame.ts` 无 `<video>` 时据此回落，`containedRect` 再算真实画面矩形；工具栏/手势带按该矩形定位。真机观感待验收。
- [x] **WS3 全事件映射（代码）**：`PrismPlayerSession` 将 Media3 状态/位置映射到 `MediaEvent` 闭集（250ms timeupdate、ready→loadedmetadata、自然 ended 不伪 pause），`exo-engine` 转发并驱动 `progress-reporter`。精度真机待测。
- [ ] **WS4 后台音频 + 通知（部分施工，不标完成）**：已修通知PendingIntent为getService；PlaybackService在startForeground成功后记录running，原生进入后台仅在服务running时保留播放。新增NativePlaybackCommands，暂停/恢复/停止和焦点命令直接送原生当前会话；上一集/下一集仍走现有JS通知链。编译/JVM测试及P0/资产门禁通过。已新增PlaybackMediaSession系统token/元数据/播放暂停回调，原生state报告进度与通知图标；后台前台服务running时ticker保留，缺服务时暂停；源代次隔离通知命令，临时duck改暂停而非误恢复，observer移交回归新增。最近编译/JVM测试通过，未装机验证。允许设置已接JS→PrismPlayerPlugin→Session，默认false，只有允许且foreground服务running才后台播；换集继承且用户手动关闭不会因play事件偷偷重开。后台启动迟到销毁/关闭竞争新增测试，停止改stopService不另拉起服务，焦点请求移至startForeground后适配API35。待补：后台自动下一集/JS调度可靠性、MediaSession真机状态与耳机/通话复跑、真实息屏验收。当前仅完成基础命令与保活条件，不证明完整后台功能通过。
- [~] **WS5 全屏/转屏（部分）**：`exo-engine` 监听 resize/scroll 并 `setBounds`，`metadata` 后重算；全屏 surface 实际效果未真机验证。
- [ ] **WS6 选集抽屉/切季（未验收）**：引擎已按线路 `setSource(vid)` 会话隔离可换源，但 30 段抽屉与多季无感切播的真机效果未测。
- [x] **WS7 投屏（代码）**：`cast-ports.ts` 对带 native 的线路不直投、明文集不受影响；分享页 `share-player-script.ts` 跳过 native 线路，避免把密文交电视/浏览器。加密内容"如实不可投"，不谎报。
- [ ] **WS8 回归收口（部分）**：本地 `npm test` 138/1644、P0、契约、Android 资产全绿并出集成 APK；**30-AC 矩阵与透明叠层/后台真机复跑尚未做**。

内部中间构建：`build/apk265/prism-play-v2.6.5-integrated-native-playback.apk`，现已撤回用户验收交付，收据`readyForUserAcceptance=false`。不删除产物、不要求Master安装。不再称作完整验收包。待端侧功能、播放授权、内容更新及可测数据链全部具备且本地回归通过，才能交付下一份完整验收APK；单集探针已通过的结论保留。

---

## 6. 阶段 D：普适发现体系补完（与内核解耦，可并行）

设计正本在 `SPEC-UNIVERSAL-DISCOVERY-INGESTION-AND-SERIES.md`（§4 多季聚合、§5 连载追更、§6 客户端交互）。此处只做**状态跟踪**，实现细节读该文档对应节。

已完成（前序会话）：
- [x] 共享发现库 D1（迁移 0005/0006）+ 私有 R2 + 查询缓存/跨 isolate 租约/限流
- [x] 默认自动补充（无需手点按钮）
- [x] 纵向三列网格 + 真翻页（废除隐藏横向滚动条）
- [x] 云端 CJK 长前缀匹配修复 + 生产 503/1102 修复

待完成：
- [ ] D1 搜索结果**季/系列聚合卡（部分实现）**：复用providers/seasons的季号解析，新src/core/series.ts按频道/基础名/季部区分并排序，不造缺季；src/views/series-card.ts保留所有已观测work选择。search-view已接入，已跨matchType合并并用最强匹配分组，保留各季选择；已补季/部/阶段歧义和同名无后缀work拒绝猜绑，6解析/3卡片测试通过；仍需同族分页与权威族关联全量回归。3解析测试+2卡片测试及搜索回归通过，浏览器393px实测选择第七季对应work可触发；不是全数据族关联完成。
- [ ] D2 **播放器内多季切换（部分实现）**：新增season-switcher.ts，宿主从组合根seriesItems读取公开本地/共享目录候选，显示已观测季并打开对应work，私密和无同族项不渲染；2项组件测试和10项host回归通过。已改保留同一shell/stage切季并保留全屏，转季期间清空旧标题，退出可取消在途详情；详情台与选集抽屉均有切季入口。6项切季回归（含同stage乱序成功/失败不得拆掉新季）和host/loading回归通过；浏览器实测s1→s7保留同一shell/stage。跨季未知数据仍需补权威族关联/目录更新，正式全屏真机待验。
- [ ] D3 **连载状态机 + 增量追更（部分实现）**：discovery-refresh.ts从已公开共享works取6h以上旧项，复用provider.resolve与原有publish/change日志；续跑checkpoint只存在私有R2。上游失败保留旧fact，1h冷却；公开频道/作品身份/标题一致且集数不减少才能发布，10项SQLite测试通过（含跨worker续跑、公平轮转、过期与撤回边界、刷新期间撤回/更新不得复活或覆盖）；刷新发布增加enabled/updated_at/fact_hash原子条件，pending工作按最近任务时间轮转，过期但未撤回项也可尝试刷新。正式连载状态字段和规模公平调度/过期保留/续跑压力验证未完成。
- [ ] D4 **cron 定时增量任务（已接代码、未上线）**：scheduled-discovery.ts复用权威publicDiscoveryContext，开关和独立bucket齐备才注册waitUntil；单次先续跑最多2个未完公开搜索查询（严格匹配当前配置scope/源分页，更新时间轮转，不初始化新查询），再默认刷新2作品，每作品8请求15s预算；5项scheduled测试（含真实service发布未完job、轮转公平性、旧scope超过32项不阻塞当前任务，无新search）及durable jobs回归通过。现有cron频率对长剧续跑可能不足，需规模调度评估与实际完整刷新测试，不宣称无人值守闭环已完成。
- [ ] D5 端到端：断网→拉取→合并写本地 SQLite 全流程回归（§9 G2）

**规模**：700–1100 LOC / 28k–45k tokens。

---

## 7. 阶段 E：部署 + 验收 + 发布（全程需 Master 授权）

- [ ] E1 部署 Worker + 更新 `SEARCH_DISCOVERY_CONFIG` 密钥（含新 App 主机白名单，源文件 `outputs/search-discovery-config.json`）
- [ ] E2 仅对实际新增模型执行经验证的迁移；阶段A不新增旧D1 episode元数据列，D是否需要迁移由实现决定
- [ ] E3 本地JDK/SDK出完整集成验收APK → `build/apk265/` + SHA-256/签名/测试范围收据；不复用单集验证包充当完整包
- [ ] E4 Master 真机验收（30-AC 矩阵 + 加密剧真实全集播放）
- [ ] E5 **验收合格后**才做云端正式发布 / 官网下载替换（严禁提前，AGENTS.md + SPEC §9 G4）

**规模**：~0 代码（配置/CI 为主）/ 5k–10k tokens。

---

## 8. 主跟踪看板（Master Todo Board）

> 新 agent 每完成一项就把对应 `[ ]` 改 `[x]` 并在此表更新状态列。

| 阶段 | 关键出口 | LOC | Token | 需授权 | 状态 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| P0（已完成）| ADR v1.2 + P0-1 协议 + 密钥返回 | ~180 | ~15k | 否 | DONE（本地）|
| A 云端播放绑定 | 非密钥清单代码完成；每次播放权威绑定和最终收口未实现 | 剩余350–670 LOC | 总余量见下 | 部署另授权 | PARTIAL，禁止标整阶段完成 |
| B ExoPlayer spike | **真机一集出画面+声音+完整时长（闸门）** | 新增约1580（含测试，已超过原估算） | 不再沿用旧估算，实际消耗待统计 | 本地构建+Master真机 | 单集真机播放通过（Master 2026-10-06）；完整功能回归待C |
| C 完整集成 WS1–8 | 桥/适配/控制条等代码已写；后台音频、控制/生命周期收口、完整集成验收未完成 | 剩余750–1420 LOC | 总余量见下 | 本地实现，最终真机验收 | IN PROGRESS，中间APK不交付 |
| D 普适补完 | 季聚合/切季/连载追更/cron，对全部内容生效 | 剩余750–1350 | 余量总估算见下 | 部署时 | TODO |
| E 完整回归与交付 | 全量测试、APK、验收记录、部署发布 | 剩余200–350（测试/修复） | 余量总估算见下 | 生产操作另授权 | TODO |
| **剩余合计** | 不含文档/生成物/第三方库，含测试 | **约2050–3890 LOC** | **约85k–155k tokens粗估** | | 不代表完成百分比 |

唯一有效执行顺序：控制条/生命周期收口 → A3权威播放绑定 → 后台音频/全屏集成 → D多季与追更 → 本地完整回归及可测后端/fact链路准备 → 完整验收APK → Master真机验收 → 获准正式发布。B单集基础播放已通过，不重复要求测试。内部编译可验证代码，但不得提前把中间APK交给Master承担未完工作。测试后端准备与正式发布分开：有真实可播数据才能验收，生产写入仍需授权。

---

## 9. 新 agent 交接清单（按序执行，不依赖对话）

1. 读取本文件§0/§3/本节，再读ADR-007的v1.3当前路线及普适发现SPEC。旧分析是探测记录，不把旧ClearKey/D1方案当现行施工图。
2. `git status --short`确认工作树。当前大量跨模块未提交工作必须保留；不reset/restore/clean、不把其他人的变更一并提交。禁止调用子代理，直接执行。
3. 云端入口：`edge/src/library/title-asset.ts`、`edge/src/search/providers/s1.ts`及`transport.ts`、`edge/src/routes/titles.ts`、`edge/src/search/discovery-store.ts`。旧`routes/playback.ts`不是正式work manifest主路径。
4. 客户端入口：`src/player/title-manifest.ts` → `line-runner.ts`/`line-fallback.ts` → `prism-player.ts` → `exo-engine.ts`；控制条`native-controls.ts`，几何`media-frame.ts`，样式`player.css`。native投屏拒绝在`cast-ports.ts`，网页分享过滤在`edge/src/html/share-player-script.ts`。
5. 原生入口：`PrismPlayerPlugin.java`（API/会话）、`PrismPlayerSession.java`（播放与事件）、`PrismPlayerSurface.java`（TextureView/WebView）、`ProbeNativeResolver.java`、`ProbeCencDataSource.java`与`Cenc*.java`（当前正式桥复用这些类）。`PlaybackService.java`后台改造未完成。
6. 先核验控制条收起、换集销毁、播放中取消异步取流；不得因release等待网络导致下一集阻塞。当前JS release已改为立即发原生release，尚须回归并重新Android编译。
7. 再执行A3权威授权绑定与WS4后台播放。用工作包task8/9/10及本文件todo跟踪；未实现的不打勾。
8. D待办读普适发现SPEC§4/§5；多季/追更调查子任务失败，无可引用结论或实现，不得假设已完成。
9. 本地验证：`npm test`、`npm run build`、`npm run typecheck`、`python tests/scan_p0.py`、`python tests/verify_contracts.py`、`python tests/verify_android_assets.py`；`npx cap sync android`后用本地JDK/SDK运行`./gradlew :app:testDebugUnitTest :app:assembleDebug`。完整集成不带`-PplaybackProbe=true`，该参数仅用于旧独立验证入口。
10. 工具链路径：`build/android-tools/jdk-21.0.12.1+1`、`build/android-tools/sdk`、`build/android-tools/gradle-cache`；通过JAVA_HOME/ANDROID_HOME/GRADLE_USER_HOME传入。不需要为了本地出包写Git/CI。安装包必须归档hash/签名及真实验收范围。
11. 最近基线证据：138文件1644项全量回归通过，P0扫描467文件、契约及Android编译/JVM单测通过；仅证明该基线已测代码，未实现功能不在完成范围。浏览器仅假内核验证，不证明Android叠层；后续改动最终必须重跑全部。
12. 曾编译名为integrated-native-playback的中间APK，现已撤回用户验收并在收据标false；保留文件作内部证据。当前没有可交付的完整验收APK。生产未部署、旧fact缺native。必须先完成A/C/D并准备真实可测后端，再交包；生产写入需授权，正式发布只在最终验收后执行。

---

## 10. 附录：源码映射与参考锚点

| 能力 | 光影Play 目标文件 | 参考锚点 |
| :--- | :--- | :--- |
| App 原生报文 | `edge/src/search/providers/s1-native.ts` | `guoguo-juku/internal/app/provider_hongguo_native_media.go:15-37`、`provider_hongguo_app.go:145-205` |
| spade_a→16字节密钥 | `edge/src/search/providers/s1-cipher.ts` | `guoguo-juku/internal/app/provider_hongguo_playback.go:159-201`（`hongguoContentKey`）|
| CENC 本地解密（回退用）| 阶段 B 备选 | `guoguo-juku/internal/app/cenc_mp4.go`（`buildCENCStreamIndex`/`DecryptRange`/`xorCTRAtOffset`）|
| 播放句柄签发 | `edge/src/routes/playback.ts` | `edge/src/core/media-handle.ts`、`core/proxy-signature.ts` |
| 引擎注入缝 | `src/player/engine-seam.ts` | `src/player/art-engine.ts`（`createArtEngine` 现内核）|
| 原生桥/生命周期 | `android/.../PrismNativePlugin.java`、`MainActivity.java` | 现有 `withWindow` UI 线程纪律、`registerPlugin` 时序 |
| 后台音频/通知 | `android/.../PlaybackService.java` | WS4 改承载原生 MediaSession |

---

## 变更记录

| 日期 | 版本 | 变更 |
| :--- | :--- | :--- |
| 2026-10-06 | v1.0 | 首次创建。整合 ADR-007 v1.2 与 ANALYSIS §6，给出 A/B/C/D/E 五阶段的自完备施工计划、机制、代码触点、todo 清单、LOC/token 估算、go/no-go 闸门与交接清单。 |
| 2026-10-06 | v1.1 | 同步单集真机通过、正式native清单契约/Android桥/TS控制条实际落点；撤销旧D1/PlaybackInfo.key/ClearKey默认路线；记录本地工具链、剩余2050–3890 LOC、验证基线及未完授权/后台/多季/生产刷新，扩充§9无上下文接手步骤。Master要求后续不再调用子代理。 |
| 2026-10-06 | v1.2（部分判定已撤销） | 曾按清单准入错误标A3完成、过早把内部构建称为验收APK；该状态不是当前有效基线。138/1644及本地构建记录保留为证据，不代表完整功能完成。 |
| 2026-10-06 | v1.3（当前状态正本） | 核对后恢复A3/A6未完成：manifest签发不证明原生桥每次播放绑定。中间APK撤回用户验收，收据标readyForUserAcceptance=false。统一A部分/C施工/D未完/E未交付，恢复剩余2050–3890 LOC估算；先完成实现与可测数据链，再完整交包，最终验收后正式发布。 |
