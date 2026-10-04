# 光影Play v2.6.2 基线修复 Implementation Plan

**Goal:** 在保留 v2.6.2 tag 的前提下，以最小分批改动修复搜索事实链与播放、浏览、追剧及提醒体验。
**Architecture:** 重客户端 + 最小云端。复用现有公开快照、SQLite FTS、播放器宿主、LIFO返回栈及同generation事实pack；先契约与事实，再同步，再宿主交互，最后集中验证。
**Tech Stack:** TypeScript/Vite、Vitest/jsdom、SQLite FTS5、ArtPlayer/hls.js、Capacitor Android、Cloudflare R2/KV/D1、Node本地打包测试。
**授权边界:** 用户已授权文档及后续本地修复执行；各批完成须分别记录验证结果。禁止自动commit/push/tag/部署、修改AGENTS.md或权限配置；不改2.6.2 tag与package版本，不创建其他计划目录。
**规格:** `D:/DEV/prism-play/docs/04-spec/SPEC-v2.6.3-REPAIR.md` R26-01～12；正本 `D:/DEV/prism-play/docs/04-spec/SPEC-v2.0.md`。

## 1. 每批固定执行纪律

- [ ] 读取本批源码与既有测试，保留用户已有变更；每次仅改本批必要文件，单文件≤300行，Tokens/Lucide红线不变。
- [ ] 先在下列既有测试路径补失败回归，用指定命令确认真实FAIL（不是语法/环境错误）；实现最小修复；复跑到PASS并登记输出。未执行保持未勾选。
- [ ] 运行本批相关测试，再做全量本地门禁；浏览器检查真实DOM/网络/媒体，不以jsdom代替。
- [ ] 原生能力交Master真机实测；结果分“单测通过/浏览器通过/真机待验/生产待验”，不能合并成已交付。
- [ ] 失败保留旧可用快照与旧generation；回退只撤销本批文件的明确patch，禁止全库reset/restore/覆盖用户工作。
- [ ] 不执行Git写操作或云端写操作；每批完成只报告diff、失败项和下一依赖。

所有命令以 `D:/DEV/prism-play` 为执行目录。以下为后续命令，不代表本轮已运行。Node `.mjs` 测试依赖支持 `node:sqlite` 的Node环境；先 `node --version`，不擅改依赖/锁文件。浏览器使用 `npm run dev -- --host 127.0.0.1`，只在本地运行；真云请求/CI周期另取授权，不触发收费AI。

## 2. 分批清单与精确路径

### B0：契约修订与计划落盘（已完成文档及静态检查）

- [x] 完整读正本、三轨SPEC、PRD、UIUX、API-SPEC。
- [x] 只读核查搜索冷启接线、seed统计、播放器宿主、榜单、历史、增量发布保护。
- [x] 创建本计划与增量SPEC；回写正本受影响AC/边界/变更记录，同步直接冲突条款。
- [x] `npm run verify:contracts`、`npm run verify:acceptance` 均退出0；后者仅检查30项署名覆盖，未运行行为测试，不转为R项完成。
- [x] `git diff --check` 退出0；本任务工具写操作仅10份文档。工作区出现其他并发业务/测试变更，未覆盖或回退，不归入本轮完成量。

### B1：首批搜索冷启完整性（R26-01，最高优先，禁止先大改UI）

**Modify:** `D:/DEV/prism-play/src/core/catalog-cache.ts` hydrate/feedIndex；`D:/DEV/prism-play/src/core/storage/index.ts` createLocalSearchApi 的 search/suggestions/fallback；必要时 `D:/DEV/prism-play/src/core/storage/search-index.ts` init/pending/revision/count校验；接线核对 `D:/DEV/prism-play/src/main.ts`。
**Test（既有）:** `D:/DEV/prism-play/tests/client/17-catalog-cache.test.ts`、`D:/DEV/prism-play/tests/client/43-search-index.test.ts`、`D:/DEV/prism-play/tests/client/44-local-search.test.ts`、`D:/DEV/prism-play/tests/client/60-main-boot.test.ts`、`D:/DEV/prism-play/tests/client/catalog-bundle-loader.test.ts`。

- [ ] 构造已持久完整快照+全新索引，断网冷启；断言hydrate发送全量items/revision，不等网络新变更才建索引；部分快照不冒充完整feed。
- [ ] 构造init尚未完成、sync排队时立即search/suggestions；断言先等待就绪，再判fallback，remote调用数为0；真实SQLite不可用允许明确降级，区分空结果与索引错误。
- [ ] 构造同revision但实际count不足、旧revision、写入中断、清缓存重建、重复hydrate；验证实际行数/公开可索引count，避免状态表假完整。
- [ ] 最小接线修复，不改词法排序算法和数据库架构；同步等待不能阻断快照首显。
- [ ] 固定“末世”查询按 `public/seed/catalog-bundle.json` 对照：本轮基线20,163、短剧5、AI3，记录实际ID，不把数量写死成永远验收阈值；后续新generation变更须注明。

Run: `npx vitest run tests/client/17-catalog-cache.test.ts tests/client/43-search-index.test.ts tests/client/44-local-search.test.ts tests/client/60-main-boot.test.ts tests/client/catalog-bundle-loader.test.ts`
Browser: 清空搜索索引但保留完整快照→断网重启→首个输入即搜；检查零误发云搜索。Android: 强停/冷启/飞行模式、保留旧索引与损坏状态复试。**停止条件:** 本地快照与搜索结果仍不一致不得进入B3。

### B2：统一云搜索/目录/详情事实 + 来源待证调查（R26-02）

**Modify候选:** `D:/DEV/prism-play/edge/src/routes/search.ts`、`D:/DEV/prism-play/edge/src/routes/titles.ts`、`D:/DEV/prism-play/edge/src/library/work-facts.ts`、`D:/DEV/prism-play/edge/scripts/library-catalog.mjs`、`D:/DEV/prism-play/edge/scripts/work-fact-packs.mjs`；页数冲突同时核查 `D:/DEV/prism-play/edge/src/core/constants.ts` 与 `D:/DEV/prism-play/edge/src/routes/catalog.ts`（仅公开60条，不改变搜索20条契约）。
**Test（既有）:** `D:/DEV/prism-play/tests/edge/60-search-lexical.test.ts`、`61-search-suggestions.test.ts`、`62-search-correction-related.test.ts`、`70-catalog.test.ts`、`76-titles-assets.test.ts`、`78-work-facts-reader.test.ts`（均在 `D:/DEV/prism-play/tests/edge/`）；`D:/DEV/prism-play/tests/edge/work-fact-packs.test.mjs`、`library-package.test.mjs`。

- [ ] 先留用户报告旧anime ID/两集截断的复测样本，不猜云端已变更；对相同查询逐项记录目录/搜索/详情同generation ID、分类、总集数与每集线路。
- [ ] 补有workFacts时旧D1候选不可见、详情缺pack不fallback、完整多集不截两集、同名异作不串集、撤片与私密不召回回归。
- [ ] 复用现有facts读取器复核搜索候选；必要的新搜索投影必须先补契约，不向客户端开放整包或pack key。
- [ ] 按增量SPEC §3待证矩阵核对旧库截图约70部与另一来源多集；后台调查未完保持待证，逐provider填可达/分类/同作/集数/合集/失败原因，缺强映射不归并。
- [ ] provider_m3合集按真实媒体语义核实；不得虚拟拆成多集、承诺固定来源数量或把局部缺失当作全网结论。

Run: `npx vitest run tests/edge/60-search-lexical.test.ts tests/edge/61-search-suggestions.test.ts tests/edge/62-search-correction-related.test.ts tests/edge/70-catalog.test.ts tests/edge/76-titles-assets.test.ts tests/edge/78-work-facts-reader.test.ts`
Run: `node --test tests/edge/work-fact-packs.test.mjs tests/edge/library-package.test.mjs`
Browser/真机: 同一作品从搜索、目录、榜单进入，对照完整集表和真实起播；需云样本时另行只读授权。**停止条件:** 来源未证不阻止已证样本修复，但不得宣称全源内容验收通过。

### B3：播放器手势、倍速、选集返回与原生沉浸（R26-03～06）

**Modify:** `D:/DEV/prism-play/src/player/gestures.ts`、`prism-player.ts`、`engine-seam.ts`、`art-engine.ts`、`hud.ts`、`episode-drawer.ts`、`player-detail.ts`、`cast-panel.ts`、`cast-ports.ts`（均在 `D:/DEV/prism-play/src/player/`）；`D:/DEV/prism-play/src/player-host.ts`；`D:/DEV/prism-play/src/core/native/back-button.ts`、`bridge.ts`、`capacitor-bridge.ts`、`orientation.ts`；`D:/DEV/prism-play/src/views/settings-view.ts`；`D:/DEV/prism-play/android/app/src/main/java/org/prismos/play/PrismNativePlugin.java`、`MainActivity.java`；样式限现有 `src/player/player.css`、`src/player/player-host.css`、`src/views/views.css` 对应绝对路径。
**Test:** `D:/DEV/prism-play/tests/client/30-gestures.test.ts`、`33-player-interaction.test.ts`、`51-player-host.test.ts`、`53-fullscreen-aspect.test.ts`、`35-cast-panel.test.ts`、`64-cast-direct-line.test.ts`、`41-settings-view.test.ts`（均在同目录）。

- [ ] 先改回归期望左亮右音，中央保留、控件排除、双击不变；桥接调用和HUD同值。
- [ ] 内核接缝增加真实rate读写后接正常八档与可设置长按倍率；补pointerup/cancel/失焦/销毁/锁定恢复及切线换集维持正常rate。
- [ ] 选集独立浮层注册返回栈；Escape/系统返回/侧滑统一最顶浮层→全屏→播放器；测试每次只消费一层。
- [ ] 宿主CSS权威保持；原生hide/show系统栏需保存进入前状态并清理所有退出路径，处理转屏竞态；不放开TLS或FLAG_SECURE边界。
- [ ] 当前集变更统一通知详情、抽屉、分享与投屏；手选/ended/通知栏/切线复试，不能捕获初始episode代替当前集。

Run: `npx vitest run tests/client/30-gestures.test.ts tests/client/33-player-interaction.test.ts tests/client/51-player-host.test.ts tests/client/53-fullscreen-aspect.test.ts tests/client/35-cast-panel.test.ts tests/client/64-cast-direct-line.test.ts tests/client/41-settings-view.test.ts`
Browser: 控件可达、倍速真实生效、抽屉滚动无穿透、连续返回三级；仅证明Web。Android: 横屏隐藏状态/导航栏、退出恢复、后台切换/连续转屏、系统亮音、当前集分享到真实电视；设备缺失标阻塞，不以mock填绿。

### B4：重复分类操作 + 每频道顶部真热榜（R26-07～08）

**Modify:** `D:/DEV/prism-play/src/views/home-view.ts`、`home-topology.ts`、`home-scroll.ts`、`rankings-rail.ts`；`D:/DEV/prism-play/src/components/channel-bar.ts`、`capsule-rail.ts`；`D:/DEV/prism-play/src/main.ts`、`src/core/catalog-cache.ts`、`src/styles/home.css`。
**Test:** `D:/DEV/prism-play/tests/client/20-channel-bar.test.ts`、`22-home-view.test.ts`、`27-home-lifecycle.test.ts`、`42-search-view.test.ts`、`66-catalog-status.test.ts`。

- [ ] 点击当前目标首次scrollTop，第二次真实同步刷新；切新目标重置序列，交错目标/离页打断；刷新中single-flight、错误状态、乱序结果丢弃。
- [ ] 当前HomeApi快照优先可能只重读内存，需接真实检查同步入口而非仅refreshTopology；不另建更新器。
- [ ] 顶部榜限定当前公开频道、可信hitsTotal排序，ID仅同分收口；无可信热度不假排，局部缓存明确范围；Overlay三榜不删。

Run: `npx vitest run tests/client/20-channel-bar.test.ts tests/client/22-home-view.test.ts tests/client/27-home-lifecycle.test.ts tests/client/42-search-view.test.ts tests/client/66-catalog-status.test.ts`
Browser/真机: 深滚首次点击回顶、第二次网络/同步状态真实变化；四频道分别榜单、空数据、断网、连点、新类切换。不要凭新增标签认为热榜完成。

### B5：追剧持久化、同类空间、二维码与真实观看计时（R26-09～11）

**Modify:** `D:/DEV/prism-play/src/core/storage/history-store.ts`、`D:/DEV/prism-play/src/core/storage/following-store.ts`、`D:/DEV/prism-play/src/core/native/platform-adapters.ts`、`D:/DEV/prism-play/src/core/storage/storage-domains.ts`、`D:/DEV/prism-play/src/core/watch-time.ts`、`D:/DEV/prism-play/src/core/runtime-services.ts`、`D:/DEV/prism-play/src/views/settings-support.ts`；`D:/DEV/prism-play/src/views/history-view.ts`、`settings-view.ts`；`D:/DEV/prism-play/src/player/episode-drawer.ts`、`prism-player.ts`、`engine-seam.ts`、`art-engine.ts`；`D:/DEV/prism-play/src/main.ts`、`src/core/user-sync.ts`、`src/views/views.css`；本轮作者资源只走host静态SupportAssets，不新增云QR/收藏sync/计时sync字段，商业价格与提醒保持既有云端契约。
**Test:** `D:/DEV/prism-play/tests/client/11-history-store.test.ts`、`15-platform-adapters.test.ts`、`40-history-view.test.ts`、`history-singleflight.test.ts`、`41-settings-view.test.ts`、`32-player-integration.test.ts`、`54-user-sync.test.ts`；`D:/DEV/prism-play/tests/edge/82-monetization-version.test.ts`、`10-redeem.test.ts`、`14-redeem-rejections.test.ts`。

- [ ] 按已同步正本§6.1复核local_following与history同库幂等DDL、created_at Unix秒、公开写闸门及提交后反馈；独立收藏不受history500条LRU/清history/清cache影响，无新增云sync。局部store已实现，关进程/覆盖安装/备份恢复及写失败仍须分别回归，不等于按钮已完整交付。
- [ ] 正在追→同类→完播保留；缓存管理放“我的”；同代公开标签推荐去重与私密拦截，测试窄屏推荐不是零高度/被撑出可用区。
- [ ] 复核已实现host静态注入旧已确认 `D:/DEV/prism-play/public/images/author-contact.jpg` / `author-reward.jpg` 的放大、文件下载、关闭/返回及微信手动辅助；不新增云QR字段。旧reward历史权益不是当前购买承诺，须同时显示免责声明；下载不等于相册保存，取消/失败不得报成功，商业价格/提醒仍有效云配置控制。
- [ ] 计时以单调时钟对实际playing且非buffering/seeking/error区间结算；pause/ended/换集/销毁只结算一次；seek到尾、未知duration、2/4倍速、后台暂停、恢复均不虚增。
- [ ] 按正本§6.1复核Preference `prism.watch_seconds_total` / `prism.watch_seconds_last_nudge` 标量读写/失败重试，无ID、无云sync；private/unknown零计，私密时长不落盘不上报；按有效云nudgePolicy自然切集提醒、关闭继续播放，缺配置关闭提醒。核销原子/幂等/撤销/设备限额/限流/Ed25519安全边界回归不降级。

Run: `npx vitest run tests/client/11-history-store.test.ts tests/client/15-platform-adapters.test.ts tests/client/40-history-view.test.ts tests/client/history-singleflight.test.ts tests/client/41-settings-view.test.ts tests/client/32-player-integration.test.ts tests/client/54-user-sync.test.ts tests/edge/82-monetization-version.test.ts tests/edge/10-redeem.test.ts tests/edge/14-redeem-rejections.test.ts`
Browser: 强制重载追剧恢复、推荐布局、二维码放大取消/保存失败、seek不虚增和自然切集可关闭。Android/微信: 强停/覆盖安装/真实相册保存/受限反馈/后台计时；真实D1核销并发仍需另验。

### B6：每日新fact pack管线（R26-12公开日更，独立批）

**Modify:** `D:/DEV/prism-play/edge/scripts/sync-incremental.mjs`、`package-and-publish-library.mjs`、`work-fact-packs.mjs`、`library-catalog.mjs`、`publish.mjs`；`D:/DEV/prism-play/.github/workflows/content-sync.yml` 仅在后续明确执行授权下修改，本轮不动。
**Test:** `D:/DEV/prism-play/tests/edge/work-fact-packs.test.mjs`、`library-package.test.mjs`、`78-work-facts-reader.test.ts`、`71-catalog-changes.test.ts`。

- [ ] 基于完整上一代公开事实合并日更，不能只把当天touched清单冒充全库；新增、改集、改线、撤片、坏页、中断及失败重试均有证据。
- [ ] 新事实pack/分片/bundle全部同代；显式revision比当前发布递增、尺寸hash/manifest全量校验，blobs验完再指针；旧拒覆盖保护保留至新发布器闭环。
- [ ] 本地测试先行，未经允许不运行带 `--publish`、`--network` 或 `--pull` 的生产命令；不更新seed造成版本事实偷换。
- [ ] 真实CI周期另行授权后核对revision推进、对象完整、客户端手动更新后目录/搜索/榜单/详情一致；KV多节点不是瞬时原子，不宣称即时全网一致。

Run: `node --test tests/edge/work-fact-packs.test.mjs tests/edge/library-package.test.mjs`
Run: `npx vitest run tests/edge/78-work-facts-reader.test.ts tests/edge/71-catalog-changes.test.ts`
状态：本地产物测试待执行；真实日更周期待授权/待验，不以旧脚本拒绝作为成功。

### B7：私密资源隔离；B8：CI secrets/备份（另批，不与B6捆绑上线）

B7源码核查路径：`D:/DEV/prism-play/edge/scripts/sync-private.mjs`、`edge/src/routes/private-sessions.ts`、`edge/src/routes/proxy.ts`、`edge/src/library/work-facts.ts` 与三轨私密契约；公开bucket/直链隔离待证。不发布private objects；保留D1私密消费者，不整体停用旧内容表。
Run（后续）: `npx vitest run tests/client/10-write-gate.test.ts tests/edge/21-private-sessions.test.ts tests/edge/50-proxy-access.test.ts tests/edge/74-catalog-private.test.ts tests/edge/80-share-page.test.ts`

B8核查路径：`D:/DEV/prism-play/.github/workflows/content-sync.yml`、`D:/DEV/prism-play/android/app/src/main/res/xml/data_extraction_rules.xml`、`D:/DEV/prism-play/android/app/src/main/res/xml/backup_rules.xml`（已核实存在，不创建其他配置）；`D:/DEV/prism-play/src/core/storage/storage-domains.ts`、`D:/DEV/prism-play/src/core/native/platform-adapters.ts`、`D:/DEV/prism-play/src/core/storage/credentials.ts`。CI只核secret名称/可用状态不打印值，任何secret/权限写入另行明确批准；公开缓存/搜索库排备份，历史偏好纳入，凭证排除，私密无文件。恢复能力用真机证明。
Run（后续）: `npm run verify:android`；`npx vitest run tests/client/10-write-gate.test.ts tests/client/13-credentials-vault.test.ts tests/client/15-platform-adapters.test.ts tests/client/56-signature-pinning.test.ts`

### B9：集中回归与交付门禁（不自动发布）

- [ ] Run: `npm test`、`node --test tests/edge/work-fact-packs.test.mjs tests/edge/library-package.test.mjs`、`npm run typecheck`、`npm run build`、`npm run scan:p0`、`npm run verify:contracts`、`npm run verify:acceptance`、`npm run verify:android`。
- [ ] 每个R项分别附浏览器证据和所需真机/电视/微信结果；记录机型/网络/样本revision，不把静态脚本当行为验收。
- [ ] 后续APK构建须保持原证书、覆盖安装及数据恢复门禁；本轮不运行cap sync/Gradle、不产APK。
- [ ] Master确认发布动作前不改version、不tag、不Git提交推送、不云上线。未验项带入交付报告，不以旧30项绿色隐藏。

## 3. 工作量与全局进度地图

估算仅供分批控制，不是完成量，不采用人类工时。B1约60～180 LOC / 4k～9k Tokens；B2约100～260 LOC / 7k～15k；B3约200～450 LOC / 12k～24k；B4约100～220 LOC / 6k～12k；B5约180～400 LOC / 10k～22k；B6约100～260 LOC / 8k～16k；B7/B8待矩阵与配置核查后评估，不伪填资源数量。均含必要测试增改粗估，实际diff另记。

| 阶段 | 关联批 | 当前状态 |
| :--- | :--- | :--- |
| G0 | B0 | 文档落盘；命令与diff审查结果见下方 |
| G1 | B2来源、B7安全、B8CI事实 | 待调查/待证，不据后台badge认定完成 |
| G2 | B1、B2事实统一、B6日更 | 首批冷启局部已修；内部generation/projection与完整日更模块已落地，新全量/配套上线/真实日更待验 |
| G3 | B3～B5 | 播放/首页/独立收藏/计时/作者资源局部实现与测试已存在，新全量及浏览器/原生均待验 |
| G4 | B9 | 未构建交付，禁止自动上线 |

## 4. 执行记录（最初文档批与当前同步分开）

当前文档同步静态检查：`npm run verify:contracts`、`npm run verify:acceptance` 均退出0，22条公网路径未增加、30/30仅署名覆盖；未运行新全量行为测试。当前局部实现/待验登记见本节末及增量SPEC§5。

### 最初文档批历史记录

- 实际执行：完整契约阅读、只读源码定位、seed统计、文档编辑；未运行业务修复测试/浏览器/真机/云端发布。
- 本轮静态检查：`npm run verify:contracts` 退出0；`npm run verify:acceptance` 退出0（30/30署名覆盖，非执行用例）；`git diff --check` 退出0（仅有LF/CRLF提示）。R26业务/浏览器/真机仍未验。
- 并发变更提示：最终status出现 `D:/DEV/prism-play/src/core/catalog-cache.ts`、`src/core/storage/index.ts`、`edge/scripts/harvest-all.mjs` 及新搜索冷启/采集测试变更；本任务未写这些文件、不撤销。B1源码定位为读取时快照，执行者需先核对并发diff与测试结果，不据文档重复覆盖。
- 当前文档同步：用户已授权计划与完整修复；following-store/watch-time/settings-support、runtime及public generation/manifest/projection/打包/日更/provider模块已完整读取，局部实现事实见增量SPEC§5。上述最初“未改业务”是历史文档批记录，不能作为当前未实现结论；新增测试存在不代表已运行，旧86文件1040/Node24项通过仅首批report，新全量仍待执行。
- B2/B6后续必须复核 `D:/DEV/prism-play/edge/src/search/generation.ts`、`edge/src/library/manifest.ts`、`edge/scripts/public-search-projection.mjs`、`edge/scripts/daily-facts.mjs`、`edge/scripts/publication-guard.mjs`。内部publicSearch无新公网路由；现代workFacts代缺/坏投影503。上线先完整同代blobs校验上传，再manifest pointer，Worker配套，禁止单独部署搜索Worker；本次不部署。
- provider_s1元数据/集数/空lines不是可播证据，身份绑定player解析模块与候选不等于真实线路健康/生产覆盖；不得猜URL或借私密补货。
- 待验：旧库截图/后台来源覆盖、云搜索旧ID与两集响应复测、新全量回归、收藏和计时读写失败/清理/恢复、真机系统栏/投屏/微信识别及下载、真实日更周期与私密bucket隔离、CI secrets可用性及备份恢复。R26未全完成，浏览器/原生/生产未验；本次仅文档，不改业务/权限/AGENTS/Git。
