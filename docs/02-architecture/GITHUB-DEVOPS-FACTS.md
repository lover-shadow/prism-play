# 《光影Play》（Prism Play）GitHub 运维、CI/CD 与自动化事实正本 (GITHUB-DEVOPS-FACTS.md)

> **版本**：v2.0 生产基线  
> **生效日期**：2026-10-02  
> **代码仓库**：`https://github.com/lover-shadow/prism-play`  
> **编制目的**：消除跨会话认知断层与反复摸索，将 GitHub 代码仓库、本地免密 SSH 鉴权、浏览器插件自动化控制（Playwriter）、GitHub Actions 云端 Android 打包流水线及全流程实战踩坑经验白纸黑字固化为单源事实正本。新会话接入或任何 Agent 接手时，必须严格本文件为操作依据。

---

## 一、 GitHub 仓库基本面与主干资产 (Repository Basics)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                           【GitHub 仓库与协作资产总账】                          │
├──────────────────────────────────────────────────────────────────────────────────┤
│ • 远程仓库地址：https://github.com/lover-shadow/prism-play                       │
│ • Owner 账号：lover-shadow (绑定邮箱：shadows.lover@gmail.com)                   │
│ • 默认开发与生产分支：main (所有构建与 CI 均以此分支为基线)                      │
│ • 本地工作区绝对路径：D:\DEV\prism-play                                         │
│ • Git Remote 配置：origin -> git@github.com:lover-shadow/prism-play.git          │
│ • 云端编译虚拟机规格：GitHub Actions Hosted Runner (ubuntu-latest, 4-core, 16GB) │
│ • 出厂安装包归档目标：GitHub Actions Artifacts (prism-play-debug-apk, 保留 14天) │
└──────────────────────────────────────────────────────────────────────────────────┘
```

---

## 二、 本地免密 SSH 鉴权体系与网络跳板铁律 (SSH Authentication)

本地与 GitHub 之间的 Git 交互（`git fetch` / `git push`）全部基于 **Ed25519 高强度非对称免密密钥** 完成。

### 1. 密钥参数与 GitHub 登记
- **本地私钥路径**：`~/.ssh/id_ed25519`
- **本地公钥路径**：`~/.ssh/id_ed25519.pub`（密钥注释标识：`workbuddy-yiying-lan`）
- **GitHub 后台登记名称**：`WorkBuddy-PrismPlay-ED25519`
- **公钥 SHA256 指纹**：`SHA256:U4ROKy1aFYjUHK4cO1sHGWdRhvTXr69DkrCJKMMVp30`

### 2. 国内代理/Clash 环境下的关键网络铁律 (443 端口跳板)
**致命陷阱**：国内网络环境下，Git 默认走的 SSH `22` 端口会被 Clash/Mihomo 的 TUN/Fake-IP 模式或运营商防火墙直接阻断（报错特征：`Connection closed by 198.18.0.104 port 22`）。  
**工程解决铁律**：必须在 `~/.ssh/config` 中配置将 `github.com` 的流量通过 `ssh.github.com` 的 **443 端口** 转发，该端口支持 SSH-over-TLS，可无缝穿透所有代理与节点：

```sshconfig
Host github.com
    HostName ssh.github.com
    Port 443
    User git
    IdentityFile ~/.ssh/id_ed25519
    StrictHostKeyChecking accept-new
```

**连接性自检验证命令**：
```bash
ssh -T git@github.com
# 预期成功输出：
# Hi lover-shadow! You've successfully authenticated, but GitHub does not provide shell access.
```

---

## 三、 浏览器插件接管控制机制 (Playwriter Automation)

为避免低效、脆弱且容易发生坐标误触的 Windows UI 截图/OCR 识别，系统全面采用 **Playwriter** 浏览器扩展协议直接接管 Master 已登录 GitHub 的真实 Chrome 浏览器。

```
┌─────────────────┐       WebSocket (CDP)       ┌────────────────────────┐       CDP Hook       ┌──────────────────────────┐
│  AI Agent / CLI │ ──────────────────────────> │ playwriter-relay-serve │ ───────────────────> │ Chrome Playwriter 扩展   │
│ (Node / Bash)   │    127.0.0.1:19988          │ (Background Daemon)    │    Chrome DevTools   │ (已保持 GitHub 登录态)    │
└─────────────────┘                             └────────────────────────┘                      └──────────────────────────┘
```

### 1. 服务端组件与扩展状态
- **Chrome 扩展 ID**：`jfeammnjpkecdekppnclgkkffahnhfhe`（Playwriter v0.0.148）
- **本地中继后台服务启动命令**：
  ```bash
  npx playwriter serve --host 127.0.0.1 --replace
  ```
  *(注：必须显式绑定 `--host 127.0.0.1`，避免因无 token 绑定 public host 而报错)*
- **端口与端点**：`127.0.0.1:19988`（HTTP / WebSocket CDP 协议）

### 2. 常用自动化脚本执行模版
```bash
# 查看已连接的真实 Chrome 实例
npx playwriter browser list

# 创建新会话并获取 Session ID (例如 1)
npx playwriter session new

# 在已登录会话中执行自动化操作 (读取页面、点击按钮、监控构建)
npx playwriter -s 1 --timeout 30000 -f script.js
```
*利用此机制，Agent 可直接在 Master 已认证的环境中检查 Actions 运行状态、下载编译产物，完全免除验证码或密码泄露风险。*

---

## 四、 GitHub Actions 云端 Android 自动编译流水线全解 (CI Architecture)

鉴于本机 Windows 环境无 JDK 17/21、无 Android SDK、无 Gradle 的现状，系统全面采用 **方案 A：云端 GitHub Actions 自动化编译出厂**。

### 1. 流水线定义与触发源
- **编排文件路径**：`.github/workflows/android-build.yml`
- **触发机制**：
  - 代码 `git push` 到 `main` 分支时自动触发；
  - 提交流水线 PR 时触发；
  - 支持在 GitHub 网页手动点击 `workflow_dispatch` 随时触发构建。

### 2. 完整 18 步工序流水线与职责划分
```yaml
name: Android APK Build & Artifact Packaging

on:
  push:
    branches: [ main, master ]
  pull_request:
    branches: [ main, master ]
  workflow_dispatch:

jobs:
  build-android:
    name: Build Android APK on Cloud CI
    runs-on: ubuntu-latest

    steps:
      - name: 检出代码仓库
        uses: actions/checkout@v4

      - name: 设置 Node.js 环境 (v22)
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: 'npm'

      - name: 设置 JDK 21 (Temurin)
        uses: actions/setup-java@v4
        with:
          distribution: 'temurin'
          java-version: '21'

      - name: 设置 Gradle 构建缓存与加速
        uses: gradle/actions/setup-gradle@v4

      - name: 接受 Android SDK 协议许可
        run: |
          echo "ANDROID_HOME: $ANDROID_HOME"
          yes | sdkmanager --licenses 2>/dev/null || true

      - name: 安装项目依赖
        run: |
          npm ci

      - name: 运行契约与数据模型静态复核
        run: |
          python tests/verify_contracts.py

      - name: 运行 Android 原生资产与组件声明复核
        run: |
          python tests/verify_android_assets.py

      - name: 运行 P0 工程红线扫描
        run: |
          python tests/scan_p0.py

      - name: 运行全量单元与集成测试
        run: |
          npm test

      - name: 执行前端生产构建 (tsc + Vite)
        run: |
          npm run build

      - name: 组织 Android 原生工程与 Capacitor 同步
        run: |
          cp -r android android.handauthored
          if [ ! -f "android/gradlew" ]; then
            npx cap add android || true
          fi
          cp -rf android.handauthored/* android/
          rm -rf android.handauthored
          npx cap sync android

      - name: 编译构建 Android Debug APK
        run: |
          cd android
          chmod +x gradlew
          ./gradlew assembleDebug --stacktrace

      - name: 归档上传 APK 构建产物至 GitHub Artifacts
        uses: actions/upload-artifact@v4
        with:
          name: prism-play-debug-apk
          path: android/app/build/outputs/apk/debug/*.apk
          retention-days: 14
```

---

## 五、 实战踩坑与避坑宝典 (Lessons Learned & Pitfalls)

在打通 CI/CD 出包的全流程中，历经 10 次云端编译实测，踩平了以下 7 大高危暗礁，后续修改必须避开：

### 1. 禁用过期的第三方 `setup-android` Action
- **踩坑现象**：使用 `android-actions/setup-android@v3` 时报错 `Failed to find package 'tools'`，导致 `sdkmanager` exit 1 失败；
- **底层成因**：Google 在现代 Android SDK cmdline-tools (16.0+) 中彻底删除了旧版 `tools` 包，第三方 action 脚本写死了 `sdkmanager tools` 导致崩溃；
- **解决铁律**：GitHub 的 `ubuntu-latest` 虚拟机已自带完善的 Android SDK 34/35 工具链，**无需任何 setup-android action**，直接运行 `yes | sdkmanager --licenses` 即可。

### 2. Android 资源 XML 注释内严禁包含 `--`
- **踩坑现象**：AAPT2 资源合并报错 `The string "--" is not permitted within comments`；
- **底层成因**：在 `ic_launcher_background.xml` 的注释中写入了 `--bg`（CSS Token 变量名），违反了 XML 1.0 规范（注释内部不允许出现连续双横线）；
- **解决铁律**：Android XML 资源文件中的所有注释，严禁出现 `--`，改为 `bg token`。

### 3. CI JDK 版本与 Gradle 声明强匹配
- **踩坑现象**：Javac 报错 `error: invalid source release: 21`；
- **底层成因**：`app/build.gradle` 声明了 `sourceCompatibility JavaVersion.VERSION_21`，而 CI 初始配置了 JDK 17；
- **解决铁律**：CI 流水线中的 `actions/setup-java` 必须统一锁定为 **`java-version: '21'`**。

### 4. Gradle Wrapper 网络超时与加速策略
- **踩坑现象**：下载 Gradle distribution 时抛出 `java.io.IOException: Downloading ... timeout 10000ms`；
- **底层成因**：`all.zip` 包体积大（150MB+），默认网络超时 10 秒过于严苛；
- **解决铁律**：
  1. `gradle/wrapper/gradle-wrapper.properties` 中改用轻量 `gradle-8.11.1-bin.zip`（仅约 80MB）；
  2. 显式配置 `networkTimeout=120000`（放宽到 2 分钟）；
  3. 引入官方 `gradle/actions/setup-gradle@v4` 进行依赖与构建分块缓存，将编译耗时从 2 分钟压缩至 **40 秒**。

### 5. Java 原生层必须显式依赖 `androidx.media:media:1.7.0`
- **踩坑现象**：`NotificationCompat.MediaStyle` 报找不到符号；
- **底层成因**：AndroidX 将 `MediaStyle` 从 `core` 拆分到了独立的 `androidx.media:media` 库中；
- **解决铁律**：`android/app/build.gradle` 的 dependencies 中必须显式声明 `implementation "androidx.media:media:1.7.0"`，且在 Java 源码中导入 `androidx.media.app.NotificationCompat.MediaStyle`。

### 6. `WebResourceResponse` 与 `Notification` 构造方法规范
- **踩坑现象**：编译提示 `no suitable constructor found`；
- **底层成因**：
  - `PrivilegedServerProxy.java` 对 200 响应必须使用 6 参数构造签名 `(mime, encoding, 200, "OK", headers, stream)`；
  - `PlaybackService.java` 中调用 `startForeground` 时，必须对 `NotificationCompat.Builder` 显式调用 `.build()` 产出 `Notification` 实体对象。

### 7. 前端 Vite 构建必须锁定相对路径 (`base: './'`)
- **踩坑现象**：移动端真机 WebView 无法解析绝对路径 `/assets/main-xxx.js`；
- **底层成因**：Vite 默认 `base: '/'`，在浏览器或网页服务器上正常，但在 Capacitor 的本地 scheme（`https://localhost`）或混合打包中，会导致静态资源寻址错位；
- **解决铁律**：`vite.config.ts` 必须显式声明 **`base: './'`**，生成相对路径资产标签。

---

## 六、 常用开发与流水线操作命令手册 (Runbook)

```bash
# 1. 本地代码与门禁全量自检 (在 push 前必跑)
npm test                             # 跑通 54 套件、672 项单元/集成测试
python tests/verify_contracts.py     # 验证 G0 契约与 D1 表自洽
python tests/verify_acceptance.py    # 验证 18 条 AC 验收矩阵
python tests/verify_android_assets.py # 验证 Android 清单与原生资源引用
python tests/scan_p0.py              # 验证 186 文件 0 破口红线

# 2. 本地前端生产打包
npm run build                        # tsc + Vite 生成优化后的 dist/ 产物

# 3. 提交代码并自动触发云端打包
git add .
git commit -m "feat/fix: 说明本次改动"
git push origin main                 # 推送到 GitHub，Actions 自动开始编译

# 4. 下载最新云端 APK
# 访问 GitHub 仓库 Actions 页面：
# https://github.com/lover-shadow/prism-play/actions
# 点击最新一条绿色的 Run 记录，在页面底部 Artifacts 区域下载 prism-play-debug-apk 即可。
```
