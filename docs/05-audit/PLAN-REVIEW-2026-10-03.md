# 《光影Play》v2.4 二合一计划正本 · 施工前审核意见书 (PLAN-REVIEW-2026-10-03.md)

> **审核对象**：`docs/04-spec/PLAYER-FULLSCREEN-SIGNING-UPDATE-SPEC-AND-PLAN.md`（v2.4）
> **审核方式**：逐条对照仓库真实现状核验，不采信计划自述（"云端已就绪"一类断言一律回源验证）
> **审核日期**：2026-10-03
> **结论**：**方向与根因判断基本正确，但存在 6 项会击穿门禁/制造假绿的 P0 级缺陷，施工前必须修正；另有 8 项技术空洞需补设计。不建议按现版直接开工。**

---

## 零、先说做对了的部分（已回源核验，非客套）

| 计划论断 | 核验证据 | 判定 |
| :--- | :--- | :--- |
| 签名漂移根因＝CI 动态生成证书 | `android/app/build.gradle` 无 `signingConfigs`；`.github/workflows/android-build.yml` 只跑 `assembleDebug`、无 keytool；`android/.gitignore` 的 `*.keystore` 已被注释（可提交） | ✅ 成立 |
| 分享死链根因＝误用 `window.location.origin` | `src/core/share.ts:22` `const origin = deps.origin ?? window.location.origin;`；`src/main.ts:138` 调用处未传 origin | ✅ 成立 |
| `/s/:id` 修复后确实可播（非空壳承诺） | `edge/src/routes/share.ts` 存在且完整；`edge/scripts/process-harvest.mjs:259` 与 `seed-runner.mjs:239` 入库时 `shareable=1, enabled=1` | ✅ 成立 |
| 依赖齐备 | `package.json`：`@capacitor/screen-orientation` / `@capacitor/app` / `@capacitor-community/sqlite` 均在 | ✅ 成立 |
| ArtPlayer API 名称真实 | `node_modules/artplayer@5.4.0`：`types/player.d.ts:36` `set fullscreenWeb`、`:109` `autoSize(): void` | ✅ 成立（曾疑 `autoSize` 仅构造项，核后确认方法存在） |
| 测试规模口径 | `find tests -name "*.test.ts"` = 55（25 client + 30 edge） | ✅ 口径准确 |
| WP1 排在最前 | SOP Step 1 | ✅ 排程正确，签名必须先跑一次 CI 验证哈希恒定 |

---

## 一、P0 级缺陷（不修必红或必出假绿）

### P0-1 ★最严重★ 验收编号与 SPEC §9 撞号，会静默污染验收矩阵

**证据**
- `tests/verify_acceptance.py` 规则 4 明文：「测试里出现 SPEC §9 不存在的 AC 编号 → 红（防止端侧自造验收口径）」；
- 同文件 `if len(rows) != 18: FAIL` —— SPEC §9 被硬锁为 **18 条**。

**问题**
计划自造 `AC-01 … AC-12`，与 SPEC-v2.0 §9 现有编号重叠、语义完全无关：

| 编号 | 计划语义 | SPEC-v2.0 §9 真实语义 |
| :--- | :--- | :--- |
| AC-01 | 竖屏短剧全屏沉浸 | 大视界加载 |
| AC-02 | 横屏影视联动全屏 | 个人探索绝密安全机制 |
| AC-04 | 永久签名覆盖安装 | 四模海报切换 |
| AC-05 | 有效公网分享 | 日夜双模主题 |
| AC-06 | 局域网大屏投屏 | 左滑音量调节 |
| AC-11 | 海报极简微光角标 | **来电自动暂挂** |
| AC-12 | 端云状态多端同步 | **分享点开即播** |

**后果**：施工方按计划写 `it('AC-11 角标...')`，门禁会把这条用例**记作"来电自动暂挂"已覆盖**，矩阵出现**假绿**。这正撞 AGENTS.md「杜绝虚假度量」红线——比报红更坏。

**必须的修正（二选一，写进 WP8）**
1. 新建独立编号族（如 `AC-W-01…`，注意 `AC_REF` 正则 `\bAC-\d{2}\b` 不匹配该形态 → 不会误判，但也**不受门禁覆盖**，需说明）；或
2. 并入 SPEC §9 为 AC-19…AC-30，**同时**把 `verify_acceptance.py` 的 `!= 18` 断言与末尾"18/18 条"文案改为新总数，并同步 `PRD-prism-play.md` 第九章。

---

### P0-2 WP6 的云端前提不成立：`isAi` / `isHot` / `hotScore` 在代码库里**根本不存在**

**证据**
- 全仓 grep：`isAi|isHot|hotScore` **仅命中 3 个 docs**（本计划、`BUILDER-HANDOFF-RECOMMENDATION-AND-BADGES.md`、`CLOUD-SYNC-JIT-PIPELINE-SPEC.md`），**零源码命中**；
- `edge/src/types/api.ts:36` `ContentItem` 字段全集：`id / channelId / title / category / isPrivate / coverUrl / coverVersion / synopsis / episodeCount / enabled / shareable` —— 无 `isAi`、无 `isHot`、无 `hotScore`、**也不下发 `tags`**；
- `edge/migrations/0001_initial_schema.sql` 的 `content_items` 无 `is_ai` / `hot_score` 列；
- edge 全仓无任何 trending/hot 计算逻辑（grep `trending|hot|popular` 仅命中注释）。

**后果**
- A 轨（AI精品）无判定依据；计划写的「`item.isAi === true` **或 tags 包含 AI**」在广州端也拿不到——**catalog 不下发 tags**（`content_tags` 表存在于 D1，但不进响应体）；
- B 轨（全网热门）无排序依据；
- 结果：贴标逻辑对 8,874 部作品**一律落空**，角标与三轨混排退化为空壳 UI。

**必须的修正**：把「D1 加列（或加热度打标表）+ `catalog` 序列化扩展 + `openapi.yaml` Schema 扩展 + seed 回填」列为 WP6 的**硬前置交付项**，并明确责任方（云端专员 or 本包）。计划现在把它写成"云端已就绪"，是**未经核验的转述**。

---

### P0-3 合同门禁是「精确闭集」，加 `/api/user/sync` 不同步改门禁则 CI 必红

**证据**：`tests/verify_contracts.py::check_openapi` 断言
```python
assert len(paths) == len(expected_paths)   # expected_paths 现为精确 18 条
```
且 `ErrorResponse.code` 必须为 ≥9 项的受控 enum。

**后果**：只写 edge 路由 + 客户端而不动 `openapi.yaml` / `expected_paths`，Gate G0 直接失败。

**修正**：WP7 文件清单必须补
- `docs/03-contracts/openapi.yaml`（新增 `/api/user/sync` 的 GET + POST）
- `docs/03-contracts/API-SPEC.md`
- `tests/verify_contracts.py`（`expected_paths` +1；末尾"覆盖 18 API / 20 业务表"横幅同步）
- 如引入新错误码，须登记进 `ErrorResponse.code` enum。

---

### P0-4 新增两张云端表会撞「业务表 == 20」硬断言，或则完全不被校验

**证据**：`verify_contracts.py::check_sqlite_schema`
```python
assert len(business_tables) == 20
schema_path = ROOT / "edge" / "migrations" / "0001_initial_schema.sql"   # 只解析 0001
```

**两种落法都有坑**
- 写进 `0001` → 22 ≠ 20，报红；
- 只写进计划命名的 `0002_user_sync_schema.sql` → **该文件根本不进门禁**，两张新表零校验，"契约外挂"口子。

**修正**：显式决定表数口径（推荐并入 0001 → 断言改 22 + 横幅同步；或把 0002 纳入门禁解析并在计划写明）。当前计划对此**一字未提**。

---

### P0-5 计划自身违反 P0-1（emoji）与 P0-3（裸 Hex），照抄施工必挂门禁

**证据 A｜P0-1 emoji**
- §1.5 写 `【📺 投屏】`、`[🔄 重新扫描]`，AC-06 与 SOP Step 4 原样复制；
- `scan_p0.py` 的 `EMOJI_RANGES` 含 `(0x1F000, 0x1FAFF)`，📺=U+1F4FA、🔄=U+1F504 **均在区间内** → 一旦落进 `src/` 或 `tests/`，P0-1 直接判红；
- 同一份文档 §1.8 却写「严禁任何 Emoji 图标」——**自相矛盾**。

**证据 B｜P0-3 裸 Hex**
- §1.8 写 `color: var(--badge-ai, #70A5FF)`：`HEX_COLOR` 正则会命中 fallback 的 `#70A5FF` → 判红（`home.css` 不在 `HEX_ALLOWED` 白名单）；
- 底板 `rgba(8, 10, 16, 0.75)`：扫描器只查 hex、不拦 rgba，**但**违反 P0-3「100% 消费 Design Tokens」（`design-tokens.css` 是唯一允许出现字面色值的地方）。

**修正**
- 投屏图标改用项目已有的 Lucide `icon()` 内联 SVG；
- 新色值一律双写 `src/styles/design-tokens.css` + `src/styles/design-tokens.json`（`check_design_tokens` 只校验 json→css **单向**覆盖，css 侧反漏需人工保证同源）；
- WP6 的文件清单**缺失这两个 tokens 文件**。

---

### P0-6 胶囊降到 26~28px 会撞 SPEC §10「可点击目标 ≥44px」

**证据**：`docs/04-spec/SPEC-v2.0.md:202`「可点击目标 **≥44px**、相邻目标间距 ≥8px」；现状 `.capsule { min-height: var(--subnav-height /* 44px */) }` —— 44px 正是为满足该下限而设，不是"臃肿"。

**后果**：计划把可点击胶囊直降 26~28px，等于**方案层自证违反 SPEC §10**。

**修正**：视觉胶囊收到 28px，但**命中区必须仍 ≥44px**（外层 wrap 补 padding 或伪元素扩展热区），并在 AC 中把"视觉高度"与"命中高度"**分开写、分开验**。

---

## 二、P1 级缺陷（会复现旧病或联调必炸）

### P1-1 全屏「三重权威」未收口 → 极可能复现"缩在中间的小方块"

**现状三处并存（已核）**
1. `src/styles/app.css:218-224`：整链 `!important`；
2. `src/player/prism-player.ts:100`：`setFullscreen: (f) => { art.fullscreenWeb = f; art.autoSize(); }`；
3. `src/player/prism-player.ts:282` + `src/player/player-host.ts:75`：宿主类开关。

**且** `MainActivity.java` **未覆写** `onShowCustomView / onHideCustomView` → WebView Fullscreen API 走 Capacitor ChromeClient 的**原生全屏容器**，与我们 CSS 层互不感知。

**问题**：计划只说"废除 `!important`"，没说**谁是唯一全屏权威**。若不收口，三者继续争夺，"缩在中间"极可能复现——这正是旧缺陷的病理。

**修正**：二选一并写明（建议纯 CSS 宿主状态机，**不**调 `art.fullscreenWeb`），并明确 `MainActivity` 是否需要接管 `onShowCustomView`。

---

### P1-2 9:16「顶天立地充满 + 无死黑边框」在数学上不可同时成立

**算式（已核数据）**：典型短剧 1080×1920（9:16=1.78），典型手机 1080×2400（20:9=2.22）。

| 策略 | 结果 |
| :--- | :--- |
| `contain`（按宽铺满） | 高只到 1920 → **上下共留 480px 黑边，占屏 20%** |
| `cover`（按高铺满） | 宽扩到 1350 → **左右各裁 135px，裁掉 13.5% 画面**（字幕/两侧构图丢失） |

计划写「`object-fit: contain` 或 `cover`」+ AC-01「100% 顶天立地充满，无多余死黑边框」——**自相矛盾**，且现状 `.prism-player-host--fullscreen video { object-fit: contain !important }` 正是黑边来源。

**修正**：显式定策并量化 AC。例：短剧走 `cover`（接受裁切，需对用户可感知）；或 `contain` 且 AC 改为"无横向死黑、上下黑边 ≤ X%"。

---

### P1-3 3.5:3.5:3 与现有分页/增量游标未对账

**证据**：`src/views/home-view.ts` 存在 `page`、`pageRevision`、`loadCatalog(++token, 1)`、"加载更多"。

**问题**
- 混排按"当前页"重排 → 破坏**稳定序**：翻页/加载更多时同一条目可能换轨、或跨页重复；
- `revision` 增量同步的前提就是稳定序，混排直接推翻该前提；
- `slice(0, targetCount * 0.35)` **无余数策略**：24 条 → `floor` 得 8+8+7=**23 条，凭空少 1 条**。

**修正**：明确混排作用域（建议"仅展示层重排，不改游标与 revision 语义"）+ 锁定"先按 id 稳定排序再插值" + 写死余数补齐规则（余数给哪一轨）。

---

### P1-4 C 轨"冷门高分"在数据模型里没有可依据字段

**证据**：`content_items` 无 rating/popularity 列，catalog 也不下发 → "高分"无来源。

**修正**：C 轨改为纯端侧可导出定义（如「本地得分最低的 K 个题材 ∩ 非私密 ∩ enabled」），并把"高分"字样从规格摘除，否则又是空壳。

---

### P1-5 `{推荐}` 用 `var(--fg)` / `{热门}` 用 `var(--accent)` 是**主题相关** token，浅色模式失效

**证据**：`design-tokens.css` 浅色主题 `--fg: #131720`（近黑）、`--accent: #B87B14`；而角标底板恒为深色 `rgba(8,10,16,0.75)`：
- 近黑字压深底 → **不可读**；
- `#B87B14` 对深底约 **3.7:1**，低于 10.5px 小字所需的 4.5:1（实测换算）。

**项目已有正确先例**：`--player-accent: #E5A93C` 在**深浅两模取值相同**——正是"深底不变"场景的标准做法。

**修正**：三个角标色必须定义为**双模同值**的 theme-invariant token。

**附带**：`10.5px` / `16px` / `18px` 均**不在**字号阶梯（10/12/13/15/17/20/24/32）上，需落 token 或改用阶梯值（如 10px=`--text-2xs`）。

---

### P1-6 端云同步的三处工程尾巴没写

1. **挂起时发请求不可靠**：`appStateChange(isActive=false)` 后 WebView 随时被冻结/回收，普通 `fetch` 可能根本发不出去 → 需 `keepalive: true` 或「先落盘 + 下次启动补传」的待发队列。计划只写了"触发一次静默上报"。
2. **字段命名三套不齐**：本地 `content_id / last_episode_number / position_seconds / updated_at`（`storage-domains.ts:33`）→ D1 `content_id / episode_number / …` → 载荷 `contentId / episodeNumber / …`。**需一张显式映射表**，否则首次联调必错。
3. **身份是 `coupon_code` 而非用户**：换卡即丢历史；同卡 10 台设备共享一份画像，多人共用会互相污染。要么写入限制，要么改按「卡 + 设备」双键。

---

### P1-7 DLNA 在当前安全配置下跑不起来（三个硬前置）

**证据**
- `android/app/src/main/res/xml/network_security_config.xml`：`base-config cleartextTrafficPermitted="false"`，且对 `play.prismos.org` 也显式 false；
- `AndroidManifest.xml`：`android:usesCleartextTraffic="false"`；
- DLNA 的 SSDP `Location` 抓取与 AVTransport SOAP 控制是 **`http://192.168.x.x:…` 明文** → 平台策略拦截。

**另外两个前置**
- 需 `android.permission.CHANGE_WIFI_MULTICAST_STATE` + `WifiManager.MulticastLock` 才能稳定收组播响应（**现清单里没有**）；
- Android 的 `<domain>` **不支持 CIDR**，技术上做不到"放行整个局域网网段"。

**好消息（已核）**
- SSDP 走原生 UDP 裸 socket，**不受** cleartext 策略约束；
- 插件按 `PrismNativePlugin` 的**同模块** `registerPlugin` 模式加即可，**不需要**改 `capacitor.settings.gradle`；
- 但 `verify_android_assets.py` 门禁第 6 条要求 **Java 注解里的插件名与 TS 常量逐字一致**，第 7 条要求清单声明 Java 会启动的组件。

**修正**：WP4 必须补 manifest 权限 + 明文策略方案（建议：控制命令走 native socket，视频流仍走公网 HTTPS 代理，避开明文限制），否则 AC-06 不可达。

---

### P1-8 L2 热更新（机制五）"有规格、零工作包"

**证据**：WP1–WP8 无一条涉及 `dist.zip` 下发/校验/切换；`package.json` 无任何 live-update 插件。

**且缺失关键约束**：引入原生插件后，L2 与 L3 必须建立**版本锁**（web bundle 声明的 native 依赖 vs 实际宿主），否则热更一旦下发使用了 `PrismCastPlugin` 的 bundle，落到旧宿主即白屏。

**修正**：要么显式标记 Backlog（本期不做），要么补 WP 并写清 native/web 版本协商。**不能既不实现也不声明。**

---

## 三、P2 级（治理与准确性）

1. 收尾段落仍写"五大核心议题"，与 v2.4 的**八大机制**不符（陈旧文案）。
2. 编制日期停在 2026-10-02，已跨至 10-03；建议补「修订：v2.4（2026-10-03）」。
3. **WP4 的 220 行明显偏乐观**：SSDP 发现 + XML 解析 + SOAP 控制 + 半屏面板 + 状态机，同类开源实现仅发现层就不止此数。建议标注"首个可信估算，联调后回填"。
4. WP7 私密红线建议**直接复用**既有 `assertWritable`（`src/core/storage/storage-domains.ts:71`），而不是新造口号——避免同一规则两处各写一套。
5. 「邀请裂变码 `&ref=`」在边缘是**display-only 归因**（`edge/src/routes/share.ts:154` 注释自陈「URL 参数无法跨越 APK 安装」），计划不应表述为真正的裂变闭环。

---

## 四、修正后的施工前置清单（建议按此顺序解锁）

| # | 前置动作 | 解锁的 WP | 风险等级 |
| :--- | :--- | :--- | :--- |
| 1 | 定验收编号族（新建族 或 并入 SPEC §9 并改门禁断言） | WP8 / 全部 | **P0** |
| 2 | 明确 `isAi/hotScore` 数据来源责任方与字段契约定案 | WP6 | **P0** |
| 3 | 定 `openapi.yaml` / `expected_paths` / 业务表数 三处门禁口径 | WP7 | **P0** |
| 4 | 清除计划内 emoji 与裸 Hex，补齐 tokens 双写文件清单 | WP5 / WP6 | **P0** |
| 5 | 胶囊"视觉 28px / 命中 ≥44px"双高度口径落盘 | WP5 | **P0** |
| 6 | 定全屏唯一权威（CSS 状态机 vs ArtPlayer Web Fullscreen） | WP2 | P1 |
| 7 | 定 9:16 策略（contain 黑边 vs cover 裁切）+ 量化 AC | WP2 | P1 |
| 8 | 定混排作用域 / 稳定序 / 余数规则 | WP6 | P1 |
| 9 | 定 DLNA 明文策略与本地组播权限方案 | WP4 | P1 |
| 10 | 声明 L2 热更新为 Backlog 或补 WP + 版本协商 | 机制五 | P1 |

---

## 五、审核结论

- **可以保留的部分**：八大机制的**问题定位**与根因判断，绝大多数经回源核验成立；WP1 排程顺序正确。
- **不能照抄的部分**：验收编号体系、WP6 云端前提、门禁同步项、以及计划自身违反 P0 的 emoji/裸 Hex 与 §10 的 44px。
- **建议**：先完成上表 1–5 五条 P0 修正（预计文档改动约 60–90 行，不涉及业务代码），再评审一遍即可开工。其余 P1 可在开工当日作为"设计决策"一并落盘，不必阻塞。

> 本意见书基于**当次仓库快照**核验。若期间 `edge/` 或 `tests/` 有更新，第 1–4 条需重新校验。
