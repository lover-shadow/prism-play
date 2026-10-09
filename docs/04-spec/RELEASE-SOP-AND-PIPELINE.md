# 《光影Play》（Prism Play）端云一体生产发布标准操作手册 (SOP)
# (RELEASE-SOP-AND-PIPELINE.md)

**维护主体**：MVP开发专家团  
**生效日期**：2026-10-09  
**版本状态**：正式现行生产标准（v2.6.7+）

---

## 一、 架构原则与发布红线 (Hard Rules)

1. **不可变产物与同域分发**：
   - 所有正式发布的 Android APK 必须归档在 R2 不可变路径：`releases/android/<versionCode>/<sha256>.apk`。
   - 官网下载通道严格限制为同域入口（`https://play.prismos.org/dl/latest/android`），由 Worker 校验后 302 重定向到 `/dl/artifacts/<versionCode>/<sha256>.apk`。严禁外链跳转或引入外部 CDN。
2. **零临时脚本与状态闭环**：
   - 彻底废除发布过程中现场临时手写 `deploy-*.mjs` 的低效方式。所有发布、回核、回滚必须且仅能通过标准化工具链 `edge/scripts/release-pipeline.mjs` 执行。
3. **版本单调递增与签名防篡改**：
   - 每次发布 `versionCode` 必须严格大于云端运行版本的 `versionCode`。
   - 正式发布包必须通过固化密钥库（`debug.keystore`）验签，签名 SHA-256 指纹必须恒为：`8bc228b3d45e2afa0fba9f27676d13b60cd0dcfb0537121bf14766ffe5f4d29d`。严禁携带 `.probe` 调试标记。
4. **环境变量与 Secret 保护**：
   - 部署 Worker 必须携带 `--keep-vars`，严禁清除线上已配置的敏感密钥（`JWT_PRIVATE_KEY_JWK`, `PRIVATE_SESSION_SECRET`, `PROXY_SIGNING_SECRET`, `ADMIN_PASSWORD_HASH` 等）。
5. **发布即留痕 (Receipt Tracing)**：
   - 预检阶段生成 `outputs/release-backup.json`；
   - 资产上传生成 `outputs/release-upload-receipt.json`；
   - 全链路验收生成 `outputs/release-live-receipt.json`。

---

## 二、 环境准备与前置鉴权

发布前必须确保本机具备以下执行环境：

| 依赖项 | 推荐版本/位置 | 校验命令 |
| :--- | :--- | :--- |
| **Node.js** | v22.10+ / v24.13+ | `node -v` |
| **Cloudflare Wrangler** | 4.147.0+ (工程自带) | `npx wrangler --version` |
| **Cloudflare 登录态** | 账号 `3d11a910907ee5175e7f807cd34a2ada` | `npx wrangler whoami` |
| **JDK (Java)** | OpenJDK 21 LTS (`build/android-tools/jdk-21.0.12.1+1`) | `java -version` |
| **Android Build Tools** | 35.0.0 (`build/android-tools/sdk/build-tools/35.0.0`) | `aapt version` |

> 若未登录 Cloudflare，请先执行 `npx wrangler login`，或在环境变量注入 `CLOUDFLARE_API_TOKEN`。

---

## 三、 标准化 5 步发布 SOP (流水线阶段)

完整发布流程按如下 5 个标准阶段依序推进：

```
[本地构建与出包] ──> [步骤1: 预检与基准备份] ──> [步骤2: 不可变资产上传与回核]
                          npm run release:preflight       npm run release:upload
                                     │                              │
[步骤5: 线上端到端验收] ◄── [步骤4: 版本与通告生效] ◄─── [步骤3: 边缘服务部署]
    npm run release:verify        npm run release:promote        npm run release:deploy
```

### 步骤 0：本地打包与门禁复核
在触发发布前，完成前端编译、Capacitor 原生同步及 Android APK 构建：
```bash
# 1. 前端编译与同步
npm run build && npm run cap:sync

# 2. Android 原生编译 (使用本地固化 Gradle 环境)
export JAVA_HOME="D:/DEV/prism-play/build/android-tools/jdk-21.0.12.1+1"
export ANDROID_HOME="D:/DEV/prism-play/build/android-tools/sdk"
export GRADLE_USER_HOME="D:/DEV/prism-play/build/android-tools/gradle-cache"
cd android && ./gradlew assembleDebug && cd ..

# 3. 产物归档到 build/apk<versionCode>/ 目录
mkdir -p build/apk268
cp android/app/build/outputs/apk/debug/app-debug.apk build/apk268/prism-play-v2.6.8-release.apk
```

### 步骤 1：本地预检与云端基线捕获 (`preflight`)
```bash
npm run release:preflight -- --apk build/apk268/prism-play-v2.6.8-release.apk
```
**机制说明**：
- 自动调用 `aapt` 和 `apksigner` 核验包名、versionCode、versionName 与固化证书指纹；
- 解析内嵌 `assets/public/seed/catalog-bundle.json`，核验公开剧目种子；
- 联网读取云端当前 `config:version`，确保新包 Code 严格大于云端 Code；
- 抓取当前运行的 Worker Version ID 与公告快照，自动保存至 `outputs/release-backup.json`。

### 步骤 2：不可变 APK 上传与 SHA 回下校验 (`upload`)
```bash
npm run release:upload
```
**机制说明**：
- 自动向系统申请动态空闲端口（避免固定端口冲突导致的挂起或超时）；
- 启动受限的临时绑定 Worker，将 APK 推送至 R2 `prism-play-releases` 并注入 `customMetadata`（`sha256`, `versionCode`, `versionName`）；
- 立即发起反向 GET 下载整个对象，重算 SHA-256 并与本地包字节级比对；
- 无论成功或失败，在退出前 100% 优雅清理子进程与临时代码；
- 成功后输出 `outputs/release-upload-receipt.json`。

### 步骤 3：Edge Worker 部署 (`deploy`)
```bash
npm run release:deploy -- --message "发布 2.6.8 版本 Worker 与系列修复"
```
**机制说明**：
- 先执行 `--dry-run` 确保打包无语法或类型异常；
- 执行 `wrangler deploy --keep-vars`，保留线上 Secret 与环境变量；
- 捕获新部署生成的 Version ID，追加到备份记录。

### 步骤 4：原子切换版本指针与生效启动通告 (`promote`)
```bash
npm run release:promote
```
**机制说明**：
- 校验已存在前置阶段的上传回执；
- 原子写入 KV `config:version`，更新 App 更新检查与官网下载指针；
- 合并并置顶两段合一启动确认通告至 KV `config:announcements`，递增文档 revision，保留已有公告；
- 执行回读核验，杜绝网络写入假成功。

### 步骤 5：全链路生产端到端回归校验 (`verify`)
```bash
npm run release:verify
```
**机制说明**：
- 模拟客户端与用户浏览器访问 `https://play.prismos.org`：
  1. `/api/version` 返回新发布版本元数据；
  2. `/dl/latest/android` 触发 302 重定向到 `/dl/artifacts/<Code>/<SHA>.apk`；
  3. 流式拉取该包，核对 HEAD 与完整下载 SHA-256；
  4. 官网主页 HTML 包含新版本号与体积文字；
  5. `/api/announcements` 首条消息为有效启动通告；
  6. 公开端点 200，私密与未授权 Admin 严格 401/404；
- 生成最终验收报告 `outputs/release-live-receipt.json`。

---

## 四、 一键全流程发布 (All-in-One)

在确认本地出包完成且门禁已通过的情况下，可直接执行一键串行发布：
```bash
npm run release -- --apk build/apk268/prism-play-v2.6.8-release.apk --message "V2.6.8 正式发布"
```
**安全屏障**：流水线内任何一环（预检不符、上传失败、部署报错、KV 冲突、验证未通过）均会立即中断退出，绝不盲目进入下一步。

---

## 五、 应急处置与一键回滚 SOP (Rollback)

### 5.1 触发回滚的判定条件
- 新 Worker 上线后核心接口（如 `/api/channels`, `/api/search`）发生 500 或 503；
- 官网下载的 APK 无法覆盖安装或运行时崩溃；
- 线上接口返回非预期的私密数据。

### 5.2 回滚操作命令
执行以下单条命令即可触发自动化回滚：
```bash
npm run release:rollback
```

### 5.3 回滚执行细节
1. 读取发布前自动保存的 `outputs/release-backup.json`；
2. 将 KV `config:version` 原样恢复为上个稳定版本的描述（官网下载与更新立即指回旧包）；
3. 将 KV `config:announcements` 恢复为上个版本的公告快照；
4. 调用 `wrangler rollback <previousWorkerVersion>` 将 Worker 路由秒级退回上一版本；
5. 回滚完成后，运行 `npm run release:verify` 复核线上状态。

---

## 六、 常见故障排查表 (Troubleshooting)

| 异常现象 | 根本原因 | 标准处置手段 |
| :--- | :--- | :--- |
| **`preflight` 报版本未递增** | 新包 versionCode ≤ 云端运行 versionCode | 修改 `android/app/build.gradle` 中的 `versionCode` 并重新打包 |
| **`preflight` 报证书指纹不匹配** | 打包未绑定 `debug.keystore`，使用了随机调试密钥 | 检查 `android/app/build.gradle` 的 `signingConfigs` 配置，重新编译 |
| **`upload` 报端口超时或占用** | 历史后台残余进程占用了端口 | 工具自带动态可用端口分配；若系统异常，执行 `powershell -Command "Stop-Process -Name workerd -Force"` 清理 |
| **Worker 部署报 Secret 缺失** | 误用了未经保护的 deploy 命令 | 本工具内置 `--keep-vars`，严禁脱离工具直接执行裸 deploy |
| **下载 APK 报 503 服务不可用** | R2 对象的 `customMetadata` 缺失或与 KV 记录不一致 | 检查并重新运行 `npm run release:upload`，通过标准通道注入元数据 |
| **云端公告未按两段弹窗显示** | 公告正文中未包含换行符 `\n\n` 或被单段覆盖 | `promote` 会自动使用标准两段正文模板；自定义内容时请确保包含换行 |

---

## 七、 维护与索引收录
- 生产操作入口：`edge/scripts/release-pipeline.mjs`
- 凭据处理模块：`edge/scripts/release-client-auth.mjs`
- 资产上传模块：`edge/scripts/release-r2-uploader.mjs`
- 管理员手册联动：参见 `docs/04-spec/ADMIN-OPERATION-MANUAL.md`
