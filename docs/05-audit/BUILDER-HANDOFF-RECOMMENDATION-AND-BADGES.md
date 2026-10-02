# 客户端实施指令包：大视界 3.5:3.5:3 E&E 自适应混排与海报微光角标系统 (BUILDER-HANDOFF-RECOMMENDATION-AND-BADGES.md)

> **致施工总包 Agent**：  
> 本任务由 Master 与云端监理方共同审定定案。云端部分（D1/API 数据与客观热度打标）已由云端专员全权负责并就绪；本文档指导客户端（APP 内部）完成**“纯离线 3.5:3.5:3 推荐混排”**与**“海报左上角微光角标”**的优雅落地。请严格按照规范施工。

---

## 一、 核心目标与端云权责边界

1. **核心目标**：
   - 将首页大视界从纯线性的静态排列，升级为兼顾未来趋势与大盘流量的 **“35% AI精品 + 35% 全网热门 + 30% 口碑破圈” 自适应流体瀑布流**；
   - 在海报左上角增加符合 P0 极客美学的**极简微光角标系统（【AI精品】/【热门】/【推荐】）**。
2. **端云权责分工（恪守零隐私上报原则）**：
   - **云端（已由专员就绪）**：`/api/catalog` 下发作品的客观元数据（含 `isAi: boolean`, `category: string`, `isHot?: boolean`, `hotScore?: number`）；
   - **客户端（由你负责）**：纯本地读取 `local_watch_history`，纯离线计算题材喜好，纯内存执行 2ms 混排与贴标，**严禁将用户观影流水上传云端**！

---

## 二、 算法规格：三轨互斥去重与交错编织 (Deduplication & Interleaving)

### 1. 本地兴趣画像打分模型 (Preference Scoring)
读取本地 SQLite `local_watch_history`，叠加 **7 天半衰期时间衰减**：
$$Score(Genre) = \sum \left[ 0.5^{\frac{\Delta t}{7天}} \times (WatchedEpisodes \times 2 + WatchMinutes \times 0.5 - SkipPenalty) \right]$$
- 算出用户在 21 个双字分类中的偏好得分向量（如 `{ 战神: 18.5, 逆袭: 12.0, 科幻: 6.2 ... }`）。

### 2. 候选分池与顺序去重（严格互斥管道）
将云端返回或本地快照的当前片单分为三池，按优先级**单向消费去重**，杜绝同一剧目重复出现：

```ts
const selectedSet = new Set<string>(); // 全局去重集合

// 1. 优先提取 A 轨 (35% AI精品，战略优先)
// 条件：item.isAi === true 或 tags 包含 AI，按画像偏好分排序
const aiItems = poolAI.filter(x => !selectedSet.has(x.id)).slice(0, targetCount * 0.35);
aiItems.forEach(x => { selectedSet.add(x.id); x._badge = 'ai'; });

// 2. 提取 B 轨 (35% 全网热门爆款)
// 条件：无论题材，按 hotScore 降序，强制排除 selectedSet
const hotItems = poolHot.filter(x => !selectedSet.has(x.id)).slice(0, targetCount * 0.35);
hotItems.forEach(x => { selectedSet.add(x.id); x._badge = 'hot'; });

// 3. 提取 C 轨 (30% 破圈异质探索)
// 条件：用户低频涉足的冷门异质高分题材，强制排除 selectedSet
const exploreItems = poolExplore.filter(x => !selectedSet.has(x.id)).slice(0, targetCount * 0.30);
exploreItems.forEach(x => { selectedSet.add(x.id); x._badge = 'recommend'; });
```

### 3. 步长交错编织 (Interleaving Shuffle)
最终展示列表按 `[AI精品, 热门爆款, 破圈探索, AI精品, 热门爆款, ...]` 交织混合插入，呈现自然呼吸的流体节奏，避免板块感堆叠。

---

## 三、 UI/UX 规范：海报微光角标设计 (P0 绝对铁律)

1. **绝对禁令**：
   - 严禁 Emoji（如 `🎯` `🔥` `🌟`，违者触发 P0-1 门禁重做）；
   - 严禁使用荧光大红大绿地摊色，零裸 Hex，100% 消费 Design Tokens。
2. **位置与排版**：
   - **位置**：海报**左上角**绝对定位，与右下角集数徽标（`.poster-ep-badge`）形成对角呼吸呼应；
   - **尺寸**：高度 18px，内边距 `2px 6px`，圆角 `4px`，字号 `10.5px`，字重 `500`；
   - **底板**：`background: rgba(8, 10, 16, 0.75); backdrop-filter: blur(8px); border: 1px solid var(--border-subtle);`
3. **三档微光样式（语义分明）**：
   - **【AI精品】（或极简 `AI`）**：
     - 文字色彩：冰蓝/未来科技银白（`color: #70A5FF` 或 `var(--badge-info)`）；
   - **【热门】**：
     - 文字色彩：流媒体院线级琥珀金（`color: var(--accent)`）；
   - **【推荐】**：
     - 文字色彩：象牙纯白（`color: var(--text-primary)`）；
   - 保持留白美感：未命中上述特征的作品不贴标，保持海报纯净。

---

## 四、 建议修改与新建文件清单

1. **新建推荐引擎核心纯函数 (`src/core/recommendation.ts`)**：
   - 承载 `computeMixedRecommendations(items, historyRows, options)` 纯算法函数，方便针对 3.5:3.5:3 与去重机制编写独立单元测试；
2. **改造海报网格卡片 (`src/components/poster-grid.ts`)**：
   - 在 `media()` 函数内部，根据 `item._badge`（或外部扩展属性），在左上角追加 `<span class="poster-corner-badge poster-corner-badge--{type}">标签文字</span>`；
3. **补充角标 CSS 样式 (`src/styles/home.css`)**：
   - 注入 `.poster-corner-badge` 系列类名，严格消费 CSS 变量与 Design Tokens；
4. **首页主视图装配 (`src/views/home-view.ts`)**：
   - 在片单渲染或增量拉取后，调用 `computeMixedRecommendations` 进行混排输出。
