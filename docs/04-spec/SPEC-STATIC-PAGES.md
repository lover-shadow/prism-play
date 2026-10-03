# Track 1: 静态页面与裂变门户施工规格书 v2 (SPEC-STATIC-PAGES)

**版本**: v2（2026-10-03 审计后重写，取代 v1）
**生效日期**: 2026-10-03
**物理隔离边界**: `edge/src/html/**`, `edge/src/routes/share.ts`, `edge/src/routes/dl.ts`
**严禁触碰**: `src/**`, `android/**`, `edge/scripts/**`, `.github/**`, `edge/migrations/**`

---

## 〇、施工红线速查表（独立 Agent 必读，违反即 CI 拒签）

| 红线 | 内容 |
| :--- | :--- |
| P0-1 | 零 Emoji 功能图标；统一 Lucide Icons（内联 2px stroke SVG），尺寸仅 16/20/24px |
| P0-2 | 零紫色→粉色渐变；主强调色 `--accent: #E5A93C`；夜间背景 `#080A10`；日间背景 `#F5F6FA` |
| P0-3 | 零裸 Hex 色值、零占位空洞文案；100% 消费 Design Tokens |
| 文件 | 单文件 ≤ 300 行 |
| 去平台化 | 分享页 DOM/文案/网络请求中零上游站源名（视频流直连上游 CDN 属运行时行为，页面源码与文案不得出现域名） |
| 私密 | 私密/未知剧目分享一律 404，响应体字节与"未知剧目"完全一致，不泄露任何元信息 |

**自测命令（真实存在，勿改）**：
```bash
npm run typecheck          # edge TypeScript 编译
npm test                   # vitest 全量（含 tests/edge 下 share/dl 用例）
npm run verify:contracts   # 契约一致性门禁
npm run scan:p0            # P0 红线静态扫描
```

---

## 一、背景与决策依据

### 1.1 当前缺陷（代码实证）

1. **分享页 100% 黑屏**: `edge/src/html/share-page.ts:180` 仅以 `canPlayType('application/vnd.apple.mpegurl')` 探测，微信 X5 / 安卓 Chrome / 桌面 Chrome+Edge 均返回空 → 提前 return → 视频永不加载；hls.js 被刻意排除（见 §1.3 契约覆盖说明）。
2. **根路径 404**: `edge/src/index.ts:65` 将 `/` 解析为空段，19 条路由无一匹配。
3. **裂变链路断裂**: 播不了 → 绑在 `ended` 事件上的截流卡永不出现。

### 1.2 架构决策（2026-10-03 定案）

1. **分享页视频流直连上游 CDN，不经云端代理**：实测魔都 CDN 全链路 `Access-Control-Allow-Origin: *`（m3u8 与 TS 分片均开放），Hls.js 可零代理起播，云端转发流量 = 0。
2. **播放地址来源 = R2 剧集清单**（Track 2 C-3b 提供 `/api/titles/{id}`），**不再读 D1 `episode_sources`**（该表已被 Track 2 C-5 停用）。
3. **准确播放当前单集**：链接格式 `/s/{dramaId}?ep={N}`；`share.ts:71-73` 已实现"非法 ep 返回 404、绝不回退第 1 集"，**必须保留**。
4. **Hls.js 自托管**：`https://play.prismos.org/assets/hls.min.js`（Worker 静态资产 + CDN 长缓存）。**禁止第三方 CDN**（jsdelivr 在微信/大陆网络间歇性不可用，而分享页主战场正是微信）。
5. **官网设计吸收 MiniReel 思路但绝不模仿其视觉**：Hero 极简下载按钮、设备信息矩阵（版本号/体积/格式药丸）、"数据留在本地"信任声明。

### 1.3 契约覆盖声明（必读）

`share-page.ts:138` 注释载明 hls.js 被排除的原因是 **SPEC-v2.0 §10 禁止分享页使用站点级 JS 资产**。
**本 SPEC 的 S-1 决策显式覆盖该条款**：允许分享页加载一个自托管的 `hls.min.js`。
配套义务：同步修订 `docs/04-spec/SPEC-v2.0.md` §10 与 `docs/03-contracts/` 相关描述，并使 `npm run verify:contracts` 保持绿色。**未同步修订前不得合并 S-1 代码。**

---

## 二、数据契约（自包含，Track 2 生产、本 Track 消费）

### 2.1 剧集清单响应（`GET /api/titles/{workId}`，Track 2 C-3b 实现）

```jsonc
{
  "workId": "drama_m_90431",
  "title": "…", "channelId": "drama", "isPrivate": false,
  "episodes": [
    { "episodeNumber": 24, "title": "第24集", "durationSeconds": 120,
      "lines": [ { "providerId": "provider_m1",
                   "mediaUrl": "https://play.modujx11.com/…/index.m3u8" } ] }
  ],
  "generatedAt": 1790000000
}
```

分享页取用规则：`episodes` 中 `episodeNumber === 请求的 ep` 的条目 → `lines[0].mediaUrl` 作为 Hls.js 的加载地址；`lines[0]` 失败时按序尝试 `lines[1..]`。

### 2.2 分享页服务端注入的数据（现有 `handleShare` 已提供，保留）

`share.ts:145-161` 现有逻辑保留：解析 `dramaId` + `ep` → 返回 HTML 并在页面内注入 `config`（含剧目 id、请求的集数、品牌文案）。**v2 变更**：页面脚本在客户端用 `workId` 调 `/api/titles/{workId}` 获取 §2.1 清单（公开剧目该响应可 CDN 缓存）。

---

## 三、施工任务清单

### S-1: 分享落地页双通道起播引擎

**文件**: `edge/src/html/share-page.ts`
**预估 LOC**: ~140 行（改写）

1. **移除** `:180` 处 `canPlayType` 为空即 return 的阻断逻辑。
2. 双通道策略：
   - **通道 A（原生 HLS）**: `canPlayType('application/vnd.apple.mpegurl')` 非空（iOS Safari 等）→ 直接 `video.src = mediaUrl`。
   - **通道 B（Hls.js MSE）**: 否则动态 `<script src="/assets/hls.min.js">`（自托管，§1.2-4）→ `new Hls().loadSource(mediaUrl); hls.attachMedia(video)`。
3. 微信 X5 同层播放属性注入到 `<video>`：
   `playsinline webkit-playsinline x5-video-player-type="h5-page" x5-video-player-fullscreen="true"`
4. 自动播放仅"尝试"：`video.play().catch(() => showTapCard())`；被拒时画面中央显示**单次点击播放卡**（Lucide `play-circle`，24px，琥珀金），点击后 `video.play()`。
5. **保留** `ended` 事件触发截流卡（现有 `:164` 逻辑）。
6. **多线路容错**: `lines[0]` 加载/解码失败（Hls.js `ERROR` 事件 fatal）→ 自动切换 `lines[1]`，最多 2 次；全失败显示"当前线路暂不可用"状态卡（不泄露源信息）。
7. 页面 `<head>` 不引入任何第三方域名资源；`hls.min.js` 仅来自同源 `/assets/`。

**验收**:
- AC-S1-1 微信内置浏览器（Android 真机）点开 3 秒内起播；
- AC-S1-2 桌面 Chrome/Edge 起播；
- AC-S1-3 播放的是 `?ep=N` 指定集；`?ep=999999`（不存在）返回 404 而非第 1 集；
- AC-S1-4 自动播放被拒时单次点击可起播；
- AC-S1-5 `ended` 后截流卡弹出；
- AC-S1-6 页面源码与 Network 面板中除视频流外零第三方域名。

### S-2: 全生命周期截流转化 UI

**文件**: `edge/src/html/share-page.ts`, `edge/src/html/theme.ts`
**预估 LOC**: ~90 行

1. 顶部常驻品牌条：Lucide `film` 16px + "光影Play"；右侧【下载 APP】小按钮；`position: sticky; top: 0`；高 44px。
2. 底部悬浮 CTA：【下载 APP 免费看全集】，固定于 `env(safe-area-inset-bottom)` 之上；琥珀金底 + 黑曜石字。
3. 选集横滑预览轨：渲染 §2.1 `episodes` 全集数；当前集高亮；点击其他集 → 提示"下载 APP 看更多"（不跳转、不加载）。
4. 微信内点击下载：UA 含 `MicroMessenger` 时弹半透明蒙层"点击右上角 ··· 在浏览器中打开"（Lucide `arrow-up-right` 图示）；非微信环境直接跳 `/dl`。
5. 私密/未知剧目：沿用 `share.ts` 现有 404（字节与未知剧目一致）。

**验收**: AC-S2-1 品牌条滚动置顶；AC-S2-2 CTA 播放期间常驻；AC-S2-3 微信内下载弹蒙层；AC-S2-4 选集轨当前集高亮且集数与清单一致。

### S-3: Hls.js 自托管静态资产路由

**文件**: `edge/src/routes/dl.ts`（或新建 `edge/src/routes/assets.ts`）, `edge/src/index.ts`
**预估 LOC**: ~40 行

1. 新增路由 `GET /assets/hls.min.js`：从 R2（或构建期内联产物）返回，`Content-Type: application/javascript`，`Cache-Control: public, max-age=31536000, immutable`（文件名带内容哈希：`hls.{hash}.min.js`，HTML 引用同步更新）。
2. 构建期来源：`npm i hls.js` 后由 Vite/构建脚本产出压缩 bundle 上传 R2；**CI 负责上传，仓库不存二进制**。

**验收**: AC-S3-1 该 URL 返回 200 且 immutable 缓存头；AC-S3-2 分享页加载该脚本成功（Network 面板同源）。

### S-4: 根路径官方门户与 APK 下载

**文件**: `edge/src/routes/dl.ts`, `edge/src/index.ts`, `edge/src/html/landing-page.ts`(新建)
**预估 LOC**: ~160 行

1. `index.ts` 路由表为 `/` 增加处理函数，返回 200 门户页。
2. 页面结构（吸收 MiniReel 思路、自有视觉）：
   - **Hero**: 主标题"好剧随时开场"；副标题"数据留在本地，纯净无广告"；醒目【立即下载 APK】琥珀金按钮 → `/dl/latest/android`（现有 R2 路由，`dl.ts:39` `ANDROID_APK_KEY`）。
   - **设备矩阵**: Android 卡显示 版本号 / 体积 / `APK` 药丸标签；iOS·TV 显示"即将推出"置灰卡（不放假链接）。
   - **功能亮点**: 4 卡（Lucide 图标 + 一句话）：精选短剧一键播放 / 离线可搜零流量 / 多源聚合去重 / 多端断点接力。
   - **Footer**: 版本信息 + 品牌名。
3. 日夜双模适配 Design Tokens；移动端/桌面响应式。

**验收**: AC-S4-1 `https://play.prismos.org/` 返回 200；AC-S4-2 下载按钮取得 APK；AC-S4-3 响应式无横向溢出；AC-S4-4 `scan:p0` 通过。

---

## 四、与其他 Track 的接口约定

| 方向 | 接口 | 约定 |
| :--- | :--- | :--- |
| ← Track 2 | `/api/titles/{workId}` 剧集清单 | Schema 见 §2.1；公开可 CDN 缓存、私密需准入（本 Track 分享页只服务公开剧目，私密一律 404） |
| ← Track 2 | `/dl/latest/android` APK | 现有 R2 路由不变 |
| → Track 3 | 分享链接格式 | `/s/{dramaId}?ep={episodeNumber}`；App 侧 `src/core/share.ts:35` 不变 |
| → 契约文档 | SPEC-v2.0 §10 覆盖 | 见 §1.3，先修契约再合代码 |

---

## 五、已决策事项备忘

- 分享页视频流直连上游 CDN（CORS `*` 实测通过），不经云端代理。
- 播放地址来自 R2 剧集清单，不读 D1（`episode_sources` 已停用）。
- 准确播放当前集，非法 ep 返回 404，绝不回退第 1 集。
- Hls.js 自托管同源，禁第三方 CDN。
- 私密内容不可分享（404），与 Track 2 §2.2 私密定级规则一致。
