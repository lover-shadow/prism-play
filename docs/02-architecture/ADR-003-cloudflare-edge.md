# ADR-003: 采用 Cloudflare Serverless 边缘云脑统一收口与动态源调度

- **状态 (Status)**: Accepted (已采纳)
- **决策日期 (Date)**: 2026-09-30
- **决策者 (Deciders)**: Master_流光逸影 (架构主理人), 大湾区靓仔 (项目总监), 高见远 (首席架构师)

---

## 背景与问题陈述 (Context and Problem Statement)

传统聚合播放器普遍将上游接口域名直接写死在客户端内，一旦上游域名变更、失效或被 DNS 污染，客户端立即瘫痪，必须强制发版重装。同时，传统 VPS（虚拟主机）需要每月固定付费、面临单点机房高延迟、DDoS 攻击与系统运维负担。

我们需要决定：在《光影Play》（`play.prismos.org`）中，如何以零运维成本实现播放源的空中动态管理、自动巡检、商业卡密核销与未来 AI 扩展？

---

## 决策结论 (Decision Outcome)

**选择【Cloudflare Serverless 全栈边缘云脑（Workers + Cron + D1 + KV + R2）】**，并以 **`play.prismos.org`** 作为客户端唯一收口网关。

> **2026-10-01 修订 (落实 M-5)**：本期不引入 Workers AI 语义搜索与 Vectorize，全文检索完全基于 Cloudflare D1 FTS5 原生词法倒排索引（包含精确剧名、拼音缩写、别名与错字纠偏）；Workers AI 与 Vectorize 统一收归 v2.1+ 演进储备，本期 Worker 不绑定 AI/Vectorize 资源。

### 核心机制与理由
1. **空中调度大脑（Dynamic Channels & Sources）**：
   - 客户端零硬编码上游地址，启动时向 `play.prismos.org/api/channels` 与 `/api/sources` 获取动态“大视界”频道（短剧/电影/动漫/纪录片/私密）与脱敏后的 Provider 列表；
   - **Scheduled Cron 自动巡检**：利用 Cloudflare 定时触发器每天刷新 2 次（表达式 `0 4,16 * * *`，**Cloudflare Cron 以 UTC 计时**，即北京时间 12:00 与次日 00:00），对候选上游源进行连通性探测与响应延迟测速，自动熔断死源并将健康源按速度排序写入 KV 缓存。
2. **预制卡密 D1 原子核销**：
   - 使用 Cloudflare D1 存储卡密与设备绑定关系，由 Worker 签发非对称 JWT；额度依当前账号订阅和官方规则核实，不在此以公共免费上限替代账号实际能力。
3. **全文检索与去 AI 减负**：
   - 采用 D1 原生 FTS5 配合预计算汉字/拼音词元，实现毫秒级响应的剧名、拼音缩写与模糊纠偏检索，零额外算力开销；
   - 彻底避免因 Workers AI 免费配额与 Vectorize 延迟导致的系统复杂性。
4. **成本与运维**：
   - 免费额度（每日请求数、R2 出口流量）与全球节点延迟均为**平台当前公布的量级**，随 Cloudflare 政策变动；正式发布前须以届时官方免费额度页面为准，不得把本文数值当作已核实的合同承诺。
