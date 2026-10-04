# 光影Play v2.6.3 修复增量 SPEC

> 状态：规则已按本轮授权写入；业务实现、浏览器验收、Android 真机验收、生产日更均未验收。
> 基线：保留现有 v2.6.2 tag、包版本与签名基线；本文件名是修复目标，不代表已经发布 v2.6.3。
> 正本关联：`D:/DEV/prism-play/docs/04-spec/SPEC-v2.0.md` §9、§10、§13；执行顺序见同目录 `REPAIR-v2.6.2-PLAN.md`。
> 执行范围：文档与分批本地代码修复；不修改 AGENTS.md/权限配置，不自动 Git 提交、推送、tag、云部署或发布 APK。

## 1. 约束与编号

沿用重客户端 + 最小云端三轨架构；已有模块优先局部接线与修正，不重复造播放器、目录、搜索库或历史库。本轮使用 **R26-01～R26-12**，是修复追踪编号，不新增/复用 AC 编号，不改写既有 AC-01～30 已验收证据。30 项矩阵通过只说明其扫描覆盖，不能证明本轮 R 项通过。

四公开频道的目录、搜索候选、同类推荐、按作详情、分享与海报必须归于同一 manifest generation 的公开事实及 flags。私密原路径保留有效高级授权 AND 当次显式开启凭据双准入；开启状态、私密内容身份与资源仅内存，不进入公开 seed、FTS、快照、推荐、备份、日志或 fact pack。服务端只能证明收到显式开启请求，不能证明设备上的真实点击，不宣称绝对不可绕过。

## 2. 修复规则与可验收结果

| R 编号 / 正本关联 | 必须实现的行为 | 验收边界（全部待验） |
| :--- | :--- | :--- |
| R26-01 / AC-16、18 | 冷启 `catalog-cache.ts` 的 hydrate 对已恢复且完整的公开快照发送完整 SnapshotFeed；搜索与补全在判 fallback 前等待索引 init 和已排队 sync。检查快照 revision、可索引公开 count 与索引实际行数，不以 docs 非零冒充完整，不以同 revision 的空增量冒充初始化 | 已有快照+空索引、旧索引、排队重建、持久索引冷启、真实 SQLite 不可用、写失败、部分快照、空公开快照均测试；能本地检索时不误发云请求；失败明确状态且不毁旧快照 |
| R26-02 / AC-16、17、18 | 公开云搜索/补全/related 候选必须经当前 generation 可见事实复核，不能返回旧 anime ID 或旧 D1 条目；详情保留完整集数和线路，禁止只截取两集。目录 item、搜索 item、workId、episodeNumber 身份一致 | 每个固定查询记录 generation/revision、频道、workId、集数、线路；缺失/坏 pack 拒绝，不回读旧公开事实；旧代兼容路径只能在无 workFacts 的真实旧 generation 使用 |
| R26-03 / AC-06、07、08 | 左侧 0%～48% 垂直调窗口亮度，右侧 52%～100% 调音量，中央保留区不触发；左双击退10秒/右双击进10秒不变 | Android 实际亮度/系统音量 + HUD 一致；Web 音量仅媒体元素，亮度无原生能力明确受限，不以遮罩冒充 |
| R26-04 / 播放器补充 | 正常速度可选 1、1.25、1.5、1.75、2、2.5、3、4 倍，1 倍标“正常”；长按临时倍率在设置可修改（使用同一倍率集合），不得固定2倍；松开/取消/离场/失焦/锁定/销毁恢复长按前正常速度 | 真正改变播放内核 rate，控件与 HUD 同步；正常倍率偏好和长按倍率偏好分开；切线/换集不丢正常倍率，临时倍率不持久化为正常倍率；高倍率不支持如实失败 |
| R26-05 / AC-19～21、24 | 选集为独立可操作浮层，不能依赖挤在详情操作岛；系统返回/侧滑/Escape 先关最顶浮层，再退全屏，再退播放器。横屏全屏通过原生隐藏状态栏与导航栏，退出/关闭/异常恢复进入前系统栏及方向策略；CSS 为唯一全屏状态权威 | 选集滚动/焦点/点击有效，不穿透触发播放手势；Web 不宣称隐藏原生系统栏；异步转屏、连续进退、锁屏恢复、销毁均不留隐藏栏 |
| R26-06 / AC-23、24、30 | 全屏倍速、选集、投屏可达且避开安全区。手选、自然连播、通知栏切集、切线/重试共用当前集状态；详情、高亮、分享 ep、投屏 workId+episodeNumber 和续播始终同步 | 当前集不能由打开时闭包永久固定；投屏仍仅允许已发现内网设备，锁释放、地址策略和私密边界不削弱；真实电视接收与当前集同步另验 |
| R26-07 / AC-01、25、26 | 重复点击当前频道或当前子分类：第一次滚动当前内容容器至头部，连续第二次调用真实刷新；刷新中合并请求、防连点重复触发。切换新频道/分类正常加载第1页并重置重复状态；切换目标、离页或其他导航打断连续序列，刷新后重新从第一次开始 | 不新增臆造毫秒阈值；测试同频道、同子类、交错点击、切新类、请求乱序、刷新失败；刷新不能只重画旧内存列表，须接入现有目录同步并展示结果 |
| R26-08 / AC-28、29 | 每个公开频道顶部提供该频道热门榜，搜索 Overlay 三榜继续保留。排名用同代可信 hitsTotal 等可核验热度数据，不能仅按 isHot+ID 假排；ID 只做真实热度相同的稳定 tie-break | 无可信热度显示“热度数据不足”或隐藏名次，不造热度数字；标明累计热度与本机快照覆盖范围，不称24小时/全网实时榜。个人探索不进入公开榜；公开缺字段与部分缓存分别测试 |
| R26-09 / AC-03、18、30 | 公开追剧断点与用户追剧意图真实持久化，重启和覆盖安装后可恢复；清缓存不清历史/追剧。追剧页顺序为正在追→同类好剧→往期完播，推荐有独立可读可点空间，缓存管理归“我的”附属区，不挤占同类推荐 | 基于真实公开历史与同代分类标签推荐，排除源剧/已看重复/私密/撤片；无推荐明确空态；写失败不显示已保存；私密不保存不云同步；本轮不擅改既有历史容量 |
| R26-10 / 商业配置与分享下载边界 | host可静态注入旧已确认作者contact/reward本地二维码（无需新增云QR字段），可点击放大并提供真实文件下载；下载不等于原生相册保存，提供微信识别/保存辅助说明，取消和返回先关放大层。保存失败/平台不支持给真实兜底，不能用 Toast 假装已保存 | 不伪造收款主体、二维码、价格或配置字段；二维码用途/资产来源须确认。微信辅助由用户操作触发，不自动跳出 `/s`；不改 ended 才截流、当前单集、私密/未知404 |
| R26-11 / §10 商业策略、AC-14、15 | `watch_seconds_total` 为确实播放期间的单调计时累计，不是 currentTime、seek位移、假 duration 或 timeupdate次数。播放暂停/缓冲/出错/无首帧不累计；倍速按实际观看经过时间而非媒体时间。后台仅确实播放才计，恢复不补算未知时段，不重复结算 | 回放可累计实际观看，拖到结尾不增加跳过时长；跨集/销毁/恢复不重复。公开累计可持久化，私密不写时长或身份；提醒阈值/间隔/文案/档位/价格全由有效云配置控制，缺配置关闭提醒，只在自然切集出现并可关闭，不拦播放/核销 |
| R26-12 / AC-17、18、G1～G4 | 每日同步生成完整新 fact packs、目录、bundle、manifest，校验后 blobs 先、指针后，同代完整性一致；旧 publisher 拒绝覆盖 workFacts 仅防退化，不算日更成功。来源覆盖调查、私密资产隔离、CI secrets/备份分别门禁 | 本地离线产物测试不等于真实CI周期；必须取得一个真实周期发布与端侧读取证据后才标日更闭环。私密发布须另行确认真实访问隔离，前缀不是安全边界；本轮不发布 private objects、不读 secrets明文/不改权限 |

## 3. 已知证据与待证矩阵

首批修复前的历史定位（下列缺口已被后续局部修复，不是当前源码状态；当前执行登记见§5）：`D:/DEV/prism-play/src/core/catalog-cache.ts` hydrate 仅恢复缓存并返回状态；现有 feedIndex 只接在提交/导入/增量之后。`D:/DEV/prism-play/src/core/storage/index.ts` search/suggestions 先调用同步 fallBack，而 init/queued sync 的等待在索引 search 内部，因此首次调用可提前回云端。`D:/DEV/prism-play/src/core/storage/search-index.ts` 已有 pending 队列、init、revision/docs 状态，优先复用，不另建索引。

本轮读取 `D:/DEV/prism-play/public/seed/catalog-bundle.json`：revision=2，公开条目20,163；按 channelId=drama 且 title 包含“末世”筛选，5条，其中 isAi=true 为3条。这是指定 seed 的统计，不是云端现状、完整来源覆盖或推荐质量证明。

| 观察/对象 | 当前证据级别 | 必须补齐 | 禁止推断 |
| :--- | :--- | :--- | :--- |
| 云搜索旧 anime ID、打开后两集截断 | 用户报告，本轮未重新请求云端 | 相同查询原始响应、generation、workId、完整集表与对应事实pack投影对照；归因搜索旧索引/详情旧投影/来源全集字段 | 不把所有“AI漫剧”一概视为两集，也不拿本地单测替代云复测 |
| 旧库截图约70部且主要另一来源、多集 | 用户证据摘要，本轮未提供截图文件供直接重读 | 对应截图/旧库导出及同名同作强映射；记录来源编号、题材、集数、采集范围和时点 | 70不是当前覆盖验收阈值；不能只比较标题数量 |
| provider_m1 三部同名 AI 条目为合集，内容不足 | 已核对原始采集与公开源详情，非全来源结论 | 同一作品逐源比对播放列表、真实媒体时长与分集语义；合集可能是1个长视频，需核验而非虚拟拆集 | 不将 m3 局部不足推广为其他来源同样不足；不制造集数 |
| 其他公开来源覆盖（含provider_s1） | 调查未闭环；s1元数据及公开player解析模块已出现，空lines非可播证明、候选非健康验收 | 每源可达性、真实分类、末世/AI同作数量、分集/合集、线路健康、公开/私密定级与失败原因 | 不宣称全源接入、固定来源数量或调查已完成 |
| 每日日更新 packs | 旧拒覆盖保护和全量打包模块存在 | 新增/改集/撤片/坏页/中断的本地产物及真实CI周期；客户端手动更新后复查搜索/榜单/详情 | 不把运行拒绝当作发布成功 |
| 私密资产、CI凭据与备份 | 安全边界已定，实际隔离/恢复未验 | 公开bucket直链风险、双准入资源每跳、备份白名单/恢复、CI secret仅名称/可用性证据 | 不公布secret值，不据“已配置”文字证明可用，不改权限后补授权 |

## 4. 契约同步与尚未确定的接口

正本与 PRD/UIUX 直接修正 AC-06/07 方向；正本 AC-20/21 补系统栏与浮层优先；海报缓存口径按三轨 A-9 统一512 MiB（目录20 MiB不变）。导航统一三键【精选/追剧/我的】，搜索Overlay，海报分享仅播放器内。

API-SPEC/OpenAPI 公开目录 pageSize 按三轨60条分片同步（旧20/50是直接冲突）；这是目标契约修订，不代表 `edge/src/core/constants.ts` 20/50 常量或旧测试已经修改。下一实施批必须区分公开facts分页与私密/真实旧代兼容，不改变搜索端点既有20条分页。

搜索同代读取是既有端点行为约束，不新增公网端点或响应字段。内部manifest `publicSearch={schema:1,count,key,bytes,sha256}`，key=`library/search/{sha256}.json`、≤16 MiB；对象 `{schema:1,revision,entries:[{item,aliases,pinyin,tags}]}` 必须与workFacts同代，校验hash/bytes/count/各公开频道总数，返回前复核事实。现代workFacts代缺/坏投影503，不回D1；只有真实无workFacts旧代兼容。上线须同代facts/目录/bundle/search blobs先校验上传、manifest pointer后切、Worker配套，禁止搜索Worker单独部署。

存储DDL与清理语义以正本§6.1为准：`local_following(content_id TEXT PRIMARY KEY,title TEXT NOT NULL,cover_url TEXT,created_at INTEGER NOT NULL)` 与history同库prism_local.db，created_at为Unix秒，独立收藏无500条LRU、清cache/history不删除、不新增云sync。观看累计仅Preference `prism.watch_seconds_total` / `prism.watch_seconds_last_nudge` 数值字符串，无ID/凭据；private/unknown零计。源码读写失败状态不冒充保存成功，真实备份/覆盖安装仍待验。

作者资源已确认：`D:/DEV/prism-play/public/images/author-contact.jpg` 联系作者、`D:/DEV/prism-play/public/images/author-reward.jpg` 自愿赞赏，main已通过host SupportAssets静态注入；不要求云QR字段。旧reward图含“截图发微信换长期通行证”历史权益文字，不是当前购买/授权承诺，须展示免责声明；价格/档位/提醒策略仍云端，未有效配置关闭商业提醒。微信手动辅助不改变/s边界。

## 5. 全局进度地图与验收登记

| 门禁 | 本轮实际状态 | 后续证据 |
| :--- | :--- | :--- |
| G0 | 完整读契约、只读定位、文档修订；verify:contracts及verify:acceptance退出0，后者仅署名覆盖，非行为验收；diff --check退出0 | 新规则语义人工复核；机器门禁不覆盖所有R项 |
| G1 | 未进行云端调查或资源写入 | 来源待证矩阵、当前generation及安全边界 |
| G2 | 冷启首批已修并有历史1040通过记录；同代搜索投影/完整日更模块局部已落地，新全量与真实CI周期待验 | 新回归、同代blobs→pointer与Worker配套证据、真实CI周期 |
| G3 | 播放/导航/收藏/二维码/计时已有局部实现及测试文件，非整项完成；浏览器/原生未验 | 新全量回归 + 浏览器路径 + Android/电视/微信真实结果 |
| G4 | 未构建发布、未提交推送部署 | 前置门禁齐备后另行受控交付 |

执行批完成时逐项登记命令、退出码、样本/设备、实际结果与阻塞原因，不覆盖历史验收记录；不得以旧30项署名覆盖代替本轮行为验收。

### 2026-10-04 当前执行事实（本次仅文档同步）

- 用户已授权计划与完整修复；本次完整读取 `D:/DEV/prism-play/src/core/storage/following-store.ts`、`src/core/watch-time.ts`、`src/views/settings-support.ts`、`src/core/runtime-services.ts`、`edge/src/search/generation.ts`、`edge/src/library/manifest.ts`、`edge/scripts/public-search-projection.mjs`、`edge/scripts/package-and-publish-library.mjs`、`edge/scripts/daily-facts.mjs`、`edge/scripts/public-provider.mjs`（均相对同一绝对工程根）；确认独立收藏、标量计时、静态作者资源、内部投影/同代复核及日更生成模块局部落地，不代表接线/所有边界验收。
- provider_s1已有公开元数据与身份绑定player解析模块；detail的sourceEpisodeId/集数及空lines不构成可播事实，resolver候选不等于真实健康线路。真实补采/生产可播覆盖待证，不借私密或App接口补货。
- 本次 `npm run verify:contracts` 与 `npm run verify:acceptance` 均退出0，仍为22条公网路径、30/30署名覆盖；只证明静态契约/署名，不证明R项行为。
- 新增following/home/player/runtime/settings/watch-time/nudge及generation/projection/daily/public-provider/publication测试文件已存在；本次未执行新全量测试。以下1040/24及静态命令是旧首批report，不可挪作当前全量结果。R26未全完成、浏览器/原生/生产未验；无业务/权限/AGENTS/Git写操作或部署。

### 2026-10-04 首批执行记录（历史快照）

- R26-01：已实施 hydrate 完整快照 feed、search/suggestions 等待本地检索初始化及排队同步后再决定回落。`npx vitest run tests/client/search-cold-start.test.ts tests/client/43-search-index.test.ts` 17/17通过；全套 Vitest 86文件1040项通过。部分缓存、写失败及实际索引行数一致性仍需补验；不标整项完成。
- R26-12 采集子项：`planCrawl` 在缓存页数缺失/无效/损坏时重新探测，失败明确拒绝，保留显式页数上限。`node --test tests/edge/*.test.mjs` 24/24通过。未进行真实补采、来源接入或日更发布。
- `npx tsc --noEmit`、`npm run scan:p0`、`npm run verify:contracts`、`npm run verify:acceptance` 与 `git diff --check` 均退出0；后两者不证明本轮行为通过。未浏览器/真机验收，未构建APK或提交部署。
- 来源调查补证：截图主要公开来源尚未接入；《列车求生，我天选福星》118集、《在线急！前男友变成丧尸找上门了！》149集、《釜山行之末班车》30集获公开详情核验，本库均缺失。现有来源AI缓存仅6页120条，实时分类首页1918条96页；快照时点不同，不将全部差额归因单次采集。严禁把私密来源用于公开补货，旧库约70部未逐条实证。
