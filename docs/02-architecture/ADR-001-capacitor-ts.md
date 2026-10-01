# ADR-001: 采用 Capacitor 7 工业级跨端容器与纯 TypeScript 架构

- **状态 (Status)**: Accepted (已采纳)
- **决策日期 (Date)**: 2026-09-30
- **决策者 (Deciders)**: Master_流光逸影 (架构主理人), 大湾区靓仔 (项目总监), 高见远 (首席架构师)

---

## 背景与问题陈述 (Context and Problem Statement)

初代实验项目（历史工程 `D:\DEV\guoguo-juku`，**非当前仓库**；当前工程为 `D:\DEV\prism-play`）采用 Android 原生 Activity 内部通过 `ProcessBuilder` 强行拉起 Go 编译的 Linux ELF 可执行程序（`juku_arm64`）监听本地 8999 端口，并用简易 WebView 呈现界面的模式。  
该模式带来了 5 大硬伤：
1. 安装包体积膨胀（仅 Go 运行时就多出 15MB+）；
2. 违反 Android 10+ 的 W^X 安全沙箱红线，新版安卓系统容易后台查杀子进程；
3. 开发调试极其繁琐，无法使用现代前端 DevTools 进行热重载；
4. 存在强烈的“网页套壳感”，窗口无标准现代 WindowInsets 沉浸式支持；
5. 技术血统与主站 `prismos.org`（React 19 / Vite / Tailwind）完全割裂。

我们需要决定：在《光影Play》（Prism Play）商业版 2.0 中，采用何种移动端宿主与语言架构？

---

## 考虑的备选方案 (Considered Options)

1. **方案 A：保留 Go 原生静态库化 (gomobile bind)**：将 Go 代码用 gomobile 编译为 Android 原生 `.aar` 动态库，由 Android 原生宿主调用；
2. **方案 B：纯原生全栈 (Kotlin + Jetpack Compose + ExoPlayer)**：完全抛弃 Web 与 Go，纯原生重写；
3. **方案 C：Capacitor 7 宿主 + TypeScript 客户端（全局方案 B）**：端侧负责公开快照、搜索交互、播放与原生桥；来源接入、聚合、择源、授权及索引在边缘服务端执行，不向客户端下发上游地址。

---

## 决策结论 (Decision Outcome)

**选择【方案 C（即全局方案 B）】**。

### 核心采纳理由 (Decision Drivers)
- **减少端侧进程**：没有额外 Go 子进程；APK 体积 6～8MB 是待真机构建测量的目标，不能作为已经达到的结果。
- **便于联调**：Vite + TypeScript 支持浏览器热重载与调试；效率收益须在实际工程测量。
- **官方插件生态丰富**：Capacitor 7 官方提供 `@capacitor/status-bar`（真全屏）、`@capacitor/app`（生命周期）、`@capacitor/preferences`（非敏感本地偏好）；网络能力由随 `@capacitor/core` 提供的 `CapacitorHttp` 承担——它**不是**独立包，且默认不 patch `window.fetch`，因此**不能**假设它能自动解决 HLS 切片跨域与防盗链，媒体链路一律走同源受控代理；
- **全端同构**：与主站 `prismos.org`（Vite + Tailwind）技术栈同根同源，同一套 TypeScript 代码可同时打成 Android APK、发布为 Web 网页版、或后续上架 iOS。

### 带来的正面后果 (Positive Consequences)
- 彻底根除了 Android 10+ 上因私有目录执行二进制被系统封杀的崩溃风险；
- 预计减少端侧需维护的独立运行时；全栈实际代码量须以阶段工作包完成后的 LOC 统计为准，不预设节省百分比；
- 任何具备标准 Node.js 环境的开发者均可快速构建，告别 NDK/Cgo 编译地狱。

### 带来的妥协与应对 (Negative Consequences & Mitigation)
- 旧项目源解析逻辑只能作历史结构参考，不能直接继承上游访问权限或把旧内容源当作可公开片库。仅对已明确配置且具备相应接入依据的来源设计服务端 Adapter；规模由真实样本测量，不能承诺不足 300 LOC。
