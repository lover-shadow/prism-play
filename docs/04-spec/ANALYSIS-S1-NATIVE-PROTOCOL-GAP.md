# 方案 A 预研报告：S1 原生协议取流全链路差异分析与真实播放验收标准

> 日期：2026-10-06。状态：只读预研，未修改任何代码。
> 目标：逐段核清 `guoguo-juku` 对 S1 内容（以《持械入宋》为例）的实际取流路径，
> 对照光影Play 已移植模块，列出协议地址、请求参数、签名、响应解析、密钥传递、
> 播放内核支持上的差异；以真实取流并实际播放为验收，不以拿到 HTTP 地址或 Range 206 代替播放成功。

---

## 1. guoguo-juku S1 取流全链路（逐段核实）

### 1.1 章节 ID 来源

- **搜索阶段**：`fetchHongguoChapters`（`provider_hongguo.go:143`）先尝试 App 详情接口
  （`hongguoAppDetail`），失败后回落到 Web 详情接口（`fetchHongguoWebChapters:162`）。
- **Web 详情**：请求 `GET /detail?series_id={sid}`，从 `_ROUTER_DATA.loaderData.detail_page.seriesDetail.vid_list`
  获取全部集数 ID（字符串数组），每集生成 `Chapter{VideoURL: "hongguo-cenc://" + vid}`。
- **App 详情**：请求 `POST /novel/series/detail/v1/?{query}`，响应结构不同但同样返回 vid 列表。
- **关键**：章节 ID 就是纯数字 vid，`hongguo-cenc://` 前缀仅是内部标记，表示该集可能需要 CENC 解密。

### 1.2 原生请求依赖

`resolveHongguoMedia`（`provider_hongguo.go:204–231`）是三级回退链：

```
Tier 1: resolveHongguoAppMedia  →  POST /novel/player/video_model/v1/
Tier 2: resolveHongguoWebMedia  →  GET  /player/{series_id}/{video_id}
Tier 3: resolveHongguoPlaybackAPI → GET  https://djapi.999888456.xyz/api/hongguo/play?id={base64}
```

**Tier 1（App 原生接口）详细参数：**

| 项目 | guoguo-juku 实际值 | 来源 |
| :--- | :--- | :--- |
| **Base URL** | `https://api5-normal-sinfonlineb.fqnovel.com` | `provider_hongguo_app.go:18` |
| **Path** | `/novel/player/video_model/v1/` | `provider_hongguo_native_media.go:23` |
| **Method** | POST | 同上 |
| **User-Agent** | `com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)` | `provider_hongguo_app.go:19` |
| **Query 参数** | aid=8662, app_name=novelread, version_code=73532, version_name=7.3.5.32, manifest_version_code=73532, update_version_code=73532, channel=update_64, device_platform=android, os=android, ssmix=a, device_type=25053RT47C, device_brand=Redmi, language=zh, os_api=36, os_version=16, resolution=1280*2772, dpi=520, ac=wifi, device_id={随机}, iid={随机} | `provider_hongguo_app.go:150-155` |
| **Body** | `{"video_id":"{vid}","content_type":1,"biz_param":{"need_all_video_definition":true,"video_platform":3}}` | `provider_hongguo_native_media.go:19-22` |
| **签名头** | X-Khronos, X-Gorgon, X-SS-Req-Ticket, X-SS-STUB | `provider_hongguo_sign.go:23-47` |
| **其他头** | Accept: application/json, X-XS-From-Web: 0, Sdk-Version: 2, Content-Type: application/json; charset=utf-8 | `provider_hongguo_app.go:188-203` |

**Tier 2（Web 播放页）：**
- 请求 `GET /player/{series_id}/{video_id}`，从 `_ROUTER_DATA.loaderData.player_page.video_player_info.main_url` 取地址。
- **上游对第 4 集起返回 404**（试看限制），因此 Tier 2 只能拿到前 3 集。

**Tier 3（备用解析接口）：**
- 请求 `GET https://djapi.999888456.xyz/api/hongguo/play?id={base64}`。
- 响应可能是 `v2.{hexKey}.{base64Cipher}` 格式，需要 AES-128-CBC 解密（`provider_hongguo_playback.go:108-148`）。
- 解密后 JSON 含 `key_urls` 数组，每项有 `src`（媒体地址）、`spade_a`（CENC 密钥）、`kid`。

### 1.3 响应中的地址和密钥如何被播放器消费

`selectHongguoAppMedia`（`provider_hongguo_native_media.go:39-107`）处理 App 原生响应：

1. 遍历 `video_list` 中每个 variant；
2. **跳过 `bytevc2` 编码**（proprietary codec，ffmpeg 不支持）；
3. 检查 `encrypt_info.spade_a`：
   - 若存在，调用 `hongguoContentKey(spade_a)` 提取 16 字节 AES-128 密钥，存入 `media.CENCKey`；
   - 若提取失败（tag 为 `app_v2`/`web_v2`），跳过该 variant；
4. 收集所有候选地址（`main_url`、`backup_url` 等，可能 base64 编码）；
5. 按质量评分排序，选最高分 variant 返回。

**播放时**（`playback_stream.go:113-114`）：

```go
if len(media.CENCKey) > 0 {
    args = append(args, "-decryption_key", hex.EncodeToString(media.CENCKey))
}
```

ffmpeg 使用 `-decryption_key` 参数在**解码时实时解密 CENC 样本**，然后转码为 fMP4 通过管道输出给浏览器播放。

**关键约束**（`playback_gateway.go:104`）：
- CENCKey 必须是 16 字节（AES-128）；
- 有 CENCKey 时 Playlist 必须为空（即只能是 MP4 直链，不能是 HLS）；
- 直链播放要求 `local == "" && key == nil && HLSKey == nil && CENCKey == nil`（`playback_direct.go:17`），
  即 CENC 媒体**不能直接给浏览器播放**，必须经过 ffmpeg 解密转码。

### 1.4 是否依赖账号、设备身份或受保护内容授权

- **无账号登录**：整个链路不需要用户登录或 token；
- **设备身份**：`device_id` 和 `iid` 是随机生成的 19 位数字（`newHongguoDeviceID:15-21`），
  不需要注册，但每次请求必须携带且服务端可能做频率限制；
- **签名**：X-Gorgon 算法是固定密钥的位运算（`provider_hongguo_sign.go:35`），不含用户凭据；
- **Referer**：App 接口需要 `Referer: https://novel.snssdk.com/`（`provider_hongguo_native_media.go:69`）。

---

## 2. 光影Play 已移植模块逐项差异对照

### 2.1 协议地址差异（P0 阻断）

| 项目 | guoguo-juku | 光影Play 当前 | 影响 |
| :--- | :--- | :--- | :--- |
| **App Base URL** | `https://api5-normal-sinfonlineb.fqnovel.com` | `https://novel.snssdk.com` | **404，完全不可用** |
| **Web 播放页** | `https://hongguoduanju.com/player/{sid}/{vid}` | 同 | 仅前 3 集可用 |
| **备用 API** | `https://djapi.999888456.xyz/api/hongguo/play` | 同 | 需验证可达性 |
| **Referer** | `https://novel.snssdk.com/` | 未设置 | 可能被 WAF 拦截 |

### 2.2 请求参数差异

| 参数 | guoguo-juku | 光影Play 当前 | 影响 |
| :--- | :--- | :--- | :--- |
| device_id | 随机 19 位数字 | **缺失** | 服务端可能拒绝 |
| iid | 随机 19 位数字 | **缺失** | 同上 |
| ssmix | "a" | **缺失** | 同上 |
| device_type | "25053RT47C" | **缺失** | 同上 |
| device_brand | "Redmi" | **缺失** | 同上 |
| os_api | "36" | **缺失** | 同上 |
| os_version | "16" | **缺失** | 同上 |
| resolution | "1280*2772" | **缺失** | 同上 |
| dpi | "520" | **缺失** | 同上 |
| ac | "wifi" | **缺失** | 同上 |
| manifest_version_code | "73532" | **缺失** | 同上 |
| update_version_code | "73532" | **缺失** | 同上 |
| channel | "update_64" | **缺失** | 同上 |
| _rticket | 当前毫秒时间戳 | **缺失** | 签名校验可能失败 |

### 2.3 User-Agent 差异

| 项目 | guoguo-juku | 光影Play 当前 |
| :--- | :--- | :--- |
| UA | `com.phoenix.read/73532 (Linux; U; Android 16; zh_CN; 25053RT47C; Build/BP2A.250605.031.A3; Cronet/TTNetVersion:04657795 2026-01-23 QuicVersion:c67e9834 2025-09-08)` | `com.dragon.read/7.3.5.32 (Linux; U; Android 14; zh_CN; 25053RT47C; Build/UKQ1.231003.002; Cronet/TTNetVersion:7a37fa20 2024-03-05 QuicVersion:420658e4 2024-03-05)` |
| **差异** | `com.phoenix.read` vs `com.dragon.read`；Android 16 vs 14；Cronet 版本不同 | 可能触发 WAF |

### 2.4 签名算法差异

| 项目 | guoguo-juku | 光影Play 当前 | 影响 |
| :--- | :--- | :--- | :--- |
| X-Gorgon | 完整实现（`provider_hongguo_sign.go:23-47`） | 已移植（`s1-sign.ts`） | 算法一致，但 payload[8:12] 未填充（body 为 nil 时跳过），需确认 |
| X-Khronos | uint32 秒级时间戳 | 同 | 一致 |
| X-SS-STUB | body 的 MD5 大写 hex | 同 | 一致 |
| X-SS-Req-Ticket | 毫秒时间戳 | 同 | 一致 |
| _rticket | 在 URL query 中追加 | **缺失** | 签名计算时 query 不含 _rticket，但实际请求 URL 含，可能导致签名不匹配 |

### 2.5 响应解析差异

| 项目 | guoguo-juku | 光影Play 当前 | 影响 |
| :--- | :--- | :--- | :--- |
| video_model 可能是 string | JSON.parse 二次解码 | 同 | 一致 |
| video_list 可能是 map | 按 key 排序转 array | 同 | 一致 |
| bytevc2 过滤 | 跳过 | 跳过 | 一致 |
| backup_url 等字段 | 递归收集 + base64 解码 | 仅检查 main_url | **丢失备选地址** |

### 2.6 密钥传递与播放内核（P0 架构阻断）

**这是最核心的差异：**

| 项目 | guoguo-juku | 光影Play 当前 | 影响 |
| :--- | :--- | :--- | :--- |
| CENC 密钥提取 | `hongguoContentKey` → 16 字节 AES key | `extractSpadeKey` → 16 字节 AES key | 算法一致 |
| 密钥传递到播放 | `media.CENCKey` 传入 ffmpeg `-decryption_key` | **密钥被提取但未传入任何播放路径** | **加密媒体完全不可播** |
| 播放内核 | ffmpeg（服务端解密转码） | ArtPlayer.js + hls.js（浏览器 MSE） | **hls.js 不支持 CENC MP4** |
| 非加密 H264 | ffmpeg 直接播放 | hls.js/video 元素直接播放 | 仅非加密媒体可播 |

**结论：即使修好所有协议差异，如果上游返回的所有 variant 都是 CENC 加密的，
光影Play 的浏览器播放内核也无法直接播放。**

---

## 3. 真实播放验收标准（不以 HTTP 206 代替）

### 3.1 最低可播条件

一部 S1 长剧（如《持械入宋》100 集）要算"真实可播"，必须同时满足：

1. **取到地址**：通过 App 原生接口或备用 API 拿到每集的媒体 URL；
2. **地址可解析**：URL 指向的是 hls.js/video 元素能消费的形式：
   - `.m3u8`（HLS，含 AES-128 加密的 HLS 也可，hls.js 原生支持）
   - `.mp4`（**仅限非 CENC 加密的 plain MP4**）
   - 经服务端解密转码后的 fMP4 流（需要额外架构支持）
3. **密钥可用**（如适用）：
   - HLS AES-128：hls.js 自动获取 key URI 并解密 ✅
   - CENC MP4：浏览器 MSE **不支持** AES-CTR cenc scheme ❌
4. **实际起播**：在 Android WebView（Capacitor 宿主）中 video 元素触发 `canplay` → `playing` 事件，
   画面与声音正常输出；
5. **非试看**：第 4 集及以后不能是 30 秒试看片段，必须是完整时长。

### 3.2 验收测试矩阵

| 测试项 | 通过标准 | 当前状态 |
| :--- | :--- | :--- |
| App 接口返回 200 + video_model | HTTP 200，JSON 含 data.video_model | ❌ 404（URL 错误） |
| 第 1 集取到非 CENC H264 地址 | video_list 中有 codec≠bytevc2 且无 encrypt_info 的 variant | 待验证 |
| 第 4 集取到可播地址 | 同上（不依赖 Web 试看页） | ❌ 当前 Tier 2/3 均失败 |
| 第 100 集取到可播地址 | 同上 | ❌ 未测试 |
| hls.js 实际加载并起播 | video 元素 playing 事件 + currentTime > 0 | ❌ 未测试 |
| 非试看完整时长 | durationSeconds 与上游标注一致（如 120s±5s） | ❌ 未测试 |
| 全 100 集入库 | discovery_works 中 episodeCount = 100 | ❌ 任务 failed |
| 其他设备可复用 | 另一设备搜索同一词，不触发上游请求 | ❌ 未测试 |

---

## 4. 修复路径与决策落点

> **决策已定档（2026-10-06）**：播放内核路线见 `ADR-007-cenc-playback-kernel.md`。
> 采纳分层递进路线：**方案 1（Android 本地轻量中继代理）为主方案立即实施；
> 方案 3（ExoPlayer/Media3）为后续演进；方案 4（FFmpeg）为保底；
> 方案 2（Cloudflare 边缘流式解密）因未知项过多降级为技术储备，暂不实施。**
> 但**在投入任何解密方案之前，必须先完成下述 P0-1 与 P0-2**——
> 若上游存在非 CENC 明文变体，则直接择优取明文地址，四个方案全部无需启动。

### P0-1：修正 App 原生接口地址与参数

- Base URL 改为 `https://api5-normal-sinfonlineb.fqnovel.com`（当前移植误用 `novel.snssdk.com`，导致 404）；
- 补全所有 query 参数（device_id、iid、ssmix、device_type、device_brand、os_api、os_version、resolution、dpi、ac、manifest_version_code、update_version_code、channel）；
- 修正 User-Agent 为 `com.phoenix.read/73532...`；
- 添加 `Referer: https://novel.snssdk.com/`；
- 在签名前将 `_rticket` 注入 query（与 guoguo-juku 一致）。

### P0-2：确认非 CENC 媒体是否存在（成本最低路径，优先做）

- 用修正后的参数实际请求 App 接口，检查返回的 `video_list` 中
  是否有 `encrypt_info` 为空或 `spade_a` 不存在的 H264 variant；
- 如果存在非加密 variant，**优先选择非加密地址即可彻底绕过解密问题**，方案 1/3/4 全部无需启动；
- 如果**所有 variant 都是 CENC 加密**，则启动方案 1。

### P0-3：CENC 解密落点（如 P0-2 确认全加密才需要）

| 优先级 | 方案 | 定位 | 关键理由 |
| :--- | :--- | :--- | :--- |
| **主方案** | **方案 1**：Android 本地轻量中继代理（Kotlin 移植 `cenc_mp4.go` 的 MP4 box 改写 + AES-CTR 区间异或） | 立即实施 | 包体积 0 增加、不重编码不发热、首帧秒出、ArtPlayer 内核不改；`guoguo-juku` 已生产验证 |
| **后续演进** | **方案 3**：ExoPlayer / Media3 原生内核 | 中长期 | 系统级硬解最佳，但需重写全手势 HUD/选集/倍速/投屏 UI，回归面最大 |
| **保底** | **方案 4**：FFmpeg（`ffmpeg-kit-android`） | 兜底 | 能力最全但 APK 从 31 MB 膨胀到 70～90 MB，违背轻量取向；仅在 1/3 无法覆盖异常格式时启用 |
| **技术储备** | **方案 2**：Cloudflare 边缘流式解密 | 暂不实施 | 未知项过多（Free 档 10 ms CPU 余量风险、TOS 2.8 视频分发限制、回源出口稳定性、subsample 加密纯 JS 实现未验证）；保留为免发版的服务端兜底通道 |

> 方案 2 的 CPU/配额测算已完整归档于 `ADR-007` §方案 2，未来切换时可直接引用。

### P1：备用 API 可达性验证

- `https://djapi.999888456.xyz` 的 `v2.` 加密响应解密已移植；
- 需要实际请求验证该 API 是否仍然存活、返回的 `key_urls` 中是否有非 CENC 地址。

---

## 5. 生产环境当前状态快照

| 指标 | 值 |
| :--- | :--- |
| Worker 版本 | `6351b11c-e401-4018-875b-20d7dfa1b8e8` |
| 持械入宋任务 | `status: failed`（因 App 接口 404） |
| 已发布共享作品 | 1 部（末世：我成了唯一治愈系！，来自 m1 非加密源） |
| 待处理任务 | 35 pending + 5 failed |
| 搜索"末世"第二页 | HTTP 200，20 条（1102 已修复） |
| 验收 APK | v2.6.5 / 21605 已编译，但 App 端无 CENC 播放能力 |

**结论：搜索展示与共享发现框架已实现；原生取流因协议地址错误完全不可用；
CENC 加密媒体因播放内核限制无法直接消费；真实全季全集播放尚未实现。**

---

## 6. P0 实测结果（2026-10-06，只读探测，未改生产代码）

用修正后的完整协议对真实上游做了逐层探测，结果**修正了 §4 的初步判断**：

### 6.1 P0-1 App 原生协议修正 —— 成功

- 用 `api5-normal-sinfonlineb.fqnovel.com` + 全量 query 参数 + `_rticket` 先注入再签名 + `com.phoenix.read` UA + Referer，POST `/novel/player/video_model/v1/`：
- **HTTP 200**，返回完整 `video_model`，`video_duration = 135.698s`（**完整正片，非 30 秒试看**），5 个清晰度变体（360p～1080p）。
- 证实：此前 `failed` 的唯一原因就是 §2.1 的地址/参数错误；协议本身可用。

### 6.2 P0-2 是否存在非 CENC 明文变体 —— 否定

App 接口 5 个变体**全部** `encryption_method = cenc-aes-ctr` 且带 `spade_a` 密钥，无一个明文变体。备用 API（Tier 3）返回 `{parse:0, url:""}`（空，不可用）。

### 6.3 决定性发现：编码底层不是 H264，且音频也加密

对每个变体下载 MP4 头部（CENC 只加密 mdat 样本，moov 明文）嗅探真实样本编码：

| 变体 | 标称 codec | 真实样本编码 | `frma`(原始编码) | 音频 | 结论 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 360p/480p/540p/720p | bytevc2 | `encv` | **bvc2**（字节私有） | `enca` | 解密后仍是私有编码，**任何标准播放器都无法解码** |
| 1080p | bytevc1 | `encv` | **hvc1（HEVC/H.265）** | `enca` | 解密后是标准 HEVC，但**音频轨同样被 CENC 加密** |

**同时探测 Web 播放页（Tier 2）第 1 集**：`content-type: video/mp4`，20.6 MB 完整正片，moov 内为 **`avc1`(H.264) + `mp4a`(AAC)，无 `encv`/`senc`/`sinf`** —— **完全明文、浏览器可直接解码**。但 Web 端仅覆盖 `accessible_episode_cnt`（此剧为前 3 集），第 4 集起 404。

### 6.4 对方案选择的修正

| 事实 | 对方案的影响 |
| :--- | :--- |
| Web 端 = 明文 H.264 | **能拿到 Web 集数的，现在的 ArtPlayer/hls.js 直接可播，零解密成本**（解释了为何部分剧已能播） |
| App 端 = bytevc2(私有) + bytevc1(HEVC) + **音视频双 CENC** | **方案 1（仅 CENC 解密）不足以让 s1 App 全集可播**：① bytevc2 解密后仍是私有编码，标准解码器无解；② bytevc1 解密后是 HEVC，多数 Android WebView 的 `<video>`/MSE 不保证硬解；③ 音频轨 `enca` 也需 CENC 解密，浏览器 MSE 无法自动处理 |
| 浏览器 MSE 不支持 CENC 的 `encv/enca` 样本级解密 | 需要能同时做 **CENC 解封装 + HEVC 硬解** 的内核 |

**修正后的路线（详见 ADR-007 v1.1）：**

1. **优先榨取 Web 明文路径**：能拿到 `accessible` 集数的一律用 H.264 明文直连播放（现状已支持），这是零成本主路径。
2. **App 加密路径升级为主方案时，直接采用方案 3（ExoPlayer / Media3）**，而非方案 1：ExoPlayer 原生支持 CENC（含 `encv`+`enca` 音视频双轨）解封装 + HEVC 硬解，一次解决"解密 + 编码 + 音频"三重障碍；bytevc2 私有编码变体则**放弃、只取 bytevc1(HEVC) 变体**。
3. **方案 1（本地 CENC 中继）降级**：仅在"上游给的是明文 H.264 但被 CENC 包了一层、且设备 WebView 能解 H.264"的窄场景才有意义；对 s1 的 HEVC+加密音频不适用。
4. **方案 4（FFmpeg）**：作为 bytevc2 等异常编码的终极兜底（若确有 ffmpeg 版 bytevc 解码器），否则不引入。

### 6.5 仍需真机验证（探测无法替代）

- 目标 Android 设备的 ExoPlayer 能否对上游 HEVC+CENC 正常起播（需方案 3 插件落地后真机测）；
- bytevc1(HEVC) 变体在各机型的硬解覆盖率；
- Web 明文路径能否通过合法参数扩展到 `accessible` 以外的集数（当前证据：不能，第 4 集 404）。
