# 云端与 APK 优化：最小闭环计划＋SPEC

2026-10-09 r2。Master批准按六项最小验收实施。本版取代r1全平台要求及错误完成勾选，不依赖聊天上下文。
Master已追加授权本批生产Worker部署、R2上传和版本下载更新，现已执行；Git提交/推送仍未授权。保留当前工作树此前成果，未迁移或重置D1。

2026-10-09 后续系列/播放审核修补由 `docs/plans/2026-10-09-series-playback-notice-minimal-spec-and-plan.md` r2承接：针对共性规则而非指定剧目；本地21607候选重出包不改变已发布21606，发现GET保持8秒。新批云端代码/通告/版本指针仍待独立授权，不能沿用本页旧发布授权。

## 1. 目标与延期

现有Worker/D1/KV/R2和play.prismos.org内实现：本地片单不等云端，发现更新不重建全库，正常看剧，新版有后续版本提醒和消息，下载正确包。不买资源、不换内核。
延期强制升级、完整Range/If-Range、Android文件断电原子性、完整公告中心、Admin发布UI、一键发布回退、完善审计状态机。延期不是完成；保留receipt，不宣称断电不丢数据。
底线仍为授权/历史/签名保留、公开私密隔离、不伪造版本、不把失败返回成功、不发布错包。夜间允许短暂中断，不背无必要旧版兼容，但要可恢复。
已有本地先显/API预算/发现patch和receipt/manifest读取/消息初版；review发现入口外域、审计失败继续写、强制无门禁、原生批次非原子。旧全完成结论撤回；早期2.6.6/21606包不代表本轮验收。

## 2. 实现机制

### 启动同步
有效公开快照/seed先呈现卡片，channels挂起不挡卡片，本地历史用于推荐。无候选真实加载/离线/重试，不持久化私密拓扑。
API保留普通8秒、联想/related12秒、搜索35秒、写15秒及已有播放3次8秒策略。整包接入readWithBudget，fetch和body读取60秒限时，不重试，只有404允许既有分页回退。客户端ETag副本/304复用延期。
发现每轮4页；每页前检查播放busy/销毁signal，页间让出事件循环。播放开始不启动下一页，销毁中止网络，已提交小批允许完成。失败不推进cursor，后续触发可重试。仅touched最终合并公开卡片upsert/delete；withdraw有底库则恢复底库。保留receipt，不每页clear，不改授权历史表，不承诺Android断电原子性。

### 同域下载
KV config:version保留已有android字段并增可选artifact={key,bytes,sha256}，key固定releases/android/<versionCode>/<sha256>.apk，hash小写64位，bytes正安全整数。读取器校验并保留。缺artifact可读版本但latest下载503，不能外域回退或猜包。
GET /dl/latest/android读取同一公告；R2 head size及customMetadata.sha256/versionCode/versionName匹配才302同源/dl/artifacts/<Code>/<sha>.apk，no-store。
GET|HEAD /dl/artifacts/{versionCode}/{file}只接受正整数Code和64位sha.apk，固定key完整流式200/HEAD空body，APK MIME/Content-Length/文件名正确，Accept-Ranges:none，忽略Range/If-Range并完整200，不宣称续传。hash路径长期缓存，发布不得覆盖同key不同字节。未知key404，无桶503，不开放DISCOVERY_BUCKET。删除本批试验旧/release旁路。
官网版本/大小来自同一指针和对象，不另读可变latest.apk。

### 可选更新和消息
自动仅真实Android或测试注入有效Code；App.getInfo失败/无效Code跳过，不猜21605。首页后后台检查，新Code才提醒下载/稍后24小时，失败不阻塞。本批所有升级均可选，不启强制门禁；force/minVersionCode保留字段但无强制文案，首发force=false，不抬最低版本。
版本/消息独立拉取，不相互掩盖；显示前复查有效期、前台和播放。更新关闭后可显示一条有效未读消息，明确确认按id+revision已读。销毁取消计时器，不持久化旧正文。用户点击才打开下载，失败明确反馈，不静默安装。
消息人工操作已有受保护GET/POST /api/admin/announcements，不做UI。全量替换/删除、明确确认、纯文本、10条/7KB上限，保留后台会话/同源保护。
DB/KV缺席或写失败返回503；审计失败且无既有ID不得写KV；KV失败删本次未完成认领以允许原requestId重试，清理失败提示结果未确认、人工读回。重复ID409要求读回，不宣称完善幂等。成功仅写入/传播中，不等于全员收到。

## 3. 六项验收

- MIN-01：channels挂起仍先显本地卡片，离线可浏览，基本/原生播放无新增退化；home/player测试＋浏览器＋真机。
- MIN-02：少量发现只patch、失败可重试；整包限时，播放后不发下一页；SQLite/receipt＋fake timer/busy/cancel测试。
- MIN-03：同签名递增Code覆盖，授权/历史/倍率/主题保留，私密冷启关闭；aapt/apksigner＋Master真机。
- MIN-04：高版本提醒说明，主动同域下载正确包，失败不阻塞；浏览器＋字节/hash/Code验证。
- MIN-05：消息发布可显示，撤下下一成功读取不显示，失败不假成功；路由失败/删除＋浏览器。
- MIN-06：包先核验后公告，保留旧包/指针，失败可恢复；preflight＋SOP。
真机覆盖/原生解码不得以单测替代；未测项如实记录，不承诺固定提速或永久无503。

## 4. 工作包与验证
顺序：本文及主SPEC/OpenAPI/API-SPEC/PRD/架构/索引收敛→传输同步→下载→提醒消息→浏览器和全量门禁→APK→Master真机→生产授权。
文件：src/core/catalog-bundle-loader.ts、api/retry-fetch.ts、discovery-sync.ts、api/client.ts、main.ts；edge/src/routes/dl.ts、index.ts、config/kv-config.ts、types/api.ts；src/core/client-bulletins.ts、views/client-bulletins.ts、edge/src/routes/admin-announcements.ts。
回归：home-cold-start-local、discovery-sync/recovery、catalog-bundle-loader、api-request-budget、81-download-landing、84-portal-assets、apk-artifact、82-monetization-version、announcements、client-bulletins。先红后绿，继续300行/Tokens/Lucide/准入纪律。
命令：npx tsc --noEmit；npm run typecheck；npm test；npm run build；npm run scan:p0；npm run verify:contracts；npm run verify:acceptance；npm run cap:sync；npm run verify:android。
Android用既有build/android-tools/JDK21/sdk/gradle-cache，android目录./gradlew assembleDebug --no-daemon。node edge/scripts/publish-client-release.mjs preflight <APK>仅本地预检，不冒充自动发布器。
浏览器npm run dev -- --host 127.0.0.1，用实际端口。受控版本/消息/错误验证不冒充生产或Android解码。

## 5. 人工发布/恢复SOP（本批发布已执行，回退未触发）
1. 获Worker/R2/KV授权；保存旧deployment ID、config:version/config:announcements与旧包收据，不含私钥、不进Git。
2. 最终APK预检Code/Name/签名/seed/bytes/SHA，Code高于生产，拒绝probe。
3. 上传preflight不可变key，APK MIME和customMetadata sha256/versionCode/versionName；下载重算SHA，不以ETag代替。
4. 备好新格式旧指针/不可变旧包后部署Worker，不迁移重置D1。
5. 写完整config:version，artifact只指验包，force=false；核验version→latest→同域artifact及hash。KV传播保留旧新对象。
6. 已认证会话调用announcements，revision递增、有效期明确，GET读回；撤下items=[]并读回。只保证下一成功读取不显示，不保证闭屏推送/全员触达。
7. 异常恢复旧Worker和对应KV/消息，保留APK。已装新版不降Code，用更高Code修复；不要全库旧备份覆盖新核销。
8. 保存部署/指针/包/测试/真机证据，未测保持未完成。

## 6. 动态进度
- [x] Master批准六项最小闭环，r2范围/延期明确。
- [x] 核心收尾/针对性测试/回归：167文件/1788测试通过，0失败、退出码0。
- [x] 浏览器结构与DOM受控流程：本地60卡片/私密导航0、可选提醒、下载由点击触发、消息显示及撤下后读取为空、0未处理异常。内置浏览器无鼠标视口，视觉/指针与真机不冒称通过。
- [x] 本地门禁/最终APK构建/签名hash归档：2.6.6/21606，详细收据 outputs/minimal-closure-receipt-20261009.json；仍有既有Vite包体/导入警告。
- [ ] Master真机覆盖/播放验收。
- [x] 生产授权/部署/切换/恢复记录准备：Worker `d8d63d31-9336-40a7-bc25-a5a36759d259`；公告2.6.6/21606、force=false。真实同域302→200下载36,379,585字节，SHA与签名一致；频道/目录增量/发现/公开详情/消息成功，未知内容404、后台未认证401。没有执行回退演练，不宣称真机通过。
发布收据：`outputs/deploy266-live-receipt.json`、`deploy266-upload-receipt.json`、`deploy266-final-check.json`。旧Worker `b5ba77bf-7980-4fcb-a43c-937f230e558d`，原KV/包及新格式旧指针已保存。临时上传预览已停止、临时凭据已清理。
实现前初估560～1000 LOC、55k～95k Token仅为历史估算，不能再称剩余量；本批本地和生产操作完成，剩余为Master真机验收和后续观察。
自完善：完成即时记录命令/证据；新会话重基线接未完项；文档不实先纠正，不改验收隐瞒失败。r1范围过大且误标完成；r2明确延期增强，不降低实际包/版本正确性与用户数据底线。
