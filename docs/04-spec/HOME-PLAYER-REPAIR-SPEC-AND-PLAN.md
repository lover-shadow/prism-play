# 光影Play 首页与播放器修复：SPEC＋执行计划

> 日期：2026-10-05。状态：产品规则已对齐；执行会话获监理＋施工双角色，仅本地文档/代码/测试与静态检查，Git、CI、云端、官网另行授权。
> 代码基线：`631fcf3`；真机验收包：2.6.3，`build/apk263b/app-debug.apk`。本包未通过本轮真机验收。
> 范围：修复真机缺陷，增加综合首页，完善发现、刷新、分类榜单与信息展示。
> 权威关系：`SPEC-v2.0.md` 仍是工程正本；本文件记录已确认的增量决策与执行步骤。实施前须同步正本、PRD、UIUX及受影响数据契约，不能让旧条款继续作为新行为的验收依据。
> 授权边界：执行会话已获「监理＋施工」双角色，允许修改计划内本地文档、业务/测试代码及运行本地静态检查；不授权Git提交/推送、CI触发、云读取或写入、APK构建/发布或官网推广。跨角色、外部写操作与真实媒体验收仍须分别取得明确授权。

## 0. 新会话入口：项目、位置、授权与历史

### 0.1 这是什么项目，为何本轮重要

《光影Play》是免注册、无广告的 Android 观影终端，公开内容包括短剧、电影、纪录片与动漫；官网提供正式 APK 下载，公开分享链接只观看指定单集。高级授权＋当次显式开启才可访问个人探索，它不是首页的“其他内容”。本轮修复的是从发现作品、点击进入、真实播放到返回浏览的核心闭环，不是独立演示页面；连播失控是P0，静态控件看起来正确不能抵消不能正常观看。

工程根为 `D:/DEV/prism-play/`。实际技术为 Capacitor 7 Android 宿主、TypeScript＋Vite、Artplayer＋hls.js；端侧 SQLite 管公开历史、收藏与检索，公开 JSON 快照/海报缓存支持先显。Cloudflare Workers 做准入、配置和按请求投影，R2 保存公开资产与APK，KV保存配置和manifest指针，D1保留授权/账本/同步及原私密消费者。不是把整库查询和每个视频分片都压到云端，也不是完全无云。

2026-10-03 的重构把公开读面迁向静态事实、端侧目录/搜索/推荐：旧全量同步曾形成每设备436个D1读请求，统一云代理视频还有请求配额及出口封禁风险。新公开详情允许按作取得线路后直连媒体；目录、种子、公开文案不泄露上游名称/地址，内部事实pack不作为App下载接口。公开直连例外不放宽私密逐资源准入。

### 0.2 分工、三轨与权威关系

- Master定义产品与商业规则，只验收可安装新版APK，不承担后端、采集、CI或浏览器工程验收。
- Agent负责契约、端侧工程、必要云配套、自动回归、有效浏览器和真实媒体证据、CI出包/签名/资源核验；Master明确通过后才更新官网下载地址、正式包和版本公告。
- Track 1静态门户/分享：`D:/DEV/prism-play/docs/04-spec/SPEC-STATIC-PAGES.md`；Track 2云事实/传输/CI：`D:/DEV/prism-play/docs/04-spec/SPEC-CLOUD-REFACTOR.md`；Track 3 App/Android：`D:/DEV/prism-play/docs/04-spec/SPEC-APP-REFACTOR.md`。三轨是职责划分，不是绕过G0→G4的并行发布许可。
- 正本仍为 `D:/DEV/prism-play/docs/04-spec/SPEC-v2.0.md`；本文件自包含本轮增量，引用用于证据追踪，不要求通过旧聊天才能理解。旧正本含历史基线/过期状态，不能整段照抄作为今日事实；B0先同步直接冲突。
- 本次授权仅修改本文件；不能改其他业务、AGENTS、配置、权限、Git或执行构建/测试/网络。以下命令、发布和实施步骤是后续已获相应授权时的计划，不是本次已执行记录；没有自动提交/推送许可。

### 0.3 三面状态快照与最后验证边界

| 面 | 最后登记日期 | 已知状态 | 本次验证边界 |
| --- | --- | --- | --- |
| 源码 | 2026-10-05历史交接 | baseline `631fcf3`；业务源码clean，仅本文件untracked | 主会话在本次文档补全后以只读git status／rev-parse复核：HEAD为631fcf3，仅本文件未跟踪；后续会话必须再次核对 |
| 正式官网/云 | 2026-10-05历史交接 | 官网正式2.6.2；公开云revision 3；21963作品、1920 AI | 未联网复验，数据不等于推荐质量/口碑已验证；官网不可提前替换 |
| 验收APK | 2026-10-05真机反馈 | 2.6.3，`D:/DEV/prism-play/build/apk263b/app-debug.apk` | 本轮未通过；不是正式2.6.3发布，也不是本次已重新编译 |

当前文件核读日期为2026-10-05文档轮次，行号以本次读取源码为准；以后源码变动应按符号重新定位。源码核读不证明生产部署与APK包含同一代码。种子历史统计：21963作品中14786有简介、最长30字、展示副标签0；1920 AI为历史登记而非此次重算。下一Agent必须记录自己的核验时间/证据，不能将这张表更新为“实时”而不复验。

### 0.4 需求演进与假绿教训

1. 前轮修复舞台层叠、选集三态/30集分段、倍速/投屏互斥、全屏收起、详情状态文案；这些已有模块应保留，旧任务显示completed只代表那个施工片段，不代表本轮HP通过。
2. 2026-10-05真机截图证据标识为 `2026-10-05-10-27-41-810` 与 `2026-10-05-10-52-12-935`：用于复核控制条/选集/海报/底栏/留白的实际表现。原图由Master提供，主会话已读取：`C:/Users/Master/Downloads/Screenshot_2026-10-05-10-27-41-810_org.prismos.play.jpg` 与 `C:/Users/Master/Downloads/Screenshot_2026-10-05-10-52-12-935_org.prismos.play.jpg`。前者显示非全屏厚重控制条及已恢复的推荐海报；后者显示列表留白、单分类与宽厚底栏。它们不是仓库资产，新会话若无法读取，应保留上述观察而注明原图当前不可取得；不得声称重新目视。尺寸以真实视口测量，不从截图像素倒推CSS。
3. 用户进一步确认：非全屏无画面内悬浮工具条，全屏透明紧凑；点击先显加载宿主；底栏背景本身收窄；海报更密；Ai剧是类型不是精品；简介/多标签须来自真数据。
4. 用户要求新的综合首页和60条4:2:1:3构成，再明确其中短剧24＝20 AI＋4强口碑强热度真人；频道目录传输分页没有变为20条。
5. 多集失败根因是上次事件接线扩大了订阅到playing/seeked，但结束处理仍用兜底else：它们落入onEnded，刚起播/拖动恢复就被当完播，短剧/动漫连续扫集。以前已显式挡loadedmetadata/waiting/seeking，不能因此断言事件闭集安全。
6. `D:/DEV/prism-play/tests/client/player-harness.ts:60–75` 的play只发play、seek只改时间，不能自然覆盖playing/seeked。替身与生产 `art-engine.ts:74–82` 的原生video事件桥不同，单测绿暴露了证据缺口；需补事件序列红灯＋真实HTMLVideo/HLS回归，而非再堆静态CSS断言。

### 0.5 词汇与不可混淆的身份

| 词 | 本文含义 |
| --- | --- |
| 作品/work/title | 一部剧或一部影片；首页60条是60作品，不是60集 |
| 集/episode | 作品内一个可播放单元；合集可只有一集，不等于缺失多集版本已查清 |
| workId/contentId | 作品稳定身份；公开归并须可信映射，不能同名即合并 |
| local episode id | 新清单以episodeNumber适配episodeId；身份必须是workId＋集号，不是旧D1全局集ID |
| generation（内容） | manifest指向的一整代目录/facts/search/bundle；同代校验是数据一致性 |
| generation/token（操作） | 打开播放器/换源/刷新请求的失效代次；不是云revision，二者要分别命名 |
| revision | 公开目录修订号；同revision可显式新推荐轮次，不表示新增云内容 |
| page/chunk | 云目录60作品传输页；搜索仍用独立搜索分页；榜单20条上限不是目录分页 |
| 推荐轮次/推荐页 | 从公开候选池选出的60条展示页；同轮追加固化，显式刷新才新轮次 |
| profile/曝光 | profile是现有公开历史/题材偏好信号；曝光只指真实可见卡片，预取不算观看也不算曝光 |

## 1. 目标与不变边界

- 重客户端＋最小云端架构不变，复用公开快照、搜索索引、推荐、播放宿主与返回总线。
- 公开目录分页仍为60部作品；作品不等于单集。不得为推荐改为20条传输分页。
- 新首页是公开内容的客户端综合视图，不是新增来源频道，也不新增伪造的服务端频道ID。
- 个人探索不进入综合首页、公开榜单、标签、推荐或曝光记录；双准入及私密零落盘边界不变。
- 保留左亮度／右音量、八档倍速、长按恢复、独立选集、投屏安全边界和宿主全屏单权威。
- 应用免注册，不引入广告或支付SDK；商业阈值、价格与档位仍来自有效云配置。
- 业务/测试源码单文件不超过300行；本施工文档允许约400–650行，不将源码拆分限制误套文档。Lucide图标与Design Tokens约束不变。

## 2. 当前事实与问题基线

| 事实／问题 | 证据及边界 |
| --- | --- |
| 多集未播放即连续换集 | `src/player/prism-player.ts:193–215` 已订阅playing／seeked，但处理函数的兜底else调用onEnded；起播恢复事件被误当结束。真机反馈覆盖短剧和动漫。 |
| 热门榜返回误触退出 | `src/views/home-topology.ts` 开榜只切hidden，没有独立返回Layer。 |
| 点击进入迟钝 | `src/player-host.ts` 创建可见宿主之前等待runtime刷新及详情请求。 |
| 刷新结果不变且无明显反馈 | `src/views/home-repeat.ts` 有连续点击检查；目录同步未变化时，重读相同快照和确定性编织仍产生相同结果。不能据此宣称完整推荐刷新已实现。 |
| 分类不能改变热门榜 | `src/views/rankings-rail.ts` 仅支持频道范围；`home-topology.ts` 未传二级分类。 |
| 旧推荐比例不是新产品规则 | 旧实现为20条内部编织、7 AI／7热门／6探索；不能当成AI／真人／个人偏好的已实现比例。 |
| 列表简介与标签不足 | 修订三种子21963部，历史只读统计14786部有简介，长度最多30字；展示副标签覆盖为0。上述统计是本地种子基线，不是源数据永远不提供这些信息。 |
| 视觉问题 | 真机截图显示非全屏大黑控制条、全宽厚底栏、海报间隙及列表留白；以用户提供截图为基线，不从截图像素反推CSS尺寸。 |

### 2.1 当前总体架构与目标接线

```text
配置来源/原料元信息 + 本地SQLite内容原料（内部，不作公共整库种子）
  -> 采集/归一/可信映射 -> 目录 + 完整facts + publicSearch + bundle
  -> 体积/hash/count/公开隔离/同代校验 -> R2 blobs -> KV manifest指针
                                                     |
                 Workers: channels/config/catalog/title/search/share/poster
                          |          |（按作线路，惰性读取）
                  公开缓存/本地索引    v
                  SQLite/JSON -> main -> player-host -> prism-player
                          |                |               |
                          v                返回/全屏         Artplayer+hls.js
              home-view / rankings        单权威               |
               |             |                             真实video事件
      目标：跨公开池推荐轮次  分类先筛后排                       |
               |                                           v
      poster-grid -> actual-visible曝光（待接）       ended guard/进度/真实计时
```

目标曝光、60配额与立即loading在图中是待实现节点，不代表已有完整机制；已有缓存、索引、线路和返回总线应复用。私密在独立双准入内存链，不进入这条公开推荐/曝光链。

### 2.2 实际源码锚点与模块责任

以下均为 `D:/DEV/prism-play/` 下绝对路径，行号为此次只读核验，不是替代符号检索的永久定位。

| 位置 | 当前责任/事实 | 本轮注意点 |
| --- | --- | --- |
| `D:/DEV/prism-play/src/main.ts:84–101,130–178` | 快照提交喂搜索、公开homeApi、runtime及宿主/首页注入 | 全公开读取面已存在；首页仍按频道拿items；syncCatalog失败直接throw |
| `D:/DEV/prism-play/src/core/runtime-services.ts:17–27,45–95` | refresh等待偏好写队列/授权/倍率读取；video首帧与实际计时 | runtime刷新不在此await商业网络；阻塞来自偏好/授权I/O；不能混同推荐profile |
| `D:/DEV/prism-play/src/player-host.ts:135–160,192–208,247–273` | open先runtime再title才建层，晚注册返回；close增opening | loading需提前、每个await核代；isOpen当前仅player非空，不识别loading |
| `D:/DEV/prism-play/src/player/prism-player.ts:182–215,231–254` | 兜底结束与新增订阅错配；load先改集号后换源 | 旧媒体读数污染新集风险，只有最终await后核token不够 |
| `D:/DEV/prism-play/src/player/engine-seam.ts:16,32–43` | MediaEvent闭集，回调无源身份 | 仅当前token不能证明迟到事件归属；需最小扩展可验证接缝 |
| `D:/DEV/prism-play/src/player/art-engine.ts:37–85` | 懒载Artplayer/HLS，原生video事件转发、换源/错误 | 真实event、source/内核代次关联应从实际适配层验证 |
| `D:/DEV/prism-play/src/player/progress-reporter.ts:45–57` | 读取当前episode与媒体读数；duration缺失用position | HP-01禁止以position冒充duration，必须同时修上报边界 |
| `D:/DEV/prism-play/src/views/home-view.ts:80–99,126–131,176–204,236–271` | 单频道分页、确定性weave、本地先显；读取历史 | 无全库选择/新轮次/曝光；不能只换常量宣称综合首页完成 |
| `D:/DEV/prism-play/src/views/home-repeat.ts:9–37` | 连续目标序列、single-flight、代次失效，无时间窗 | 第二个相同目标即刷新，即使相隔很久；sync失败不reload |
| `D:/DEV/prism-play/src/views/home-topology.ts:68–99` | 开榜hidden切换、仅传channel | 没独立Layer，category未进入ranking接口 |
| `D:/DEV/prism-play/src/views/rankings-rail.ts:47–62,119–162` | 热度/日期筛选排序截20，公开与频道过滤 | 原始hitsTotal比较不证明跨源公平；缺category输入 |
| `D:/DEV/prism-play/src/core/recommendation.ts:23–31,53–68,146–232` | 7/7/6、历史衰减、块内确定性编织 | 不是20/4＋12/6/18；旧画像可复用但不可称完整偏好学习 |
| `D:/DEV/prism-play/src/core/native/back-button.ts:21–32,96–126` | Layer/Dialog/Page，注册注销及popstate抑制 | 新榜单/加载宿主复用，不另造返回系统 |
| `D:/DEV/prism-play/src/core/api/title-detail.ts:16–44` | 验证清单并标记local episode id | 不同work同集号隔离，新清单空线不许旧ID兜底 |
| `D:/DEV/prism-play/edge/src/types/api.ts:20–48,197–203` | 频道名/身份、ContentItem与revision/pageSize | 暂无展示tags、年份/地区/语言/口碑证据字段 |
| `D:/DEV/prism-play/edge/scripts/library-catalog.mjs:59–103` | 从原料组目录，简介短化、hits等可选 | 有原料不等于字段已保真投影；须统计供应覆盖 |
| `D:/DEV/prism-play/edge/scripts/compute-hotscore.mjs:68–92,216–251` | 30字简介、分类/AI辅助正则、旧热分 | 标题AI正则不能作新推荐唯一资格证据；旧热分不是已确认新算法 |
| `D:/DEV/prism-play/edge/src/library/work-facts.ts:20–47,49–71` | 公开fact校验、hash/bytes/flags与投影 | 新字段还要穿过解析器，不能只改DTO或seed |
| `D:/DEV/prism-play/src/components/poster-grid.ts:176–195` | 主分类与现有synopsis文本渲染 | 尚无多副标签及新元信息渲染 |

### 2.3 实现事实、产品决策、缺口分别记账

- **产品确认**：HP中的20 AI/4精选真人、60展示单位、独立首页、公开四频道、真正发现刷新、二级分类榜、视觉与诚实元信息是需求，不需再请Master设计普通工程参数。
- **工程参数待校准**：真人合格阈值/口碑来源、跨源热度标准化、曝光可见比例/停留、双击时间窗、文本体积和Token尺寸。不得用旧0.6/0.2/0.8热分权重或“数字越大越好”直接锁定跨源选择。
- **数据缺口**：展示tags/元信息/口碑证据链缺失；未接曝光；简介被30字截断；isAi可能含历史片名辅助猜测。源码存在profile函数只证明有历史题材分，不证明曝光、真实喜好或质量完整。
- **配额与回退边界**：Master提出20 AI／4强口碑强热度真人；Agent建议优质真人不足时补给AI，Master随后认可方向并要求形成文档。HP-05保留这一最小回退，但不扩大为任意自动调比：不能强凑低质量真人，回退必须登记实际配额偏差；所有候选不足时允许尾页不足60。评分公式与具体资格阈值仍须据真实数据制定，不把建议参数伪装成已批准数字。

## 3. 行为SPEC

本轮编号使用HP-01～HP-12，不挪用既有AC编号或把旧矩阵通过视为新行为通过。

### HP-01：真实结束与多集播放

- 仅显式ended事件可以进入自然结束判定，其他事件必须显式处理或忽略，禁止兜底触发结束。
- playing／seeked用于控件恢复与播放状态，不加载下一集。
- 换集／换线清理本代结束与首帧状态；以实际媒体证据隔离旧源迟到事件，一次自然结束最多推进一集。
- 自然结束时媒体通常已暂停，不能要求playing=true才允许ended。
- 未起播、空线路、播放错误不自动扫完整部剧；呈现错误、重试或择源状态。
- 新集的进度不得借用旧集位置／时长写成完播；时长未知不以当前位置冒充总时长。

### HP-02：热门榜返回与生命周期

- 打开热门榜注册返回Layer；系统返回、手势返回及Escape优先关闭榜单。
- 关闭、离页、销毁注销Layer，恢复展开前焦点；不触发应用退出提示。
- 同一榜单不能重复注册；搜索、播放器等更高层打开时遵循既有返回栈顺序。

### HP-03：点击立即进入

- 点击剧目后，在任何偏好或网络等待前展示无元信息加载宿主，并注册返回入口。
- 详情、授权及线路异步处理；每次await后核对打开代次，返回取消使旧结果不可提交。
- 未验证私密／未知身份前不从卡片提前展示受保护标题或海报；无权与未知遵循同等错误边界。
- 连续点不同剧目仅最新操作生效；加载失败显示重试及返回，不留空壳或不可关闭遮罩。

### HP-04：导航与综合首页

- 顶部固定公开顺序：**首页｜精彩短剧｜电影仓库｜纪录片｜动漫**。
- 启动默认首页；底部仍为精选／追剧／我的，精选承载上述顶部导航。
- 新展示名称保留原频道内部身份：drama／movie／documentary／anime，不通过名称拼接请求ID。
- 首页没有虚构二级来源分类；既有四频道保留其真实二级分类与频道榜单。
- 首页推荐跨公开频道读取完整候选池，不能只取当前频道第一页后假装综合推荐。

### HP-05：60条推荐与20 AI／4精选真人

| 独占推荐轨 | 每个完整60条推荐页的目标 |
| --- | ---: |
| AI短剧 | 20 |
| 严格筛选的真人短剧 | 4 |
| 电影 | 12 |
| 其他公开内容：纪录片＋动漫 | 6 |
| 跨公开频道个人偏好 | 18 |

- 合计60，对应短剧24／电影12／其他6／偏好18，即4:2:1:3。
- AI只认有依据的类型字段；不得靠片名、海报或缺失字段猜测。
- 真人4席优先可信口碑与高热度候选。没有评分／口碑证据时不能称口碑优秀；仅有点击量不等于高质量。
- 实施前核查真实指标、历史用户信号与可用候选，形成可测试的筛选规则；指标权重及资格阈值是待证工程参数，不作为用户已经批准的数字。
- 高质量真人不足不强凑普通作品，可以补给AI轨；仍不得伪造类型。其他轨不足时明确记录实际配额偏差，以剩余公开可用候选补齐，无候选则返回不足60的尾页。
- 所有轨全局去重，个人偏好轨从尚未选中的公开候选中取；前三类也可按兴趣排序。
- 新用户无画像时，偏好席使用有依据的热门与多样性探索，不宣称已懂其偏好。
- 纪录片／动漫的6席兼顾两个频道，避免单一频道长期独占；不擅增复杂自动调比机制。
- AI与真人配额仅约束首页短剧24席，不机械套到18个偏好席或普通频道目录。
- 推荐内部分页生成复用60条展示单位；各频道R2传输分片仍是原60条，不把推荐页与单个云分片等同。

### HP-06：发现式刷新

- 刷新含检查可获得的内容更新、读取本地候选、利用个人偏好与已曝光信息重新选择编排，不能只是同步修订号或重画旧列表。
- 当前一级／二级标题第一次重复点击回顶部，短时间再次点击刷新；具体时间窗口集中定义并测试，不向用户反复询问基础操作参数。
- 页面顶部下拉刷新使用同一入口，仅顶部且无横向手势／浮层冲突时响应。
- 显式刷新建立新的推荐轮次；同轮加载更多不重排已展示条目，不跨页重复。
- 曝光只记录实际展示的公开内容，不能把预取整库算作曝光；复用现有画像，必要新增存储须先补契约。
- 弱网／断网仍能用本地数据重新推荐；联网同步失败与本地推荐成功分别反馈，不能混成假新增。
- 明确展示刷新中、已完成／没有新内容、离线重新推荐或失败；不能承诺每次每张都不同。
- 热门榜刷新重读真实热度；无指标变化时排名允许不变，不随机洗牌。

### HP-07：频道＋分类热门榜

- 榜单位置保持现有展开区，不替换成另一个独立页面。
- 全部＋热门榜＝频道总榜；逆袭＋热门榜＝当前频道逆袭榜，其余分类同理。
- 切分类保留开榜状态，即时更新标题、范围、排名；切频道按现有导航规则清理旧状态。
- 从完整当前可见候选中先按频道／分类筛选，再按热度排序和截取，不从总榜前20名中过滤。
- 热度依据可信源推荐、点击、播放量等；核查字段口径和跨源可比性，不能自行混加不同单位。
- 个人偏好不伪装成公共热度；isHot仅标签，不作为唯一排序依据；ID仅用于同分稳定收口。
- 缺热度、空分类与部分缓存提供诚实空态／覆盖说明，不编造名次或实时榜名称。

### HP-08：全屏限定的紧凑透明控制层

- 非全屏不显示画面内悬浮条；详情操作区及媒体基本播放／进度功能仍可达。
- 全屏才显示透明紧凑控制层，取消横贯实心背景与常驻大状态胶囊。
- 图标采用16／20／24px Lucide；视觉紧凑，透明命中区仍至少44px，不将视觉高度与触区高度混淆。
- 正在播放自动隐藏，暂停／缓冲／拖动／菜单展开保持可操作，退出全屏取消残余隐藏计时。
- 状态名称通过菜单、操作反馈或无障碍名称提供，不靠一整条文字占画面。
- 保留数字选集与30集分段，非全屏在视频下方，横屏抽屉给视频让位；不回退已修分层与安全区。

### HP-09：收窄底部导航

- 精选／追剧／我的的背景承载区及内容一起收窄居中，不仅限制按钮内容、背景仍全宽。
- 图标和文字适当靠下，外壳／底栏只由一处计算底部安全区，避免重复留白。
- 小屏、横屏、大字体、手势导航与三键导航分别验证；不侵占系统手势区、不覆盖列表最后一项。
- 宽度／留白以Tokens表达，先真实视口样稿校准，不从截图像素直接当CSS值。

### HP-10：海报密度与类型角标

- 双列、三列、多列统一缩小横纵间距，并核查卡片描边、底版、内边距，避免叠加浪费。
- 第一版可用现有4px间距Token做样稿起点；这是工程试验值，不是已批准最终尺寸。
- 图片比例、文字可读性及点击准确性不能因密度提升退化；不将导航按钮的触区间隔一并压缩。
- 所有公开展示将AI精品改为 **Ai剧**；只认有依据的isAi，不把制作类型说成精品质量。

### HP-11：列表简介与可信元信息

- 有简介展示真实摘要，列表右侧利用合理行数；不得为沿用30字截断而制造大面积留白。
- 采集／打包保留可用简介，明确列表摘要与完整详情的边界及体积上限，不直接无界扩大种子。
- 无简介时展示有依据的年份、地区、语言等，缺字段则省略；无可用信息时压缩信息块而不编文案。
- 日期／年份、地区、语言须贯通原料→目录→事实→搜索投影→端侧展示，不能只写入UI夹具。

### HP-12：主分类＋多个副标签

- category仍为主分类／筛选口径；新增有来源依据的副标签用于题材与风格展示，不改分类请求身份。
- 标签去重、去空、剔除外部品牌与无意义词；不把原料“短剧／漫剧”等制作类型自动当多题材证据。
- 不凭片名猜标签，不用搜索词集合冒充展示标签，不为了数量强造多个标签。
- 数据模型与上限先在OpenAPI／API-SPEC／类型中同步；目录、facts、search、seed、本地索引和渲染一致传递。
- 空标签可正常展示，禁止把源数据缺失当成界面已实现就算完成。

### 3.1 统一状态机与结束守卫（B1/B2必须落地）

```text
宿主 closed -> loading(openGeneration) -> ready -> error/retry
          ^       | cancel/back/new open/destroy      |
          +-------+-----------------------------------+
媒体 unavailable -> loading(sourceGeneration) -> started/首帧 -> ended/失败
                        | 换集/换线/销毁：旧代失效；首帧/结束消费清零
```

宿主创建loading必须在第一个await之前，只有无元信息标题/骨架与返回；不能把deps.titleOf或卡片缓存当受保护身份已验证。每次open建立唯一代次，close即取消并释放Layer、计时、菜单、orientation与旧引用；不能await晚到后补回画面。冷启不恢复loading、开榜、推荐在途操作或私密开启状态。

Ended guard至少核对：实例存活、实际源/内核代次归属、当前work＋episode、当前代确已起播证据、该代尚未消费结束、显式ended。不能只检查playing=true（自然结束通常false），不能只看当前闭包token而无法识别旧video/source事件。valid ended先消费一次，再异步自然间隙；await后再次核代才加载下一集。失败/重试/换线不调用自然结束，手选集也不触发自然间隙提醒。允许使用最小接缝携带事件源证据或重绑独立内核，但B1须证明真实来源隔离，不武断预定某一实现。

进度提交需绑定产生读数的作品/集/源代次；换源前可保存旧集有效断点，新集源未就绪不发借来的旧duration/position。未知总时长用既有未知语义，不能填position制造100%；有限数/负值/NaN都要校验。真实观看计时沿用实际playing＋首帧＋单调时钟，seek/倍速位移不产生时长，私密/unknown零profile/零曝光/零同步日志。

### 3.2 推荐、频道刷新与公平排名的实施约束

- 推荐输入必须记录公开候选覆盖（完整或部分）、内容revision、可用类型证据、profile是否有效及轮次；先统一去private/撤片/重复workId，再分配独占轨。重复作品跨轨只占一次；同名异剧无可信归并不能互相删掉。
- 先为具有足够合格供应的轨预留额度，再从未选候选补位；20/4/12/6/18只对供应足够的完整推荐页严格断言。第18偏好轨可含AI/真人但不反向挤掉预留24席；需同时记主供给轨与制作类型，不能靠渲染角标倒算配额。
- 缺额应记录requested/actual/deviation和依据。真人不足补AI采用§2.3的最小回退，其他补位优先级需按真实可用供给集中定义并登记；不扩展成自动动态调比产品。候选不足60正常尾页，不重复作品补满；不在普通频道目录套综合配额。
- 本频道/本二级分类刷新也是本范围候选＋公开profile＋真实曝光的发现feed重选，不是仅首页可刷新，也不是把公共热门榜随机洗牌。分类切换是新范围加载，重复点击才按首回顶/窗内再次刷新判定。
- 同轮冻结已展示选择和顺序；loadMore不回算前页；背景同revision不应重排。新revision处理须有明确轮次/一致性策略，不能一个推荐页混代；更新失败保留上一可用快照。
- 源热度需先核验字段单位、统计窗口、更新时间、累计/周值、是否真实零、是否来源内排序或推荐证据，再决定可比池/规范化；点击与评分不同，口碑评分需有量纲/样本量/来源证据。没有可比证据不能全源直接比绝对hits或把isHot当高口碑。
- 可选择来源内分位/分源候选后公平合并等方案，但选择前均为建议，不设未经证实的评分公式/真人分数门槛；无口碑字段必须标“口碑证据不足”，不假装4席都优秀。
- 五个公开顶部展示项中首页是本地视图，另外四项必须与云ChannelItem.name配置/契约协调变更；保留channelId与真实categories，不造 `/api/channels/home`、mix频道或前端伪API。私密原准入入口保留但不是固定公开导航的第六项。

### 3.3 元数据与曝光契约（2026-10-05 B0已选定文本边界；曝光阈值待定）

现有 `ContentItem` 只有synopsis/category/isAi/isHot/firstPublishedAt/hitsTotal等；搜索投影中的tags是检索词，不天然等于展示副标签；现有category部分来自归一推断，必须标明其来源可信度，不能把它当原料多个题材的证明。

| 字段 | 语义/证据 | B0选定边界（240/年份/64/标签6×12） |
| --- | --- | --- |
| synopsis | 清洗后的真实列表摘要；完整详情另设边界 | 摘要上限240 Unicode code points；真实体积与完整generation校验后才可发布 |
| tags?: string[] | 展示题材/风格，来源字段映射；非搜索词堆 | 最多6个、每个最多12 Unicode code points；仅可信受控题材/风格，去空/同义重复/外部品牌/URL；不足不造 |
| releaseYear?/region?/language? | 原料可核验年份/地区/语言，非打包时间 | 年份只从明确四位`vod_year`字段映射为整数；region/language各最多64 Unicode code points；不能用上架/采集时间冒充 |
| metadataProvenance? | 内部字段来源、规则版本/证据引用 | 可选、内部保留为主；公开仅抽象编号/可信说明，不泄露上游品牌/地址 |
| reputation evidence | 真人口碑资格证据，非isHot | 来源、评分量纲/样本/时间先调查；未选定不发明公网rating接口 |
| exposure record | workId、轮次、公开身份、实际可见证据 | 进程内有界集合起步；持久化/TTL/容量须先立存储契约，禁止借profile日志保存private |

B0选定的文本边界统一放一个共享策略定义，类型/打包/校验/渲染和测试引用同口径；不是各模块再写240/6/12。可见曝光以IntersectionObserver真实视口、前台未被遮挡、比例/停留达标判定；具体比例/停留仍是待定工程参数，预取/骨架/隐藏榜/屏外卡/背景页不记。Observer销毁注销，重复visible幂等，private/unknown在入口拒绝且不输出身份日志。无需新用户行为上报API或重建完整画像系统。

元数据验收从真实可追溯原料抽样开始：原料→归一→catalog/facts/publicSearch/bundle→seed/缓存/index→DTO/parser→实际列表。旧记录新字段可缺省，空synopsis/tags压缩信息块；渲染用安全文本而非执行原料HTML。生成库保留媒体地址为内部资产，公共seed仅公开目录，不为补简介导出整个SQLite。新增字段不得无界增长，继续20 MiB目录、512 KiB facts pack、64 KiB manifest及16 MiB内部publicSearch既有约束；超限拒绝发布不截集。

## 4. 分批执行计划

| 批次／依赖 | 实施范围（现有路径优先） | 失败回归与完成标准 |
| --- | --- | --- |
| B0 契约（文档同步已做／门禁待跑） | 正本、PRD、UIUX、API-SPEC、openapi.yaml、设计Tokens | 已同步HP独立编号、频道/推荐/刷新/视觉和元数据规则；`verify:contracts`与`verify:acceptance`未获执行，故B0不签署通过。本文件HP编号不是旧AC自动通过依据。 |
| B1 播放P0 | `src/player/prism-player.ts`、`engine-seam.ts`、`art-engine.ts`、`progress-reporter.ts` | playing／seeked不换集；有效ended只推进一次；旧源迟到、重复ended、未首帧、错误／暂停、未知时长不污染历史。先红再绿。 |
| B2 返回与立即进入 | `src/views/home-topology.ts`、`rankings-rail.ts`、`src/player-host.ts`、既有返回总线 | 开榜返回仅关榜；延迟runtime／详情前已经有loading宿主；取消／乱序／404不漏内容、不留旧Layer。 |
| B3 元数据契约与链路 | `edge/src/types/api.ts`、`edge/scripts/library-catalog.mjs`、`compute-hotscore.mjs`、事实与搜索投影模块、客户端DTO | 同源字段保真、长简介合理保留、标签空态和去重、恶意文案安全、公开私密隔离、旧记录缺新字段可读取。 |
| B4 综合首页与推荐 | `src/core/recommendation.ts`、`src/views/home-view.ts`、`home-topology.ts`、`src/main.ts` | 60条配额、20AI／4合格真人、全局去重、不足补位、新用户、尾页及非首页目录互不污染。真实供给与热度不足诚实报告。 |
| B5 刷新与分类榜 | `home-repeat.ts`、`home-scroll.ts`、`rankings-rail.ts`、首页和宿主接线 | 短时再次点击／下拉共用入口；同修订仍重新推荐；曝光降重；同轮追加稳定；分类先过滤后排；断网与同步失败如实反馈。 |
| B6 视觉与列表 | `src/player/player.css`、控件渲染模块、`src/styles/app.css`、`home.css`、`src/components/poster-grid.ts`、角标模块 | 非全屏无悬浮条，全屏透明可达；底栏背景收窄／安全区唯一；各海报模式密度；Ai剧；简介及多标签真实显示。 |
| B7 集成与交付 | 测试、浏览器、Android构建、验收包 | 所有前批通过后统一出包；不为出包跳过测试；官网和版本公告等待Master明确通过。 |

每批：读取最新状态→写失败用例→确认因目标行为失败→最小实现→相关测试→审查实际差异→登记结果。禁止用一次巨大代理任务涵盖全部模块；跨模块接线由主会话复核。

### 4.1 批次输入、输出、责任与红绿命令

以下owner是职责角色，不是新增代理任务；Agent主会话负责跨模块审查。路径均以 `D:/DEV/prism-play/` 为根；执行命令工作目录必须为该根，测试过滤路径为仓库相对参数。先在已有测试追加HP用例，单文件将超300行才拆必要测试文件，并登记新绝对路径。当前轮次不运行这些命令。

| 批 | 输入/依赖与owner | 精确文件范围（相对根定位） | RED→GREEN命令与输出 |
| --- | --- | --- | --- |
| B0 | 已确认HP＋本地证据；契约Agent | `docs/04-spec/SPEC-v2.0.md`、三轨SPEC、`SPEC-v2.6.3-REPAIR.md`、`REPAIR-v2.6.2-PLAN.md`、`docs/01-prd/PRD-prism-play.md`、`UIUX-design-system.md`、`docs/03-contracts/API-SPEC.md`、`openapi.yaml`、`src/styles/design-tokens.css` | `npm run verify:contracts`＋`npm run verify:acceptance`；先证明旧口径冲突而非改测试遮盖，再同步后退出0。输出冲突/参数决策表，不能凭静态绿标功能完成 |
| B1 | B0结束事件/身份契约；播放器Agent | `src/player/prism-player.ts`、`engine-seam.ts`、`art-engine.ts`、`progress-reporter.ts`；`tests/client/player-repair.test.ts`、`32-player-integration.test.ts`、`62-player-direct-playback.test.ts`、`player-harness.ts` | `npm test -- tests/client/player-repair.test.ts tests/client/32-player-integration.test.ts tests/client/62-player-direct-playback.test.ts`；红灯必须是playing/seeked推进、重复/旧源结束或进度污染；绿灯所有新序列通过，输出真实媒体待验项 |
| B2 | B0；依赖B1绿色后集成播放器；宿主/返回Agent | `src/player-host.ts`、`src/views/home-topology.ts`、`rankings-rail.ts`、既有`src/core/native/back-button.ts`接线；`tests/client/51-player-host.test.ts`、`19-back-button.test.ts`、`home-repair.test.ts` | `npm test -- tests/client/51-player-host.test.ts tests/client/19-back-button.test.ts tests/client/home-repair.test.ts`；deferred runtime/title未resolve前应已有loading与Layer；返回后迟到不得重新开；开榜消费返回且注销计数复原 |
| B3 | B0字段边界＋可追溯原料；数据/契约Agent | `edge/src/types/api.ts`、`edge/scripts/library-catalog.mjs`、`compute-hotscore.mjs`、`public-search-projection.mjs`、`work-fact-packs.mjs`、`package-and-publish-library.mjs`、`edge/src/library/title-asset.ts`、`work-facts.ts`、`edge/src/http/serialize.ts`、`src/core/api/title-detail.ts`；`tests/edge/library-package.test.mjs`、`public-search-projection.test.mjs`、`tests/client/17b-seed-bundle.test.ts` | `node --test tests/edge/library-package.test.mjs tests/edge/public-search-projection.test.mjs`＋`npm test -- tests/client/17b-seed-bundle.test.ts`；原料长简介/标签贯通前红、修改后绿；旧字段缺省/私密不入公开/超限拒绝均通过。输出真实覆盖率不是UI夹具数量 |
| B4 | B0导航与配额＋B3可用证据；推荐Agent | `src/core/recommendation.ts`、`src/views/home-view.ts`、`home-topology.ts`、`src/main.ts`、`src/components/channel-bar.ts`；`tests/client/25-recommendation.test.ts`、`22-home-view.test.ts`、`26-corner-badge-home.test.ts` | `npm test -- tests/client/25-recommendation.test.ts tests/client/22-home-view.test.ts tests/client/26-corner-badge-home.test.ts`；供应充足严格配额/跨轨去重/首页默认前红后绿；不足、旧无新字段、部分池、尾页、跨页稳定全绿。输出选择轨计数/偏差及revision轮次 |
| B5 | B4轮次＋B3指标；首页/榜单Agent | `src/views/home-repeat.ts`、`home-scroll.ts`、`rankings-rail.ts`、`home-topology.ts`、`home-view.ts`、`src/main.ts`；`tests/client/home-repair.test.ts`、`27-home-lifecycle.test.ts`、`22-home-view.test.ts` | `npm test -- tests/client/home-repair.test.ts tests/client/27-home-lifecycle.test.ts tests/client/22-home-view.test.ts`；同revision有效发现/分类先筛再截/窗外不刷新先红；离线本地成功/网络失败反馈/曝光只真实可见/销毁不回写后绿 |
| B6 | B2/B3/B4/B5已稳定；视觉Agent | `src/player/player.css`、`hud.ts`、`controls-idle.ts`、`src/styles/app.css`、`home.css`、`design-tokens.css`、`src/components/poster-grid.ts`（角标定义亦在此，不新造corner-badge模块）；`tests/client/controls-idle-review.test.ts`、`53-fullscreen-aspect.test.ts`、`59-episode-controls.test.ts`、`21-poster-grid.test.ts`、`50-app-shell.test.ts` | `npm test -- tests/client/controls-idle-review.test.ts tests/client/53-fullscreen-aspect.test.ts tests/client/59-episode-controls.test.ts tests/client/21-poster-grid.test.ts tests/client/50-app-shell.test.ts`；非全屏无chrome、退出取消timer、元信息渲染先红后绿；必须再做有效浏览器几何/截图，文本断言不能交付视觉 |
| B7 | B0–B6证据齐且云/构建授权；集成发布Agent | 现有测试、`public/seed/`、`android/app/src/main/assets/seed/`、`.github/workflows/android-build.yml`、`android/app/build.gradle`仅核查既有签名/构建 | §5全量门禁全部退出0→浏览器真实媒体→CI构建→APK核验→Master；官网保持不变。CI配置若需修改另审，不借本计划更改权限/密钥 |

每批输出：实际改动路径/LOC、目标红灯断言和原始失败原因、绿灯命令/退出码/用例数、未验真实事项、下一批输入。依赖只满足部分时允许停在该批，不让缺口跨批伪装完成。新测试署名HP，旧AC有效回归继续保留；保留旧用例含义或在B0明确迁移，不能删除断言使门禁绿色。

### 4.2 新Agent可复现启动流程

1. 确认本次授权是文档还是实施；本文件不自动扩大授权。根目录、历史三面基线、当前待验图先登记，保护现有工作，不reset/clean/覆写旧包。
2. 完整读本文件，按§2.2重新核目标符号/行号；变动后重新登记证据。引用正本用于B0差异审查，不需寻找上一段聊天才能得知需求。
3. 仅在允许本地门禁时，读取 `D:/DEV/prism-play/package.json` 与锁文件核命令；Node22、Python及依赖是否就绪先检查。已有依赖优先复用；`npm ci`需要安装/网络授权，不在离线任务擅自执行。
4. 先B0，后B1/B2核心闭环；B3供给事实先于B4质量筛选，B4稳定轮次先于B5刷新，B6消费已稳定状态，B7集中交付。不是看到一张截图就抢先改CSS。
5. RED可用deferred promise、注入时钟、明确事件序列和可追溯原料夹具；命令须因目标断言失败，不接受“包没装/文件不存在”作为红灯。GREEN记录退出码，不通过管道截尾掩盖失败。
6. 目标测试通过后跑相关回归＋全量门禁；真实媒体/布局/Android能力分层补证。没有真实样本时记录阻塞，不借替身通过宣称真机通过。
7. 收尾只汇报当前批结果/地图/缺口，Git提交推送、云发布、CI触发、下载和官网推广分别遵循明确授权，不自动动作。

### 4.3 B0冲突同步与HP追踪表

本次不改下列正本；表中“同步”是后续工作。既有AC编号保持历史含义可追踪，不把HP直接重命名为旧AC。必要新增正式验收编号须遵守SPEC唯一编号源并同步PRD/门禁。

| HP | 旧AC/R26关联 | 直接冲突/需同步清单 |
| --- | --- | --- |
| HP-01 | AC-09/11/30；R26-02/06/11 | playing/seeked不是ended、源代次和进度/首帧；SPEC/修复SPEC/计划/测试与真实计时说明 |
| HP-02 | AC-21；R26-07/08 | 频道热门榜加入Layer生命周期；三轨App/PRD/UIUX返回矩阵 |
| HP-03 | AC-03/15/21；R26-02/06 | 点击可见加载和真实起播耗时分开；无身份loading/取消/404；PRD/UIUX/修复文档 |
| HP-04 | AC-01/25；三轨A-4 | AC-01默认drama改默认综合首页；真实频道name顺序与云配置协调；不能增加假频道API |
| HP-05 | AC-28；三轨A-4/旧v2.5§1.8 | 旧20块7/7/6与新60配额冲突；SPEC/PRD/UIUX/推荐测试、真人证据资格与回退决策 |
| HP-06 | R26-07；AC-18/28/30 | 旧连续无时间窗/仅同步不是发现；保留缓存同步/曝光/轮次语义，profile不可混同曝光 |
| HP-07 | R26-08；三轨A-3 | 补category输入/先过滤再limit、公平指标；API-SPEC/OpenAPI只在确需新增字段时同步 |
| HP-08 | AC-19/20/21；R26-05/06 | 旧非全屏常显chrome注释/工具条与新无悬浮条冲突；基本操作另可达、选集/宿主单权威保留 |
| HP-09 | AC-27；三轨A-3 | 旧仅内容限宽360不等于背景承载收窄；UIUX/Tokens/外壳测试安全区唯一 |
| HP-10 | AC-04/29；三轨A-4 | 旧6–8px与试验4px区别；AI精品→Ai剧、可信类型而非质量；Tokens/PRD/UIUX |
| HP-11 | 三轨云§3.1≤30字；R26-02/12 | 长简介/日期地区语言缺口；SPEC/三轨/PRD/UIUX/API-SPEC/OpenAPI/DTO/事实解析器同口径 |
| HP-12 | AC-16/17；R26-01/02/12 | 检索tags不等于展示tags；新增可选字段及来源/上限/旧代兼容，数据链/模型/测试同步 |

R26既有真实计时禁止click/position/seek伪计时、私密零计、云配置提醒仍有效；修点击响应不能把loading开始记成播放时长。B0变更日志逐条登记日期、原因、受影响路径、参数批准/建议状态，不能把旧30AC矩阵覆盖率称HP通过。

## 5. 验证矩阵与命令

### 自动门禁

```bash
npx tsc --noEmit
npm run typecheck
npm test
node --test tests/edge/*.test.mjs
npm run scan:p0
npm run verify:contracts
npm run verify:acceptance
npm run verify:android
npm run build
```

- 使用新增独立测试记录HP用例，不挪用旧署名制造通过；不能用管道截尾掩盖前置命令失败。
- 既有重点回归：`tests/client/33-player-interaction.test.ts`、`53-fullscreen-aspect.test.ts`、`59-episode-controls.test.ts`、`controls-idle-review.test.ts`、`51-player-host.test.ts`、`22-home-view.test.ts`、`home-repair.test.ts`、`25-recommendation.test.ts`、`26-corner-badge-home.test.ts`、`21-poster-grid.test.ts`、`50-app-shell.test.ts`。
- 元数据传递必须增加原料→打包→DTO／种子→真实渲染的集成回归，不能只注入虚构tags测试UI。

### 5.1 Given/When/Then验收矩阵（全部本轮待执行）

每行含正向及负向/边缘，不能只做happy path。G＝Given、W＝When、T＝Then；用例按HP编号独立登记，复用旧测试文件但不沿用旧通过声明。

| ID | Given | When | Then（正向） | 负向/边缘必验 |
| --- | --- | --- | --- | --- |
| HP-01a | 公开35/120集真实可播清单，当前第一集 | 原生loadedmetadata→play→playing→timeupdate及seeked | 集号不变、真实画面/进度正常 | waiting/seeking/pause/error/seeked不自然换集；起播错误不扫剧 |
| HP-01b | 当前代已首帧并播到自然结束，playing可能false | 发一次/重复ended | 只下一集一次，进度归旧集，最后集不再推进 | 未起播ended/旧源迟到/换线旧回调拒绝；自然间隙await期间手选/退出不能旧结果接管 |
| HP-01c | A作第3集→B作第3集或同作换集 | 新源未metadata前发生pause/timeupdate | 不把A源读数写到B；work＋localepisode区分 | 未知duration、NaN/负值、空线路、缺号、合集一集、不存在集都不制造完播/旧proxy兜底 |
| HP-02a | 首页榜单关闭，返回层数已记录 | 开榜后系统Back/手势/Escape | 仅关闭榜单、焦点还原，不退App | 重复开不多注册；更高搜索/播放器先消费；同层LIFO |
| HP-02b | 榜单打开 | 手动关/换频道/离页/destroy/popstate | Layer计数归基线，history不双退 | 新页面返回不被旧榜单消费；冷启无开榜残留 |
| HP-03a | runtime/title人为延迟，未resolve | 点击作品 | 第一个await前无元信息loading与返回可见 | titleOf/卡片受保护标题/海报不预泄漏；冷启runtime慢同样可返回 |
| HP-03b | loading中或A/B请求乱序 | Back、连点B、失败/404、重试 | 取消旧代，仅最新可提交；错误可重试可返回 | 每个await后取消、scope失败/空episodes、destroy、旧结果迟到均不留Layer/不可关闭空壳 |
| HP-04 | 有四公开频道快照和部分/完整候选 | 启动/切五导航项 | 默认首页且公开顺序正确，频道ID/分类真实 | 缺频道不伪补数据/API；private不进首页；旧收藏/搜索/三底Tab不退化 |
| HP-05a | 足够有类型/口碑/热度证据的公开候选，profile有效 | 生成完整推荐页 | 独占轨20/4/12/6/18合计60、work去重 | 偏好18可含AI但不偷24席；跨页不重复；普通频道不强套配额 |
| HP-05b | 真人证据/供应不足，零profile或仅部分缓存 | 刷新/尾页 | 如实偏差/覆盖，按获准回退补位或不足尾页 | 不强凑差真人、不伪口碑、不猜AI；有相同片名不同work保留；没有新供给不保证全换 |
| HP-06a | 同revision足够本地候选，已有真实曝光 | 当前一级/二级首重复、窗内再重复/顶部下拉 | 首回顶、再刷新；同入口新轮次按范围/profile/曝光重新发现 | 窗外重复只回顶；切新类正常加载；非顶下拉/横滑/浮层冲突不误刷 |
| HP-06b | 当前轮第一页已显示 | 普通滚动loadMore/背景同步/多次刷新 | 已显示不重排、同轮无重复，刷新single-flight | 导航/销毁取消迟到；网络失败仍可本地发现并分别反馈；空缓存诚实失败 |
| HP-06c | DOM含visible、屏外、hidden、预取及private夹具 | 观察可见/遮挡/后台/重复visible/destroy | 仅真实公开可见达到选定边界记曝光，幂等注销 | 不把整库/骨架/日志记profile；私密身份零曝光存储/零日志；viewport0×0不能判通过 |
| HP-07a | 分类候选在频道总榜20名以外 | 开全部榜后切逆袭/其他分类 | 先筛完整范围再排序limit，开榜状态保留，标题范围同步 | 不是过滤总榜20；切频道清旧；private/撤片/无证据候选排除 |
| HP-07b | 热度缺失/真实0/同分/跨源单位不明/部分缓存 | 排名与刷新 | 真0和缺失分开，同分稳定，覆盖说明；指标不变排名可不变 | 不随机洗牌/不称全网实时；不可比不默认绝对值大更好；偏好不混为公共热度 |
| HP-08a | 非全屏详情，基本播放/进度、选集入口可达 | 播放/暂停/进出全屏 | 非全屏无画面内chrome，全屏透明紧凑有44px命中 | Artplayer基本控件与自建chrome分别检查；不能删全控件导致无法播放/seek |
| HP-08b | 全屏playing，菜单/缓冲/seek分别发生 | 自动隐藏、打开选集/倍率/投屏、Back | 真playing才按规则隐藏，阻塞态操作可达；抽屉→全屏→宿主 | 退出清timer；竖屏不强横、横屏栏恢复；长按取消恢复、数字选集30段不退化 |
| HP-09 | 360/393窄屏、873横屏、大字与不同系统导航 | 显底栏/滚到末项/转屏 | 背景＋内容都收窄居中偏下，安全区只一次 | 小屏不溢出、三键/手势不遮挡、末项可达；不是只限按钮宽而背景仍全宽 |
| HP-10 | 四海报模式、平板多列、长标题、缺海报 | 切布局/点击卡片/贴类型角标 | 间距更密但图文清晰准确命中，Ai剧只可信isAi | 不压导航触区；无类型留白，不把真人/缺字段贴Ai；追剧/详情推荐共享海报也验 |
| HP-11 | 原料含长摘要/年份地区语言与恶意HTML/URL | 打包同代并在真实列表显示 | 摘要按选定上限保真安全，真元信息合理利用行数 | 空字段省略压缩；旧记录兼容；更新时间非上映日；超资产体积拒绝发布，不假数据填UI |
| HP-12 | 原料多个题材、重复空词/外品牌/无标签 | 归一/索引/seed/实际渲染 | 主category筛选不变，可信副tags去重且上限一致 | 搜索词/片名猜测/制作类型不冒充多标签；无源正常空态，private不进入公开字段链 |

### 有效浏览器与真实媒体

- 视口360×800、393×873、873×393，单集／35集／120集／缺号目录、大字体及长标题。
- 测量控件命中、抽屉交集、底栏安全区、网格间距／溢出、列表摘要与标签、榜单分类切换及返回。
- 媒体替身只证明几何与操作；多集播放必须追加真实媒体事件时序检查，不能再以不会发playing的假内核证明连播正常。
- 有效viewport和截图须记录；0×0窗口、CSS文本断言、构建成功都不构成视觉通过。

真实浏览器补证步骤：Agent在获准环境启动既有 `npm run dev -- --host 127.0.0.1`（本次不运行），使用已可用浏览器工具设置有效viewport，不临时下载测试工具冒充零网络。记录浏览器/WebView版本、viewport/DPR、样本workId/集号/线路代次、真实事件时间序列、首帧/自然结束、请求及截图。用真实HTMLVideoElement播放本地可授权媒体可验证事件；HLS/Artplayer生产适配还要实际清单/分片播放，不能仅dispatchEvent或注入fake engine。至少第一集实际播放到自然ended进入第二集，再seek后恢复，证明不会连续扫第三集；故障切线/旧回调与取消可注入受控延迟补测。

非全屏检查chrome不存在而媒体基本播放/进度仍可操作；全屏检查透明层、各控件命中rect≥44px、菜单与视频交集、退出计时器及方向恢复。底栏测背景rect与按钮rect、安全区只算一次；四模式测computed gap/实际卡片rect/横向溢出/最后一项可达。布局必须实际渲染，不能用0×0窗口、CSS关键词或mock尺寸作为唯一证据。

### APK唯一用户验收

Master仅验新版APK；Agent负责云端配套、构建、签名与资源核查。验收至少覆盖：多集真实播放／连播、热门榜关闭及分类榜、立即进入及取消、首页60条发现刷新、全屏透明控件、紧凑底栏和海报、列表元信息、Ai剧与多标签。

Agent交付短真机清单：覆盖安装→冷启首页/60构成→一级/二级重复点击与下拉→分类榜返回→点剧立即loading后取消→短剧及动漫真实连播/拖动→竖屏/横屏控制与选集→四模式简介/标签→追剧推荐海报。每项记录设备/Android版本、网络、APK身份/种子revision、实际结果及截图；失败项必须重开HP，不能拿旧completed任务或CI绿驳回真机反馈。Master不需要单独验收云命令和采集流程。

## 6. 数据、发布与验收登记

- 本文件不锁定下一包版本号；执行交付前确定可区分的验收包身份，保留旧包及签名。
- 数据字段或展示名变更须评估当前2.6.2／2.6.3读取兼容性，不单独发布破坏旧目录／搜索的Worker。
- 新公开数据同代校验后blobs先、manifest指针后；不将私密或含上游地址的SQLite整库放入公共种子。
- 官网正式下载包与版本公告保持现有状态，只有Master明确验收通过才更新；不能因GitHub出包自动推广。
- 内容来源覆盖差距、真实日更周期、公开／私密资源隔离仍是独立未闭环事项，不由本轮UI修复代替。

| 状态项 | 当前登记 |
| --- | --- |
| 产品认知与增量规则 | 本轮已整理；动态参数须证据校准，不等于代码实现 |
| 契约同步 | 待B0，旧正本／旧修复文档尚有与新规则冲突条款 |
| HP-01～12业务实现 | 全部待本轮实施与验证，不沿用上一包通过声明 |
| 自动测试／浏览器／真实播放 | 本轮未执行 |
| 新APK／Master验收／官网推广 | 本轮未执行／未通过／未授权提前更新 |

### 6.1 同代配套、兼容与CI出包顺序

1. 先记录当前有效manifest/Worker/正式包/验收包身份，保留旧可用数据及包；后续有云权限才读取生产，不凭历史rev3覆盖新代。新revision必须明确递增，来源证据不足的作品不得用空lines发布。
2. B3字段为可选增量，验证旧2.6.2/验收2.6.3忽略新字段或缺省读取；如解析器为闭集需先证明兼容。catalog、facts、publicSearch、bundle和两个seed使用同一构建输入、同一revision，校验hash/bytes/count/频道总数、公开无private、无媒体地址进入公共种子。
3. 云配套先上传并核验本代blobs，再更新manifest指针，Worker与投影协议配套；不能单独发搜索Worker或只更新catalog而facts仍旧。KV最后写是指针发布顺序，不是跨边缘节点瞬时原子保证；抽样读到不一致则停止推广并保留旧可用代。
4. 同步 `D:/DEV/prism-play/public/seed/` 与 `D:/DEV/prism-play/android/app/src/main/assets/seed/`，出包后还要核包内资源revision/count，不只检查工作区文件。内部含真实地址的SQLite不能被整包复制成公共seed。
5. 本机历史环境无JDK/Android SDK；Android编译采用既有 `D:/DEV/prism-play/.github/workflows/android-build.yml` 云CI，Node22/JDK21、全量门禁、Vite构建、Capacitor同步、assembleDebug、artifact。不要为本轮临时装本地JDK或另造打包管线。CI触发/提交推送需各自获准，本次均不执行。
6. workflow的 `publish_website` 默认为false，官网上传仅workflow_dispatch显式true才进入；验收构建必须保持false。成功artifact不等于官网已发布，也不等于Master已通过；正式推广还须同时核官网显示版本、下载内容与版本公告一致。
7. 从CI取得并保留新版APK的独立本地路径，不覆盖 `D:/DEV/prism-play/build/apk263b/app-debug.apk`。登记版本名/code、commit、CI run/artifact、APK SHA-256、体积、seed revision/count、证书指纹；下一包版本在交付前统一确定，不在此擅定为2.6.4。
8. 永久签名资产为 `D:/DEV/prism-play/android/app/debug.keystore` 与 `D:/DEV/prism-play/android/app/build.gradle` 既有绑定；证书SHA-256应为 `8B:C2:28:B3:D4:5E:2A:FA:0F:BA:9F:27:67:6D:13:B6:0C:D0:DC:FB:05:37:12:1B:F1:47:66:FF:E5:F4:D2:9D`。CI用 `apksigner verify --print-certs <APK绝对路径>` 核APK证书，不能只核keystore文件；指纹漂移即停止交付，不重生密钥/更改签名规避。覆盖安装保留历史/收藏还需Master真机验证。
9. Master明确验收通过后，在另行获准正式发布中更新官网下载包/地址与云版本公告；回滚需使用保留旧版本，不靠改同名包掩盖差异。新包未通过时官网2.6.2历史正式状态继续保持，不能自动宣布“发布完成”。

### 6.2 验收登记模板与证据层级

每批/每个HP至少填写下表；直接记录在获准的交付记录或审阅回复中，不能为本次擅建报告文件。

| 项 | 填写内容 |
| --- | --- |
| 核验时间/执行人/批次 | 日期＋时区、Agent职责、B编号；区分历史登记与本次复验 |
| 代码/云/包身份 | commit及实际diff；manifest revision/生成时间/hash；Worker版本；APK版本/code/SHA/签名/seed |
| 用例 | HP编号＋Given/When/Then、样本来源/作品/集号；正负边缘覆盖，不写只“回归正常” |
| RED | 命令、退出码、目标失败断言与原始输出；依赖/环境错误不是有效红灯 |
| GREEN | 同一目标命令、退出码/通过数、相关/全量回归；不得引用上一包1040项历史绿作今日绿 |
| 浏览器/真实媒体 | 工具/版本、viewport/DPR、首帧及事件时间序列、真实HLS/普通媒体区别、截图绝对路径 |
| Android/Master | 设备/系统/导航方式/网络/覆盖安装；Master原始结论与日期，未验填未验 |
| 残缺/阻塞/偏差 | 来源字段覆盖、口碑/热度可比证据、推荐实际配额/尾页、未通过项及下一动作 |
| 结论/授权 | 仅静态通过/单测通过/真实媒体通过/APK通过分别标记；正式推广授权独立 |

静态契约绿只证明规则一致；单元/替身绿只证明所建模型；浏览器真实媒体绿不证明Android原生；CI绿只证明构建门禁；只有Master新版APK明确通过才满足用户交付验收。每一层必须能追溯具体身份，不能混用不同commit/云代/包的证据。

### 6.3 独立未闭环与本轮不做

- 来源覆盖完整性：旧项目约70个“末世”结果、新seed部分合集、其他来源多集的差异，需要同标题/同源/合集对照；本轮不宣称已补完所有短剧，合集可播不证明多集源不存在。
- 超过第3集来源404、单集真实线路有效性等来源侧失败仍需逐作品/集/线路证据；HP-01事件bug修好不等于此类源故障修好，也不能把source404误诊为ended。
- 新facts日更真实CI周期、完整基库与当天touched区分、旧publisher拒覆盖保护，仍独立待闭环；有daily-facts模块或一代静态包不证明每日更新已运行完成。
- 私密资源真实bucket访问隔离、逐资源准入/撤销、私密HLS真机和CI secrets/备份仍独立门禁；不发布private objects，不把前缀当隔离，不因本轮公开推荐补存储泄露身份。
- 不新增支付/广告SDK、账号体系、动态调比例、完整机器学习画像、公开口碑伪API、桌面包、离线视频下载、原生HTTP拦截层或全局cleartext放行。
- 不改AGENTS/权限/敏感配置，不自动Git/云/官网推广。旧任务列表completed、关联修复文档、三轨“已就绪”字样都不能用来结清以上独立事项。

### 6.4 分批执行登记（本会话，Asia/Shanghai）

| 批次／时间 | 实际改动 | RED→GREEN证据 | 未验事项 |
| --- | --- | --- | --- |
| 基线复核 14:44 | HEAD仍`631fcf3`；但工作区已非“仅本文件未跟踪” | 同级Agent于14:01–14:14写入`edge/migrations/0004_admin_and_analytics.sql`、`edge/src/db/analytics-repo.ts`、`edge/src/db/coupon-admin-repo.ts`、`tests/edge/91-admin-db.test.ts`、`tests/edge/92-analytics-db.test.ts`、`tests/edge/00-foundation.test.ts`、`tests/verify_contracts.py`、`docs/04-spec/ADMIN-ANALYTICS-AND-COUPON-SPEC-AND-PLAN.md`（均非本会话产物，不覆盖不回退） | 并发写入可能后续改写同一文档；收尾须重查HP-01标记是否仍在 |
| B0 契约 14:38–14:41 | 正本§9新增HP-01～12独立编号表、§10.1 HP分组与HP-11/12元数据边界、§13变更记录；PRD §3.1.1/§3.1.4/§9 AC-01/§12.6/§12.7；UIUX §4.1～4.3/§5.0/§5.1/§6/§12；API-SPEC频道映射与字段；OpenAPI ChannelItem.name与ContentItem可选字段；三轨SPEC元数据同步；Tokens注释 | `npm run verify:contracts`退出0（22路由/30业务表/AC-01～30对齐）；`npm run verify:acceptance`退出0（30/30，185条署名用例） | HP编号尚未进入机器门禁（脚本只识别AC署名）；真人口碑资格、跨源热度可比算法、曝光比例/停留、刷新窗口毫秒值、底栏与海报最终尺寸仍为待证参数 |
| B1 播放P0 14:05–14:37 | `src/player/prism-player.ts` 300→266行；新增`ended-guard.ts`72行（显式ended＋引擎代次＋作品集绑定）、`player-contract.ts`65行、`value-channel.ts`52行；`progress-reporter.ts`＋源绑定与未知时长不冒充；`art-engine.ts`回调绑定当前src；测试`player-repair.test.ts`＋42行、`62-player-direct-playback.test.ts`＋11行、`player-harness.ts`可设时长、`runtime-integration.test.ts`同时驱动DOM与内核接缝 | 目标RED：旧`else void onEnded()`使`playing/seeked/waiting/seeking/pause/timeupdate/loadedmetadata`触发换集，修复前2项断言失败；GREEN：`npm test -- tests/client/player-repair.test.ts tests/client/32-player-integration.test.ts tests/client/62-player-direct-playback.test.ts tests/client/33-player-interaction.test.ts tests/client/runtime-integration.test.ts` 5文件59项退出0；全量`npm test`101文件1193项退出0；`npx tsc --noEmit`、`npm run typecheck`、`node --test tests/edge/*.test.mjs`（72项）、`npm run scan:p0`（347文件）全退出0 | 真实HTMLVideoElement/Artplayer＋hls.js事件时序、Android原生播放、覆盖安装与Master真机验收均未做；jsdom假内核只证明状态机模型 |

| B2 返回与进入 14:44–15:14 | `src/player-host.ts` 300→259；新增`src/player/host-layer.ts`119行（loading/error/ready三态与同构错误）、`src/player/host-contract.ts`58行、`tests/client/player-host-harness.ts`89行、`tests/client/67-host-loading.test.ts`185行；`home-topology.ts` 108→145（Layer注册/注销与焦点还原）；`home-repair.test.ts`＋66行、`19-back-button.test.ts`＋34行、`51-player-host.test.ts`改用夹具后205行；`rankings-rail.ts`未改（分类入参属B5） | RED退出1共11条目标失败：开榜时`getBackHandlerCountOf('layer')`不涨、`open()`未await时层不存在、`isOpen()`不识别loading、失败层无出口。GREEN：§4.1 B2命令退出0（3文件30项）＋`67-host-loading.test.ts`后4文件36项退出0；相关回归27/22/53/59/58/runtime 6文件75项退出0；全量`npm test`102文件1204项、`npx tsc --noEmit`、`npm run typecheck`、`npm run scan:p0`（351文件）、`verify:contracts`、`verify:acceptance`（30/30，185署名）与`node --test tests/edge/*.test.mjs`（72项）全退出0。四类详情失败文案逐字同构且DOM零剧名，同节点升级为ready | Android物理Back/侧滑、loading观感与无闪烁、命中区几何、真实Artplayer装配待浏览器/真机；`main.ts`至今未注入`titleOf`，ready层标题在生产恒空（B4/B6须以核验后的详情结果供值）；“离页即收榜”目前靠可见性守卫，事件驱动需后续给`ManagedView`加hide钩子 |

| B3 元数据链 15:28–15:58 | 新增单一策略源`edge/src/library/metadata-policy.mjs`232行＋`metadata-policy.d.mts`（数字只写一次）；新增`edge/src/library/platform-lexicon.mjs`（站源品牌词表**只给打包/边缘侧注入**，端侧不导入，避免品牌名进APK包）；`edge/src/types/content-item.ts`新形状；贯通`compute-hotscore.mjs`/`library-catalog.mjs`/`work-fact-packs.mjs`/`public-search-projection.mjs`/`package-and-publish-library.mjs`/`http/serialize.ts`/`library/title-asset.ts`/`src/core/api/title-detail.ts`/`src/core/catalog-bundle-loader.ts`；新测试`tests/edge/metadata-policy.test.mjs`、`tests/client/68-metadata-detail-dto.test.ts`与`library-package`/`public-search-projection`/`work-fact-packs`/`17b-seed-bundle`扩充 | 子代理在150回合被截断，主会话接管收尾。真实缺陷：旧清洗只认`https?://`，`mac://site.douban./108361/`与裸`site.douban.com/107923/`绕过；且`\S*`会把紧贴URL的中文片名一起吃掉。GREEN：`node --test tests/edge/*.test.mjs` 97项退出0（含协议无关清洗、CJK处停手、`.fr/a`残片、越界拒发布、词表只过滤不添加、旧记录缺字段仍可读）；`npm test`106文件1256项退出0；`npx tsc --noEmit`、`npm run scan:p0`（367文件）退出0 | 未再生`public/seed`与Android assets（属B7，需生产数据与授权）；展示副标签当前**无可信受控供给**（drama `vod_tag`覆盖0，movie去重值85.3%为单次噪声），故线上tags实际为空即诚实缺供，界面须按HP-11压缩信息块 |
| B4 综合首页 15:29–16:02 | 新增`src/core/home-recommendation.ts`222行（60作品独占轨＋`requested/actual/deviation/basis`）、`src/core/home-feed-order.ts`97行、`src/views/home-composite.ts`195行、`home-directory.ts`129行、`home-feeds.ts`45行、`home-layout.ts`43行、`home-nav.ts`75行；`home-view.ts`281行、`main.ts`300行、`channel-bar.ts`、`recommendation.ts`（旧20块7/7/6引擎与AC-28署名保留，仅供频道目录用）；新测试`71-home-nav.test.ts`、`72-home-quota.test.ts`、`73-home-quota-page.test.ts`，并扩充22/25/26/27/60与`home-view-harness.ts`/`home-composite-harness.ts` | 子代理同样在150回合截断，停在测试文件重编号（68被B3占用→改71/72/73），主会话核实重命名已完成、无孤儿文件。GREEN：`npm test`106文件1256项退出0，`npx tsc --noEmit`、`npm run scan:p0`退出0；口碑默认接缝`insufficient`（公开契约无评分字段），真人4席缺证据即记偏差补给AI，不猜AI、不伪口碑 | 综合首页在**真实20k+候选**下的实际配额分布、供给覆盖与尾页行为未跑（只证夹具模型）；刷新轮次/曝光/分类先筛后排属B5；首页视觉与底栏密度属B6；`titleOf`生产注入缺口仍在（B6须读核验后的详情供值） |

| B5 发现刷新与分类榜 16:10–17:20 | 新增`src/views/home-refresh.ts`118、`home-refresh-status.ts`113、`home-repeat.ts`118、`home-pull-refresh.ts`126、`home-exposure.ts`158、`home-discovery.ts`51、`home-rank-scope.ts`118；改`rankings-rail.ts`232、`home-view.ts`277→285、`home-topology.ts`145→175、`main.ts`背景同步回调改走`syncRecommendation()`；新测试`74-home-refresh.test.ts`218、`75-home-exposure.test.ts`175、`76-home-rankings.test.ts`201＋共用夹具`home-refresh-harness.ts`148 | 子代理150回合截断，主会话接管合并门禁：`npm test`113文件1329项、`npx tsc --noEmit`、`npm run typecheck`、`npm run scan:p0`（382文件）、`node --test tests/edge/*.test.mjs`97项、`verify:contracts`（22路由/30业务表/13引擎）、`verify:acceptance`（30/30，188署名）、`verify:android`（53项）、`npm run build`全部退出0。监理署名两处B5契约观察：①`73`文件背景同步改以`syncRecommendation()`为唯一入口、`refresh()`只代表用户显式开新轮，与`HomeView`契约及`main.ts`接线一致；②`percentilesBySource`同分取同一分位、次序交workId收口，符合HP-07b"同分即并列" | `REPEAT_REFRESH_WINDOW_MS=800`、曝光`0.5`比例/`500ms`停留、下拉`72px`三处仍是未证工程参数；真实日更节奏、私密隔离、真机下拉惯性待测 |
| B6 播放器与列表视觉 16:12–16:58 | 改`src/styles/design-tokens.css`+47/−25（`--tabbar-height:48px`、`--tabbar-content-max:360px`自HP-09起同时约束背景＋边框＋内容、`--poster-gap-tight:4px`/`--poster-gap-wide:12px`/`--poster-pad-card:2px`/`--poster-synopsis-rows:3`）、`app.css`+20/−8（透明承载层＋居中岛，安全区单一归属）、`home.css`+28/−10（密集档`flex-wrap:nowrap`、`.poster-facts/.poster-synopsis`无供给即整块塌掉）、`poster-grid.ts`+67/−13（`Ai剧`角标与元信息节点）、`player.css`+18/−5、`player-host.css`+16/0、`hud.ts`+23/−7、`controls-idle.ts`+7/−3；新测试`80-hp08-chrome-surface`93、`81-hp09-tabbar-carrier`96、`82-hp10-poster-density`123、`83-hp11-hp12-list-meta`136 | B6自报的"密集档换行风险"经核实已在`home.css:124`收口；合并门禁同上全绿 | 间距与底栏尺寸仍是样稿试验值；海报图观感、非全屏画面区让位与真实媒体时序未经真机验证 |
| 浏览器几何证据 17:16–17:50 | 在真Chromium（Edge 154 `--headless=new`＋CDP `Emulation.setDeviceMetricsOverride`，DPR 2，`prefers-reduced-motion`）360×800/393×873/873×393三档实测；Qoder内置浏览器当时是`viewport=0×0, visible=false`，按§5「0×0窗口不构成视觉通过」不采信 | HP-09：`.app-tabbar`背景`rgba(0,0,0,0)`横贯393，`.app-tabbar-inner`360宽居中（left 17）底色`rgb(18,21,31)`圆角14，页签命中48×51≥44且未被压缩。HP-10：compact-3三列125.66px、实测横纵间距均为4px、卡片126×204、命中＝整卡；comfort-2两列178.5px/间距12px；bookshelf-4四列93.25px/间距4px；list-1单列369×135；873×393下断点只加列数（compact-3→4列198px、comfort-2→3列、bookshelf-4→6列），三档全部`overflowX=false`、卡片越界计数0；`Ai剧`角标只落在`isAi`条目（60张中24张）；缺海报时媒体盒仍占126×162比例位 | HP-11/12的**有供给分支本轮不可证**：现有`public/seed`是旧一代（21963条里摘要最长仅30 code point、drama频道1条摘要、`tags/releaseYear/region/language`供给为0），故浏览器只证到"无供给即整块塌掉、不编文案"（`factsShown=0`、`subtags=0`、list-1摘要块实测高17/33px不预留3行）；真元信息保真必须等B7同代种子再生后复测。海报图在本地无`/proxy`图源（60张全`naturalWidth=0`），图片观感仍待真机 |
| 浏览器实测揪出的三处真缺陷 17:16–17:50 | ①`home-view.ts`的`refreshTopology`catch无条件`presentState`：云端目录整条读不到时把已有本机快照盖成整页错误（现场只剩骨架＋「暂无可播放剧目／服务端返回了无法识别的错误／重试」）——改为`channels.length===0`才落五态，否则`loadScope`画本机快照并走`reportFeedback({phase:'offline'})`；`home-refresh.ts`新增`controller.feedback`使状态条成为唯一写入口（撤掉刷新管线里的第二条渲染）；`home-refresh-status.ts`补"云端目录本次没读到"这条无回执文案。②HP-02a要求的Escape出口根本没实现（`src/**`里只有播放器/设置/赞助条监听）——`home-topology.ts`给展开区加`tabIndex=-1`、开榜即把焦点移入、在容器上收Escape，只关榜单＋注销返回层＋焦点还原，上层开着时焦点天然不在这层，返回栈顺序不被篡改。③B3遗留：`platform-lexicon.mjs`没有`.d.mts`，`tsc -p edge/tsconfig.json`报TS7016——补声明文件（只写形状，词表本体仍单处） | RED→GREEN逐条留痕：`74`新增2条（拓扑整条失败仍画本机快照／无候选如实落空态）先红后绿，`76`新增2条（开榜焦点进入展开区＋Escape归还返回层／未开榜时Escape不注册也不消费）先红后绿；复跑`npm test`113文件1329项、`npx tsc --noEmit`、`npm run typecheck`、`npm run scan:p0`、`npm run build`退出0 | 修复前873×393首页卡片0张，修复后同视口同代次60张本机快照卡片＋离线状态条；Android物理Back/侧滑、真实媒体事件与`FLAG_SECURE`仍只能真机验 |

当前有效结论（暂停复核后修订）：B0为静态契约证据；B1–B6已有单元与集成证据，浏览器仅取得部分网格／底栏几何与分类范围证据，不构成HP-08～12完整视觉通过。上表为历史执行记录，1329项全绿发生在最后一次Escape改动之前，不代表暂停时的代码状态。恢复施工后已补齐首页键盘作用域类型、传入与注销，并在分类重绘后恢复榜单焦点；相关33项测试、前端及边缘类型检查、P0扫描通过；最新全量113文件1330项测试、构建、30/30 AC署名覆盖及Android静态核验通过。真实浏览器393×873与873×393确认切分类后榜单保持开启、焦点回到榜单容器，Escape关闭榜单；播放器Escape关闭仍正常。浏览器脚本保存结果后因临时profile目录清理EPERM退出1，不能把该脚本进程记为全绿。恢复施工后revision 4本地种子已再生并同步Web／Android，原revision 3种子备份在`build/home-player-local-r4/previous-seed`；有供给元信息已完成三档浏览器复测；真实海报、真实媒体、真机与APK验收仍未完成。Git、CI、云端、官网未执行。

恢复施工补充：首次revision 4浏览器复测发现真实片名`K.O`被裸域名清洗误删，客户端因此拒收整包；立即从备份恢复revision 3，未放宽端侧校验。已新增实际片名回归断言，收紧无路径host的末段长度（单字母末段仅带路径才识别为URL），原有恶意URL用例仍通过；打包器另加清洗后空标题拒绝，防止坏包再同步种子。修正后revision 4已重新生成并同步：Web JSON与Android gzip解压字节一致，21963个作品ID与旧代一致，`K.O`保留，摘要最长240码点，3036部有可信副标签、21741部有年份。真实浏览器三档视口图文模式均显示60张卡片，60张有元信息、28张有摘要、合计17个副标签，摘要实高17/33/50px并按3行收口，无横向溢出；已人工查看截图确认实际显示。此次探测结果保存成功，进程仍因临时profile清理EPERM退出1；海报接口缺席、真实媒体及APK验收仍不通过或未测。补采96/97页不完整与短剧简介／副标签缺供继续如实保留。

构建前补充核查：HLS的MSE回调不得以`video.currentSrc === manifestUrl`判归属（实际为blob）；已改当前Hls实例身份并覆盖旧实例、HLS转MP4、销毁与异步重试，11项定向测试通过，真实解码尚待验证。播放宿主核验身份后标题改取`loaded.item.title`，不再依赖未注入的候选标题；相关32项测试通过。静态读取链确认Android原始`seed/library.db`不被客户端消费且含启动库禁止的媒体地址，已取消复制并移至`build/home-player-local-r4/previous-seed/excluded-android-library.db`备份；不改客户端SQLite架构。Web／Android JSON种子频道统一为精彩短剧、电影仓库、纪录片、动漫且同代；新增实际交付种子解析与资产排除测试通过。换集／换线的独立内核隔离正在修复，真实本地MP4／HLS解码和布局验证正在进行，尚不允许APK构建。

真实媒体补充：换集／换线改为独立engine/video实例，每次先提交旧进度再失效、解绑和销毁；异步创建与fatal按token、generation及实例核验，音量／倍速恢复。新增6项隔离测试；共享夹具等待改为事件循环完成而非固定6次微任务，原断言未降低。全量115文件1348项与98项edge测试通过。真实Chrome使用ffmpeg两段6秒测试视频，经生产ArtPlayer＋hls.js，在360×800、393×873、873×393各跑MP4与HLS：两集均有trusted loadedmetadata/playing/ended、非零解码帧，第二集请求在第一集ended之后；选集面板命中、侧边让位及零横向溢出通过。此为真实本地解码而非上游或Android真机证明。线上公开海报短剧／电影／动漫实际解码成功；纪录片先前误用doc前缀404，已改从真实种子取句柄；四频道海报decode均成功且天然尺寸非零，故意不存在地址正确失败。六组本地真实媒体检查全部通过，仍记录一条测试暂停时ArtPlayer内部play Promise的AbortError，不冒称控制台零异常；不影响两集实际结束与下一集起播证据。已授权交付范围内Git／CI／联网／必要云修复，准备v2.6.4（versionCode21604），官网仍不提前推广。

验收与正式下载发布（2026-10-05）：Master反馈「基本满足预期」，并明确要求整理Git、更新Web与下载。修复提交`cf22dd1`已推送，CI run `37306940952`成功，v2.6.4／versionCode21604包位于`build/apk264/app-debug.apk`；签名证书SHA-256与旧包相同，APK内公开种子revision4、21963部，与本地JSON字节一致且不含原始library.db。发布官网Worker版本`fe3c797f-c584-4688-92fe-d2108aa69886`，上传已验收APK至`releases/android/latest.apk`后更新`config:version`。官网及版本接口显示2.6.4，下载HTTP200／32828353字节，公开下载SHA-256为`9a92f9efd94eb4f887dd01c9329eae29c5516dc6daa83e55f37192acfccccf74`，与验收包完全一致。未执行D1迁移、未发布另项后台功能、未切换内容manifest至revision4；内容库云端仍沿原代，因此新增元数据在后续联网刷新时的同代收敛仍为开放项，不能宣称云端内容数据已同步。刷新／曝光参数校准和缺供原料仍保留。

云端同代同步完成（2026-10-05）：先核对线上revision3与本地revision4均为21963部、无在途日更；备份旧manifest、JSON/gzip整包、sources及公开拓扑回滚SQL至`build/home-player-local-r4/cloud-before-sync`。仅上传manifest实际引用的761个公开对象，排除原始SQLite及历史残留；大JSON采用Wrangler、小对象REST，全部对象回读字节数及SHA-256一致后重读旧manifest确认未被并发修改，再最后切KV指针并回读确认。来源配置及私密准入未修改；仅D1四个公开频道名称／顺序与APK同步。公开验证：整包revision4、21963条元数据全部与本地一致，四频道首屏revision4，详情`movie_m_25718`及对应搜索元数据一致；after=4返回空变更／nextRevision4，after=3返回410要求整包恢复，拓扑一致。证据在`cloud-sync-result.json`与`cloud-public-verification.json`。此记录取代上方发布时的云端未同步开放项；不更换已验收APK、不迁移D1内容库、不发布私密资产。

### 6.5 全局进度地图（验收及云端同代同步后更新）

| 门禁 | 当前结论 | 下一证据 |
| --- | --- | --- |
| G0 | B0契约与HP表落定，`verify:contracts`/`verify:acceptance`退出0 | HP署名纳入机器门禁；待证参数（口碑/热度/曝光/刷新窗/视觉尺寸）逐项收敛 |
| G1 | 云端已由revision3切换至revision4，761个引用对象全部回读SHA-256一致；21963部整包元数据与APK种子逐字段一致；四频道目录、详情／搜索样本与拓扑核验通过 | 旧指针、整包及公开拓扑回滚备份保留；补采96/97页并非完整，短剧简介与副标签缺供继续如实保留 |
| G2 | B4/B5候选、配额、曝光、刷新轮次及分类榜已接线并有模型测试；真实浏览器分类范围已测 | 完整真实候选配额核验、独立日更周期证据；曝光／刷新参数真机校准 |
| G3 | 最新115文件1348项回归通过；三档真实MP4／HLS两集连播、布局及四频道海报解码有证据；v2.6.4 APK已交付 | 长期真实上游供给、曝光／刷新参数校准与Android边界场景持续复测 |
| G4 | Master反馈基本满足预期并授权发布；v2.6.4下载包与验收包逐字节相同，官网、公告与云端revision4内容同步完成 | 长期采集日更可靠性与未证参数继续跟踪，不把本次同代发布等同于缺供原料补齐 |

## 7. 工作量口径

初步估算：功能修复与接线约600–1000 LOC，首页／刷新／榜单约700–1200 LOC，元数据链及展示约400–800 LOC，回归与契约约700–1200 LOC；总新增／修改量约2400–4200 LOC，Token约80k–160k。范围包含测试和直接受影响文档，不包含批量补采、生产数据迁移和真机反馈后的再次修复。估算不是承诺，以每批实际diff与验证登记更新，禁止用人类工时口径。
