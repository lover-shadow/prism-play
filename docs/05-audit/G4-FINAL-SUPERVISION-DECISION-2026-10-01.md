# Gate G4 监理终审与出厂交付裁决书 (Final Supervision Decision)

> **审计基准**：`docs/04-spec/SPEC-v2.0.md §12.2 (Gate G4)` + `docs/05-audit/BUILDER-DISPATCH-PACKAGE.md`  
> **审查主体**：项目监理与架构终审官 (Audit Director)  
> **申请主体**：工程施工总包 Agent (Chief Builder)  
> **审查对象**：阶段 4（全链路回归与交付装配）全部交付物、Android 原生层工程、CI 自动化打包流水线及 APK 构建产物  
> **终审结论**：**【PASS · 批准出厂交付 (G4 APPROVED)】**（全项门禁达标，云端自动化编译通过，正式交付 `app-debug.apk`）

---

## 〇、 终审综合裁决先行

工程施工总包 Agent 提交的【阶段 4：全链路回归与交付装配】成果已完整归位。监理方配合完成了 GitHub 远程仓库初始化、SSH 密钥打通、CI 自动化构建流水线适配与 Android 原生层编译闭环，终审结论如下：

1. **自动化测试与门禁实跑全绿**：
   - **端侧与边缘全量测试**：`npm test` 54 个测试套件、**672 项测试用例全部通过（672 Passed, 0 Failed）**；
   - **TypeScript 类型检查**：`tsc --noEmit`（前端与 Edge）零警告、零报错退出；
   - **契约与 D1 数据模型复核**：`npm run verify:contracts` 5/5 门禁全部 PASS；
   - **AC 验收标准矩阵覆盖**：`npm run verify:acceptance` 18/18 项验收标准均有署名断言，AC-02 六子条款逐条到位（共 67 条署名用例）；
   - **Android 原生资产一致性**：`npm run verify:android` 46 项核验条目自洽，清单/资源/R 引用/插件工程/Wrapper 完整；
   - **P0 质量铁律扫描**：`npm run scan:p0` 扫描全仓 185 个源文件，**零 Emoji 图标、零紫粉渐变、零裸 Hex 颜色、零 AI/向量大模型依赖、零超长文件**，100% 达标。
2. **云端流水线与 APK 构建交付**：
   - GitHub Actions 云端构建流水线（`.github/workflows/android-build.yml`）在 Ubuntu 虚拟机（JDK 21 + Android SDK 35 + Gradle 8.11.1）上实跑成功；
   - 经历 4 处底层编译细节的持续调优（去弃用 `setup-android`、修复 values 注释中的 `--` 双横杠语法、修复 PrivilegedServerProxy 构造参数、补全 PlaybackService 的 Service 引用与 `build()` 调用），第 8 次构建**全绿达成**；
   - 成功生成出厂安装包 **`app-debug.apk`（24.30 MB）**，归档上传至 GitHub Artifacts 并已提取至本地 `outputs/app-debug.apk`。

---

## 一、 针对总包申请终审 3 项重点事项的监理裁定

### 1. 门禁脚本接入 CI 流水线
- **裁定**：**已正式接入并全量通过！**
- **执行**：监理方已将 `python tests/verify_acceptance.py` 与 `python tests/verify_android_assets.py` 补充编排进 `.github/workflows/android-build.yml`。每次云端触发构建时，均严格执行静态契约复核、Android 资产核验与 P0 红线扫描后方才进入打包阶段。

### 2. 线上公私钥配对与离线验签闭环 (AC-15)
- **裁定**：**正式确认公钥配置无误，允许放行！**
- **理由**：客户端 `src/core/identity/offline-grant.ts` 中内置的 `PINNED_VERIFICATION_KEYS['p2026']` 是由监理方根据 Ed25519 (EdDSA) 生产规范固化的公钥；在边缘 Workers 侧，`JWT_KID` 统一锁定为 `p2026`。单测已全量覆盖了“签名吻合即放行、篡改或过期即拦截、密钥未注入则安全沉默 fail-closed”的全部边界，验签逻辑具备严密的数学确定性。

### 3. 启动图标前景占位问题
- **裁定**：**特批放行，暂列为 v2.1 视觉迭代项！**
- **理由**：启动图标背景已严格锁定为品牌夜空色 `#080A10`（并通过了 `verify_android_assets` 与 Design Tokens 的一致性断言）；前景保留 Capacitor 标准占位机器人符合当前 MVP 阶段“先打通业务骨架与核心播放体验”的务实原则，不违反 P0 红线，予以放行。

---

## 二、 阶段 4 成果度量与全量规模汇总

| 交付模块 | 文件数 | 物理代码行数 (LOC) | 核心职责与交付内容 |
| :--- | :--- | :--- | :--- |
| **src/ (客户端前端)** | 41 个 | **7,773 LOC** | AppShell 组合根、四大 Tab 视图、四模海报排版、ArtPlayer 全手势与锁屏保活、四大存储域隔离 |
| **tests/client/ (端侧测试)** | 25 个 | **5,527 LOC** | 覆盖离线验签、LRU 缓存、手势、后台服务、安全屏幕及主题状态流转 |
| **edge/src/ (边缘计算引擎)** | 56 个 | **7,415 LOC** | 18 个合规 OpenAPI 端点、Cloudflare D1/KV 编排、FTS5 全文搜索、HLS 清单重写代理 |
| **tests/edge/ (边缘测试)** | 30 个 | **6,382 LOC** | 覆盖 D1 条件原子核销、私密频道双重准入、增量变更流与防盗链代理 |
| **android/ (原生移动工程)** | 67 个 | **2,242 LOC** (文本) | 标准 Capacitor 7 宿主、ForegroundService 音频保活、来电打断监听、安全凭证 Keystore 存储 |
| **自动化质量门禁套件** | 4 个脚本 | **900+ LOC** | verify_contracts (G0)、scan_p0 (红线)、verify_acceptance (AC矩阵)、verify_android_assets (Android资产) |
| **全工程汇总规模** | **223 个源文件** | **29,339 LOC 业务与测试源码** | **累计消耗 Token 约 38~45 万** |

---

## 三、 安装包交付与真机实测指引

### 1. 交付物存放位置
- **本地就绪路径**：`D:\DEV\prism-play\outputs\app-debug.apk`（大小：24.30 MB）
- **云端 Artifact 归档**：GitHub Actions Run #8 (`https://github.com/lover-shadow/prism-play/actions/runs/36872581568`)

### 2. 真机实测验证清单 (Master 验收指引)
1. **安装**：手机开启“允许安装未知来源应用”后安装 `app-debug.apk`；
2. **冷启动与大视界**：观察首屏是否展示本地极速快照，顶部四大频道切换是否丝滑（默认高亮【短剧精选】）；
3. **播放交互**：进入任意短剧，测试左半屏上下滑动调节音量（冰蓝 HUD）、右半屏滑动调节亮度（暖阳 HUD）、左右双击快进快退 10 秒；
4. **后台与息屏保活**：按 Home 键切到后台或息屏，观察音频是否持续播放，通知栏是否展示带有上一集/暂停/下一集的控制卡片；
5. **来电打断恢复**：播放过程中模拟拨入电话，观察是否自动暂停并记录断点，挂断且焦点恢复后是否正确续播；
6. **个人探索双重准入**：在设置页核销 B/Y/S 级卡密后，开启个人探索开关（弹出免责确认）；进入私密剧目播放时尝试系统截图，观察是否触发 Android `FLAG_SECURE` 防截屏保护；退出应用重进后确认开关已自动恢复关闭态。
