# 端侧点播韧性加固实施与验收记录

日期：2026-10-08。范围：端侧代码、测试、本地验收APK；不自动替换官网已验收的v2.6.5，不提交Git，不改云端套餐。

## 基线与诚实边界

官网v2.6.5为Master已验收的原包，SHA-256为 `7729c377fd6903e21d12b1955b38ba4f41af5b48ca13fa0c7f7f88dfc4d0a8b6`。
云端此前部署过CPU优化，有限请求返回200不等于永久消除1102；搜索当时需14～20秒，2026-10-08 复测为6～25秒波动，因此不能给所有API统一设置8秒超时。
`Failed to fetch`不能区分CORS、TLS、平台错误和真实断网；`navigator.onLine`也不能证明服务可达。HTTP/2连带重置、VPN导致故障等仍无直接证据，不能作为已锁定原因。
原计划的“1秒内起播”“首秒所有网络完整让渡”“彻底无死锁”等绝对承诺取消，以可复现的状态与请求行为验收。

## 已实现机制

- [x] 播放GET读取有界重试：详情、播放清单、旧播放取址、原生播放身份复核；只重试传输TypeError或自身超时，最多3次请求，退避250/600ms。
- [x] 每次请求8秒超时，覆盖fetch与响应体读取；三次全部超时的总等待上限约24.85秒（不含浏览器计时调度延迟），非8秒总预算。
- [x] 不重试HTTP业务响应或JSON解析错误，不自动重试核销POST、私密会话POST/DELETE；慢搜索不套播放超时。
- [x] 打开详情时传递AbortSignal，退出、重新打开或切剧中止旧详情请求与退避；取消不记作网络失败，不再自动重试。
- [x] 在线或在线状态未知的传输失败显示“连接暂不可用 / 请求超时或服务暂不可达，请重试”；明确离线才显示“需要网络”。私密/未知/授权拒绝保留同构missing。
- [x] 已知SERVICE_UNAVAILABLE在宿主显示连接错误，而不是内容不存在；无可用媒体线路仍保留原retryable语义。
- [x] 冷启目录bootstrap之后延后2秒拉取发现同步；播放器打开时每2秒继续让路，销毁取消未执行定时器。搜索补充成功触发的同步保持即时，已有同步不强制取消。

请求重试不保证弱网必然恢复，不绕过私密准入；内核及清单的现有代次守卫保持，详情之外的在途媒体请求取消不是本次新增范围。

## 文件与验证

实现入口：
- `src/core/api/retry-fetch.ts`：超时、退避及取消。
- `src/core/api/client.ts`：按路径选择播放读取策略；title可接收signal。
- `src/player-host.ts`、`src/player/player-contract.ts`：详情请求取消接线。
- `src/player/host-layer.ts`、`src/player/hud.ts`、`src/player/prism-player.ts`：错误态分流。
- `src/core/discovery-start.ts`、`src/main.ts`：冷启同步让路与销毁清理。

测试新增：`api-retry-resilience.test.ts`、`host-error-mapping.test.ts`、`discovery-start-deferral.test.ts`；既有宿主及离线测试同步更新并保留真实离线断言。

- [x] 红灯→绿灯：新transport模块缺失；在线错误误报offline；延时模块缺失均先复现失败，再实现。
- [x] 全量Vitest：154文件 / 1746测试通过，日志 `outputs/client-resilience-full-tests.log`。
- [x] 客户端tsc、云端typecheck、P0（499文件）、verify:contracts通过。
- [x] npm run build通过，保留原chunk体积与Capacitor动态导入警告，不宣称零警告。
- [x] 浏览器在Vite 3001使用真实模块验证：第一次fetch失败第二次成功；连接态重试进入loading，返回移除宿主；明确离线文案；三类拒绝同构missing；取消退避后仅一次请求。
- [x] Android真实Gradle编译、APK哈希与固定签名检查通过，集成包见追加记录。
- [x] Master真机验收通过（含原生起播、倍速、分享提示、二维码保存与打开微信）；弱网与退出取消的分态仍以可控注入测试为主，未做专门断网实验。
- [x] 验收后获授权更新官网下载（见下方发布记录）。

浏览器验证为可控错误注入，不是Android原生画面或真实上游解码证明；dev服务器未接云API产生预期404，另有一次验证导入路径错误已改正。

## 后续交付

本次独立命名验收APK，不覆盖原已发布包。应用版本号仍为2.6.5 / 21605；文件名、SHA-256与收据区分端侧加固包，正式发布前另行确定递增版本号。
工作量以最终diff统计为准，不将268 LOC初估作为上限。预计新增/调整约200～350 LOC（含回归测试）；Token初估3.5～4.5万，仅估算而非实测计费。

## 追加：默认倍率、分享反馈与作者支持（2026-10-08）

Master新增三项真机反馈并批准修复。本次已集成：
- 原生准备阶段旧1x事件不覆盖待设置2x，setRate完成后才play；网页defaultPlaybackRate及metadata重应用，换集仍保留常规倍率。
- 全局分享复制提示z-index从60提升到300，高于200的播放器，不截获触控；剪贴板不可用时请求打开分享页并给提示，不宣称已发出分享。
- 已有同源联系/赞赏二维码由PrismAuthorSupport插件保存：Android10+ MediaStore写Pictures/PrismPlay，Android8/9系统文件保存，Web仍为下载请求；取消/失败/成功明确区分，按钮等待时禁用。
- 用户主动点击才尝试定向打开微信，未安装/失败给明确提示；不自动扫码/联系/转账，不猜测联系方式，不新增存储读取权限，不放宽HTTPS外链白名单。

验证：156文件/1755测试、客户端tsc、P0（503文件）、契约与AC覆盖、Android静态门禁和真实Gradle构建通过。浏览器真实MP4（1280×720）metadata后playbackRate与defaultPlaybackRate都为2；分享提示300高于播放器200；两张QR图片真实解码成功，受控保存成功/取消/微信失败及滚动关闭验证通过。图库写入和微信唤起仅编译、未真机验证，不能冒称已通过；dev API无后端404明确记录。

集成验收包：`build/apk265/prism-play-v2.6.5-client-feedback-acceptance-20261008.apk`；36303231字节；SHA-256 `67e07a5ae5f35b6ecd416fc4e560a12db7a6404c79b68675375543480d237036`。applicationId org.prismos.play，版本2.6.5/21605，签名SHA-256仍为 `8bc228b3d45e2afa0fba9f27676d13b60cd0dcfb0537121bf14766ffe5f4d29d`；同签名可覆盖安装，不能靠设置版本号区分，请核对文件名/哈希。包含此前请求韧性加固，原官网下载包未替换。

### Master验收与官网下载发布（2026-10-08）

Master反馈“真机测试通过”，要求默认常规播放保持1x并授权Web发布。已核对readPlaybackRates缺省normalRate=1、holdRate=2，偏好缺失/无效回归通过；APK不包含设备SharedPreferences，测试时保存的2x不被打包。覆盖安装保留用户主动保存倍率，不重置个人设置。

原验收包未重新编译，正式命名 `prism-play-v2.6.5-20261008.apk`，上传R2 `releases/android/prism-play-v2.6.5-20261008.apk`与`releases/android/latest.apk`；latest设no-store，Content-Disposition为正式日期文件名。config:version更新修订说明，保留2.6.5/21605、minVersionCode21110与force=false。官网下载经302至R2/200，36303231字节，SHA-256与本次验收包完全一致；官网版本与34.6 MB展示通过。

版本Code未递增，因此原2.6.5用户不会被版本比较提示新版本，须手动官网下载覆盖安装；不把更新公告当作OTA升级通知。

全局地图：实现、测试、浏览器、Android编译/签名、Master真机验收与官网下载发布完成；未执行Git提交，未部署新Worker或更改套餐。

## 收官：文档、进度地图与架构图对齐（2026-10-08）

按 Master 指令把文档口径拉回与代码/真机/线上实测一致，并修正两处过度表述：

- 撤下「日志故障端点生产实测全部 200」「1102 已修复」两处结论，改为实测的间歇口径：`titles` / `related` / `discoveries` 与部分搜索查询回到 200，发现同步 CPU 由 2,020ms 降至 528ms；但同一查询「人到中年」首拉 200（19 条 / 22.1 秒）后紧接两次 503（2.6 秒 / 13.8 秒，503 页面 `access-control-allow-origin` 为空），「归墟」503、「持械入宋」200（10 条 / 6.6 秒）。搜索墙钟 6～25 秒波动，未宣布资源安全。
- 门禁自报口径纠偏：`tests/verify_contracts.py` 汇总横幅原写「37 业务表」，与其逐张断言的 38 不一致；改为从实测值推导，现输出 `24 App API / 38 业务表 / 13 功能 / 30 AC`。`docs/00-index/README.md` 的「22 前台 + 14 后台及隐私」更正为 38 条路径（24 + 12 后台 + 2 隐私），`CLOUDFLARE-BACKEND-FACTS.md` 的 20/30 张表口径补齐为 0001 首批 20 张、叠加 0002~0007 后 38 张 + 5 张 FTS5 影子表。
- 进度地图：`SPEC-CLOUD-REFACTOR.md`（G1 改为间歇复发）、`SPEC-APP-REFACTOR.md`（新增 G0~G4 五行表与两行变更记录）、`SPEC-CENC-EXOPLAYER-PLAYBACK-PROGRAM.md`（新增 §0.2.1 状态校正、A/E 阶段勾选项按证据重判）、`HOME-PLAYER-REPAIR-SPEC-AND-PLAN.md` 与 `SPEC-v2.6.3-REPAIR.md`（标注为 v2.6.4／v2.6.3 批次冻结记录并指向现行地图）、`ANALYSIS-S1-NATIVE-PROTOCOL-GAP.md` §5 快照加 2026-10-08 校正、`docs/plans/2026-10-07-search-cards-and-device-playback.md` 看板按代码实际接线重判（Task 2 按需分集目录 `edge/src/search/providers/s1-directory.ts` 与 `resolveCardDetail` 已接通，Task 6.2 保持未完成）。
- 架构图：`docs/qgraphflow/prism-play-overview/` 四视图重生成，47 节点 / 69 边 / 41 处源码锚点对工作树校验通过（语义、几何均 passed，仅模块配色槽位的信息性提示）。新增 API 传输层、错误态分流、作者支持原生保存三个节点；播放流程图插入「重试后是否拿到响应」判定与断网/连接分态分支；时序图把详情请求包进 `loop 1..3` 有界重试窗口；数据流图登记发现单页 10 条预算。

**仍未取证細節**：Android 8/9 的 `ACTION_CREATE_DOCUMENT` 保存路径未在真实旧机型上跑过（仅代码与 Android 10+ 分支经真机验收）；微信唤起未在不同微信版本上复测；弱网与退出的取消行为以注入测试为准，没有做过真实断网实验。以上不得写成已验收。

工作量：本批为文档与图数据对齐，代码改动仅 `tests/verify_contracts.py` 的计数推导（+4 行，0 处业务逻辑变更）；文档净增约 120 行，Token 估算 3~5 万（估算非实测计费）。

- 机读契约补注：`openapi.yaml` 与 `API-SPEC.md` 的 `/api/search/discoveries` 说明写明 `limit` 是上界而非承诺——服务端单页硬预算 10 条、不足 10 且 `hasMore=false` 即已到游标末尾、历史 upsert 失可见时降级为 withdraw。仅描述文字，不增删字段、路径或状态码。

复跑门禁：全量 Vitest **156 套 / 1,755 项通过**（44.0 秒）、`verify:contracts` 通过（24 App API / 38 业务表 / 13 功能 / 30 AC）、`verify:acceptance` 通过（30/30，188 条署名用例）、`scan:p0` 通过（503 文件）；`openapi.yaml` 改后 YAML 解析与路径全等断言仍通过。
