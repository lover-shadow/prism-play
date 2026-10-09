# 系列缺季、原生海报遮挡与使用通告：最小修复计划＋SPEC

**Goal:** 保留2.6.6已有起播提速，修复已证明的系列归组/原生全屏遮挡问题，按需补系列卡片，并提供清楚的内容与反馈通告。

**Architecture:** 复用当前本地公开库、共享搜索卡片、季选择器和云端消息渠道。先本地归组和播放，系列补充后台进行；不重抓全库、不为缺季逐集取流。原生画面与网页海报底片分开处理。

**Tech Stack:** TypeScript、Capacitor 7、SQLite FTS5、ArtPlayer/hls.js、Android ExoPlayer/Media3、Cloudflare Worker/D1/KV/R2、Vitest。

日期：2026-10-09，r2。状态：用户已授权本地实施、审核修补，并追加授权本批生产云端/官网APK下载/启动公告更新，已发布及线上核验；不授权Git写操作、D1重置或CI更改。本地实现、模拟测试、浏览器与线上验证独立记录；Android真机完整验收仍待进行，不要求子代理。

## 1. 背景、基线与范围

生产：APK 2.6.6/21606，Worker `d8d63d31-9336-40a7-bc25-a5a36759d259`，已完成同域下载与可选提醒。生产收据 `outputs/deploy266-live-receipt.json`。当前工作树包含未提交既有成果，不覆盖/撤销其他工作；实施前重核版本与相关文件。

用户真机反馈：播放明显更快；启动发现流after=105在8秒超时；多个系列缺首季或中间季；持械入宋搜索多季但没有季选择，且视频被海报遮挡。产品仍处于完善阶段，需要说明网络聚合内容可能带源内广告，并邀请反馈。

本批仅做：两段通告、标题归一化、重复季号归组、原生海报层修正、按系列后台补卡、发现同步的针对性取证和轻量减负。不得借机扩建系列管理平台、公告中心、Admin UI、跨源影视身份系统、媒体广告检测引擎、强制升级或全库采集。

底线不变：有效高级授权＋当次开启的私密双重准入，公开补卡不接触私密；不泄露上游品牌、不伪造缺季/播放地址、不删除不同版本媒体，不影响授权/历史/设置/签名。通告不替代BUG修复，不声称源内广告已经全部剔除。

## 2. 根因证据与诚实边界

| 症状 | 已证明事实 | 源码/数据锚点 |
| --- | --- | --- |
| 糯糯下山首季可搜但不归组 | season解析NFKC把中文逗号转英文，首季却用原始标题精确比较；真实seed复现2～4成组、无编号首季单独 | `edge/src/search/providers/seasons.ts:4`、`src/core/series.ts:18` |
| 持械入宋没有季选择 | 当前共享卡片有“持械入宋：第三季/持械入宋第三季”和两种第四季；重复季号使整组放弃归并，真实卡片复现 | `src/core/series.ts:24` |
| 多部剧缺季 | seed21963条revision4中别逼我修炼仅7，万妖缺2/11/12，凡人缺6；上游存在这些季或共享卡片已存在。播放器候选只来自本机缓存 | `src/main.ts:130`、`src/player-host.ts:199`、`public/seed/catalog-bundle.json` |
| 海报挡原生视频 | 原生TextureView在WebView下；全屏样式覆盖原生hide，实际CSS计算原生inline hidden→fullscreen visible/opacity1 | `PrismPlayerSurface.java:30`、`src/player/player.css:27`、`player-host.css:53` |
| 发现超时 | 真机02:43:46.144发起，02:43:54.158报错，8.014秒匹配普通GET预算；D1/R2当前读取逐条重复核验 | `src/core/api/retry-fetch.ts:45`、`edge/src/search/discovery-store.ts:172`、`routes/search-discovery.ts:104` |

不是所有上游都包含所有季；缺季不能靠填1～N虚构解决。发现超时的网络/D1/R2墙钟占比尚无profile，不宣布Cloudflare被阻断。用户海报遮挡发生时是否全屏未知：全屏CSS冲突已证；非全屏的同一次现场原因尚未证明。

GitNexus当前没有prism-play索引，不能使用prism_local或其他项目的图证明本仓库问题；本批以工作树/seed/当前云端只读事实为准。

## 3. 使用通告SPEC

### 3.1 合并一条消息，正文两段

标题：**内容来源与反馈说明**

正文：

> 本程序的内容来自网络搜索聚合。部分来源的视频可能带有广告，我们正在逐步完善识别与剔除；目前无法保证所有内容均无广告。
>
> 程序目前仍处于完善阶段。如遇到 BUG 或有改进建议，欢迎通过【我的 → 作者支持 → 联系作者】反馈，帮助我们持续完善。反馈时可附上剧名、操作步骤、截图或运行诊断报告；请勿提供卡密、授权令牌等敏感信息。

两段放入同一message，因为当前客户端只展示result.announcements[0]；不新增两层连环弹窗，也不为两段文案开发消息队列。禁止外部来源品牌和“全部去广告”等绝对承诺。

### 3.2 显示和联系入口

复用KV config:announcements现有结构，稳定id `content-feedback-notice`、条目revision1；整篇普通文本，不加外部动作链接。前台首页呈现后拉取；播放中等待退出，已确认按id+revision不再自动弹。消息改变正文时提升revision；缺配置/断网不能挡APP使用，不保证旧版/未联网设备收到。

实施时先读取现有公告，保留仍有效条目，不清空现有消息。该通告放在当前客户端取到的有效消息首位：采用实际发布startsAt并按服务器倒序排序验收，不填未来时间或同时间不稳定排序。运维更改KV需独立发布授权，文档编写不等于授权发布。

设置页作者支持区域补同一两段纯文本说明，便于用户关闭消息后随时重看；复用已有联系二维码按钮、保存二维码/打开微信能力，不猜联系方式、不自动跳微信、不增加外部链接或新消息类型。云端通告是当前客户端通道，常驻说明需安装新版。

文件：`src/views/settings-support.ts`、已有 `tests/client/support-actions.test.ts`、`client-bulletins.test.ts`、`minimal-bulletins.test.ts`。不必修改消息DTO或新建页面。

AC-R01：云端单条消息完整包含两段；标题未被SVG替换，关闭不循环弹；断网/播放时不打断使用。
AC-R02：我的作者支持常驻说明可读，联系作者入口真实存在且仍用既有二维码；文案无上游品牌、敏感信息或已完成去广告的虚假承诺。

## 4. 系列归组最小SPEC

### 4.1 同一规则匹配标题

提取用于匹配的规范key：标题NFKC、统一空白、尾部分隔标点处理与现有season.base一致。编号标题/无编号基础标题采用同一规范key；显示仍保留原title，不改云端作品名、不丢语义字符。

编号识别继续使用现有1～200季/部/阶段闭集，不把“之/篇/外传”一律当同剧，不把季和部强行并组。channelId不同不合并。

无编号作品规范key等于系列base时可以入第一季候选；与显式第一季同时存在时保留两个真实workId，不认定必然同一媒体；多个基础记录也不能因此抛掉其他季。单作品没有其他季仍不造选择器。

### 4.2 重复季号不拆整组

按workId去重，不按title/季号删除。排序按季号，其次原title、workId稳定排序；同季不同ID均可选。为了区分同标题版本，仅重复季号项增加“版本1/版本2”中性提示，不使用抽象provider以外的上游品牌，不把集数差异当身份证明。

`SeriesGroup`可最小增加可选展示标签映射，`views/series-card.ts`与`player/season-switcher.ts`共用；若现有原标题足以区别，只显示原标题，标签只为实际歧义生成。不创建全局系列ID库或信任映射。

文件：`src/core/series.ts`、`src/player/season-switcher.ts`、`src/views/series-card.ts`、`tests/client/season-switcher.test.ts`、`tests/client/series-card.test.ts`。季切换继续使用现有retainStage/open代次，保留全屏/退出/续播机制。

AC-R03：糯糯下山中文逗号的无编号首季与第二～第四季归组，原名称不变。
AC-R04：持械入宋重复第三/第四季记录不拆散整组、不删记录，任一ID仍可选；私密/未知频道与不同季部单位不误并。

## 5. 缺季按需补卡，不等网络才起播

播放器详情已可用时先建本地季选择、播放当前集；系列补充是后台操作，不await到player.load之前。打开编号系列提取base；无编号剧亦可用其标题查询，但仅保留规范base一致的真实基础/编号卡片，过滤其他模糊命中。

复用 `/api/search` 与现有本机公开mergeDiscoveries及局部searchIndex同步，不新增接口/表，不逐季取媒体，不强制触发全库发现日志。后台每个series key同进程single-flight，成功结果供后续使用；失败保留本地列表，退出/切剧结果不改旧详情。

最小预算：每次打开最多2个搜索结果页、每页20卡片，顺序请求，既有35秒单次搜索预算不变。上限到达/来源超时只表示未完整核验，不能写“全季齐全”。目录中真实缺号可以暂缺；用户仍可在正常搜索中继续补充，不猜N季URL。

补卡后通过当前public cache合并读面重建当前季选择器；更新详情/抽屉中的既有season host，不累积重复节点；不得销毁当前播放或改当前episodeId。host opening代次/loaded workId需仍匹配。只添加元数据并局部索引，不清FTS库。

建议必要新增小模块 `src/core/series-discovery.ts` 集中负责base过滤、single-flight和有界补卡；在 `main.ts` 将同一merge/index逻辑接给搜索及该模块，避免第二套持久库。`player/host-contract.ts`仅增加可选补充回调接缝，`player-host.ts`在ready后调用并按代次更新；mock无此能力按本地流程，不造数据。

云端共享search卡片存在不等于可见/可播，必须继续通过正常search响应；不直接读取或回传未经权威校验的discovery_cards JSON。

AC-R05：本地仅第七季仍可立即播放，后台找到真实第一～第六季后列表更新；网络挂起不阻塞起播，返回/切剧不复活旧列表。
AC-R06：万妖2/11/12、凡人6通过真实公开搜索成功后进入本地季候选；失败明确只保留已知项，不虚构内容，不全库同步/逐集取流。

## 6. 原生海报遮挡最小SPEC

只修已证CSS优先级：原生active条件下backdrop在非全屏、全屏、播放/暂停/缓冲均hidden；保留ArtPlayer网页内核全屏模糊底片。不要全局删除海报，不改TextureView原生层次，不用一串!important扩大修复。

文件：`src/player/player-host.css`、`tests/client/53-fullscreen-aspect.test.ts`或专门 `tests/client/native-backdrop.test.ts`。测试必须按生产CSS加载顺序计算visibility/opacity，不只扫描字符串。

AC-R07：原生全屏海报不盖视频；网页全屏底片仍可作留白背景；换剧/退出透明class与原生资源按原机制清理。

真机复测持械入宋：非全屏→全屏→暂停→恢复→选集→换季→退出；记录屏幕是否是模糊底片/锐利海报/首页片单。若非全屏也遮挡且本修正未消除，先取DOM/原生bounds现场证据，再按实际根因最小修复，不提前把所有z-index重写。此现场差异不阻止已证CSS与归组修复。

## 7. 发现超时：先核验再针对性调整

客户端8秒budget已经有效，不能把8秒超时称云端宕机。after105页当前含10条真实变更，权威/卡片路径仍串行多次读。诊断不用搜索GET作为只读探针，因为搜索可能写共享发现；D1用SELECT、R2/KV用GET，并标明业务接口中的过期维护写入。

首选最小减负：`readDiscoveryChanges`同页同identity只核验一次，key必须包含workId/providerId/sourceId；`handleSearchDiscoveries`继续同页卡片复用，维持10条页上限/最新可见性/withdraw语义，不删准入校验、不加陈旧响应缓存。

在真实after105以及空页/含撤回页取有限顺序样本，记录状态/首包/总耗时，区分冷暖，不能从2次样本承诺固定提速。若减少重复读取后仍可正常200但常超过8秒，将**仅discovery GET**预算从8秒调整到15秒，与后台非阻塞/播放让路/游标重放同时验收；不改所有API预算、不无限重试。是否调到15秒必须用样本支持并在执行记录写明，不把延长等待当提速。

顺带验证搜索 `fillSeasons`：当前8请求/15秒scope与最多32次补缺查询存在不匹配，若补缺失败导致已搜到卡片全丢，最小改成保留已成功卡片并如实pending/failed；不能无条件增加请求池或把部分当完整。仅先写可控预算耗尽测试，证实后才改相应函数。

文件：`edge/src/search/discovery-store.ts`、`edge/src/routes/search-discovery.ts`、`edge/src/search/providers/seasons.ts`（条件修复）、`src/core/api/retry-fetch.ts`（条件单端点预算）、已有99/104/100-discovery与api-budget测试。

AC-R08：重复身份不重复重读，私密/撤回/过期仍安全；超时不推进cursor，旧目录可用；搜索预算耗尽保留已成功卡片，不能报告全季齐全。未证实搜索失败环节保持待取证，不代替已证根因。

## 8. 执行顺序与测试门禁

每包按失败测试→红灯→最小实现→定向绿灯→相关回归；先通告文案/归组/CSS，随后后台补卡，最后有证据地收尾超时。不等待完善所有错误处理平台才出包。

1. Task A：§3通告；复核现有消息与联系入口，在本地settings加入说明，云端发布步骤只写到收据不立即执行。
2. Task B：§4真实标题夹具验证标点/重复季，修改groupSeries/共享展示；季切换竞态回归。
3. Task C：§6生产CSS计算回归，修原生隐藏。
4. Task D：§5单页/两页/挂起/私密/切剧/失败补卡与既有缓存索引集成。
5. Task E：§7预算测试及有限样本，按证据选最小修正。
6. Task F：契约与界面规则同步、全量测试、浏览器、APK构建、Master真机。云端消息/Worker/APK发布再次授权；旧部署/指针保留。

定向命令（新文件只在确有职责时创建）：

```bash
npx vitest run tests/client/season-switcher.test.ts tests/client/series-card.test.ts
npx vitest run tests/client/minimal-bulletins.test.ts tests/client/support-actions.test.ts
npx vitest run tests/client/discovery-recovery.test.ts tests/client/discovery-sync.test.ts
npx vitest run tests/edge/99-discovery-store.test.ts tests/edge/104-search-discovery-route.test.ts
```

新增native-backdrop/series-discovery测试进入全量；成功必须0失败/0未处理rejection，不是文件存在即可。

```bash
npx tsc --noEmit
npm run typecheck
npm test
npm run build
npm run scan:p0
npm run verify:contracts
npm run verify:acceptance
npm run cap:sync
npm run verify:android
```

浏览器起Vite实际端口，真实DOM/CSS测试区别网页与原生替身；不能当作Android视频层真机证明。使用既有JDK21/sdk/gradle-cache构建，签名保持；最终正式Code必须大于生产21606，先核验实际版本，再确定下一Code，不同号换包。打包不包含开发注入/测试媒体/诊断凭据。

受影响契约：主SPEC变更记录、API-SPEC的discovery预算（若调整）、UIUX通告/系列标签、当前端云r2计划的承接说明；不改抽象agents.md或既有migration。无新接口/表时不膨胀OpenAPI。

## 9. 发布与恢复（待授权）

发布通告可独立于修复APK，当前2.6.6已具备消息读取；但先保存现有消息、合并通告、保证有效首位，再写入并读回，不能覆盖其他活跃公告。旧2.6.5无该机制，不承诺主动触达。

修复APK真机验收后按现有 `publish-client-release.mjs preflight`核版本/签名/seed/hash，上传不可变key并回下核验；如有云端代码变更先留旧Worker/旧KV快照，部署后检查正常搜索/发现/私密拒绝，最后提升版本公告force=false。同域下载字节与最终APK一致。

问题只在客户端时不重复部署Worker。云端配置传播不保证即时；记录部署ID、Code、hash和有限样本，不称永久稳定。出错恢复旧Worker和对应KV/通告，保留包对象；已安装APK不降Code，以更高Code修复，不回滚客户历史或重置D1。

## 10. 进度与工作量初估

LOC为实现＋测试新增/调整量，不含打包产物；Token为估算非计费，不采用人类工时。

| 工作包 | 状态 | LOC初估 | Token初估 |
| --- | --- | --- | --- |
| 通告＋常驻反馈说明 | 本地与浏览器通过；云端通告已发布并读回 | 30～70 | 3k～6k |
| 标点/重复季归组 | 本地测试与浏览器通过 | 80～140 | 8k～14k |
| 原生海报CSS/回归 | 样式测试与浏览器替身通过；真机待测 | 20～50 | 3k～5k |
| 后台按系列补卡/接线 | 本地恢复与宿主集成测试通过 | 160～280 | 18k～28k |
| 同步/搜索预算针对性收尾 | 重复校验复用/部分失败状态已实现；发现GET维持8秒 | 60～120 | 8k～14k |
| 契约/集成/构建验证 | 自动门禁通过；重出包收据见执行记录 | 70～120 | 8k～12k |
| 合计 | 估算不是计费或实际diff；不代表真机/生产完成 | 420～780 | 48k～79k |

- [x] 只读诊断和自包含最小计划文档。
- [x] 本地通告排版与作者反馈常驻说明；生产两段合一启动消息已发布。
- [x] 标点一致/重复季归组及真实夹具回归，基础首季与显式首季并存。
- [x] 原生全屏海报隐藏与网页底片样式回归；不代表Android实测。
- [x] 不阻塞播放的系列补卡、部分失败恢复与当前季选择刷新模拟测试。
- [x] 搜索预算耗尽保留卡片并报告失败；发现GET仍8秒，15秒调整待新证据。
- [x] 最终本地重出APK、全量门禁与收据归档（不含生产发布/真机）。
- [ ] Master真机遮挡场景/缺季/播放验收。
- [x] 用户追加生产发布授权；Worker/启动公告/官网APK下载已发布并有限线上验证。

自完善：每任务完成立即更新此看板和AC-R证据，区分实现/模拟/浏览器/真机/线上。实现假设失效先修本文，不临时扩成新系统、不把未测项勾完。共享数据随其他用户搜索变化，复查当前事实再判断；首季同名和重复季号都不授权删除媒体版本。

## 11. 2026-10-09 审核修补执行记录

用户随机测试是共性规则的样本，不是修复白名单。实现不按剧名、workId或缺季号做特判；未收录内容不虚构。

- AC-R01/02：两段正文完整显示、标题保留、联系入口沿用既有二维码；minimal-bulletins/support-actions回归。浏览器实际打开通告得到2段，确认按钮关闭成功。生产KV尚未写入，不能称云端已触达。
- AC-R03/04：NFKC/尾标点归一、重复编号保留、同名版本标签、无编号与显式首季并存；series/season-switcher测试。浏览器通用故事夹具显示4个候选（两项版本标签），选择第二季确实回调对应ID。季/部有歧义时基础记录仍不跨组。
- AC-R05/06：series-discovery测试覆盖pending/failed再次打开可重试、第二页失败保住第一页、落盘失败不污染缓存、2页上限、私密及跨频道过滤；成功落盘后才缓存，未完成或截断结果不作成功缓存。season-switcher宿主测试确认网络挂起时当前播放已启动；更新两处选择器不重载内核、不换episode，重复回调不累积节点，关闭/切剧后旧结果不更新详情。
- AC-R07：native-backdrop生产CSS顺序计算及浏览器实际样式：native=hidden、web=visible。仅为Web DOM替身，Android TextureView非全屏/全屏/暂停/换季场景仍待Master实测。
- AC-R08：fillSeasons遇补缺失败立即以内部IncompleteDiscoverySearch携带已成功卡片退出；S1Provider保留该状态，两种DiscoveryService继续校验并处理卡片，failed=true且不写成功query缓存。可控maxRequests=1失败测试先红后绿；没有扩大请求预算或媒体采集。发现GET恢复8秒：此前只有一次约5秒线上样本，不足以证明优化后常超过8秒，且本地Worker尚未部署，不把延长等待称提速。
- 浏览器地址：http://127.0.0.1:5178；通过真实组件导入及DOM操作验证，不增加生产测试入口。控制台仅见本地未启动Edge API的4条404，不作为线上验证或零网络错误承诺。
- 初次审核前APK（21607）保留，不将旧SHA冒作修补后新包；修补后构建使用同Code（尚未发布），独立文件名与新SHA。最终收据待下方补录。
- 最终全量Vitest：169文件、1808测试通过；新增测试由1798提升至1808，失败回归先验证红灯，再验证绿灯。前端build/tsc、Edge typecheck、P0、verify:contracts/acceptance/android均通过，Gradle assembleDebug成功。未运行覆盖率统计，不将用例通过率冒作80%覆盖率。
- 修补后APK：`build/apk267/prism-play-v2.6.7-series-playback-review-fixed-20261009.apk`；21607/2.6.7；36,382,007字节；SHA-256 `2d2363b2a1739c6238d89a6c888a82c84a09e373d8038a50abebb651cef9bba8`。preflight核验真实包名/Code、固定签名、公开seed及文件hash通过；候选版本描述更新于`build/version-267.json`，不是生产指针，timestamp为本地preflight时间不是发布完成时间。
- 上述本地修补阶段没有Git写操作、Worker/R2/KV部署或生产搜索采集。后续授权发布记录如下，不能把本地验证冒作真机验证。

## 12. 2026-10-09 生产发布收据

用户追加指令“更新云端和web下载”授权本批Worker、APK下载及两段合一启动确认公告。2026-10-09 01:55～01:57 UTC（北京时间09:55～09:57）已发布并核验：

- Worker：`be761fca-310f-4d21-8bc6-3ffe31ed1185`；保留既有secrets/vars、路由与cron，未改D1/CI/Git。旧Worker `d8d63d31-9336-40a7-bc25-a5a36759d259`及版本/公告/部署快照保存于`outputs/deploy267-old-*`，baseline记录旧绑定名与普通变量，未记录密钥值。
- 新APK：21607/2.6.7，36,382,007字节，SHA-256 `2d2363b2a1739c6238d89a6c888a82c84a09e373d8038a50abebb651cef9bba8`；不可变R2对象key与本地预检一致。认证临时上传后回下核验，再切config:version；force=false。临时上传进程与随机认证文件已清理，不留下生产上传端点。
- 公告：文档revision2，`content-feedback-notice`条目revision1；正文两段，按实际startsAt成为有效消息首位，原`release-21606-minimal`保留。21606/21607公开查询均完整返回两段；确认已读机制由客户端执行，尚未获得Android现场截图，不承诺每次启动重复弹窗。
- 官网实际浏览器显示v2.6.7、约34.7MB，三个APK按钮均指向既有同域latest入口。latest302指向21607不可变对象，GET200完整下载哈希一致，HEAD200长度一致。线上version/channels/catalog200、未知详情与分享404、Admin无会话401、私密目录未准入404。
- after105有限顺序样本：200/3189ms、200/4316ms；空页200/358ms。不区分为严格冷/暖实验，不承诺固定延迟；发现GET端侧仍8秒。正常搜索有限验证：200、10项、discoveryPending=false/discoveryFailed=false，8770ms；搜索请求可能写共享发现，这是本次授权发布后的业务验证，不称只读取证。
- 主收据：`outputs/deploy267-live-receipt.json`；R2收据：`outputs/deploy267-upload-receipt.json`；补充边界：`outputs/deploy267-extra-checks.json`；恢复指针及公告可用`node outputs/deploy267-release.mjs restore-kv`，Worker恢复须指向上述旧version，生产恢复操作仍需匹配用户授权。
- 注意：官网既有“全链路纯净零广告”等宣传与源内广告说明不一致，属本轮浏览器发现的历史文案遗留，当前未借下载更新扩大为官网内容改版。Android真机遮挡/缺季完整验收仍待Master复测。
