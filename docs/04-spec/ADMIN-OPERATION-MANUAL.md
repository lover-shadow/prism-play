# 《光影Play》（Prism Play）管理后台与卡密运维操作手册
# (ADMIN-OPERATION-MANUAL.md)

## 2026-10-09 消息与版本的标准化操作渠道（已部署）

目前不新增Admin公告UI；使用已认证后台会话及同源请求调用 GET/POST `/api/admin/announcements`，携带现有CSRF头。POST为 `{requestId,confirmed:true,document:{schema:1,revision,items}}`，纯文本、有效时间、条目id/revision明确；撤下以递增revision和items=[]提交。每次操作GET读回确认，不把200解释为全员收到；409要求核对已有请求，503不称成功，结果未知先读回再重试。

版本、安装包与通告发布已全面沉淀为工程级自动化流水线与 SOP 手册：
- **正本手册**：`docs/04-spec/RELEASE-SOP-AND-PIPELINE.md`
- **操作命令**：`npm run release:preflight`、`npm run release:upload`、`npm run release:deploy`、`npm run release:promote`、`npm run release:verify`、`npm run release:rollback` 或一键 `npm run release`。
- 彻底告别临时手工脚本，不可变包校验、R2元数据注入、KV指针切换与生产端到端验收全部由标准工具保证。

> **正本关联**：`docs/04-spec/ADMIN-ANALYTICS-AND-COUPON-SPEC-AND-PLAN.md`（技术规范与实施计划）、`docs/04-spec/RELEASE-SOP-AND-PIPELINE.md`（生产发布SOP）  
> **服务域名**：`https://play.prismos.org/admin`  
> **适用对象**：Master（产品负责人/日常运营）、接续施工 Agent、系统运维工程师  
> **更新日期**：2026-10-06  
> **当前状态**：生产已上线（Worker 版本 `a563ec8d-fcab-4ed1-a348-9c2013d41650`，D1 迁移 `0004_admin_and_analytics.sql` 已执行）

---

## 一、 管理后台访问与凭据体系

### 1.1 访问入口
- **控制台地址**：[`https://play.prismos.org/admin`](https://play.prismos.org/admin)
- **网络与浏览器要求**：
  - 必须通过现代标准浏览器（Chrome, Edge, Safari 等）访问。
  - 控制台原生适配桌面宽屏与移动端竖屏，无多余外链资源，弱网及高延迟环境秒级加载。
  - 未登录访客仅能看到干净的登录表单骨架，**任何运营数据、卡密明文、图表均在通过身份鉴权后由服务端按需异步拉取**，无预埋敏感数据。

### 1.2 本地凭据管理规范 (`admin-access.local`)
为了便于后续各专业 Agent、自动化运维脚本以及管理员本人快速取用凭据，同时杜绝生产凭据泄露进 Git 仓库：
- **存储文件**：`D:\DEV\prism-play\admin-access.local`（项目根目录）
- **安全隔离**：该文件已被根目录 `.gitignore` 中的 `*.local` 规则强制忽略，**不会被提交到版本库，仅存在于部署该服务的本地工作区**。
- **文件格式**：
  ```text
  Admin: https://play.prismos.org/admin
  Password: <管理员高熵登录口令>
  ```
- **Agent / 脚本读取示例**：
  ```javascript
  // 自动化脚本/Agent 取用口令标准代码片段
  import fs from 'node:fs';
  const content = fs.readFileSync('D:/DEV/prism-play/admin-access.local', 'utf8');
  const password = content.split('Password: ')[1].trim();
  
  // 发起登录认证
  const loginRes = await fetch('https://play.prismos.org/api/admin/login', {
    method: 'POST',
    headers: {
      'Origin': 'https://play.prismos.org',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ password })
  });
  ```

### 1.3 会话与安全防御机制
1. **12 小时绝对超时**：会话生命周期严格锁定为 12 小时（43,200 秒），不采用任何无限制滑动延期机制。到期后自动清理本地展示并提示“会话已失效，请重新登录”。
2. **安全 Cookie 隔离**：认证成功后下发 `__Host-prism_admin_session`，具备 `Secure; HttpOnly; SameSite=Strict; Path=/` 属性。客户端 JavaScript 无法读取该 Cookie，免疫 XSS 盗取。
3. **摘要存储**：数据库 `admin_sessions` 表中**仅保存 session token 与 csrf token 的 SHA-256 哈希摘要**，服务端数据库被只读 dump 时也无法反推有效登录凭据。
4. **同源校验与 CSRF 防御**：
   - 所有的后台接口严格校验请求来源 `Origin` 是否为 `https://play.prismos.org`。
   - 所有写操作（生成、确认、分发、作废、登出）必须在请求头中携带与当前会话严格绑定的 `X-CSRF-Token`。
5. **登录防暴力破解**：
   - 基于客户端 IP（Cloudflare `CF-Connecting-IP` 的 SHA-256 摘要）在 D1 数据库执行原子计数。
   - 15 分钟固定时间窗口内，单个 IP 累计密码错误 5 次，系统自动锁定并返回 `HTTP 429 Too Many Requests`，锁定期间即使输入正确口令亦被拒绝。
6. **App 跨域完全隔离**：后台请求在 Worker 入口处被独立拦截并返回，绝不进入 App 前台的公共 CORS 包装管道，不会向外反射任何 Origin，亦不接收任何 App Bearer JWT。

---

## 二、 预制卡密生命周期与操作 SOP

卡密中心是后台的核心资产调度模块。为了保障高并发环境下的数据一致性与账实相符，系统将卡密设计为**三条独立正交的状态轴**：
1. **核销可用状态 (`status`)**：`UNUSED`（未核销） / `ACTIVE`（可用中） / `REVOKED`（已作废）
2. **设备绑定计数 (`device_count`)**：当前已绑定的实际硬件数（0 到 10 台）
3. **分发流转状态 (`dispatch_status`)**：`UNKNOWN`（历史状态未知） / `IDLE`（可用空闲库存） / `DISPATCHED`（已手动送出）

```
                     ┌────────────────────────────────┐
                     │ 历史迁移初始卡密 (UNKNOWN, 0台) │
                     └────────────────────────────────┘
                                      │
                                [确认库存] (人工核实未送出)
                                      ▼
┌──────────────────┐           ┌────────────────────────────────┐
│   后台批量生成   │ ────────> │   可用空闲库存 (IDLE, 0台)      │
└──────────────────┘           └────────────────────────────────┘
                                      │
                                [查看全码 / 复制] (仅复制文本，状态仍为 IDLE)
                                      │
                                [确认分发] (录入渠道/受赠人备注)
                                      ▼
                               ┌────────────────────────────────┐
                               │   已手动发出 (DISPATCHED, 0台)  │
                               └────────────────────────────────┘
                                      │
                                (用户在 App 端完成卡密核销)
                                      ▼
                               ┌────────────────────────────────┐
                               │   设备已绑定 (DISPATCHED, N台)  │
                               └────────────────────────────────┘
                                      │
                                [停止核销] (发生恶意退款/纠纷)
                                      ▼
                               ┌────────────────────────────────┐
                               │  已停止后续核销 (REVOKED)        │
                               │  *已有 N 台设备在到期前权限保留* │
                               └────────────────────────────────┘
```

### 2.1 核心动作详解与易混淆概念释义

#### ① 确认库存 (Confirm Stock)
- **按钮状态**：仅对 `dispatch_status = 'UNKNOWN'`、未核销（`device_count = 0`）且未作废的卡密高亮可用。
- **业务含义**：历史 0001/0002 迁移遗留下来的 4 张初始卡密，因无法追溯过去是否已被作者在微信中赠予他人，系统本着严谨原则一律初始化为 `UNKNOWN`（状态不明）。当管理员翻阅线下聊天记录、确认该卡密确实没有送出过时，点击“确认库存”，系统将其转为 `IDLE`（可用空闲库存）。
- **注意点**：**新通过后台生成的卡密默认直接是 `ACTIVE` + `IDLE`，天然处于可用库存状态，无需也不允许点击“确认库存”**。

#### ② 确认分发 (Confirm Dispatch)
- **按钮状态**：仅对 `dispatch_status = 'IDLE'`、未核销（`device_count = 0`）且未作废的卡密高亮可用。
- **业务含义**：操作者正式将卡密分配给特定受赠人（如“好友张三”、“小红书活动01”）时使用。点击后弹出确认对话框，必须录入分发备注并勾选二次确认。系统会以原子事务写入分发备注、分发时间戳，并将状态置为 `DISPATCHED`。
- **核心避坑（复制卡密 ≠ 确认分发）**：
  - 点击“查看全码”并复制卡密到剪贴板，**系统绝不会自动将其标记为 `DISPATCHED`**！
  - 理由：防止误触、试探性查看或者复制后因故未发给用户导致后台库存账面失真。只有卡密真正从你手中送出时，才手动点击“确认分发”。
- **并发与防重**：操作绑定唯一 `requestId` 并执行原子条件更新。两个管理员或两个窗口同时尝试分发同一张卡密时，仅一人成功，另一人立即收到 `HTTP 409 Conflict` 冲突拒绝，杜绝“一码重复派给两人”。

#### ③ 查看全码 (Reveal Code)
- **安全策略**：列表中所有卡密默认全部进行不可逆掩码遮罩（如 `GY-****-****-AD5X`），防止屏幕录制或肩窥泄露。明文卡密绝不保存在浏览器的 `localStorage`、`sessionStorage` 或 URL 参数中。
- **操作方式**：点击“查看全码”，前端向 `/api/admin/coupons/{id}/reveal` 发送请求。服务端在 `admin_audit_logs` 留下 `COUPON_REVEAL` 审计日志后返回全码。
- **复制兜底**：弹窗内支持“一键复制”。若浏览器因环境安全限制或用户拒绝授予剪贴板权限，系统会诚实显示“剪贴板不可用，请手动复制”，并自动全选文本框内的卡密供管理员 `Ctrl+C` 复制，绝不以虚假 Toast 误导操作者。

#### ④ 停止后续核销 (Revoke)
- **业务含义**：当某张卡密因恶意刷单、退款或争议需要紧急作废时使用。点击后系统将其核销状态更新为 `REVOKED`，并记录作废原因和审计日志。
- **严正权限边界**：**“停止核销”仅仅阻止未来该卡密被任何新设备再次激活或已清空设备再次恢复，绝对不会自动撤销或修改已经绑定的设备现有会员权限！** 已经激活过该码的终端在本地持有的 Ed25519 签名凭据依然在有效期内正常运行。

#### ⑤ 绑定详情 (Binding Details)
- **功能**：点击后展示该卡密关联的设备绑定明细（物理设备 ID、首次绑定时间）。
- **隐私脱敏**：弹窗内展示绑定的具体设备编号及时间，默认脱敏屏蔽绑定的客户端 IP，既保证裂变核验又兼顾隐私合规。

---

### 2.2 批量生成卡密标准工作流

1. 展开卡密库存顶部的 **【生成新卡密】** 抽屉。
2. **选择档位**：
   - `Q`：季度畅享卡（90 天有效，公开发售主流档位）
   - `B`：高级全源卡（90 天有效，具备【个人探索】私密视界开启资格）
   - `Y`：年度尊享卡（365 天有效，具备【个人探索】私密视界开启资格）
   - `S`：极客纪念卡（永久有效 -1，具备【个人探索】私密视界开启资格，内部赠予专用）
3. **输入数量**：单批次支持 1 ~ 100 张。
4. **批次备注**：选填，例如“2026年10月社群抽奖专用”。
5. **点击生成**：
   - 系统使用 Web Crypto 强密码学随机发生器生成符合 `GY-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}` 防伪规则的 12 位纯随机卡密，避免任何规律性递增。
   - 生成成功后自动弹出全码弹窗，可直接全选复制。
   - 卡密进入库中，初始状态自动为 `ACTIVE` + `IDLE`。

---

## 三、 运营与转化大盘使用说明

### 3.1 指标口径（非技术人员必读）

| 指标名称 | 统计来源与严格定义 | 常见误区与边界声明 |
| :--- | :--- | :--- |
| **页面访问请求** | 门户首页（`/`）、下载落地页（`/dl`）、公开分享页（`/s/{id}`）返回 HTTP 200 的请求次数 | **不代表真实人类眼球停留**。网络爬虫、刷新页面均会计入次数，不能当作严格的真实受众 PV。 |
| **下载触发** | 在下载页点击后通过 R2 校验并成功下发 HTTP 302 重定向到 APK 文件的请求次数 | **不代表 APK 实际下载完毕，更不代表在手机上安装成功**。如果用户中途取消下载或系统拦截，依然计为 1 次触发。 |
| **期间可识别浏览器** | 用户在 `/privacy` 中明确点击“同意”后，由系统种下 180 天匿名凭据 `__Host-p_vid` 并按 `DISTINCT visitor_hash` 统计的去重浏览器数 | **不代表真实自然人数量**。无痕模式、清理 Cookie、跨应用打开均会被视为新浏览器。**严禁把 7 天内每天的数值直接相加当作周 UV！跨天去重是系统的核心机制。** |
| **同标识转化率** | `期间内既浏览公开页又触发下载的唯一浏览器数 / 期间内浏览公开页的唯一浏览器数` | 若期间内没有产生任何同意 Cookie 的访客（分母为 0），系统如实展示“暂无数据”，绝不编造虚假的百分比。 |

### 3.2 冷启动与数据延迟提示
- **开始记录与最近写入**：大盘顶部明确显示该环境最早产生数据的时间以及最近一次数据库成功更新的时间戳。
- **状态感知**：若服务刚刚部署上线或长时间无访客触发，大盘会明确提示“尚无统计数据”，不展示虚假占位曲线。

---

## 四、 运行信息概览（只读监控）

运行信息模块为管理员提供边缘底座的实时健康状态：
1. **有效授权设备**：按档位（Q / B / Y / S）实时汇总当前数据库中处于有效期内的设备总量。
2. **近 24 小时失败上报样本 (`line_health_signals`)**：
   - 展现真实手机客户端在播放过程中因网络断连、上游源超时（timeout）或解码异常（decode_error）自动上传的异常排障样本。
   - **重大判定纪律**：由于系统为了保护性能，没有上传“正常播放成功”的数据作为分母，**因此该处的数据绝对不是“线路故障率”！** 几十次报错可能对应着几十万人次的顺畅播放，**严禁仅凭少量失败样本盲目判定线路已废并擅自下架片源**。
3. **当前发布信息**：只读展示 Cloudflare KV `config:version` 当前向全网客户端广播的最新版本号、更新日志及下载地址。一期后台不开放线上热写表单，以防误改导致全网 App 弹出更新甚至卡死。

---

## 五、 用户隐私合规与数据自洁机制

### 5.1 隐私与同意入口 (`/privacy`)
- 站点在门户首页、下载落地页和短剧分享页底部统一提供了纯 HTML、无额外追踪脚本的【隐私与统计设置】链接。
- 访客在 `/privacy` 页面可自由选择：
  - **同意浏览器去重统计**：种下合规匿名 Cookie `__Host-p_vid`。
  - **拒绝或撤回同意**：立即销毁浏览器本地 Cookie，并在服务端 D1 数据库中物理删除该访客的历史标识与去重记录（历史已聚合的匿名日总数不追溯重写）。
- 系统原生遵从浏览器的 `Sec-GPC` 与 `DNT`（禁止追踪）请求头，检测到此类标头时，即使已同意也会强制视为拒绝，不写入任何唯一标识。

### 5.2 数据库自动清理机制 (Scheduled Clean-up)
为了防止分析数据无限膨胀耗尽 Cloudflare D1 额度，系统在每天 UTC 04:00 与 16:00 的定时巡检中自动执行限量分批清理：
- `analytics_visitor_days`（按日去重事实）：保留 **90 天**，超期自动删除。
- `analytics_visitors`（访客档案）：基于首次建档日保留最长 **180 天**。
- `analytics_daily`（每日汇总趋势）：保留 **365 天**（1 年）。
- `admin_audit_logs`（管理操作审计）：保留 **365 天**（1 年）。
- `admin_sessions`（后台会话）：到期即物理销毁。
- `admin_login_limits`（登录防爆破窗口）：保留 **24 小时**。
- 单表每次清理严格硬限制最多删除 1,000 行，利用主键索引删除，零锁表、零写风暴。

---

## 六、 运维应急 Runbook

### 6.1 密码轮换操作
若管理员密码发生疑似泄露，可在本地工程根目录执行以下命令一键重新生成并推送至云端：
```bash
# 1. 切换到本地 edge 目录
cd D:\DEV\prism-play\edge

# 2. 生成新高熵密码并更新本地密钥记录
node --input-type=module - <<'JS'
import fs from 'node:fs';
import crypto from 'node:crypto';
const password = crypto.randomBytes(24).toString('base64url');
const salt = crypto.randomBytes(32).toString('hex');
const hash = crypto.pbkdf2Sync(password, salt, 100000, 32, 'sha256').toString('hex');

// 更新项目本地防泄漏凭据
fs.writeFileSync('../admin-access.local', `Admin: https://play.prismos.org/admin\nPassword: ${password}\n`);
// 准备临时 secret JSON
fs.writeFileSync('C:/Users/Master/.qoder-cn/tmp/admin-new-secret.json', JSON.stringify({
  ADMIN_PASSWORD_HASH: `pbkdf2-sha256:100000:${salt}:${hash}`
}));
console.log('新口令已保存至 admin-access.local');
JS

# 3. 推送新密码哈希至 Cloudflare 生产环境
npx wrangler secret bulk "C:/Users/Master/.qoder-cn/tmp/admin-new-secret.json" --config wrangler.toml
```

### 6.2 紧急踢除所有在线管理员 (会话失效)
若需要瞬间让全网所有当前已登录的管理会话全部失效（即使他们持有未到期的 Cookie）：
```bash
# 修改认证版本号，例如从 '1' 升级为 '2'
npx wrangler secret put ADMIN_AUTH_VERSION --config wrangler.toml
# 在交互提示中输入新的数字（如 2）并确认
```
*原理：所有管理接口读取会话时，会核对 `admin_sessions.auth_version` 是否与环境变量 `ADMIN_AUTH_VERSION` 一致。版本号一旦变动，所有老版本的存量会话直接 401 拒绝。*

### 6.3 统计紧急熔断
若因流量激增需要彻底停止后台的所有统计写入：
- 修改 `edge/wrangler.toml` 中的 `ANALYTICS_ENABLED = "false"`，并执行 `npx wrangler deploy`。
- 系统自动跳过所有统计写入与 Cookie 处理，前台网页与 App API 零影响。

### 6.4 生产数据库 Time-Travel 回滚
若遭遇误操作需要将数据库完整恢复到本次上线前的状态：
```bash
cd D:\DEV\prism-play\edge

# 恢复至上线前的确定性时间旅行书签：
npx wrangler d1 time-travel restore prism-play-db --bookmark=000000aa-00000002-000050fb-6181c2a3c9b29b64c4a1c8ec99dc6aae
```
