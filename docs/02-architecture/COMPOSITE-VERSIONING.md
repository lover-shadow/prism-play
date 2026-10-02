# 《光影Play》（Prism Play）多维复合版本控制规范 (COMPOSITE-VERSIONING.md)

> **版本状态**：基线确立  
> **生效日期**：2026-10-02  
> **适用范围**：全端代码库（Client Web / Android Native / Cloudflare Edge / GitHub CI/CD）  
> **核心原则（Master 2026-10-02 权威定案）**：
> 1. **全端采用多维复合组件版本号**：格式为 `{env}_v{major}.{edge}.{web}.{native}`；
> 2. **外部 APP 界面呈现**：明确显示当前版本（如 `dev_v2.1.1.1`），**但坚决不显示 `git.hash`**；
> 3. **Git 锚点（`+git.{hash}`）严格限定于本地开发与 Git 提交/Tag 约束**，属于开发环境记录，绝不暴露到用户客户端界面。

---

## 一、 架构动机：传统单一版本号为何失真？

《光影Play》由三个独立演进、解耦部署但紧密协同的子系统构成：
1. **Cloudflare Serverless 边缘云脑 (`edge/`)**：D1 数据库、KV 拓扑/商业化配置、Cron 定时源巡检；
2. **Web / UI 界面与播放舞台 (`src/`)**：Vite + TS + 48px 全宽搜索 + 非全屏详情生态台 + 半屏数字选集抽屉 + 二级视图；
3. **Android 原生宿主与桥接层 (`android/`)**：Capacitor 插件、硬件 Keystore、系统返回键总线接管（`@capacitor/app`）。

如果仅标记一个模糊的单体版本号（如 `2.0.0`），开发者和测试人员无法得知当前包中的前端是否已是最新、原生手势总线是否已编译进 APK、云端 API 契约是否对齐。因此，必须将各部件的版本状态显式解耦在版本号字段中。

---

## 二、 复合版本号结构解析：`{env}_v{major}.{edge}.{web}.{native}`

```
                        复合版本号架构模型
    ┌───────┬──────┬───────┬───────┬─────────┐
    │  env  │major │ edge  │  web  │ native  │  (+ git.hash 仅本地Git使用)
    │  dev  │  v2  │   1   │   1   │    1    │
    └───────┴──────┴───────┴───────┴─────────┘
       │       │       │       │        │
       │       │       │       │        └─ 第 4 字段：原生底座与 Android 桥接版本
       │       │       │       └────────── 第 3 字段：前端界面、播放器与交互系统版本
       │       │       └────────────────── 第 2 字段：Cloudflare 边缘云脑与 D1 数据库版本
       │       └────────────────────────── 第 1 字段：架构代际主版本 (Major Generation)
       └────────────────────────────────── 前缀标识：运行与交付环境 (dev/rc/prod)
```

### 字段职责与演进标准表

| 字段位置 | 字段代号 | 覆盖源码范围 | 触发递增场景 | 当前取值 |
| :--- | :--- | :--- | :--- | :---: |
| **Prefix** | **`env`**<br>环境标识 | 整体交付与运行通道 | • `dev`：开发联调、内部调试（当前）<br>• `rc`：候选发布封测<br>• `prod`：正式发布给终端用户 | **`dev`** |
| **字段 1** | **`v{major}`**<br>架构大代际 | 全局顶层技术架构基线 | 发生跨代级架构颠覆（如从旧 Go 单体方案 A $\to$ 彻底重构为 Capacitor+Cloudflare 方案 B 纪元） | **`v2`** |
| **字段 2** | **`edge`**<br>边缘云脑版本 | `edge/` 目录源码、D1 表结构与迁移脚本、定时 Cron 巡检 | • 边缘 API 契约变更<br>• D1 数据库增加表/修改字段<br>• 上游采集与解析引擎重大调整 | **`1`**<br>(D1 0001 稳定态) |
| **字段 3** | **`web`**<br>前端与交互版本 | `src/` 视图组件、播放舞台、设计系统 CSS、UI 原型 | • 播放详情生态台、半屏数字选集面板重塑<br>• 首页 48px 全宽搜索栏与流体导航<br>• 二级页面 Inset Grouped 视觉升级 | **`1`**<br>**(本次刚完成重塑，跃升为 1)** |
| **字段 4** | **`native`**<br>原生底座版本 | `android/` 原生工程、Capacitor 插件、Keystore/JNI 桥接 | • 升级或引入新的 Capacitor 原生插件<br>• **接入系统返回键总线接管（拔除小米全面屏侧滑死锁）**<br>• Android 后台播放服务/通知栏权限变更 | **`1`**<br>**(本次接入 @capacitor/app，跃升为 1)** |

---

## 三、 双轨呈现铁律：App 界面与 Git/开发环境的严格隔离

### 1. 外部 APP 界面呈现铁律
- **App 界面中（如设置、版本信息、弹窗等）所显示的文本统一为**：
  $$\mathbf{dev\_v2.1.1.1}$$
- **红线禁令**：**严禁在 APP 界面中展示 `git.hash`（如 `+git.a1b2c3d`）**。终端用户不需要看到内部提交哈希，保持界面整洁干净。

### 2. 本地开发与 Git 提交约束
- **Git 提交信息（Commit Message）**：在 Commit 中标注本次更新对应的复合版本演进，如：
  ```gitcommit
  feat(ui): complete mobile-native UI/UX overhaul and gesture back-stack (dev_v2.1.1.1)
  ```
- **Git 标签（Tag 锚点）**：在关键里程碑节点打上复合版本 Tag：
  ```bash
  git tag -a dev_v2.1.1.1 -m "milestone: dev_v2.1.1.1 (edge.1 / web.1 / native.1)"
  ```
- **构建产物命名**：CI 自动化构建出的内部安装包命名为：`prism-play-dev_v2.1.1.1.apk`，便于精准溯源。

---

## 四、 Android 原生工程版本映射规则

Android 系统要求 `build.gradle` 中的 `versionCode` 为单调递增的整数，`versionName` 为展示字符串。映射规则如下：

* **`versionName`**：直接对齐复合版本号，即：
  ```groovy
  versionName "dev_v2.1.1.1"
  ```
* **`versionCode`**：采用十进制位权组合映射：
  $$\text{versionCode} = \mathbf{2} \times 10000 + \mathbf{1} \times 1000 + \mathbf{1} \times 100 + \mathbf{1} \times 10 = \mathbf{21110}$$
  既保证了 Android 系统的严格单调递增，又在数值结构上与 `v2.1.1.1` 一一对应。
