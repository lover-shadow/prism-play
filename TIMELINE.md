# 《光影Play》（Prism Play）工程演进时间轴 (TIMELINE.md)

> 本文件记录《光影Play》（Prism Play · `play.prismos.org`）自创立以来的架构决策、阶段交付与里程碑事件。最新记录置顶。

---

## 2026-10-01 · 新范围施工前复核（G0 静态/合成门禁）

- 搜索、已配置来源自动加工与公开列表/海报本地缓存进入本期契约；AI 免费可降级、Windows 与离线视频后移。修订后继续核对卡密格式、频道 B/Y/S 映射、目录游标、私密会话撤销、HLS 子资源、跨 APK 安装归因及阶段工作包。
- G0 仅验证了 OpenAPI 引用、SQLite 新库约束及少量合成输入；未实现业务接口、未跑 Android 真机或真实 D1/Workers AI，未核实本账号套餐和额度。阶段 1～4 待 Master 下一步指令启动，详见 SPEC §12.2 与架构第五章。
- 旧日期条目保留当时决策轨迹，**不再作为当前套餐、免费配额或施工完成状态的证据**。

---

## 2026-09-30 (深夜) · 施工前契约收敛（文档从"想法"变为"可施工依据"）

- **执行主体**：MVP开发专家团（项目总监：大湾区靓仔，独立完成收敛）
- **触发**：Master 明确——企划与构思由 Master 提出，文档由 Agent 完成，因此**让文档之间自洽、可施工是 Agent 的职责**，而不是把矛盾交回 Master 裁决
- **收敛内容**：
  1. **认证模型更正**：HMAC-SHA256 改为 **Ed25519 非对称签名**（边缘持私钥、客户端仅内置公钥），并明确 14 天离线仅代表"授权可离线验证"，不等于可离线播放任意在线剧集；
  2. **档位唯一化**：统一 `Q / A / B / Y / S`，明确 `Q` 为初期唯一公开季卡（¥9.9 / 90 天，**不含**个人探索），`B / Y / S` 才具备个人探索资格；
  3. **卡密边界可达**：成功绑定上限严格 10 台、第 11 台拒绝、同设备幂等；异常风控改按"被拒绝的不同设备数 > 20"计数，避免原"绑定超过 20~30 台"永远不可达；
  4. **私密频道双重准入**：由"仅按 JWT 档位过滤"升级为「有效 B/Y/S 授权 **且** 当次会话凭据 `X-Private-Session`」，并诚实标注服务端只能证明收到显式开启请求；
  5. **内容闭环补齐**：新增 `content_items` / `content_episodes` / `episode_sources` 数据模型与 `/api/catalog`、`/api/titles/{id}`、`/api/episodes/{id}/playback`、受控 `/proxy/*` 契约，解决分享与播放"无数据可依"；
  6. **范围与验收对齐**：F-05（后台息屏 P0）、F-10（来电 P1）纳入 Spec，AC-01 ~ AC-15 在 PRD 与 Spec 逐条对齐，补 AC-08 ~ AC-11；
  7. **口径统一**：响应式断点统一 768px、定时渐隐统一"归零前 3 秒"、手势分区统一左 0~48% / 右 52~100%、限流统一 10 次/分钟；
  8. **工程配置修正**：`package.json` 移除不存在的 `@capacitor/http` 独立包（`CapacitorHttp` 随 `@capacitor/core` 提供且默认不 patch fetch），构建改用内置 esbuild，避免 `terser` 缺失导致构建失败；
  9. **文档权威顺序**：确立 `SPEC-v2.0.md` 为施工与验收唯一依据，并建立"冲突裁决链"写入 `docs/00-index/README.md`。

---

## 2026-09-30 (夜) · 全新独立建库 `D:\DEV\prism-play` 与结构重新设计

- **执行主体**：Master_流光逸影 (战略定案) & MVP开发专家团 (大湾区靓仔)
- **核心成果**：
  1. 彻底废弃旧目录 `D:\DEV\guangying-duanju` 中陈旧的 Go 骨架与历史包袱，全新建立 **`D:\DEV\prism-play`** 独立工程库；
  2. 采用现代标准全栈分层结构：`src/`（Vite + TS + ArtPlayer）、`edge/`（Cloudflare Serverless）、`docs/`（DDAD 纯英文分级目录）；
  3. 全量迁移并升级 Phase 1 核心三文档体系、5 项 ADR、OpenAPI 3.0 契约与琥珀金日夜双模 Design Tokens；
  4. 产出 Phase 1.5 刚性团队总契约 `docs/04-spec/SPEC-v2.0.md`，准备正式进入全栈开发。

---

## 2026-09-30 (晚) · 品牌升维《光影Play》与全栈架构定案 (Phase 1 闭环)

- **核心成果**：
  1. 品牌矩阵化升维：正式定名为《光影Play》（Prism Play），统一主域 `play.prismos.org`，融入母站 `prismos.org` 生态；
  2. 架构选型彻底卸下历史包袱，锁定【方案 B】：Capacitor 7 + TypeScript + ArtPlayer.js + Cloudflare Serverless 全栈；
  3. 顶层频道升级为 Cloudflare 动态下发的“大视界”拓扑（短剧/电影/动漫/纪录片/私密频道）；
  4. 查证 Cloudflare 边缘计算能力：确认 Workers 每日 10 万次免费调用、D1 数据库与免费开源大模型（DeepSeek R1 / Qwen / BGE-M3）；
  5. 明确未来 AI 演进路线图：客户端个性化推荐与高级会员专属“AI 角色扮演/平行剧情推演” Agent。
