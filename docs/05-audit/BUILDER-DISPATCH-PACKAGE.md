# 《光影Play》（Prism Play）工程施工总包指令包 (Builder Dispatch Package)

> **生效日期**：2026-10-01  
> **制定主体**：项目监理与架构审查官 (Chief Architect & Audit Director)  
> **接收主体**：工程实施总包 Agent (Chief Builder & Engineering Swarm Lead)  
> **任务定位**：全权负责《光影Play》商业版 v2.0 从阶段 1 到阶段 4 的代码构建、单测落地与交付装配  
> **监理机制**：每阶段完成后向监理 Agent 提交结构化验收报文，通过对应 Gate 门禁后方可进入下一阶段

---

## 〇、 施工总包指引与快速启动

### 1. 你的角色定位
你是本项目（`D:\DEV\prism-play`）的**工程总包（Chief Builder）**。你拥有自主调用子代理（Subagents / Swarm）的权力，可自行调配前端工程师、后端工程师、测试工程师协同作业。
你的唯一法定契约是 **`docs/04-spec/SPEC-v2.0.md`**。你不需要重新设计架构，也不得擅自改动业务规则与接口契约；你的核心使命是**高质量、高还原度、零安全漏洞地将已有契约转化为工程级代码并闭环测试**。

### 2. 施工绝对红线（违反即退回重做）
1. **P0-1 严禁 Emoji 功能图标**：界面 100% 消费锁定的 **Lucide SVG 纯矢量图标（统一 2px stroke，16/20/24px）**，全流程自动化正则扫描；
2. **P0-2 严禁紫色→粉色渐变**：强调色锁定院线级**琥珀金 `--accent: #E5A93C`**，夜间背景 `--bg: #080A10`，日间背景 `--bg: #F5F6FA`；
3. **P0-3 严禁硬编码颜色与 AI 模板味**：前端 100% 消费 `src/styles/design-tokens.css`；
4. **合规红线：个人探索绝密隔离**：
   - 频道与数据仅在持有有效高级授权且本次启动手动开启（`X-Private-Session`）时出现，冷启动默认关闭；
   - 前端 100% 剔除分享按钮，边缘网关未授权访问一律返回 404；
   - 数据库强约束 `CHECK((channel_id = 'private' AND is_private = 1 AND shareable = 0) OR (channel_id <> 'private' AND is_private = 0))` 绝不可绕过；
5. **架构铁律：彻底去平台化**：界面与公开接口严禁出现任何外部上游站源名称，全部统一由服务端抽象 Provider 编号与受控代理管理；
6. **Master 战略定案（M-5 绝不可违）**：**本期彻底不做任何 Workers AI 语义搜索与 Vectorize 向量模型**，全文检索 100% 基于 Cloudflare D1 FTS5 原生词法倒排索引。严禁引入大模型依赖！
7. **Cloudflare 云端基础设施专职分工**：
   - 鉴于总包会话无 Cloudflare MCP，**真实 Cloudflare 云端资源（D1 数据库创建、KV 命名空间创建、R2 存储桶创建、线上 SQL 迁移执行、生产发布与线上拨备）全部由监理 Agent 专职承接**；
   - 总包 Agent **无需安装或配置 Cloudflare MCP**，仅需专注本地工程代码（TypeScript、SQL 逻辑、本地模拟测试、前端与宿主）的高质量编写！真实 ID 将由监理方自动回填入 `edge/wrangler.toml` 供你直接使用。
8. **端云生产发布铁律（严禁临时现场手写发布脚本）**：
   - 任何涉及 Cloudflare Worker 部署、R2 不可变 APK 上传、KV 版本号或公告更新的发布操作，**必须严格获得 Master 明确授权**；
   - **严禁编写任何临时 deploy 脚本或手工拼凑 CLI 命令**；
   - 无论由哪个 Agent 执行发布，**必须 100% 消费标准发布流水线**：遵循 `docs/04-spec/RELEASE-SOP-AND-PIPELINE.md`，统一运行 `npm run release:preflight`、`upload`、`deploy`、`promote`、`verify`（或一键 `npm run release`）；
   - 异常时立即执行 `npm run release:rollback` 快速回滚，确保 Secret 保护（`--keep-vars`）、不可变包 SHA-256 回核、全链路验收 100% 自动化闭环。

---

## 一、 权威正本资产地图（施工必须严格依据以下文件）

| 资产类型 | 物理路径 | 权威属性与职责 |
| :--- | :--- | :--- |
| **施工总宪法** | `docs/04-spec/SPEC-v2.0.md` | **施工与验收的唯一依据**。包含全部范围、技术版本、API 列表、DDL、Tokens、EARS 验收标准与已知坑。 |
| **生产发布 SOP** | `docs/04-spec/RELEASE-SOP-AND-PIPELINE.md` | **端云一体生产发布标准操作手册与流水线**。包含预检、不可变 R2 上传、Worker 安全部署、KV 指针原子切换、端到端线上验收与一键回滚 SOP。 |
| **机器接口正本** | `docs/03-contracts/openapi.yaml` | OpenAPI 3.0.3 规范正本（18 个合法端点，已收敛多段路由 `/proxy/{kind}/{handle}` 与闭集错误码）。 |
| **接口文字规范** | `docs/03-contracts/API-SPEC.md` | 接口逻辑细节与错误码映射表。 |
| **数据模型正本** | `edge/migrations/0001_initial_schema.sql` | Cloudflare D1 (SQLite) 物理建表 SQL（包含 20 张业务表 + 5 张 FTS 影子表）。 |
| **设计系统正本** | `src/styles/design-tokens.css` | 唯一样式真相源（`design-tokens.json` 必须与之同源）。 |
| **交互原型参考** | `docs/prototypes/ui-prototype.html` | 已落盘的高保真单文件交互原型，包含四模海报、手势 HUD、追剧断点等全部真实交互动线。 |
| **红队复核台账** | `docs/05-audit/MASTER-DECISIONS-2026-10-01.md` | 记录了 M-1~M-8 的决策背景与成因。 |
| **门禁自检工具** | `tests/verify_contracts.py` | 静态契约比对脚本，在 `package.json` 挂载为 `npm run verify:contracts`。 |

---

## 二、 四大施工阶段分解与分工建议（Inside-Out 流水线）

### 【阶段 1：云端事实与核心引擎】(Gate G1)
- **核心目标**：在 `edge/` 目录下构建 Cloudflare Workers 核心网关、D1 数据库操作层、卡密原子核销与任务摄取状态机。
- **施工分解（建议派发后端子代理 + 测试子代理）**：
  1. `edge/src/types/index.ts`：从 `openapi.yaml` 提取并建立严格的 TypeScript 请求/响应 DTO 类型定义；
  2. `edge/src/db/`：封装 D1 访问客户端，实现预制卡密条件原子核销逻辑：
     - `UPDATE card_coupons SET device_count = device_count + 1 WHERE code = ? AND status IN ('UNUSED','ACTIVE') AND device_count < max_devices`；
     - 保证单卡 10 台上限不可击穿、同设备重兑幂等不增计数；
     - 超过 10 台拒绝并记入 `coupon_rejected_devices`，不同被拒设备数 > 20 置 `is_abnormal = 1`；
  3. `edge/src/routes/redeem.ts`：实现 `/api/redeem`，集成 Ed25519(EdDSA) 私钥签名下发 JWT；
  4. `edge/src/routes/channels.ts`：实现 `GET /api/channels`，根据 JWT 档位与 `X-Private-Session` 动态决定是否返回 `private` 节点；
  5. `edge/src/routes/private-sessions.ts`：实现 `POST` 与 `DELETE /api/private-sessions`（DELETE 时向 `private_session_revocations` 写入不可逆哈希墓碑）；
  6. `edge/src/ingest/`：实现已配置来源的增量任务状态机：
     - 来源增量游标拉取，按 `(provider_id, source_item_id, source_revision)` 幂等入库 `source_records`；
     - 最多自动重试 3 次，超限置 `retry` 隔离；
     - 跨源归并必须严格匹配 `trusted_work_mappings`，严禁仅凭同名跨源合并；
  7. `edge/src/routes/invite.ts`：实现邀请裂变奖励双分支（非会员累加 `exempt_until` 免打扰，会员延长 `expires_at`）；
  8. 单元与集成测试套件编写（`tests/edge/`）。
- **预算参考**：业务代码约 1,400~2,000 LOC，测试约 500~800 LOC，Token 消耗约 90k~140k。
- **准出门禁（Gate G1 退出标准）**：
  - [ ] 卡密 10/11 台并发边界、同设备幂等单测 100% 通过；
  - [ ] 相同来源记录重复提交幂等，可信跨源映射合并通过，同名异剧分立单测通过；
  - [ ] 邀请奖励双分支计算断言通过；
  - [ ] 私密会话凭据签发与主动 DELETE 墓碑作废断言通过；
  - [ ] 提交《阶段 1 监理审查报文》，等待监理 Agent 签发通过证明。

---

### 【阶段 2：传输同步与受控代理】(Gate G2)
- **核心目标**：构建受控媒体/图片代理网关、D1 原生 FTS5 全文搜索、增量目录同步及极简分享 H5。
- **施工分解（建议派发后端子代理 + 前端模板子代理）**：
  1. `edge/src/routes/proxy.ts`：实现 `/proxy/{kind}/{handle}` 多段合规受控代理：
     - 白名单校验 + 防 SSRF 过滤；
     - 短时签名 `sig` 与 `exp` 校验；
     - HLS 清单（`.m3u8`）重写：将相对/绝对分片、密钥 URI 重写为同源代理地址；
     - 支持 Range/206 媒体分片传输；
     - 私密内容逐次核对 D1 与当次会话，响应强制附加 `Cache-Control: no-store`；
  2. `edge/src/routes/search.ts`：实现 `GET /api/search` 与 `GET /api/search/suggestions`：
     - 基于 D1 `public_search_fts`、`content_aliases`、`content_tags` 联合查询；
     - 实现精确剧名、全拼、拼音首字母缩写、错字纠偏与题材同类关联；
     - 严格过滤私密与未上架剧目，纯词法检索（无 AI 依赖）；
  3. `edge/src/routes/changes.ts`：实现 `GET /api/catalog/changes`：
     - 基于 `public_catalog_changes` 表，按单调自增 `revision` 返回 upsert 与 delete 墓碑；
     - 游标超期返回 410，异常返回 400；
  4. `edge/src/routes/share.ts`：实现 `GET /s/:drama_id` 与 `GET /dl`：
     - 直出当前单集极简 H5（内嵌 ArtPlayer 与当前集流）；
     - 私密剧目强制 404；
     - 监听 `ended` 事件弹出“继续追看请下载【光影Play】”截流卡片；
     - `/dl` 负责微信环境提示与 Android 直链分发。
- **预算参考**：业务代码约 1,200~1,800 LOC，测试约 450~750 LOC，Token 消耗约 80k~125k。
- **准出门禁（Gate G2 退出标准）**：
  - [ ] 代理路径对非白名单、伪造签名直接 403 阻断；
  - [ ] 未持有效会话请求私密代理直接 404，无元信息泄露；
  - [ ] FTS5 中文单字、双字、拼音首字母检索断言全部命中；
  - [ ] 增量游标 410 阻断测试与删除墓碑测试通过；
  - [ ] 提交《阶段 2 监理审查报文》，等待监理 Agent 签发通过证明。

---

### 【阶段 3：客户端视界与播放宿主】(Gate G3)
- **核心目标**：在 `src/` 与 `android/` 下构建现代流媒体前端界面、四大本地存储域、海报排版四模与全手势播放器。
- **施工分解（建议派发前端子代理 + 原生集成子代理）**：
  1. `src/core/storage/`：落地**端侧四大存储域契约 (SPEC §6.1)**：
     - 安全凭证域：Capacitor Preferences 配合 Keystore 加密存储；
     - 追剧历史域：SQLite 落地 `local_watch_history` 表（500 条 LRU 淘汰，提供单键清空历史）；
     - 公开缓存域：目录快照（上限 20 MiB）与缩略海报（上限 128 MiB）LRU 服务；
     - 私密禁存域：底层拦截器物理禁止 `is_private = 1` 写入磁盘，RAM 纯内存流转；
  2. `src/components/`：构建大视界动态频道导航栏、二级吸顶胶囊流、四模海报排版网格（3列紧凑/2列大图/4列书架/单列图文流）；
  3. `src/views/history-view.ts`：构建【追剧】核心主视图：
     - 顶部展示正在追剧集（带金色秒级断点条与一键续播）；
     - 中部展示根据看过的剧智能召回的同类好剧推荐流；
     - 下部展示往期完播历史清单；
     - 底部展示轻量缓存占用说明与清理入口；
  4. `src/player/prism-player.ts`：集成 ArtPlayer.js 与全手势 HUD：
     - 左半屏 (0~48%) 垂直滑动系统音量（水滴冰蓝 HUD）；
     - 右半屏 (52~100%) 垂直滑动窗口亮度（暖阳金芒 HUD）；
     - 双击快进/快退 10 秒；
     - 睡眠定时器（归零前 3 秒平滑淡出音量）；
     - 全屏误触锁；
  5. `src/views/settings-view.ts`：独立设置中心（日夜双模切换、后台播放开关、卡密核销输入、OTA 检测、个人探索免责弹窗）；
  6. `android/`：配置 Capacitor 7 Android 宿主：
     - 配置 `dataExtractionRules.xml`：将 `local_watch_history` 与偏好纳入备份白名单，严格排除凭证密文与海报缓存；
     - 注入 Edge-to-Edge 边到边全面屏、`FLAG_SECURE` 防截屏与来电监听广播。
- **预算参考**：业务代码约 1,800~2,600 LOC，测试约 600~900 LOC，Token 消耗约 100k~160k。
- **准出门禁（Gate G3 退出标准）**：
  - [ ] 四模排版切换无白屏、状态持久化；
  - [ ] 追剧断点精确记录到秒，续播 0 延迟起播；
  - [ ] 个人探索频道在无凭据/冷启动时 DOM 树与本地磁盘零留痕；
  - [ ] 断网启动先呈现公开快照，点播视频明确提示需要网络；
  - [ ] P0-1 零 Emoji、P0-2 零紫粉渐变正则扫描 100% 通过；
  - [ ] 提交《阶段 3 监理审查报文》，等待监理 Agent 签发通过证明。

---

### 【阶段 4：全链路回归与交付装配】(Gate G4)
- **核心目标**：AC-01~AC-18 自动化回归验证、生产构建打包与最终交付。
- **施工分解**：
  1. 运行 `tests/verify_contracts.py` 与端到端自动化测试套件；
  2. 执行全仓 P0 红线静态扫描（零 Emoji、零紫粉渐变、零裸 Hex）；
  3. 执行生产构建：`npm run build`，确保零 TypeScript 编译错误与零 Warning；
  4. 产出最终交付包与部署运维说明书。
- **准出门禁（Gate G4 最终交付标准）**：
  - [ ] 18 条 AC 验收标准 100% 通过；
  - [ ] 监理 Agent 终审签字通过，向 Master 提交验收安装包。

---

## 三、 施工总包汇报规程（必须遵守的报文模板）

你在每个阶段完成时，**严禁使用口水话汇报**，必须严格按照以下格式向监理提交报文：

```markdown
### 📢 【施工进度汇报】阶段 X：[阶段名称] 施工完毕申请验收

#### 1. 交付物与代码行数统计 (LOC)
- 业务代码文件清单及行数：[列出文件: LOC]
- 测试代码文件清单及行数：[列出文件: LOC]
- 本阶段实际消耗 Token 估计：[约 X k Tokens]

#### 2. 门禁验证实跑证据 (必须附带终端真实输出)
```text
[在此粘贴真实的测试命令运行结果，如 npm test 或 curl 输出，严禁伪造]
```

#### 3. 针对本阶段契约与红线的自检结论
- [x] 是否存在私密数据泄漏路径：无
- [x] 是否存在硬编码颜色或 emoji：无
- [x] 是否存在未经授权的架构偏离：无

#### 4. 遗留问题与已知限制 (如无填“无”)
- [列出需要监理知晓的边界情况]

申请监理 Agent 介入审查并执行 Gate G[X] 验收！
```

---

## 四、 施工总包避坑铁律（前车之鉴，必须刻在脑子里）

1. **D1 条件原子更新绝不可写成两步**：必须是一条 SQL：`UPDATE ... WHERE code=? AND status IN ('UNUSED','ACTIVE') AND device_count < max_devices`，根据 `rowcount == 1` 判定成败；
2. **D1 FTS5 中文单字检索**：SQLite 的 `unicode61` 不会对汉字单字分词，写入 `public_search_fts` 时必须将标题预先按单字及双字空格切分插入（如 `"战 神 战神 之 龙王 归来"`），否则搜单字搜不出；
3. **私密与可分享等式**：牢记 D1 强约束，`channel_id='private'` 必须配 `is_private=1` 且 `shareable=0`，否则插入直接报数据库异常；
4. **受控代理多段路由**：代理路由严格使用 `/proxy/{kind}/{handle}`，不要写回单段 `{path}`；
5. **四大存储域物理隔离**：追剧历史写入 `local_watch_history`，凭证写 Keystore，个人探索纯内存。一键清空历史只删除历史表，绝不能误清凭证！
6. **M-5 纯词法检索**：本期不写任何 `bge-m3`、`Workers AI`、`Vectorize` 代码，不要自己加戏搞复杂的向量接口，专注高响应词法搜索！

---

## 五、 附录：总包 Agent 启动 Prompt 正本 (Master 复制用)

当你（总包 Agent）在全新的对话中被唤醒时，你的启动参数与指令必须以此正本为准：

```markdown
你好，从现在开始，你是《光影Play》(Prism Play · play.prismos.org) 的【工程施工总包 Agent (Chief Builder)】！
本项目工程代码构建任务正式启动，当前已完成施工前契约收敛与 Gate G0 门禁。

【一、 你的身份与分工边界（绝不可越界）】
1. 你的唯一战场：100% 聚焦在本地工程代码的构建与单测编写（edge/src/、src/、android/、tests/）；
2. 明确分工：你没有、也不需要 Cloudflare MCP！真实 Cloudflare 云端资源（D1 数据库、KV 空间、R2 桶）由原对话中的【监理 Agent】专职拨备与管理，并在后续负责线上发布部署；
3. 严禁改动：严禁修改 edge/wrangler.toml 中的数据库与存储绑定 ID（由监理方统一回填真实 ID）；
4. 本地测试：本地单元测试采用内存 SQLite 或本地 Wrangler mock 驱动，不需要连接真实云端即可完成逻辑闭环验证。

【二、 你的法定依据与施工红线】
1. 项目工程根目录为：D:\DEV\prism-play
2. 请首先完整精读你的总包指令包：D:\DEV\prism-play\docs\05-audit\BUILDER-DISPATCH-PACKAGE.md
3. 你的唯一法定施工与验收依据是：D:\DEV\prism-play\docs\04-spec\SPEC-v2.0.md（严禁擅自偏离契约！）
4. P0 质量红线：
   - 严禁 Emoji 功能图标（统一锁定 Lucide 2px SVG，16/20/24px）；
   - 严禁紫粉渐变（主强调色锁定琥珀金 #E5A93C，深色背景 #080A10，浅色 #F5F6FA）；
   - 严禁裸 Hex 颜色，100% 消费 design-tokens.css；
   - 严禁违背 M-5 裁决：本期彻底不做任何 Workers AI 与 Vectorize 向量大模型代码，全文检索 100% 基于 D1 FTS5 原生词法倒排检索！
5. 私密频道合规生死线：个人探索模式双重准入，前端物理剔除分享按钮，数据库强等式禁止外发，冷启动默认关闭。
6. 端侧四大存储域物理隔离：追剧历史写入 local_watch_history 且纳入 Android 备份白名单，Keystore 凭证与海报严格排除在备份外，个人探索纯内存零留痕。

【三、 监理验收机制与汇报规程】
1. 研发严格按照 Gate G1（云端事实）→ G2（传输同步）→ G3（客户端宿主）→ G4（全链路交付）四大阶段依赖推进；
2. 每一个阶段完成时，严禁使用口水话汇报！必须严格按照指令包第三章的【汇报规程模板】输出结构化报文（包含真实 LOC 统计、命令测试运行真实日志与自检声明），交由原对话中的监理 Agent 审查并签发通过证明后，方可推进下一阶段。

【当前立即开始的任务】
请立即读取 BUILDER-DISPATCH-PACKAGE.md 与 SPEC-v2.0.md，调配后端与测试子代理力量，正式开始【阶段 1：云端事实与核心引擎】的本地代码与单测编写！
开始吧！
```

---
（本指令包完，请总包 Agent 严格照此组织施工！）
