/**
 * 《光影Play》采集管线单一事实源 (SPEC-CLOUD-REFACTOR v2 §2.1 / §2.2 / §2.3 / §3 路径 / §C-6)
 *
 * 本文件是「上游源 → 内部频道」映射、私密定级规则与 R2/KV 资产命名的唯一归属地。
 * harvest-all / sync-incremental / sync-private 一律从这里读取，脚本内不得再出现
 * 任何硬编码 type_id 或上游 URL 字面量 (AC-C6-1)；派生字段算法在 compute-hotscore.mjs。
 *
 * 去平台化红线：公开资产只允许出现抽象 Provider 编号 (`provider_m1` 式) 与同源 `/proxy/img/…`
 * 句柄；上游真实域名与播放地址只能出现在剧集清单的 mediaUrl 中（由 assertPublicAssetClean 把关）。
 */
/** §3.1 分片大小 = 客户端分页大小；chunk-N 与 page=N+1 一一对应，Worker 零拼接原样返回。 */
export const PAGE_SIZE = 60;
/** §3.3 分类学版本；映射表变更必须同步 bump。 */
export const TAXONOMY_VERSION = 'modu-2026-10-03';
/** 源配置留痕版本，写入 KV config:sources。 */
export const SOURCE_CONFIG_VERSION = 1;

/** 基础设施绑定名（edge/wrangler.toml 现状，勿改）。 */
export const INFRA = {
  r2Bucket: 'prism-play-releases',
  kvBinding: 'KV',
  kvNamespaceId: '7a8d672743d6462f8d2ae13d9416f0da',
  d1Database: 'prism-play-db',
  wranglerCwd: 'edge'
};

export const KV_KEYS = {
  manifest: 'catalog:manifest',
  privateManifest: 'catalog:private-manifest',
  sources: 'config:sources'
};

export const PUBLIC_CHANNEL_IDS = ['drama', 'movie', 'anime', 'documentary'];
export const PRIVATE_CHANNEL_ID = 'private';

/**
 * §2.1 上游真实分类表（2026-10-03 现场实测 `?ac=list`，勿再猜）。
 * 旧脚本把 1 当电影、4 当纪录片、只把 3 当动漫，与这张表全部矛盾。
 */
export const TYPE_LABELS = {
  1: '国产动漫', 2: '日韩动漫', 3: '欧美动漫', 4: '港台动漫', 5: '动漫电影', 6: '里番动漫',
  7: '电影', 8: '连续剧', 9: '综艺', 10: '动作片', 11: '喜剧片', 12: '爱情片', 13: '科幻片',
  14: '恐怖片', 15: '剧情片', 16: '战争片', 17: '惊悚片', 18: '家庭片', 19: '古装片', 20: '历史片',
  21: '悬疑片', 22: '犯罪片', 23: '灾难片', 24: '记录片', 25: '短片', 26: '国产剧', 27: '香港剧',
  28: '韩国剧', 29: '欧美剧', 30: '台湾剧', 31: '日本剧', 32: '海外剧', 33: '泰国剧',
  34: '加长版', 35: '精编版', 36: '合集版', 37: '衍生版',
  38: '短剧', 39: '伦理片', 40: '体育', 41: '足球', 42: 'AI漫剧'
};

/**
 * §C-6 providers 数组。
 * privacy: public = 公开源（其中 channelId=private 的分类仍归私密）；private-all = 源级私密（§2.2 第一条款）。
 * policy: private | exclude —— AC-C6-2 三态开关，exclude 表示该分类彻底不进任何管线。
 */
export const PROVIDERS = [
  {
    id: 'provider_m1',
    shortCode: 'm',
    baseUrl: 'https://caiji.moduapi.cc/api.php/provide/vod',
    privacy: 'public',
    crawlable: true,
    incrementalWindowHours: 24,
    channels: [
      { channelId: 'drama', typeIds: [38] },
      // 42 = AI 漫剧归入【短剧精选】并强制 is_ai=1（修复旧 harvest-all 的 42→anime P0 bug）。
      { channelId: 'drama', typeIds: [42], forceAi: true },
      { channelId: 'movie', typeIds: [7, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23] },
      { channelId: 'anime', typeIds: [1, 2, 3, 4] },
      { channelId: 'documentary', typeIds: [24] },
      // §2.2 分类级私密条款：公开源里的成人分类走独立私密管线。
      { channelId: 'private', typeIds: [6, 39], policy: 'private' }
    ]
  },
  // 源级私密五源：全部内容 = 个人探索（§2.2 第一条款）。baseUrl 已于 2026-10-03 从 guoguo-juku
  // provider_*.go 回填核实；这些源均非 macCMS 形态，各自需要独立解析器（guoguo 是一源一个
  // provider_*.go 的先例），故 crawlable 保持 false，接入时逐源开工作包，勿直接置 true。
  ...[
    ['hg', 'https://huangguoai.com'],
    ['hy', 'https://tideember.cc'],
    ['jg', 'https://huangju.net'],
    ['yg', 'https://analyze.buxefaex.cc'],
    ['dg', 'https://www.dsd.com.se']
  ].map(([code, baseUrl]) => ({
    id: `provider_${code}1`,
    shortCode: code,
    baseUrl,
    privacy: 'private-all',
    crawlable: false,
    incrementalWindowHours: 24,
    channels: []
  }))
];

/**
 * 院线电影上游分类 → 既有 5 值分类集（与 D1 channels.categories_json 对齐，不擅自扩容 UI 分类）。
 * 剧情/古装/历史/短片/电影等未覆盖类型交给标题特征词兜底判定。
 */
export const MOVIE_CATEGORY_BY_TYPE = {
  10: '动作', 16: '动作', 23: '动作', 11: '喜剧', 18: '喜剧', 13: '科幻',
  12: '爱情', 14: '悬疑', 17: '悬疑', 21: '悬疑', 22: '悬疑'
};

export function providerById(id) {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

export function isSourcePrivate(provider) {
  return provider.privacy === 'private-all';
}

/** AC-C6-2：policy=exclude 的分类不进任何管线（私密/排除/公开三态可切换）。 */
export function ruleIsExcluded(rule) {
  return rule.policy === 'exclude';
}

export function ruleIsPrivate(provider, rule) {
  return rule.channelId === PRIVATE_CHANNEL_ID || isSourcePrivate(provider);
}

/**
 * providers → 扁平采集目标清单（每个 type_id 一条，自带频道归属与 forceAi）。
 * 采集脚本只认这份清单，所以「修正频道映射」= 只改本文件。
 */
export function crawlTargets({ privacy = 'public', includeUncrawlable = false } = {}) {
  const targets = [];
  for (const provider of PROVIDERS) {
    if (provider.crawlable === false && !includeUncrawlable) continue;
    for (const rule of provider.channels ?? []) {
      if (ruleIsExcluded(rule)) continue;
      const isPrivate = ruleIsPrivate(provider, rule);
      if (privacy === 'public' && isPrivate) continue;
      if (privacy === 'private' && !isPrivate) continue;
      for (const typeId of rule.typeIds) {
        targets.push({
          provider,
          typeId,
          typeLabel: TYPE_LABELS[typeId] ?? '',
          channelId: isPrivate ? PRIVATE_CHANNEL_ID : rule.channelId,
          forceAi: Boolean(rule.forceAi),
          isPrivate
        });
      }
    }
  }
  return targets;
}

export function publicTargets() {
  return crawlTargets({ privacy: 'public' });
}
export function privateTargets() {
  return crawlTargets({ privacy: 'private' });
}

/** 本地工作目录：CI 干跑产物与跨日状态快照都落在 edge/cache/library（已被 .gitignore 忽略）。 */
export const LOCAL = {
  dir: 'edge/cache/library',
  harvestCache: 'edge/cache/harvest',
  state(isPrivate = false) {
    return `${LOCAL.dir}/${isPrivate ? 'private-' : ''}catalog-state.json`;
  },
  /** dryRun 产物与真实发布产物分目录，避免干跑文件被误当发布集上传。 */
  assets(dryRun = false) {
    return `${LOCAL.dir}/assets${dryRun ? '-dryrun' : ''}`;
  },
  sqlOut(isPrivate = false) {
    return `${LOCAL.dir}/${isPrivate ? 'sync-private' : 'sync-incremental'}.sql`;
  }
};

/** work id 归一：`{channelId}_{抽象源编号}_{上游 vod_id}`；只含抽象编号，不含上游站名。 */
export function makeWorkId(channelId, provider, vodId) {
  return `${channelId}_${provider.shortCode}_${vodId}`;
}

/** 上游时间为 UTC+8；vod_time_add 是 Unix 秒的上游入库时间，优先用于【实时新剧榜】。 */
export function toEpochSeconds(rawTime, rawAdded, fallbackSeconds) {
  const added = Number(rawAdded);
  if (Number.isSafeInteger(added) && added > 0) return added;
  const matched = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(rawTime ?? '').trim());
  if (matched === null) return fallbackSeconds;
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = matched;
  const shifted = Math.floor(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) / 1000) - 8 * 3600;
  return Number.isFinite(shifted) && shifted > 0 ? shifted : fallbackSeconds;
}

export function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

/** §3.1 海报同源句柄：proxy 路由的 img 句柄就是 work id 本身，公开海报不签名。 */
export function coverHandle(workId) {
  return `/proxy/img/${workId}`;
}

export function chunkKey(revision, channelId, pageIndex) {
  return `library/v${revision}/${channelId}/chunk-${pageIndex}.json`;
}

export function titleKey(revision, workId, isPrivate) {
  return isPrivate ? `private/v${revision}/titles/${workId}.json` : `library/v${revision}/titles/${workId}.json`;
}

/**
 * revision 无关的稳定别名路径。剧集清单按 v{revision} 发布会让每次改版都需要重传全集（约 8 千次上传），
 * 因此日增量只覆写「本次变更剧目」的两个键：v{revision} 前缀键 + 稳定键；全量 bootstrap 同样双写。
 * Track 2b 读路径：先 v{revision}/titles/{id}，未命中回退 titles/{id}（两者内容同源同刻）。
 */
export function stableTitleKey(workId, isPrivate) {
  return isPrivate ? `private/titles/${workId}.json` : `library/titles/${workId}.json`;
}

export function stateKey(isPrivate) {
  return isPrivate ? 'private/_state/catalog-state.json' : 'library/_state/catalog-state.json';
}

export function buildCatalogChunk(items, pageIndex, total, revision) {
  return { items, page: pageIndex + 1, pageSize: PAGE_SIZE, total, revision };
}

export function buildManifest(revision, channels, generatedAt) {
  return { revision, pageSize: PAGE_SIZE, channels, generatedAt, taxonomyVersion: TAXONOMY_VERSION };
}

/** §C-6 KV config:sources 载荷：Worker/App 读同一份，杜绝第二套映射口径。 */
export function sourceConfigPayload() {
  return {
    version: SOURCE_CONFIG_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    pageSize: PAGE_SIZE,
    providers: PROVIDERS.map(({ id, baseUrl, privacy, crawlable, channels }) => ({ id, baseUrl, privacy, crawlable, channels }))
  };
}

/** 上游 host 集合（公开资产泄露扫描用）。 */
export function upstreamHosts() {
  const hosts = new Set();
  for (const provider of PROVIDERS) {
    if (typeof provider.baseUrl !== 'string') continue;
    try {
      hosts.add(new URL(provider.baseUrl).hostname);
    } catch {
      // 非法 URL 交给 validateSourceConfig 报错，这里不重复裁定。
    }
  }
  return [...hosts];
}

/**
 * 公开判据（AC-C2b-1 + 去平台化红线）。目录分片与公开清单里：
 *   is_private 计数必须恒为 0；不得出现任何绝对 URL（同源海报句柄是 `/proxy/img/…` 路径）；
 *   不得出现 private 频道条目，也不得出现播放地址。
 * 用「零绝对 URL」而非「黑名单域名」做判据：上游图片/播放域名有几十个且会变，
 * 白名单式禁令无法穷举，而公开目录资产本来就一个绝对 URL 都不该有——这条更强也更好维护。
 */
export function assertPublicAssetClean(asset, label, { allowMediaUrl = false } = {}) {
  const text = typeof asset === 'string' ? asset : JSON.stringify(asset);
  const problems = [];
  if (/"isPrivate"\s*:\s*true/.test(text) || /"is_private"\s*:\s*1/.test(text)) {
    problems.push('公开资产中出现 isPrivate/is_private 为真的条目');
  }
  if (/"channelId"\s*:\s*"private"/.test(text)) problems.push('公开资产中出现 private 频道条目');
  if (!allowMediaUrl) {
    if (/"mediaUrl"/.test(text)) problems.push('公开目录资产中出现 mediaUrl（播放地址只能存在于剧集清单）');
    if (/https?:\/\//i.test(text)) problems.push('公开目录资产中出现绝对 URL（只允许 /proxy/img/… 同源句柄）');
    for (const item of Array.isArray(asset?.items) ? asset.items : []) {
      if (item.coverUrl !== undefined && !item.coverUrl.startsWith(coverHandle(''))) {
        problems.push(`${item.id}: coverUrl 不是同源海报句柄 (${item.coverUrl})`);
      }
    }
  }
  for (const host of upstreamHosts()) if (text.includes(host)) problems.push(`公开资产泄露上游域名: ${host}`);
  if (problems.length > 0) throw new Error(`[公开资产判据失败] ${label}\n  - ${problems.join('\n  - ')}`);
  return true;
}

/** 配置自检：频道闭集、tid 存在性、同 tid 不得双归属（避免再次出现两脚本互相矛盾）。 */
export function validateSourceConfig() {
  const errors = [];
  const seen = new Map();
  for (const provider of PROVIDERS) {
    if (provider.crawlable && typeof provider.baseUrl !== 'string') errors.push(`${provider.id}: 可采集源缺少 baseUrl`);
    for (const rule of provider.channels ?? []) {
      if (!ruleIsPrivate(provider, rule) && !PUBLIC_CHANNEL_IDS.includes(rule.channelId)) {
        errors.push(`${provider.id}/${rule.channelId}: 未知公开频道`);
      }
      for (const typeId of rule.typeIds) {
        if (TYPE_LABELS[typeId] === undefined) errors.push(`${provider.id}/${rule.channelId}: tid ${typeId} 不在 §2.1 实测表内`);
        const key = `${provider.id}:${typeId}`;
        if (seen.has(key)) errors.push(`${key}: tid 同时归属 ${seen.get(key)} 与 ${rule.channelId}`);
        seen.set(key, rule.channelId);
      }
    }
  }
  return errors;
}
