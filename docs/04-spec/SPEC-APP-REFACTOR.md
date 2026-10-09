# Track 3: 客户端 App 交互改造与重客户端规格书 v2 (SPEC-APP-REFACTOR)

2026-10-09 本批增量按二合一计划r2 MIN验收：本地先显、发现局部patch及分页播放让路、整包60秒限时、真实宿主Code可选提醒/前台消息。强制升级、完整公告中心、原生断电原子性延期，不冒称已完成；其余既有功能与私密准入保持。

**版本**: v2（2026-10-03 审计后重写，取代 v1）
**生效日期**: 2026-10-03
**物理隔离边界**: `src/**`, `android/**`
**严禁触碰**: `edge/**`, `.github/**`（Track 1、Track 2 领地）

---

## 〇、施工红线速查表（独立 Agent 必读，违反即 CI 拒签）

| 红线 | 内容 |
| :--- | :--- |
| P0-1 | 零 Emoji 功能图标；统一 Lucide Icons（`src/components/icons.ts` 内联 2px stroke SVG），尺寸仅 16/20/24px |
| P0-2 | 零紫色→粉色渐变；主强调色 `--accent: #E5A93C`；夜间背景 `#080A10`；日间背景 `#F5F6FA` |
| P0-3 | 零裸 Hex 色值；100% 消费 `src/styles/design-tokens.css` |
| 文件 | 单文件 ≤ 300 行（**测试文件同样受扫描**，超限需拆分） |
| 测试 | 测试内不得出现 emoji/符号/裸 Hex 字面量；颜色一律读 tokens |
| 私密 | `isPrivate` 内容永不写入持久域；`storage-domains.ts` 的 `assertWritable` 闸门不得绕过 |

**自测命令（真实存在，勿改）**：
```bash
npm test                   # vitest 全量（tests/client + tests/edge）
npm run typecheck          # tsc 编译
npm run scan:p0            # P0 红线扫描（含测试文件）
npm run verify:acceptance  # 30 项验收矩阵（AC-01~30）
```

---

## 一、背景与决策依据

### 1.1 端侧核心缺陷（代码实证）

1. **返回手势割裂**: `src/core/native/back-button.ts` 有 LIFO 栈，但全项目仅 `src/player-host.ts:203` 一处注册；`src/app-shell.ts:11` 的四个 Tab 无 history 栈 → 搜索页/设置页侧滑直接退 App（`back-button.ts:41-45` 兜底 `App.exitApp()`）。
2. **海报密度失衡**: 默认双列一屏 2-3 部；`design-tokens.css:252-257` 的 3 列模式 gap/padding 偏大。
3. **海报误触分享**: `src/components/poster-grid.ts:174-186,209` 卡片右上角浮层分享按钮。
4. **手动翻页**: `src/views/home-view.ts:157-163` 手动【加载更多】按钮；无 IntersectionObserver。
5. **底栏职责重叠**: `app-shell.ts:20-24` 四 Tab（大视界/追剧/搜索/设置），顶部另有搜索入口。
6. **搜索依赖云端**: `src/views/search-view.ts:59` 防抖 250ms 后打网络查云端 FTS5；断网不可用。

### 1.2 架构决策（2026-10-03 定案）

1. **重客户端**：目录/搜索/榜单/排版全部端侧自闭环；云端只管配置、账本与静态资产。
2. **海报 = 紧凑大图 3 列**；间距 6-8px；**单页 60 部**（= 3 个 3.5:3.5:3 混排块 = 整 20 行，尾部平齐）。
3. **海报分享按钮物理拔除**；分享 100% 收敛播放器内（`player-detail.ts:109-113` 与 `episode-drawer.ts:95-98` 已有，保留）。
4. **底栏 3 键**：【精选】【追剧】【我的】；搜索页升级为全屏 Overlay（兼榜单容器），在返回栈中作为 Layer 注册。
5. **三级返回栈 + 深滚回顶**：Layer → Dialog → Page；首页 `scrollY > 300` 时返回键先平滑回顶，顶部再按进入"2 秒双击退出 Toast"。
6. **端侧 SQLite FTS5 本地检索**：断网可用，<50ms。
7. **视频直连上游**：Android 保持 TLS-only（见 A-7）；播放地址来自同 generation 公开事实的按作详情投影（Track 2 C-3b），不经云端代理。

---

## 二、数据契约（自包含，Track 2 生产、本 Track 消费）

### 2.1 目录分片（`/api/catalog?channel&category&page&pageSize=60`）

`pageSize` 恒为 **60**，与 R2 分片一一对应（Worker 零拼接直出）。item字段为`ContentItem`超集，旧缓存可不含新增可选字段：
```jsonc
{ "id","channelId","title","category","isPrivate":false,"coverUrl","coverVersion",
  "synopsis","episodeCount","isAi","isHot","firstPublishedAt","hitsTotal",
  "tags?","releaseYear?","region?","language?" }
```
摘要最多240 Unicode code points；副标签仅可信受控题材/风格，最多6项、每项最多12 code points；年份仅来源明确四位值，地区/语言最多64 code points。`firstPublishedAt`/`hitsTotal`为可选本地排序字段；不得将搜索词、片名、制作类型或上架日期伪装为展示元数据。

### 2.2 剧集清单（`/api/titles/{workId}`，打开剧目详情时惰性拉取并本地缓存）

```jsonc
{ "workId","title","channelId","isPrivate":false,
  "episodes":[ { "episodeNumber","title","durationSeconds",
                 "lines":[ { "providerId","mediaUrl","native?": { "kind":"s1-cenc","videoId":"数字字符串" } } ] } ],
  "generatedAt" }
```
**播放地址 `mediaUrl` 仅在打开剧目时经此接口获得**，不进入目录分片、不进入启动库。实际响应另含 `item`；客户端在 API 边界校验 `item.id` / `workId` / 频道 / 私密标记一致性、剧集编号与线路，再适配内部详情。

- 新详情的 `episodeNumber` 投影为本作 **local numeric id**（身份为 `workId + episodeNumber`），不是 D1 全局 `content_episodes.id`；不得把不同作品相同集号混为一集。缺失/非法线路与坏响应落错误态，禁止旧 playback/proxy fallback；旧全局 id 仅保留给可明确识别的旧响应。
- 客户端不获取、缓存或暴露整包 public pack / manifest pack key；公开目录、title、share、poster 的事实同代规则与大小/哈希约束由 Track 2 §3.3 定义。packs 存在时服务端不得回读旧 D1 公开事实。
- 海报展示和请求统一以 **API origin** 解析 `/proxy/img/<handle>`，不是 Capacitor/Web 页面 origin；只接纳有效同源代理句柄，不猜上游地址。统一覆盖首页、榜单、搜索、历史与缓存请求边界；不改写持久快照，私密签名查询串原样保留且不落盘。
- 私密原有效高级授权 + 当次手动开启双准入不变，仅内存 + 服务端短时凭据，冷启动/完全退出失效。服务端只能证明收到显式开启请求，不能验证真实点击；不得宣称绝对不可绕过。本次不发布任何 private objects，公开 bucket 风险须确认后再另行批准私密发布。

---

### 2.2.1 native 清单与原生实现边界（2026-10-06）

`EpisodeLine` / `PlaybackLine` 保持必填 providerId/mediaUrl，新增 `native?: {kind:'s1-cenc',videoId:string}`，仅 provider_s1 可带。videoId 为1～32位 ASCII 数字字符串（`^[0-9]{1,32}$`），保留前导零；native 严格只有 kind/videoId，unknown-field reject，包括 key/cencKeyHex（即使 null）、错误类型/kind/长度及显式 null/undefined，不能抹掉 native 后降级明文播放。严格闭集仅指 native 对象，不扩大为整个响应所有层级。公开缓存可保留无 key 的 native 身份，私密仍仅内存 no-store；不进入目录分片或启动库。

实际消费主链为 work manifest / 私有 R2 discovery fact 的按作投影，不是旧 D1 episode playback。native mediaUrl 只是来源候选；原生桥的来源输入仅 vid（videoId，会话/进度控制参数另计），Android runtime resolver 获取实时地址/key，key 不返回 JS、不缓存或记录。Web 不支持该 native 播放路径；Web/native cast 必须诚实拒绝 native 线路，普通无 native 线路仍按 A-7。

Android 本地 CENC DataSource + ExoPlayer 单集已获 Master 播放正常反馈；完整 HUD 集成代码已写/编译，尚未真机通过。云端授权绑定播放解析 handle 尚未实现，Stage A 未完成；旧生产 fact 无 native，需要刷新，本轮未部署。只同步限定管线事实，不把单集反馈当完整 HUD/后台/投屏/生产验收；当前 Java bridge/resolver 仅接受1～20位 vid，21～32位 manifest 合法身份仍有原生执行兼容缺口，须待后续接齐，不能宣称全范围可播。

裁定范围：AGENTS 保持 authority，G0→G4 依赖及私密双准入不变；A-7 旧“全线路 ArtPlayer 直连/全部可投屏/不做原生层”仅被上述 provider_s1 native 特例收窄。FLAG_SECURE 仍限定正本 AC-02 个人探索频道/播放，不扩大到其他内容；本次不改权限、代码或机读契约，OpenAPI 等主会话同步前不标 G0 全绿。

## 三、施工任务清单

### A-1: 三级返回历史栈与主页防误退

**文件**: `src/core/native/back-button.ts`, `src/app-shell.ts`, `src/views/home-view.ts`
**预估 LOC**: ~180 行

1. 三级栈消费顺序：**Layer**（选集抽屉/清晰度面板/搜索 Overlay）→ **Dialog**（模态卡）→ **Page**（Tab）。
2. Tab 切换推入 history 记录（`history.pushState`），使 Page 级返回可回退到上一个 Tab。
3. **首页深滚回顶**：处于【精选】且无 Layer/Dialog 打开时，若 `window.scrollY > 300`，返回键消费事件并 `window.scrollTo({ top: 0, behavior: 'smooth' })`。
4. **双击退出**：已在顶部时按返回 → Toast"再按一次退出光影Play"（6.5s 自动消失，复用 `src/components/notice.ts`）；2 秒内再按 → `App.exitApp()`；超时重置。
5. 注册覆盖：搜索 Overlay、设置页卡密模态卡、全屏播放器选集抽屉均注册各自 handler。
6. 保留 `back-button.ts` 现有 LIFO 总线与 `dispatchBackButtonForTest()`（测试依赖）。

**验收**: AC-A1-1 搜索页侧滑回首页不退 App；AC-A1-2 深滚 5 屏后返回键平滑回顶；AC-A1-3 顶部返回弹 Toast、2 秒内连击才退出；AC-A1-4 播放器内选集抽屉侧滑仅关抽屉。

### A-2: 首页折叠搜索栏（下隐上现）

**文件**: `src/views/home-view.ts`, `src/styles/home.css`
**预估 LOC**: ~80 行

1. 滚动差量监听（rAF 节流，参照 guoguo `shell.js:497-517` 思路）：向下累计 >15px → `.home-search-bar--hidden`（`transform: translateY(-100%)`）；向上累计 >10px → 复位。
2. 点击搜索条 → 打开全屏搜索 Overlay（A-3），并传聚焦指令。
3. 过渡用 `var(--ease-standard)` + `var(--duration-normal)`；不引入新 token。

**验收**: AC-A2-1 下滑收起；AC-A2-2 上滑复现；AC-A2-3 点击平滑切入搜索 Overlay。

### A-3: 底栏 3 键 + 搜索 Overlay 集成榜单

**文件**: `src/app-shell.ts`, `src/views/search-view.ts`, `src/views/rankings-rail.ts`(新建), `src/main.ts`
**预估 LOC**: ~240 行

1. **`ShellTab` 类型收敛**（`app-shell.ts:11`）：`'home' | 'history' | 'settings'`；`SHELL_TABS` 标签定稿为 **【精选】(sparkles) /【追剧】(clock) /【我的】(user)**；`main.ts:162 viewFor()` 同步删去 `'search'` 分支。
2. **搜索页改为全屏 Overlay**：由 home 搜索条触发 `openSearchOverlay()`；在 A-1 返回栈中注册为 **Layer**（侧滑关闭 Overlay 回首页）。
3. Overlay 内容自上而下：防抖输入框（**200ms**，改 `search-view.ts:59` 默认值或注入参数）→ 搜索历史（≤20 条 + 清除）→ **榜单专区三 Tab**：
   - 【总热播榜】= 本地库按 `hitsTotal` 降序；
   - 【实时新剧榜】= 按 `firstPublishedAt` 降序；
   - 【AI先锋榜】= `isAi === true` 子集按 `hitsTotal` 降序；
   - 全部**端侧本地计算**（读本地快照/SQLite），零网络请求。
4. 榜单条目：名次徽章（前 3 名琥珀金高亮）、剧名、分类、集数、热度标签；点击进详情。
5. 新建 `rankings-rail.ts` 单文件 ≤300 行；超出则拆 `rankings-rail.ts` + `rankings-list.ts`。
6. **搜索三态互斥**：空输入为 recommendations（历史/公开热词/榜单）；输入中为 candidates（仅补全）；提交或点击候选为 results（仅检索结果及加载/空/错误态）。输入变化使旧异步结果失效，清空恢复 recommendations，禁止旧结果或榜单串场；输入法组合期间不查询，联网补充仍须用户手动触发。

**验收**: AC-A3-1 底栏 3 键等宽无错位；AC-A3-2 Overlay 默认展示历史 + 三榜单 Tab；AC-A3-3 断网状态下榜单仍可渲染（本地计算）；AC-A3-4 榜单点击可起播。

### A-4: 紧凑 3 列海报 + 60 条无感加载

**文件**: `src/styles/design-tokens.css`, `src/styles/home.css`, `src/components/poster-grid.ts`, `src/views/home-view.ts`
**预估 LOC**: ~100 行

1. 默认模式锁定 `grid-posters-compact-3`；`design-tokens.css:252-257` 的 `gap` 改 `6px`、`padding` 改 `0 var(--space-2)`（8px）；卡片内 padding 收紧。
2. **断点联动（必做）**：同步修订 `design-tokens.css:283-315` 的 ≥768px / ≥1024px 倍增段（3→6→8 列时的 gap/padding 同步收紧），避免平板出现 6 列碎图。
3. 单页拉取量 = **60**（与 Track 2 分片一致）。
4. 拔除 `home-view.ts:157-163` 手动按钮；容器尾挂 1px 哨兵；`IntersectionObserver` `rootMargin: '0px 0px 300px 0px'` 静默追加。

**验收**: AC-A4-1 竖屏稳定 3 列、间距紧凑；AC-A4-2 触底静默续载无手动点击；AC-A4-3 每批 60 部尾部平齐；AC-A4-4 平板横屏断点下列数与间距正确。

### A-5: 拔除海报分享按钮

**文件**: `src/components/poster-grid.ts`, `src/styles/home.css`
**预估 LOC**: ~-40 行（纯删减）

1. 删除 `poster-grid.ts:174-186` `shareButton()` 与 `:209` 挂载；删除 `home.css:100` `.poster-share` 样式。
2. 保留左上角微光角标与右下角集数徽章的黄金对角布局（`poster-grid.ts:169-170` 注释约束）。
3. 保留 `isShareable()` / `sharePathFor()` 导出（播放器与分享出站仍用）。

**验收**: AC-A5-1 卡片无任何分享图标；AC-A5-2 点卡片稳定进详情无误触；AC-A5-3 播放器内分享按钮完好。

### A-6: 端侧 SQLite FTS5 本地检索

**文件**: `src/core/storage/search-index.ts`(新建), `src/views/search-view.ts`, `src/core/catalog-cache.ts`
**预估 LOC**: ~220 行

1. FTS5 虚拟表：
   ```sql
   CREATE VIRTUAL TABLE IF NOT EXISTS local_search_fts USING fts5(
     content_id UNINDEXED, title, pinyin, initials, category, synopsis );
   ```
2. **数据流（明确，勿猜）**：`catalog-cache.ts` 的 `commitSnapshot` 成功后发出事件 → search-index 订阅 → 对新增/变更 item 增量写入 FTS5（拼音/首字母在写入时生成）；快照整体替换时重建索引。
3. 搜索匹配优先级：精确标题 > 前缀 > 拼音首字母 > 分类/题材；结果 ≤50 条。
4. 断网全可用；网络搜索降级为"本地未命中时提示可联网补充"（不默认发请求）。

**验收**: AC-A6-1 飞行模式输入剧名/首字母秒出结果；AC-A6-2 结果点击可起播；AC-A6-3 增量同步后新剧可被搜到。

### A-7: 播放直连与清单消费

**文件**: `android/app/src/main/AndroidManifest.xml`, `src/player/prism-player.ts`, `src/player-host.ts`
**预估 LOC**: ~40 行

1. **明文策略维持关闭（2026-10-04 集成裁定，取代原"改 true"计划）**：对已入库上游媒体全量审计，**零** http:// m3u8/切片（魔都播放列表与分片均 https），直连播放不需要放宽明文；`usesCleartextTraffic` 与 `network_security_config.xml` base-config 均保持 `false`（G3 期 H1 签署的 TLS-only 姿态不变）。未来若某源出现 http 切片，凭证据为该主机加 scoped domain-config，不得翻全局开关。
2. 打开剧目详情时拉取并校验 §2.2 按作清单；仅公开详情允许按缓存策略本地缓存，私密仅内存。起播直接以 `lines[0].mediaUrl` 交给 ArtPlayer/Hls.js（上游 CORS `*` 已实测）；本作 local numeric id 不得调用旧 playback/proxy fallback，空线路明确报错。
3. **普通线路不实现通用原生 OkHttp 拦截层**：该限制不排除本次限定的 provider_s1 本地 CENC DataSource + ExoPlayer；不扩展为任意来源代理或 Referer 拦截能力。
4. `lines[0]` 起播失败 → 自动切 `lines[1]`（≤2 次）；全失败 → 记录遥测信号（A-8）并显示可重试状态。带 native 的线路不执行第2项 ArtPlayer/Hls.js 直连，而由原生 runtime resolver 取流。
5. DLNA 投屏：仅不带 native 的合法普通 `mediaUrl` 可派发电视端；Web/native cast 对 native 线路诚实拒绝，不能以电视无 CORS 限制冒充 CENC 支持。

**验收（真机待闭环）**: AC-A7-1 真机起播、拖动续传正常；AC-A7-2 播放期间云端无流媒体转发请求；AC-A7-3 TLS-only 维持且无未经批准的全局 cleartext 放行；AC-A7-4 首线路失败自动切第二条；新详情空线路不得触发旧代理请求。

### A-8: 线路健康信号上报（端侧半边）

**文件**: `src/core/native/telemetry.ts`(新建), `src/core/user-sync.ts`
**预估 LOC**: ~60 行

1. 播放失败/切线成功时本地累积信号（内存队列，≤20 条）。
2. 复用 user-sync 的两个离场节点（退出播放页 / 应用挂起）**批量静默 POST** `/api/telemetry/lines`（Track 2 C-4）；失败即弃，不重试不阻塞。
3. 非会员同样上报（免费用户是探针主力）；不含任何剧目元信息之外的字段。

**验收**: AC-A8-1 模拟播放失败后离场，请求体含信号数组；AC-A8-2 上报失败不影响退出流程。

### A-9: 海报缓存配额 512MB

**文件**: `src/core/storage/storage-domains.ts`
**预估 LOC**: 1 行

`storage-domains.ts:14`：`128 * 1024 * 1024` → `512 * 1024 * 1024`。

**验收**: AC-A9-1 常量 = 536870912；AC-A9-2 LRU 驱逐测试在新阈值下通过。

### A-10: 内容目录状态与用户手动检查更新

**参考既有模块**: `src/views/catalog-status/`、`src/core/catalog-cache.ts`、`src/views/settings-view.ts`（已存在，不重复实现）。

1. 【我的】展示本地公开目录 revision、条数、部分快照状态与本次检查时间；内容更新与 APK 版本更新分开，不混为同一状态。
2. 【检查内容更新】由用户手动点击触发真实目录同步；挂载状态卡只读状态，不因渲染自动检查。检查中防重复点击，如实展示无变化、已更新、离线/失败及恢复动作，不宣称始终最新。
3. 稳定 bundle URL 不按 `immutable` 长期信任；同步检查 revision 并校验后提交快照，失败保留可用本地目录；不得把旧 publisher 拒绝覆盖 workFacts 当作日更成功。

**验收（待新 APK 真机）**: 挂载不额外发检查请求；点击后确有同步、重复点击合并；无变化/更新/失败状态区分；目录更新后搜索与榜单读取新快照，旧快照不因失败丢失。

---

## 四、施工顺序建议

```
A-5(删分享按钮) → A-4(3列+60条) → A-2(折叠搜索栏) → A-1(返回栈)
      → A-3(底栏3键+榜单) → A-6(FTS5) → A-7(直连) → A-8(遥测) → A-9(配额)
```
A-1 依赖 A-3 的 Overlay 存在（Layer 注册），故 A-3 先于 A-1 收口。

---

## 五、与其他 Track 的接口约定

| 方向 | 接口 | 约定 |
| :--- | :--- | :--- |
| ← Track 2 | `/api/catalog`（pageSize=60）、`/api/titles/{id}` | Schema 见 §2.1/§2.2 |
| → Track 2 | `POST /api/telemetry/lines` | A-8，离场批量 ≤20 条 |
| → Track 1 | 分享链接 | `/s/{dramaId}?ep={episodeNumber}`（`src/core/share.ts:35` 不变） |

---

## 六、已决策事项备忘

- 3 列紧凑海报（gap 6px / padding 8px），单页 60 部整行平齐。
- 海报零分享按钮；分享仅在播放器内。
- 底栏 3 键【精选/追剧/我的】；搜索为全屏 Overlay 兼榜单容器。
- 折叠搜索栏下隐上现；深滚回顶 + 顶部双击退出 Toast。
- 普通视频直连上游，不做通用原生拦截层；provider_s1 native 线路按 A-7 与 §2.2.1 使用限定 CENC 原生管线。
- 榜单端侧本地计算（hitsTotal / firstPublishedAt / isAi），断网可用。
- 搜索 recommendations / candidates / results 三态互斥；海报统一 API origin；内容目录更新由用户手动检查。

---

## 6.1 v2.6修复增量（当前规则，全部待验）

正本关联§10.1，详见 `D:/DEV/prism-play/docs/04-spec/SPEC-v2.6.3-REPAIR.md` R26-01～12及同目录修复计划。首批只修 `src/core/catalog-cache.ts` hydrate完整快照feed、`src/core/storage/index.ts` 搜索/补全判fallback前等待init/queued sync，检查revision/count实际完整性；不重复建索引。搜索结果、目录、详情、推荐须同generation，旧anime ID/两集截断待复测。

左亮度右音量；正常1（正常）/1.25/1.5/1.75/2/2.5/3/4，长按倍率设置可改且松开/取消恢复原倍率。独立选集、返回先浮层→全屏→播放器；原生横屏隐藏系统栏、退出恢复原策略，全屏倍速/投屏可达，当前集统一同步。当前频道/子类首个重复点击滚头、连续第二个真实刷新，切新分类正常加载并重置状态。A-3 Overlay三榜继续保留，同时每个公开频道顶部热门榜用可信热度，缺字段不得仅ID假排。

追剧真持久化，正在追→同类→完播留足独立可操作空间，缓存管理归“我的”。云配置二维码放大/保存及微信手动辅助待字段确认；真实累计观看用实际播放时间非position/假duration，云提醒自然切集可关闭，私密不落盘不上报。内容更新仍真实同步与状态反馈，旧日更拒覆盖不算成功。来源后台调查未完，provider_m3部分合集不代表全部来源。

## 七、变更记录与交付门禁

### 倍速、分享反馈与作者支持补充（2026-10-08）

保存的常规倍率在首次起播及换集/换线后生效；原生准备阶段旧倍率事件不能覆盖待应用的用户倍率，原生play前完成设置，网页metadata加载后重应用。分享仅确认复制完成才提示成功；全局提示须高于播放器且不截获触控，剪贴板失败改为请求打开分享页并说明，不宣称系统分享已发送。

作者联系/赞赏只使用宿主已配置的同源二维码，不新增或猜测联系方式。Android 10及以上通过MediaStore保存JPEG到Pictures/PrismPlay，不申请额外图库读取或全盘存储权限；Android 8/9通过系统文件选择窗口保存，仅写入成功后提示完成，取消不报成功。Web保留文件下载并明确不能确认图库保存。打开微信仅由用户主动点击，使用定向应用Intent，失败提示手动打开/其他设备扫码；不自动识别、不自动联系或转账，原HTTPS外链白名单不放宽。新增PrismAuthorSupport本地插件保存大小上限1 MiB，仅contact/reward角色；真实设备保存、微信唤起与倍速效果仍需Master验收。

### 端侧连接韧性补充（2026-10-08）

播放详情/清单、旧播放取址及原生播放复核的GET，传输失败或自身超时最多追加2次重试（250/600ms退避），单次8秒覆盖响应体读取，总预算约24.85秒；业务HTTP响应、主动取消、JSON解析错误及写请求不重试。搜索不套8秒播放超时。打开详情被退出或切剧替代时取消旧请求与退避，不影响私密双准入。在线状态不能证明服务可达，只有明确离线才显示“需要网络”，其余传输错误显示连接暂不可用；私密与未知拒绝保持同构。冷启发现同步在本地目录bootstrap后延后2秒，播放器打开时继续让路；销毁取消未执行定时器，搜索补充的同步仍可即时唤醒。具体实现与验证见 `docs/plans/2026-10-08-client-playback-resilience-and-hardening.md`，不承诺1秒起播或杜绝平台资源超限。

| 日期 | 变更 | 状态/边界 |
| :--- | :--- | :--- |
| 2026-10-08（端侧韧性与操作反馈落地） | §端侧连接韧性补充、§倍速/分享/作者支持补充入册；随 v2.6.5 修订包发布官网下载 | 156 套 / 1,755 项回归、双端 `tsc`、P0（503 文件）、契约 G0 与 AC 30/30、`verify:android` 与本地 Gradle+签名全绿；Master 真机复验通过（原生 CENC 起播、默认 1× 与已保存倍率、分享复制提示、二维码保存与手动打开微信、全屏 HUD、版本展示）。图库写入与微信唤起为真机实测项；API 响应、准入与 HTTPS 外链白名单未变，无新增存储权限。`versionCode` 仍 21605，老用户须手动覆盖安装 |
| 2026-10-07（原生播放与轻量搜索交付） | 原生 CENC 硬解、纯 `videoId` 描述符起播、`no-referrer` 防盗链、选季归位、HUD 置顶竖向进度、常驻版本展示 | 交付验收包 `prism-play-v2.6.5-acceptance-20261007.apk`；A3 云端授权绑定句柄、WS4 后台音频与投屏真机复跑仍未闭合，30-AC 全矩阵未做，不把单轮真机通过等同于全量验收 |
| 2026-10-06 | §2.2/§2.2.1、A-7及§六同步native字段与限定原生CENC特例 | provider_s1、1～32位数字字符串、native严格unknown-field reject且无key；work manifest/私有R2 fact、vid/runtime key不返JS、Web/native cast拒绝。单集Master反馈已取得，完整HUD已写/编译但未真机通过；授权绑定handle未实现，Stage A未完成，旧fact待刷新、未部署，Java仅1～20位缺口待接齐。AGENTS/FLAG_SECURE不扩大，原todos保留，机读等由主会话同步。 |
| 2026-10-03 | v2 审计后重写 | 原任务基线保留 |
| 2026-10-04 | A-7 明文策略改为 TLS-only | 保留集成裁定，真机播放与切线待验 |
| 2026-10-04 | 详情 API 边界校验、episodeNumber 本作 local numeric id 且禁止旧 proxy fallback；海报 API origin；搜索三态；A-10 用户手动检查内容更新；同步公开 facts 同代规则与私密发布边界 | 本次仅局部修订两份既有 SPEC，不修改代码/CI/Git/云端，不声称生产交付完成 |

**只读代码核查**：已有 `src/core/api/title-detail.ts`、`src/core/poster-urls.ts`、`src/views/catalog-status/` 与 `src/views/search-view.ts` 三态实现可供参考，不重复实现。用户已批准必要工程步骤与新 APK；后续构建、签名、交付须按门禁执行，本次文档任务未生成 APK、未部署、未进行真机验收。该末句仅描述 2026-10-04 那次文档任务；2026-10-07/10-08 的 APK 构建、部署与真机验收状态以下方进度地图为准。

**全局进度地图（2026-10-08 与代码/真机验收对齐，取代旧四行结论）**：

| 门禁 | 当前结论 | 下一证据 |
| :--- | :--- | :--- |
| G0 | 三轨 SPEC 与本正本 §端侧韧性/倍速/分享/作者支持入册；`verify:contracts`（24 App API / 38 业务表 / 13 功能 / 30 AC）与 AC 30/30（188 条署名用例）退出 0 | 待校准参数（曝光/刷新窗/视觉尺寸）与新增端点须先改契约再施工 |
| G1 | 公开基底 generation revision 4 / 21,963 部在线；发现卡片表 0007 上线；端侧只消费云端下发的同代描述子 | 内容日更真实周期；发现链路 1102 间歇复发的复发率取证 |
| G2 | OpenAPI/API-SPEC 与实现同代（native 描述子、`native-playback`、`discoveries` 独立 seq、可选 `discoveryPage`）；传输层有界重试/超时/取消落地 | 跨实例缓存合并范围举证；长查询（搜索不套 8 秒）与轮询的线上时序复测 |
| G3 | v2.6.5 修订包 Master 真机复验通过：原生 CENC 硬解起播、换集/换线独立实例、默认 1× 与已保存倍率起播前生效、分享复制提示层级、作者二维码原生保存与手动打开微信、全屏 HUD 竖向进度、常驻版本展示；156 套 / 1,755 项回归 + 双端类型 + P0 + Gradle 编译签名全绿 | DLNA 投屏、FLAG_SECURE 边界、后台音频/MediaSession 真机复跑、30-AC 全矩阵、缺供元数据与整季播完 |
| G4 | 官网下载已发布 `prism-play-v2.6.5-20261008.apk`（36,303,231 字节 / SHA-256 `67e07a5a…`）与验收包逐字节一致，`config:version` 公告同步 | `versionCode` 未递增导致老用户无 OTA 提示；下次正式发布须递增或明示取舍；内容日更闭环前不得宣称生产完成 |

上表不改变既有约束：不把已有模块或本地核查等同于生产完成，不承诺 1 秒起播，不因单轮真机通过勾选 A3 授权绑定或 WS4 后台音频。
