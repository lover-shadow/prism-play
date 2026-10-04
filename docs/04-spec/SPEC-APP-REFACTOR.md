# Track 3: 客户端 App 交互改造与重客户端规格书 v2 (SPEC-APP-REFACTOR)

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

`pageSize` 恒为 **60**，与 R2 分片一一对应（Worker 零拼接直出）。item 字段为 `ContentItem` 超集：
```jsonc
{ "id","channelId","title","category","isPrivate":false,"coverUrl","coverVersion",
  "synopsis","episodeCount","isAi","isHot","firstPublishedAt","hitsTotal" }
```
（`firstPublishedAt`/`hitsTotal` 为新增可选字段，供本地榜单排序。）

### 2.2 剧集清单（`/api/titles/{workId}`，打开剧目详情时惰性拉取并本地缓存）

```jsonc
{ "workId","title","channelId","isPrivate":false,
  "episodes":[ { "episodeNumber","title","durationSeconds",
                 "lines":[ { "providerId","mediaUrl" } ] } ],
  "generatedAt" }
```
**播放地址 `mediaUrl` 仅在打开剧目时经此接口获得**，不进入目录分片、不进入启动库。实际响应另含 `item`；客户端在 API 边界校验 `item.id` / `workId` / 频道 / 私密标记一致性、剧集编号与线路，再适配内部详情。

- 新详情的 `episodeNumber` 投影为本作 **local numeric id**（身份为 `workId + episodeNumber`），不是 D1 全局 `content_episodes.id`；不得把不同作品相同集号混为一集。缺失/非法线路与坏响应落错误态，禁止旧 playback/proxy fallback；旧全局 id 仅保留给可明确识别的旧响应。
- 客户端不获取、缓存或暴露整包 public pack / manifest pack key；公开目录、title、share、poster 的事实同代规则与大小/哈希约束由 Track 2 §3.3 定义。packs 存在时服务端不得回读旧 D1 公开事实。
- 海报展示和请求统一以 **API origin** 解析 `/proxy/img/<handle>`，不是 Capacitor/Web 页面 origin；只接纳有效同源代理句柄，不猜上游地址。统一覆盖首页、榜单、搜索、历史与缓存请求边界；不改写持久快照，私密签名查询串原样保留且不落盘。
- 私密原有效高级授权 + 当次手动开启双准入不变，仅内存 + 服务端短时凭据，冷启动/完全退出失效。服务端只能证明收到显式开启请求，不能验证真实点击；不得宣称绝对不可绕过。本次不发布任何 private objects，公开 bucket 风险须确认后再另行批准私密发布。

---

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
3. **本阶段不实现原生 OkHttp 拦截层**：直连已满足需求；拦截层仅作为"未来某源加 Referer 防盗链"的预留设计，不在本 Track 施工范围（避免范围蔓延）。
4. `lines[0]` 起播失败 → 自动切 `lines[1]`（≤2 次）；全失败 → 记录遥测信号（A-8）并显示可重试状态。
5. DLNA 投屏：将当前 `mediaUrl` 直接派发电视端（电视无 CORS 限制）。

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
- 视频直连上游；本阶段不做原生拦截层。
- 榜单端侧本地计算（hitsTotal / firstPublishedAt / isAi），断网可用。
- 搜索 recommendations / candidates / results 三态互斥；海报统一 API origin；内容目录更新由用户手动检查。

---

## 6.1 v2.6修复增量（当前规则，全部待验）

正本关联§10.1，详见 `D:/DEV/prism-play/docs/04-spec/SPEC-v2.6.3-REPAIR.md` R26-01～12及同目录修复计划。首批只修 `src/core/catalog-cache.ts` hydrate完整快照feed、`src/core/storage/index.ts` 搜索/补全判fallback前等待init/queued sync，检查revision/count实际完整性；不重复建索引。搜索结果、目录、详情、推荐须同generation，旧anime ID/两集截断待复测。

左亮度右音量；正常1（正常）/1.25/1.5/1.75/2/2.5/3/4，长按倍率设置可改且松开/取消恢复原倍率。独立选集、返回先浮层→全屏→播放器；原生横屏隐藏系统栏、退出恢复原策略，全屏倍速/投屏可达，当前集统一同步。当前频道/子类首个重复点击滚头、连续第二个真实刷新，切新分类正常加载并重置状态。A-3 Overlay三榜继续保留，同时每个公开频道顶部热门榜用可信热度，缺字段不得仅ID假排。

追剧真持久化，正在追→同类→完播留足独立可操作空间，缓存管理归“我的”。云配置二维码放大/保存及微信手动辅助待字段确认；真实累计观看用实际播放时间非position/假duration，云提醒自然切集可关闭，私密不落盘不上报。内容更新仍真实同步与状态反馈，旧日更拒覆盖不算成功。来源后台调查未完，provider_m3部分合集不代表全部来源。

## 七、变更记录与交付门禁

| 日期 | 变更 | 状态/边界 |
| :--- | :--- | :--- |
| 2026-10-03 | v2 审计后重写 | 原任务基线保留 |
| 2026-10-04 | A-7 明文策略改为 TLS-only | 保留集成裁定，真机播放与切线待验 |
| 2026-10-04 | 详情 API 边界校验、episodeNumber 本作 local numeric id 且禁止旧 proxy fallback；海报 API origin；搜索三态；A-10 用户手动检查内容更新；同步公开 facts 同代规则与私密发布边界 | 本次仅局部修订两份既有 SPEC，不修改代码/CI/Git/云端，不声称生产交付完成 |

**只读代码核查**：已有 `src/core/api/title-detail.ts`、`src/core/poster-urls.ts`、`src/views/catalog-status/` 与 `src/views/search-view.ts` 三态实现可供参考，不重复实现。用户已批准必要工程步骤与新 APK；后续构建、签名、交付须按门禁执行，本次文档任务未生成 APK、未部署、未进行真机验收。

**全局进度地图**：G0 本次两份相关 SPEC 对齐；G1 公开事实生产发布待验；G2 新 packs 日更闭环待验；G3 新 APK 真机起播/续传/多线路、本作集号隔离、海报、搜索三态与手动更新待验；G4 集中交付待前述证据。保留待真机/待日更项，不把已有模块或本地核查等同于生产完成。
