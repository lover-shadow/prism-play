# 《光影Play》全网内容自演进、多阶取流、多季聚合与共享剧库：技术规格书与执行计划 (SPEC + PLAN)

**维护主体**：MVP开发专家团（项目总监：大湾区靓仔） / Master_流光逸影  
**生效日期**：2026-10-06  
**版本编号**：v2.7.0-DRAFT  
**现行状态**：现行实施纲领（已批准架构路线，自完备执行指南）  
**基线代码**：`D:\DEV\prism-play` (Commit: `05bfdac` + 2026-10-06 本地增量)  
**对照实现**：`D:\DEV\guoguo-juku` (Golang 多源流媒体并发采集与原生逆向取流实现)

---

## 0. 新会话导读与执行宪法

### 0.1 文档定位与阅读须知
本文档为**完全自完备的工程规格书（SPEC）与分步执行计划（PLAN）二合一方案**。任何新进入仓库的开发 Agent、监理 Agent 或工程师，无需翻阅历史聊天记录，仅凭本文档、仓库既有代码及前代项目 `D:\DEV\guoguo-juku` 源码，即可掌握系统运转机理并完整实施。

### 0.2 核心问题复盘与解决宗旨
在 v2.6.4 及之前的版本中，系统的搜索与剧库机制暴露了以下根本性瓶颈：
1. **信源受限死锁**：将上游“公开 Web 网页”作为唯一取流信源。由于各大主流短剧/长剧平台为了引流 App，普遍在网页端设置“前 3 集试看、第 4 集 404/跳转下载”的防爬拦截，导致爬虫在第 4 集全部失效。
2. **入库门槛死锁**：硬性实行“100 集必须一次性全部解析成功才准入库”的判定。只要第 4 集试看阻断或单集偶发网络波动，整部剧连同前 3 集被一票否决为 `unavailable` 并被系统丢弃。
3. **展示交互缺陷**：搜索结果采用隐藏滚动条的单行横向滑动海报带（`.pv-rail`），导致数十部搜索结果在视觉上“只能看见前 6 部”，产生“只搜出 6 集”的严重错觉。
4. **孤立剧目拓扑**：缺乏“系列（Series）与季播（Season）”的聚合归纳。如《持械入宋》1～7 季在上游往往分散上传，系统缺乏自动嗅探补齐、成套聚合展示的能力。
5. **单机割裂孤岛**：各设备每次都重新向上游检索，耗费配额且受制于上游抖动，没有建立“一人检索发现，全网设备免搜共享”的内容飞轮。

**解决宗旨**：建立一套**“协议层直通 App 原生流、数据层渐进可用按需预热、拓扑层自动聚季补缺、流转层一人发现全网共享、展现层纵向全景展示”**的通用流媒体生命周期中枢。

### 0.3 P0 绝对工程红线（任何成员违反即刻驳回）
1. **彻底去平台化（零外部品牌暴露）**：公开文案、网络响应 JSON、分享页、播放器绝对严禁出现任何外部站源名（如“红果”、“魔都”等），代码内统一以 `provider_s1`、`provider_m1` 抽象代号管理。
2. **私密专属双准入隔离**：【个人探索】必须同时满足“有效高级授权”与“当次手动开启”，任一不满足则在网络传输、数据库、搜索投影、内存与 DOM 树中 100% 物理隐形，严禁流入公共发现池或公共 FTS 索引。
3. **P0 视觉规范**：
   - 严禁 emoji 表情作为 UI 功能图标，统一使用 Lucide Icons（内联 2px stroke SVG）；
   - 主色调锁定流媒体院线级**琥珀金 `--accent: #E5A93C`**，夜间背景锁定 OLED 省电**黑曜石夜空 `--bg: #080A10`**，日间背景锁定**象牙纯白 `--bg: #F5F6FA`**；
   - 严禁硬编码色值，100% 消费 Design Tokens；单文件源码行数严格收敛至 **≤ 300 行**。

---

## 1. 架构全景与两端分工

```text
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                 【两端闭环架构全景拓扑】                                │
├─────────────────────────────────────────────┬───────────────────────────────────────────┤
│         云端 (Cloudflare Serverless 调度大脑)│         端侧 (Capacitor 7 + TypeScript 终端)│
├─────────────────────────────────────────────┼───────────────────────────────────────────┤
│ 1. 协议解析层 (Multi-Tier Resolver)         │ 1. 搜索展示层 (Search View & Rail)        │
│    - Tier 1: 网页轻量元数据 (快速建卡)       │    - 废除横向隐藏轨道，全面改用纵向三列网格│
│    - Tier 2: App 原生流媒体协议 (突破试看截流)│    - 诚实标签: 剧名精确/剧名模糊/简介命中 │
│    - Tier 3: CENC / spade_a 算法解密提取    │    - 真·无限分页加载，支持加载更多与重试   │
│                                             │                                           │
│ 2. 渐进式可用引擎 (Progressive Ingestion)   │ 2. 多季原生交互层 (Series & Season UI)    │
│    - 第 1 集解析就绪即发布，拒绝全剧一票否决 │    - 搜索结果将多季聚合成【全 N 季】大卡片 │
│    - 滑动窗口异步补全队列 (8 集/批次切片)   │    - 播放详情内嵌原生【第 1 季~N 季】切换胶囊 │
│                                             │                                           │
│ 3. 系列与季播聚合器 (Series Normalizer)     │ 3. 渐进起播中枢 (Progressive Player)      │
│    - 标题正则归类母词，自动提取季号         │    - 首集秒开起播，后序集数静默加载        │
│    - 缺季嗅探 (发现1和3季，自动派生搜索补第2季)│    - 选集面板动态反映“解析中/就绪/不可用”  │
│                                             │                                           │
│ 4. 共享内容资产池 (Collective Pool)         │ 4. 本地索引与离线同步 (Local Cache)       │
│    - D1 发现索引 + 独立私有 R2 事实包存储   │    - 本机秒级先显 + 后台自动联网补全      │
│    - 跨请求分布式租约 (原子防并发打爆)      │    - 在线新剧/新集持久合并写入本地 SQLite │
│    - 增量流水账本 (`/api/search/discoveries`)│    - 独立游标定时拉取增量，关网照常检索    │
└─────────────────────────────────────────────┴───────────────────────────────────────────┘
```

---

## 2. 协议层破解：多阶取流调度器与解密引擎

### 2.1 问题的物理机制
以主流平台（如 `provider_s1`）为例：
- Web 端路由：`https://[host]/player/{series_id}/{video_id}`。上游网关在第 4 集之后强制返回 HTTP 404 或无媒体载荷，并在前端挂载拦截弹窗。
- App 端接口：`https://novel.snssdk.com/novel/player/video_model/v1/`。只要持有合法的 Android 客户端标识，上游接口返回包含全部 100 集完整多码率直链。部分优质流媒体会采用 CENC（通用加密）或者 `spade_a` 参数加密，需要客户端进行本地对称解密。

### 2.2 三阶取流管道设计 (Tiered Resolver)
在 `edge/src/search/providers/s1.ts` 与对应解析器中实现三阶管道：
1. **Tier 1 (轻量元数据探测)**：请求公开详情页 `GET /detail?series_id={sid}`，获得剧名、封面、简介、总集数及完整的 `vid_list` 数组（秒级返回，不取视频媒体流）。
2. **Tier 2 (App 原生媒体取流)**：直接模拟原生 Android 客户端报文请求流媒体模型接口，绕过 Web 端试看阻断。
3. **Tier 3 (备用解析降级)**：若 App 原生协议被上游 WAF 临时风控，自动退回通用回退解析网关。

### 2.3 关键解密与请求实现（对照 `guoguo-juku` 源码映射）

#### 机制 A：App 原生接口报文构造
*参考实现*：`D:\DEV\guoguo-juku\internal\app\provider_hongguo_native_media.go:15-37` 与 `provider_hongguo_app.go:145-205`。
在 Cloudflare Worker (TypeScript) 中的移植实现：

```typescript
// edge/src/search/providers/s1-native.ts
export interface AppMediaModelRequest {
  video_id: string;
  content_type: number; // 1
  biz_param: {
    need_all_video_definition: boolean; // true
    video_platform: number; // 3
  };
}

export const APP_HEADERS = {
  'User-Agent': 'com.dragon.read/7.3.5.32 (Linux; U; Android 14; zh_CN; 25053RT47C; Build/UKQ1.231003.002; Cronet/TTNetVersion:7a37fa20 2024-03-05 QuicVersion:420658e4 2024-03-05)',
  'Accept': 'application/json',
  'X-XS-From-Web': '0',
  'Sdk-Version': '2'
};

export const APP_PARAMS = {
  aid: '8662',
  app_name: 'novelread',
  version_code: '73532',
  version_name: '7.3.5.32',
  channel: 'update_64',
  device_platform: 'android',
  os: 'android'
};
```

#### 机制 B：CENC / spade_a AES-128 密钥解密算法
*参考实现*：`D:\DEV\guoguo-juku\internal\app\provider_hongguo_playback.go:159-201` (`hongguoContentKey`)。
当原生接口返回的数据中包含 `encrypt_info.spade_a` 时，视频流采用 AES-128-CTR 进行了加密。解密密钥的还原逻辑必须精准复现：

```typescript
// edge/src/search/providers/s1-cipher.ts
export async function extractSpadeKey(spadeA: string): Promise<Uint8Array | null> {
  if (!spadeA || spadeA.length > 1024) return null;
  // 1. 标准 Base64 解码
  const raw = Uint8Array.from(atob(spadeA.trim()), c => c.charCodeAt(0));
  if (raw.length < 33) return null;

  // 2. 提取 tag 长度与内容长度
  const tagLength = (raw[0] ^ raw[1] ^ raw[2]) - 48;
  const contentLength = raw.length - tagLength - 1;
  if (tagLength < 1 || contentLength < 33 || contentLength >= raw.length) return null;

  // 3. 校验 tag (排除暂不支持的 app_v2/web_v2 变种)
  const seed = raw[raw.length - tagLength - 2] ^ raw[raw.length - tagLength - 1];
  const tagBytes = new Uint8Array(tagLength);
  for (let i = 0; i < tagLength; i++) {
    tagBytes[i] = raw[raw.length - tagLength + i] ^ seed;
  }
  const tag = new TextDecoder().decode(tagBytes);
  if (tag === 'app_v2' || tag === 'web_v2') return null;

  // 4. 双交替异或流水解码
  const decoded = new Uint8Array(contentLength);
  let prevEven = 250;
  let prevOdd = 85;
  for (let i = 0; i < contentLength; i++) {
    const curr = raw[1 + i];
    const prev = (i % 2 === 0) ? prevEven : prevOdd;
    if (i % 2 === 0) prevEven = curr; else prevOdd = curr;
    
    // 计算 hamming weight (位计数)
    const ones = countOnes(i);
    decoded[i] = (prev ^ curr) - 21 - ones;
  }

  // 5. 提取 32 字符 Hex 字符串并转为 16 字节 AES 密钥
  const hexStr = new TextDecoder().decode(decoded.slice(1, 33));
  if (!/^[0-9a-fA-F]{32}$/.test(hexStr)) return null;
  
  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    key[i] = parseInt(hexStr.substr(i * 2, 2), 16);
  }
  return key;
}

function countOnes(n: number): number {
  let count = 0;
  while (n > 0) {
    count += n & 1;
    n >>= 1;
  }
  return count;
}
```

---

### 2.4 native manifest 已实现范围与未完成云链（2026-10-06）

`EpisodeLine` / `PlaybackLine` 保留必填 providerId/mediaUrl，新增 `native?: {kind:'s1-cenc',videoId:string}`，仅 provider_s1 可带。videoId 为1～32位 ASCII 数字字符串（`^[0-9]{1,32}$`），保留前导零、不转数字；native 严格只含 kind/videoId，unknown-field reject，包括 key/cencKeyHex（即使 null）、任意额外键、错误 kind/类型/长度与显式 null/undefined。不得删除 native 后伪装明文流；此闭集仅针对 native 对象，不宣称整个响应所有层级均严格拒绝未知字段。

实际主链为 work manifest / 私有 R2 discovery fact 的按作详情投影，不是 D1 episode 旧 playback。native mediaUrl 只是来源候选，不等于 ArtPlayer/Web/电视可播；原生桥的来源输入仅 vid（videoId，会话/进度控制参数另计），Android runtime resolver 获取实时地址与 key，key 不返回 JS，不进 manifest、事实包、响应、缓存或日志。Web/native cast 必须诚实拒绝 native 线路；不带 native 的合法普通线路仍可按既有能力处理。§2.3 云端算法示意不是 JS 密钥交付契约，§1 拓扑与§3 首集 published 也不构成 native 起播成功证明。

Android 本地 CENC DataSource + ExoPlayer 单集已获 Master 播放正常反馈；完整 HUD 集成代码已写并编译，未真机通过。云端授权绑定的播放解析 handle 尚未实现，Stage A 未完成；旧生产 fact 无 native，需刷新，本轮未部署。manifest 的1～32位范围与当前 Java bridge/resolver 的1～20位执行范围存在缺口，21～32位仍待接齐，不宣称全部合法身份可播。§9 各阶段未完成 todos 保留，局部实现、单集反馈与完整云/端验收分开登记。

authority 裁定：AGENTS 为最高工程契约，SPEC-v2.0 为施工验收正本；本文“自完备”不赋予覆盖两者权限。仅收窄 native 线路的直连/取 key 与可播口径，不授权一般内容 FLAG_SECURE；其范围仍是正本 AC-02 个人探索频道/播放，退出解除。私有 R2 是访问权限属性，不等于个人探索数据可入公开池；原双准入、零落盘、G0→G4 不变。OpenAPI/ADR/index/专门 CENC 计划由主会话负责，本轮仅五份文档同步，未部署或宣布门禁完成。

## 3. 渐进式可用引擎：滑动窗口解析与任务队列

### 3.1 废除“全集一票否决”
传统设计中，只要第 4 集报错，整部剧即置为 `status: 'failed'`。
**新规则（SPEC 强制）**：
- **首集就绪法则**：只要通过搜索命中作品，且 `episodes[0]`（第一集）获取到有效可用的真实播放地址，该作品即标记为 `status: 'published'` 写入公共索引 `discovery_works`。
- **动态就绪标记**：作品的每集状态标记为 `ready`、`pending` 或 `error`。前端在选集列表里对已就绪集数允许点击，未就绪集数展示加载中动画，绝不阻断首集播放。

### 3.2 滑动窗口后台补全队列设计 (Sliding Window Jobs)
对于 100 集的长剧，按批次异步推进：
- **批次配额**：每批次请求最多抓取 8 集（`MAX_PLAYER_REQUESTS_PER_BATCH = 8`）。
- **断点检查点（Checkpoint State）**：
  检查点由服务端完全接管，序列化存入私有 R2 桶 `DISCOVERY_BUCKET` 中的 `discovery/checkpoints/{job_id}.json`，并在 D1 `discovery_jobs` 表中记录游标状态。
- **任务生命周期状态机**：
  ```text
  [初始化任务] -> (解析第 1 集成功) -> [发布作品至 discovery_works (用户可播放)]
                     |
                     v
           [状态: pending (next: 1)] 
                     |
                     v
  (后续用户请求 / Cron 触发 / 端侧轮询) -> [抓取 2~9 集] -> [更新 R2 事实包] -> [更新 checkpoint (next: 9)]
                     |
                     v (循环直至 next == total)
           [状态: complete]
  ```

---

## 4. 系列与多季聚合引擎 (Series & Season Normalizer)

### 4.1 核心算法实现（对照 `guoguo-juku` 源码映射）
*参考实现*：`D:\DEV\guoguo-juku\internal\app\provider_hongguo_search_seasons.go:32-79`。

#### 机制 A：季播后缀正则与数字归一化
支持对中文数字、阿拉伯数字、全角半角混排进行归一化：

```typescript
// edge/src/search/series-normalizer.ts
const SEASON_REGEX = /^(.*?)[：:\s_]*第?\s*([0-9零一二两兩三四五六七八九十百]+)\s*(季|部|阶段)$/i;

const CHINESE_DIGITS: Record<string, number> = {
  '零': 0, '〇': 0, '一': 1, '二': 2, '两': 2, '兩': 2, '三': 3,
  '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9
};

export function parseSeasonInfo(fullTitle: string): { baseTitle: string; seasonNumber: number; seasonUnit: string } | null {
  const title = fullTitle.normalize('NFKC').trim();
  const match = SEASON_REGEX.exec(title);
  if (!match) return null;

  const baseTitle = match[1].trim();
  const numRaw = match[2];
  const seasonUnit = match[3];

  let seasonNumber = parseInt(numRaw, 10);
  if (isNaN(seasonNumber)) {
    seasonNumber = parseChineseNumber(numRaw);
  }

  if (!baseTitle || seasonNumber < 1 || seasonNumber > 200) return null;
  return { baseTitle, seasonNumber, seasonUnit };
}

function parseChineseNumber(str: string): number {
  if (str.length === 1 && CHINESE_DIGITS[str] !== undefined) return CHINESE_DIGITS[str];
  if (str.startsWith('十')) str = '一' + str;
  let total = 0;
  let unit = 1;
  // 简易十进制解析 (针对短剧季数 <= 99 足够)
  for (let i = str.length - 1; i >= 0; i--) {
    const char = str[i];
    if (char === '十') { unit = 10; if (i === 0) total += 10; }
    else if (CHINESE_DIGITS[char] !== undefined) {
      total += CHINESE_DIGITS[char] * unit;
      unit = 1;
    }
  }
  return total;
}
```

#### 机制 B：缺季智能嗅探算法 (Gap Sniffer)
*参考实现*：`D:\DEV\guoguo-juku\internal\app\provider_hongguo_search_seasons.go:124-162` (`hongguoSearchSeriesGroups`)。
算法步骤：
1. 对搜索命中的候选列表分组，提取母剧名 `baseTitle`。
2. 收集每个组内已知的所有季号集合 `knownSeasons = [1, 3, 7]`。
3. 计算最大季号 `maxSeason = 7`。
4. 扫描 `1 .. maxSeason` 区间。当发现某个季号（例如第 2 季、第 4 季）缺失时：
   - 自动生成补充检索词：`[ "${baseTitle}第二季", "${baseTitle}第2季" ]`；
   - 派发异步搜索任务，将补搜出来的作品归档到同一系列中。

### 4.2 客户端多季聚合卡片与选集面板设计

#### 1. 搜索结果收敛卡片 (Series Aggregate Card)
在搜索结果列表中，属于同一系列的多季作品**不再平铺展示为 7 张卡片**，而是合成一个作品卡：
- **卡片海报**：默认取最新一季（或第一季）封面；
- **右上角徽标**：显示琥珀金强调标签【全 7 季 / 连载至第 7 季】；
- **点击动作**：直接唤起播放详情页。

#### 2. 详情页与播放器内多季切换面板
在详情页顶部或选集抽屉（Drawer）上方，增加原生季播胶囊切换器：
```html
<!-- DOM 结构契约 -->
<div class="prism-season-bar" role="tablist" aria-label="剧集季数">
  <button class="prism-season-pill is-active" data-season="1">第 1 季 (100集)</button>
  <button class="prism-season-pill" data-season="2">第 2 季 (80集)</button>
  <button class="prism-season-pill" data-season="3">第 3 季 (120集)</button>
  ...
</div>
```
- **交互规范**：
  - 用户点击【第 2 季】，下方选集列表立即切换为第 2 季的集数，无需退出全屏播放器或重新进入新页面。
  - 用户的播放进度、已看集数按照 `workId` 分别独立持久化存储。

---

## 5. 连载状态机与增量追更系统

### 5.1 连载状态标注
在公开作品事实结构 `DiscoveryPublicFact` 中固化连载属性：
- `releaseStatus: 'finished' | 'ongoing'`
- `lastSyncedEpisode: number`
- `lastSyncedAt: number` (Unix 秒)

### 5.2 双轮驱动追更策略
1. **触碰式被动追更 (JIT On-Demand Probe)**：
   - 当用户在客户端检索或打开一部状态为 `ongoing` 的剧目时；
   - 若 `now() - lastSyncedAt > 1800`（30 分钟检查窗口），边缘触发一次轻量 HEAD 探针向源站比对最新 `episode_cnt`。
   - 若发现上游更新了 3 集（从 40 集变 43 集），后台自动拉取新集数并追加至 R2 事实包中。
2. **全网增量同步账本 (Change Feed)**：
   - 任何新增作品或连载剧集变动，触发 D1 触发器，自动向 `discovery_changes` 表写入一条增量日志（`operation: 'upsert'`）。
   - 客户端在后台定期轮询 `GET /api/search/discoveries?after={cursor}&limit=60`，拉取增量补齐本地 SQLite。

---

## 6. 客户端搜索交互重构：纵向三列网格与真翻页

### 6.1 废除横向滚动海报带
- **彻底废除**：删除 `src/views/views.css` 中的 `.pv-rail` 横向单行滑动类，禁止出现 `overflow-x: auto` 加隐藏滚动条的盲盒布局。
- **重构为三列纵向网格**：
```css
/* src/views/views.css 改造契约 */
.srch-results-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-3);
  padding: var(--space-2) 0;
  width: 100%;
}

@media (min-width: 640px) {
  .srch-results-grid {
    grid-template-columns: repeat(4, 1fr);
  }
}
```

### 6.2 真实结果标签与计数
彻底纠正把“简介命中”称为“模糊纠错”的含糊文案，结果分类必须真实反映召回原因：
- **`剧名精确命中 (N)`**：查询词完整包含在标题中，或标题完全等于查询词；
- **`剧名关键词命中 (N)`**：多词检索时，标题包含部分分词；
- **`简介关联推荐 (N)`**：标题不含该词，但在简介前 200 字中高频出现；
- **`拼音或错字纠偏 (N)`**：通过全拼/首字母或有限 Levenshtein 编辑距离纠正命中。

### 6.3 统一分页与无限加载流
- 废除“本地只读 50 条”、“联网只返回第一页”的短板。
- 采用规范的滚动触底机制：
  - 容器滚动到距底部 120px 时，自动发起下一页查询（`page += 1, pageSize = 20`）；
  - 底部渲染状态条：展示“正在加载更多...”、“已加载全部 N 部作品”或“加载失败，点击重试”。

---

## 7. 数据模型与 D1 / R2 物理设计

### 7.1 D1 数据库迁移设计

#### 迁移文件 1：`edge/migrations/0005_search_discovery.sql`
```sql
-- 共享发现作品索引（仅存元数据和指针，不存大媒体列表）
CREATE TABLE IF NOT EXISTS discovery_works (
  work_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  series_id TEXT,                              -- 所属系列 ID，用于多季聚合
  season_number INTEGER DEFAULT 1,             -- 季号
  card_json TEXT NOT NULL CHECK(json_valid(card_json) AND length(card_json) <= 16384),
  release_status TEXT DEFAULT 'finished' CHECK(release_status IN ('finished', 'ongoing')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  fact_key TEXT NOT NULL,                      -- 私有 R2 桶中的事实包 Key
  fact_hash TEXT NOT NULL CHECK(length(fact_hash) = 64),
  fact_bytes INTEGER NOT NULL CHECK(fact_bytes BETWEEN 1 AND 524288),
  UNIQUE(provider_id, source_id)
);
CREATE INDEX IF NOT EXISTS idx_discovery_works_series ON discovery_works(series_id, season_number);
CREATE INDEX IF NOT EXISTS idx_discovery_works_expiry ON discovery_works(enabled, expires_at);

-- 增量变更流水账本（供全网客户端无感单向同步）
CREATE TABLE IF NOT EXISTS discovery_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('upsert', 'withdraw')),
  card_json TEXT,
  updated_at INTEGER NOT NULL
);

-- 触发器：自动捕获变更写入流水
CREATE TRIGGER IF NOT EXISTS trg_discovery_insert_change AFTER INSERT ON discovery_works BEGIN
  INSERT INTO discovery_changes(work_id, operation, card_json, updated_at)
  VALUES(NEW.work_id, CASE WHEN NEW.enabled = 1 THEN 'upsert' ELSE 'withdraw' END,
    CASE WHEN NEW.enabled = 1 THEN NEW.card_json ELSE NULL END, NEW.updated_at);
END;

CREATE TRIGGER IF NOT EXISTS trg_discovery_update_change AFTER UPDATE ON discovery_works
WHEN OLD.enabled != NEW.enabled OR OLD.fact_hash != NEW.fact_hash OR OLD.card_json != NEW.card_json BEGIN
  INSERT INTO discovery_changes(work_id, operation, card_json, updated_at)
  VALUES(NEW.work_id, CASE WHEN NEW.enabled = 1 THEN 'upsert' ELSE 'withdraw' END,
    CASE WHEN NEW.enabled = 1 THEN NEW.card_json ELSE NULL END, NEW.updated_at);
END;

-- 搜索查询结果缓存表（避免全网对相同热词重复打上游）
CREATE TABLE IF NOT EXISTS discovery_queries (
  qhash TEXT PRIMARY KEY,
  normalized_key TEXT NOT NULL CHECK(length(normalized_key) <= 1024),
  ids_json TEXT NOT NULL CHECK(json_valid(ids_json) AND length(ids_json) <= 32768),
  status TEXT NOT NULL CHECK(status IN ('success', 'empty')),
  fresh_until INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discovery_queries_fresh ON discovery_queries(fresh_until);

-- 分布式防击穿原子租约锁
CREATE TABLE IF NOT EXISTS discovery_leases (
  lease_key TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discovery_leases_exp ON discovery_leases(expires_at);

-- IP 固定窗口限流记录
CREATE TABLE IF NOT EXISTS discovery_rate_windows (
  scope_key TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL CHECK(hits >= 1),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(scope_key, window_start)
);
CREATE INDEX IF NOT EXISTS idx_discovery_rate_exp ON discovery_rate_windows(expires_at);
```

#### 迁移文件 2：`edge/migrations/0006_discovery_jobs.sql`
```sql
-- 异步滑动窗口任务队列
CREATE TABLE IF NOT EXISTS discovery_jobs (
  job_id TEXT PRIMARY KEY,
  qhash TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  provider_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  cursor_key TEXT,                             -- R2 checkpoint key
  status TEXT NOT NULL CHECK(status IN ('pending', 'published', 'skipped', 'failed')),
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_discovery_jobs_queue ON discovery_jobs(qhash, status, ordinal);

-- 查询与任务关联状态
CREATE TABLE IF NOT EXISTS discovery_job_queries (
  qhash TEXT PRIMARY KEY,
  normalized_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'complete', 'failed')),
  search_failed INTEGER NOT NULL DEFAULT 0,
  provider_has_more INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
```

### 7.2 R2 存储桶分离架构
为严格遵从《AGENTS.md》上游地址零暴露与合规红线，R2 存储桶必须实施**物理权限隔离**：
1. **公开桶（`APK_BUCKET` / `prism-play-releases`）**：
   - 仅存放全量基线静态文件（`library/` 分片、`seed/catalog-bundle.json`）与正式 Android APK 产物。
   - 绝不存放包含直接第三方媒体直链的事实包。
2. **私有发现事实桶（`DISCOVERY_BUCKET` / `prism-play-discovery`）**：
   - 彻底关闭 `r2.dev` 公共访问与自定义公网域名绑定。
   - 仅允许 Worker 通过专属绑定凭据读写。
   - 存放不可变事实包 `discovery/facts/{sha256}.json` 与任务检查点 `discovery/checkpoints/{job_id}.json`。
   - 客户端只能通过 Worker 的受控接口 `/api/titles/{id}` 读取按作投影；普通线路为已批准 mediaUrl 运行时例外，native 为无 key 身份描述符与来源候选。不能把当前候选地址称为已授权绑定的播放解析 handle；该云端能力尚未实现（§2.4）。

---

## 8. API 接口契约规范 (OpenAPI 增量)

### 8.1 检索接口：`GET /api/search`
*参数增量*：
- `q` (string, required): 检索词
- `page` (integer, default 1): 客户端当前请求页
- `pageSize` (integer, default 20, max 20): 分页大小
- `discoveryPage` (integer, default 1): 来源发现分页游标

*响应体增量*：
```json
{
  "page": 1,
  "items": [
    {
      "item": {
        "id": "drama_s_7671966197985856536",
        "title": "持械入宋：第一季",
        "channelId": "drama",
        "category": "穿越",
        "episodeCount": 100,
        "isAi": false,
        "seriesId": "series_chixierusong",
        "seasonNumber": 1,
        "coverUrl": "/proxy/img/drama_s_7671966197985856536"
      },
      "matchType": "exact"
    }
  ],
  "hasMore": true,
  "discoveryPending": true,
  "discoveryFailed": false,
  "discoveryPage": 1,
  "discoveryHasMore": true,
  "retryAfterSeconds": 1
}
```

### 8.2 全网增量发现同步：`GET /api/search/discoveries`
*参数*：
- `after` (integer, required): 客户端已同步的最大 `seq` 序号
- `limit` (integer, default 60, max 100): 批次大小

*响应体*：
```json
{
  "cursor": 152,
  "hasMore": false,
  "changes": [
    {
      "seq": 151,
      "workId": "drama_s_7671966197985856536",
      "operation": "upsert",
      "updatedAt": 1791230983,
      "card": {
        "id": "drama_s_7671966197985856536",
        "title": "持械入宋：第一季",
        "channelId": "drama",
        "category": "穿越",
        "episodeCount": 100,
        "coverUrl": "/proxy/img/drama_s_7671966197985856536"
      }
    }
  ]
}
```

---

## 9. 分阶段实施路线与门禁检查表 (G0 -> G4)

### 阶段 G0：契约、数据模型与规范对齐
- [ ] 检查并确保 OpenAPI、API-SPEC、SPEC-v2.0、PRD 同步新增字段。
- [ ] 运行静态门禁：`python tests/verify_contracts.py` 退出码必须为 0。
- [ ] 确保 D1 迁移脚本 `0005_search_discovery.sql` 与 `0006_discovery_jobs.sql` 经由内存 SQLite 完整加载断言无语法错误。

### 阶段 G1：云端协议解密与多阶取流调度落地
- [ ] 编写并落地 `edge/src/search/providers/s1.ts` 的 App 原生协议与 `spade_a` 解密算法。
- [ ] 运行单测 `npm test -- tests/edge/100-discovery-providers.test.ts` 确认在无 Web 试看支持下仍能拿到 100 集真实流。
- [ ] 落地首集秒播判定：只要第 1 集成功即触发 `publishDiscoveryFact`，拒绝全集失败一票否决。
- [ ] 验证云端分布式锁与防击穿限流，确保并发相同搜词仅触发一次上游访问。

### 阶段 G2：系列拓扑引擎与增量同步闭环
- [ ] 落地 `series-normalizer.ts`，正则解析季号并嗅探缺失季。
- [ ] 验证 `GET /api/search/discoveries` 增量流水，模拟从设备端断网、拉取、合并写入本地 SQLite 的完整流程。
- [ ] 运行回归测试 `npm test -- tests/edge/104-search-discovery-route.test.ts` 确保全链路打通。

### 阶段 G3：客户端交互全面重构
- [ ] 重构 `src/views/search-view.ts` 与 `src/views/views.css`，废除 `.pv-rail`，启用三列纵向流式自适应网格。
- [ ] 实现客户端真实分页流（加载更多与触底监听）。
- [ ] 详情页与播放器内集成原生季播切换器，实现同页面无感跨季切播。
- [ ] 运行前端全量测试：`npm test -- tests/client/search-auto-supplement.test.ts` 与 `tests/client/42-search-view.test.ts`。

### 阶段 G4：全量自动化回归与独立构建交付
- [ ] 执行 P0 红线扫描：`python tests/scan_p0.py`（零 emoji、零裸 Hex、零超 300 行）。
- [ ] 执行全量回归套件：`npm test`（133 文件、1500+ 用例 100% 绿灯）。
- [ ] 构建独立验收 APK，存入 `build/apk265/`，生成 SHA-256 与签名指纹收据。
- [ ] 严禁在 Master 真机实测合格前执行云端正式发布或官网下载替换。

---

## 9.1 变更记录（限定实现事实同步）

| 日期 | 变更 | 范围与实现边界 |
| :--- | :--- | :--- |
| 2026-10-06 | 新增§2.4并修正§7.2“已签名地址”口径 | EpisodeLine/PlaybackLine的provider_s1 native、1～32位数字字符串、无key与native unknown-field reject；work manifest/私有R2 discovery fact主链，原生vid/runtime key不返JS、Web/native cast拒绝。单集Master反馈已取得，完整HUD已写/编译但未真机通过；授权绑定handle未实现、Stage A未完成、旧fact待刷新、未部署，Java仅1～20位缺口待接齐。§9 todos不抹除；AGENTS authority、AC-02 FLAG_SECURE不扩大，OpenAPI/ADR/index/专门CENC计划由主会话同步。 |

## 10. 附录：`D:\DEV\guoguo-juku` 源码映射对照表

| 目标能力模块 | 光影Play 目标文件路径 | `guoguo-juku` 原始参考源文件与代码锚点 |
| :--- | :--- | :--- |
| **App 原生接口报文** | `edge/src/search/providers/s1-native.ts` | `internal/app/provider_hongguo_native_media.go:15-37`<br>`internal/app/provider_hongguo_app.go:145-205` (`hongguoAppRequest`) |
| **spade_a CENC 解密** | `edge/src/search/providers/s1-cipher.ts` | `internal/app/provider_hongguo_playback.go:159-201` (`hongguoContentKey`) |
| **季播后缀与数字转换** | `edge/src/search/series-normalizer.ts` | `internal/app/provider_hongguo_search_seasons.go:32-79` (`hongguoSearchSeason`) |
| **缺季补全嗅探器** | `edge/src/search/series-normalizer.ts` | `internal/app/provider_hongguo_search_seasons.go:124-162` (`hongguoSearchSeriesGroups`) |
| **MacCMS (m1) 分集解析**| `edge/src/search/providers/m1.ts` | `internal/app/provider_modu.go:136-158, 250-253, 356-392` (`$$$`、`#`、`$` 分词器) |
| **全源聚合与标题去重** | `edge/src/search/discovery-service.ts` | `internal/app/aggregate_race.go:13-43, 99-245`<br>`internal/app/ui_provider_search.go:101-108` |
| **备用播放接口回退** | `edge/src/search/providers/s1-backup.ts` | `internal/app/provider_hongguo_playback.go:43-85` (`resolveHongguoPlaybackAPI`) |
