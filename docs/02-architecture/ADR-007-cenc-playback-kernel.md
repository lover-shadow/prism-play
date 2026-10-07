# ADR-007：CENC 加密媒体的播放内核路线与解密落点

- **状态 (Status)**: **Accepted（已采纳）**
- **决策日期 (Date)**: 2026-10-06
- **决策者 (Deciders)**: Master_流光逸影（架构主理人，唯一批准人）
- **关联文档**: `docs/04-spec/ANALYSIS-S1-NATIVE-PROTOCOL-GAP.md`、`ADR-002-artplayer-core.md`、`ADR-003-cloudflare-edge.md`、`ADR-006-jit-upstream-search.md`、`docs/04-spec/SPEC-UNIVERSAL-DISCOVERY-INGESTION-AND-SERIES.md` §2
- **关联代码**: `edge/src/search/providers/s1-cipher.ts`、`D:/DEV/guoguo-juku/internal/app/cenc_mp4.go`

---

## 背景与问题陈述 (Context and Problem Statement)

2026-10-06 的方案 A 预研（`ANALYSIS-S1-NATIVE-PROTOCOL-GAP.md`）确认了一个此前未被认知的架构性障碍：

1. **上游移动端内容普遍采用 CENC（AES-128-CTR）加密**。以 `provider_s1` 为例，其网页端仅开放前 3 集试看（第 4 集起返回 404），完整集数只能通过 App 原生协议取得，而 App 原生协议返回的媒体变体带有 `encrypt_info.spade_a` 加密标记。
2. **光影Play 的播放内核是 ArtPlayer.js + hls.js（ADR-002），运行在 Android WebView 的 MSE 之上**。hls.js 支持 HLS 的 AES-128 外链密钥解密，但**不支持 CENC `cenc` scheme 的 MP4 样本级解密**。浏览器标准 `<video>` 亦不支持。
3. **前代 `guoguo-juku` 能播全集，并非依赖 ffmpeg 转码**。核读其源码后确认：它在本地 HTTP 代理（`hlsProxy`）内用约 300 行纯 Go 代码完成了 CENC 流式解密——读取 MP4 前缀构建 `moov` 样本索引（`buildCENCStreamIndex`），把加密盒子标识原地改写为明文标识（`encv`→`avc1`、`senc`/`saiz`/`saio`→`free`），再对每个 HTTP Range 命中的字节区间做 AES-CTR 异或（`xorCTRAtOffset`）。播放器拿到的是**已解密的普通 MP4**，因此对播放内核零要求。ffmpeg 的 `-decryption_key` 路径仅用于需要重编码/重封装的场景。

**因此本 ADR 要决策的不是"要不要解密"，而是"解密发生在哪一层"。**

---

## 关键约束

| 约束来源 | 内容 | 对本决策的影响 |
| :--- | :--- | :--- |
| AGENTS.md 二·1 | 上游身份零暴露 | 解密落点若在手机侧，密钥与上游地址会短暂存在于设备内存；若落云端，上游地址不出边缘 |
| ADR-001 / ADR-002 | Capacitor 7 + 纯 TS + ArtPlayer.js，追求轻量与原生手感 | 引入体积庞大的原生库或替换播放内核都与既有 ADR 冲突，须单独权衡 |
| 真机体验 | 短剧要求"点开即看"、后台息屏续播、全手势 | 任何增加首帧延迟或抢占 CPU 造成发热/掉帧的方案都要扣分 |
| 成本 | 当前为私域侧载分发，无商店签名链 | 云端配额成本与 APK 体积都是真实约束，但设备存储不视为瓶颈 |

---

## 备选方案 (Considered Options)

### 方案 1：Android 本地轻量中继代理（**采纳为主方案**）

在 Capacitor Android 宿主内用 Kotlin 写一个仅监听 `127.0.0.1` 随机端口的微型 HTTP 代理，把 `guoguo-juku` 的 `cenc_mp4.go` 解密逻辑（MP4 box 解析 + AES-CTR 区间异或）移植为 Kotlin；WebView 的 `<video>` 指向本地代理 URL，代理向上游取 Range 并流式解密回吐。

- **优点**：
  - **APK 包体积 0 增加**（纯 Kotlin 逻辑，约数百行，不引入任何原生 .so）；
  - **不重编码**，仅字节级异或，手机 CPU 占用极低，不发热不掉帧；
  - **首帧秒出**，流经管即解密，无转码等待；
  - 云端零额外配额消耗；
  - 与 ADR-002 的 ArtPlayer.js 内核完全兼容，播放器侧无需改动。
- **代价**：需要写 Android 原生插件（Kotlin）与 Capacitor 桥接；密钥与上游地址存在于设备内存（在 AGENTS.md 威胁模型内可接受，rooted 用户不在防护范围内）。

### 方案 3：接入 Android 官方原生播放内核（ExoPlayer / Media3）（**后续考虑**）

以 Capacitor 插件形式引入 Android Media3/ExoPlayer 原生视图，替换 WebView 内的 `<video>`；ExoPlayer 原生支持 CENC AES-CTR，传入 `DrmSessionManager`/key 即可播放。

- **优点**：系统级硬解，功耗与兼容性最佳，是长期最"正统"的移动端方案。
- **代价**：需要重写播放器 UI 层——现有全手势 HUD、选集抽屉、倍速、投屏、定时关闭、琥珀金 Tokens 主题全部要在原生侧重做（ADR-002 的手势/HUD 资产不可复用），工程量与回归面最大。
- **定位**：作为**后续演进项**，在方案 1 稳定运行、且产品确认需要系统级硬解收益时再启动。

### 方案 4：全量引入 FFmpeg（`ffmpeg-kit-android`）（**保底备用**）

- **优点**：能力最全，可解任意封装/编码组合。
- **代价**：为兼容 arm64-v8a 与 armeabi-v7a，APK 体积将从约 31 MB 膨胀到 70～90 MB，直接违背 ADR-001 的轻量取向；子进程管道转码会带来首帧延迟与移动端发热。
- **定位**：**仅当方案 1 与方案 3 均无法覆盖某些异常媒体格式时**作为兜底，且应评估按需动态下发 so 库以控制基础包体积。

### 方案 2：Cloudflare 边缘代理流式解密（**降级为技术储备**）

由 `edge/src/routes/proxy.ts` 的 `/proxy/media/{handle}` 承担解密管道：Worker 收到 Range 请求后回源、用 Web Crypto/WASM 做 AES-CTR 解密、以 `TransformStream` 分块回吐明文 fMP4。App 端一行代码不改。

- **优点**：客户端零改动；上游地址与密钥完全不出边缘；符合 ADR-003 的"云端收口"姿态。
- **CPU 与配额实测估算**（网络等待不计费，仅统计 JS 解密运算）：
  | 项目 | 估算值 |
  | :--- | :--- |
  | 单集体积 | 10～15 MB |
  | 单集触发的 Range 请求数 | 6～10 次 |
  | 单次 Range（1～2 MB）解密 CPU | 1.0～2.0 ms |
  | 单集累计 CPU | 15～25 ms |
  | 内存 | < 2 MB（64 KB 分块流式） |

  对应承载能力：
  | 套餐 | 上限 | 可支撑播放量 | 对应 DAU（人均 20～30 集/天） |
  | :--- | :--- | :--- | :--- |
  | Free（0 元） | 10 万请求/天，单次 10 ms CPU | ≈ 1 万集/天 | ≈ 300～500 |
  | Workers Paid（5 美元/月） | 1000 万请求/月，单次 CPU 上限放宽 | ≈ 3.3 万集/天 | ≈ 1200～1500 |
  | 10000 DAU 规模 | ≈ 7500 万请求/月 | ≈ 750 万集/月 | 月费约 24.5 美元 |

- **降级为储备的原因（未知项过多，Master 判定）**：
  1. **单次 10 ms CPU 上限的余量风险**：Free 档单次请求 10 ms 硬顶，若某集分片偏大或 `moov` 解析样本数偏多，可能触碰 1102；而本项目此前已因 1102 在搜索分页上踩过坑（见 `ANALYSIS-S1-NATIVE-PROTOCOL-GAP.md` §5 与既有生产记录）。
  2. **Cloudflare TOS 2.8 视频/非 HTML 内容分发限制**：以 Worker 大规模中转视频流存在被审查或限流的合规不确定性，当前账号套餐与用量政策未逐条核实。
  3. **额外一跳延迟与出口稳定性**：起播 TTFB 增加约 80～150 ms，且边缘回源受出口 IP 信誉影响，稳定性变量多。
  4. **WASM/Web Crypto 的 CENC 子样本（subsample encryption）实现尚未验证**：视频帧普遍含 clear/cipher 混合子样本，纯 JS/WASM 逐块异或的正确性与性能均无实测证据。
- **保留价值**：一旦方案 1 的本地代理在某些 Android 版本/WebView 上遇到回源或 CORS 障碍，方案 2 可作为**服务端兜底通道**快速切换，且 App 无需发版。故记录为技术储备而非否决。

---

## 决策结论 (Decision Outcome)

**采用分层递进路线，按以下优先级推进：**

| 优先级 | 方案 | 定位 | 触发条件 |
| :--- | :--- | :--- | :--- |
| **主方案** | **方案 1**：Android 本地轻量中继代理（Kotlin 移植 `cenc_mp4.go`） | 立即实施，作为 CENC 播放的正式落地 | 前置：先完成 `ANALYSIS-S1-NATIVE-PROTOCOL-GAP.md` 的 P0-1（修正 App 协议地址与参数）与 P0-2（确认是否真有非 CENC 变体） |
| **后续演进** | **方案 3**：ExoPlayer / Media3 原生内核 | 中长期演进项 | 方案 1 稳定后，若确认需要系统级硬解收益再立项；须重做播放器 UI 与全手势 |
| **保底** | **方案 4**：FFmpeg | 兜底 | 仅当方案 1/3 无法覆盖某些异常媒体格式时启用，并评估 so 按需下发 |
| **技术储备** | **方案 2**：Cloudflare 边缘流式解密 | 暂不实施，保留设计 | 方案 1 在特定设备/WebView 上回源受阻时，作为免发版的服务端兜底通道启用 |

**补充决策：优先绕过而非硬解。** 在投入方案 1 之前，必须先执行 P0-2 验证——若上游 App 原生接口的 `video_list` 中存在**无 `encrypt_info` 的 H264/AVC1 明文变体**，则直接择优选取明文地址即可彻底规避 CENC，方案 1/3/4 全部无需启动。这是成本最低的路径。（P0-2 已执行，结论为**否**：s1 App 无明文变体，见 `ANALYSIS-S1-NATIVE-PROTOCOL-GAP.md` §6，故 App 加密路径转由方案 3 承接。）

---

## 范围裁定 (Scope Rulings, v1.2)

2026-10-06 Master 就方案 3（ExoPlayer/Media3）落地范围作出三条裁定，进一步收敛工程面。**技术实现细节由 Agent 团队决定，以下为不可逾越的产品/范围边界：**

| 编号 | 裁定 | 对实现的影响 |
| :--- | :--- | :--- |
| **R-1** | **低端机 HEVC 覆盖不再过度设计**。依据 Master 提供的芯片硬解覆盖数据，主流机型硬解 1080p HEVC 无障碍。 | 不为长尾低端机做 HEVC 软解回退、不做多档编码兜底矩阵；设备兼容性问题在真机验收阶段按实测处理，不在架构期预支成本。 |
| **R-2** | **FLAG_SECURE 防截屏从新内核路径移除，功能跑通优先**。防截屏不再作为方案 3 的验收项。 | ExoPlayer SurfaceView 路径不接入 FLAG_SECURE；`个人探索` 的截屏防护不作为本内核的交付目标（如后续单独需要，另立需求，不阻塞播放打通）。 |
| **R-3** | **变体只选 1080p HEVC**。bytevc2（360–720p 私有 `bvc2` 编码）永久不可解，直接丢弃。 | 原生解析（`s1-native.ts`）的变体筛选只保留 `bytevc1`/`hvc1` 的 1080p 流；`s1-cipher.ts` 的密钥仍用于 CENC 解封装，但不再尝试为 bytevc2 变体产出可播地址。 |

**Go/No-Go 闸门（先证据后铺开）**：方案 3 的完整集成（WS1–WS8）之前，必须先完成**单集垂直验证（spike）**——在真机上把**一集** 1080p HEVC + CENC 端到端打通（App 原生协议取流 → `spade_a` 提取密钥 → ExoPlayer ClearKey 解封装 → SurfaceView 出画面 + 声音，且时长为完整正片非试看）。spike 通过方可铺开集成；不通过则停下重新评估，不盲改播放器 UI。

---

## 后果 (Consequences)

### 正面
- 包体积守住 31 MB 基线（方案 1），不违背 ADR-001/ADR-002；
- 播放体验最优：无转码延迟、无额外发热、首帧秒开；
- 解密逻辑有 `guoguo-juku` 生产验证的算法蓝本（`cenc_mp4.go` + `download_hls.go`），非从零发明；
- 方案 2 的 CPU/配额测算已归档，未来切换服务端兜底时可直接引用，无需重算。

### 负面与需承担的成本
- 引入 Android 原生（Kotlin）代码面，Capacitor 插件工程与 CI 打包需相应扩展；
- 密钥与上游地址短暂存在于设备内存——须在 SPEC 中如实声明边界，**不得宣称绝对不可提取**（与 AGENTS.md 二·2 的"诚实边界"口径一致）；
- 方案 1 的本地代理需自行处理端口占用、进程生命周期、息屏后台续播与 WebView 混合内容策略（`http://127.0.0.1` 在 HTTPS 页面下的 allowlist 配置），这些均为真机验收项，不以单测绿灯代替。

### 待验证（本 ADR 不宣称已完成）
- P0-1：修正后的 App 原生协议地址（`api5-normal-sinfonlineb.fqnovel.com`）与全量参数能否稳定返回 200 + `video_model`；
- P0-2：`video_list` 中是否存在非 CENC 明文变体；
- 方案 1 落地后：第 4 集与第 100 集在真机上 `playing` 事件触发、画面声音正常、时长非 30 秒试看。

---

## 当前有效路线与真机结论（v1.3，2026-10-06）

Media3 官方明确列出的 ClearKey 支持格式为 DASH，不应把普通加密 MP4 可直接经 ClearKey 播放当作已证事实。独立验证包采用 **Android 本地 CENC Range 数据源解密音视频样本、等长修补 moov → ExoPlayer 解码 HEVC/AAC**，无转码，密钥运行时获取且不打包。

Master反馈原文：“真机测试通过，播放正常”。据此单集基础播放可行性闸门放行，正式集成沿用该组合，不再把 ClearKey 当作前置条件。此反馈不等于全集覆盖、完整播完、暂停/拖动、透明WebView叠层和全屏/后台等回归全部通过；这些保留到正式集成验收。未获正式发布批准。

验收包：`build/apk265/prism-play-v2.6.5-native-playback-probe.apk`；SHA-256及范围收据：`build/apk265/native-playback-probe-receipt.json`。进度todo正本：`docs/04-spec/SPEC-CENC-EXOPLAYER-PLAYBACK-PROGRAM.md` §4.8/§8。

## 变更记录

| 日期 | 版本 | 变更 |
| :--- | :--- | :--- |
| 2026-10-06 | v1.0 | 首次创建。记录 CENC 播放内核架构性障碍的发现过程、四方案对比、Master 采纳"方案 1 主 / 方案 3 后续 / 方案 4 保底 / 方案 2 技术储备"的分层路线，并归档方案 2 的 CPU 与配额测算。 |
| 2026-10-06 | v1.1 | **P0 实测修正路线（见 `ANALYSIS-S1-NATIVE-PROTOCOL-GAP.md` §6）**。对真实上游逐层探测确认：① App 原生协议修正后 HTTP 200 + 完整 135s 正片，但 5 变体全部 `cenc-aes-ctr`，**无明文变体**；② 下载 MP4 头部嗅探真实编码——bytevc2 变体解密后仍是私有 `bvc2`（标准解码器无解），仅 bytevc1 变体解密后是标准 HEVC(`hvc1`)，且**音频轨 `enca` 同样被 CENC 加密**；③ Web 播放页对可访问集数返回的是**明文 H.264/AAC MP4**（无 CENC），浏览器直接可播。**据此修正优先级：方案 1（仅 CENC 解密）不足以覆盖 s1 App 全集（HEVC + 加密音频 + 私有编码），对 App 加密路径改由方案 3（ExoPlayer/Media3，原生 CENC 解封装 + HEVC 硬解 + 加密音频）承接；方案 1 降级为窄场景备选；能走 Web 明文 H.264 的集数维持现状零解密成本。原"方案 1 立即实施"调整为"先榨取 Web 明文路径 + App 加密路径立项方案 3"。** |
| 2026-10-06 | v1.2 | **Master 范围裁定（见"范围裁定 (Scope Rulings)"节）**。收敛方案 3 工程面：R-1 低端机 HEVC 覆盖不再过度设计（依芯片硬解数据，主流机型 1080p HEVC 硬解无障碍，不做软解回退矩阵）；R-2 FLAG_SECURE 防截屏从新内核路径移除，功能跑通优先，截屏防护不作验收项；R-3 变体只选 1080p HEVC，bytevc2 私有编码永久丢弃。并确立 Go/No-Go 闸门：完整集成（WS1–WS8）前须先过单集垂直验证 spike（真机一集 1080p HEVC + CENC ClearKey 端到端出画面+声音+完整时长）。技术实现细节授权 Agent 团队决定。 |
