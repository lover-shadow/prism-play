/**
 * 公开元数据文本边界的**唯一定义处**（HOME-PLAYER-REPAIR-SPEC-AND-PLAN §3.3 B0 选定口径）。
 *
 * 为什么是 `.mjs`：采集/打包侧是 node 直接执行的 ES 模块（CI 锁 Node22，不能依赖类型擦除），
 * 而边缘 Worker 与端侧是 TypeScript。本文件用 JSDoc 标注类型，并配一份 `metadata-policy.d.mts`
 * 纯类型声明——声明里**不出现任何数字字面量**，所以 240/6/12/64/年份只在这里写一次。
 *
 * 消费面（禁止再写第二份）：
 *   edge/scripts/compute-hotscore.mjs、library-catalog.mjs、public-search-projection.mjs、
 *   work-fact-packs.mjs、package-and-publish-library.mjs、
 *   edge/src/library/title-asset.ts、edge/src/http/serialize.ts、
 *   src/core/catalog-bundle-loader.ts、src/core/api/title-detail.ts。
 *
 * 诚实边界：字段**没有可信供给就整个省略**，绝不写「暂无简介」占位、绝不按片名/搜索词造标签。
 * 原料一律按纯文本处理：HTML 标签与实体、上游 URL、空白都在这层剥掉，公开链只看到清洗结果。
 */

/** §3.1/§3.2 列表摘要上限（Unicode 码点，不是 UTF-16 长度）。 */
export const SYNOPSIS_MAX_CODE_POINTS = 240;
/** 展示副标签数量上限。 */
export const TAGS_MAX_ITEMS = 6;
/** 单个展示副标签码点上下限。 */
export const TAG_MAX_CODE_POINTS = 12;
export const TAG_MIN_CODE_POINTS = 1;
/** 来源明确型枚举文本（地区/语言）共用的码点上限；本仓库缓存实测最长 46，不会截断真值。 */
export const SOURCE_TEXT_MAX_CODE_POINTS = 64;
/** releaseYear 合法整数区间（openapi.yaml ContentItem.releaseYear）。 */
export const RELEASE_YEAR_MIN = 1000;
export const RELEASE_YEAR_MAX = 9999;
/** 端侧目录快照配额（与 src/core/storage/storage-domains.ts 的 CATALOG_CACHE_LIMIT_BYTES 同值，有测试钉住）。 */
export const CATALOG_DIRECTORY_MAX_BYTES = 20 * 1024 * 1024;

/** 本批新增的可选公开字段；投影与校验都按这份清单走，避免各处手抄字段名。 */
export const PUBLIC_METADATA_FIELDS = Object.freeze(['synopsis', 'tags', 'releaseYear', 'region', 'language']);

const codePoints = (text) => [...text].length;
const sliceCodePoints = (text, limit) => [...text].slice(0, limit).join('');

/**
 * 纯文本清洗：去 HTML 标签与实体、去绝对/裸域名 URL、控制字符归一为空格、折叠空白。
 * 上游实测混着 `<b>`、`&amp;`、`http://site.douban.com/…`、`www.xxx/PV第101集…`，
 * 这些既违反「彻底去平台化」也不是观众要看的文本，必须在进入任何公开资产之前剥掉。
 *
 * URL 形态匹配**协议无关**：上游实测不只给 `http(s)://` —— `mac://site.douban./108361/`（非 http
 * 协议 + 被写残的 host）与完全没协议的 `site.douban.com/107923/` 都混在简介里，按 AGENTS.md 二·1
 * 这类字样必须物理消失。终止字符集**显式排除中日韩文字与中文标点**：简介常见「URL 紧贴中文正文」
 * （`http://…/10450409/赛德克·巴莱`），用 `\S*` 贪婪匹配会把真正文一起吞掉，那是把"有供应"做成"无供应"。
 */
/**
 * 终止字符集只收**空白、分隔符、全角标点与括号**，刻意不收 ASCII 半角点号：
 * 半角点是 host 与路径的一部分，收了会把 `http://a.b/c` 只删到 `http://a`，留下 `.b/c` 残片。
 * 真正的中文正文由 `\u4e00-\u9fff` 一类全形字符与全角标点拦住。
 */
/**
 * 终止字符集 = 空白 + 半/全角分隔标点 + 括号 + **中日韩文字**（`\u4e00-\u9fff`）。
 * 刻意不收 ASCII 半角点号：半角点是 host 与路径的一部分，收了会把 `http://a.b/c` 只删到 `http://a`，
 * 留下 `.b/c` 残片。反过来，CJK 必须在集合内——简介里真实存在「URL 紧贴片名」的写法
 * （`http://…/10450409/赛德克·巴莱`），不在 CJK 处停手就会把真正文一起吃掉，
 * 那是把"有简介"清洗成"简介没了"，比泄露更难查。
 */
const CJK_STOP = '\\s\\u3000-\\u303f\\uff00-\\uffef\\u4e00-\\u9fff\\u3400-\\u4dbf,;|！“”‘’';
const SCHEME_URL_PATTERN = new RegExp(`[a-z][a-z0-9+.-]*:\\/\\/[^${CJK_STOP}]*`, 'gi');
/**
 * 裸 host：`site.douban.com/107923/`、`www.a.b/d`，以及上游真的写残成 `.fr/a` 的**前导点残片**。
 * 无路径host末段至少两位字母；单字母末段须带路径，避免把真实片名「K.O」当网址删除；
 * 尾随路径同样在 CJK 处停住，紧贴 URL 的中文正文必须留下。
 */
const HOST_LABEL = '(?:[a-z0-9][a-z0-9-]*\\.)+';
const BARE_HOST_PATTERN = new RegExp(`(?:${HOST_LABEL}[a-z]{2,}|${HOST_LABEL}[a-z](?=\\/)|\\.[a-z]{2,})(?:\\/[^${CJK_STOP}]*)?`, 'gi');
/** 读取/发布两侧的残留判据：任意协议前缀或裸 host 形态都不许出现在公开资产里。 */
const RESIDUAL_URL_PATTERN = new RegExp(`[a-z][a-z0-9+.-]*:\\/\\/|(?:${HOST_LABEL}|\\.)[a-z]{1,}\\/`, 'i');

export function cleanPlainText(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(SCHEME_URL_PATTERN, ' ')
    .replace(BARE_HOST_PATTERN, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 上游把「暂无简介」这类占位当正文写进 vod_blurb 的实测确实存在（旧 library-catalog 就在调用点
 * 手抄过一条 `!== '暂无简介'`）。口径收进这里做**整串精确匹配**，只排除占位本身，
 * 绝不模糊匹配——否则「暂无简介，但剧情……」这种真开头会被误杀。
 */
const SYNOPSIS_PLACEHOLDERS = new Set(['暂无简介', '暂无剧情简介', '暂无剧情介绍', '暂无剧情']);

/**
 * 列表摘要：清洗后按 240 码点截断。散文截到上限仍是真话的前缀，所以这里**允许**截断；
 * 空串与占位一律省略字段（返回 undefined），不产出空洞文案。
 *
 * `stripPlatformNames` 由**打包侧注入**（见 `platform-lexicon.mjs` 的文件头说明）：品牌词表不能写进
 * 本模块，否则会被端侧解析器 `src/core/**` 一起打进 APK 交付物。端侧读取时不传该参数，
 * 只做形态消毒；上游品牌文本在发布前已被物理剥掉，且发布门禁会二次拒绝残留。
 */
export function normalizeSynopsis(raw, stripPlatformNames) {
  const cleaned = cleanPlainText(raw);
  const text = typeof stripPlatformNames === 'function' ? stripPlatformNames(cleaned).trim() : cleaned;
  if (text === '' || SYNOPSIS_PLACEHOLDERS.has(text.replace(/。$/, ''))) return undefined;
  return codePoints(text) <= SYNOPSIS_MAX_CODE_POINTS ? text : sliceCodePoints(text, SYNOPSIS_MAX_CODE_POINTS);
}

/**
 * 年份：只接纳**明确四位**数字（`^\d{4}$`）并落在 1000–9999。
 * 实测脏值 `2026–`、`0`、`内详` 全部拒绝；严禁用 vod_pubdate/vod_time/vod_time_add 兜底——
 * 那是上架/采集时间，冒充上映年会把假数据变成观众眼前的真话。
 */
export function normalizeReleaseYear(raw) {
  const text = String(raw ?? '').trim();
  if (!/^\d{4}$/.test(text)) return undefined;
  const year = Number(text);
  return year >= RELEASE_YEAR_MIN && year <= RELEASE_YEAR_MAX ? year : undefined;
}

/**
 * 地区/语言：来源明确的多值原样清洗、逗号保留；超过 64 码点时**整个省略**而不是截一半——
 * 「中国大陆,美国,英国」被切成语义残缺的片段就是一条编造值，宁可不上。
 */
export function normalizeSourceText(raw, stripPlatformNames) {
  const cleaned = cleanPlainText(raw);
  const text = typeof stripPlatformNames === 'function' ? stripPlatformNames(cleaned).trim() : cleaned;
  if (text === '') return undefined;
  return codePoints(text) <= SOURCE_TEXT_MAX_CODE_POINTS ? text : undefined;
}

/**
 * 受控题材/风格词表：展示标签的**唯一准入通道**。
 *
 * 为什么必须走词表而不是直接清洗 `vod_tag`：本缓存实测 `vod_tag` 里 movie 11190 个去重值中
 * 85.3% 只出现一次，实际内容是演员名（TomHiddleston）、角色/地名（弗吉尼亚州）、剧情残句
 * （"andheusesittodefendthegoodandfightevil.That"）、HTML 残体（amp、&amp）与标点噪声（）、…）；
 * documentary 也有 90.5% 单次值。原文升格成展示标签就是 HP-12 明令禁止的「无意义词」。
 * 词表只**过滤**、永不**添加**：原料没给的题材，这里不会凭空长出来。
 *
 * 制作类型词（短剧/漫剧/动画/纪录片/电影/短片/故事/影片）与频道自名的形态词不入表——
 * 它们是载体不是题材，混进来会让「4 种制作类型」冒充「多题材证据」。
 */
const SHARED_GENRES = [
  '剧情', '喜剧', '爱情', '动作', '科幻', '悬疑', '恐怖', '惊悚', '犯罪', '战争', '历史',
  '奇幻', '冒险', '家庭', '传记', '音乐', '歌舞', '古装', '武侠', '同性', '灾难', '运动'
];
const GENRE_VOCABULARY = Object.freeze({
  drama: [...SHARED_GENRES, '战神', '逆袭', '都市', '甜宠', '玄幻', '修仙', '穿越', '重生', '宫斗', '民国', '年代', '军旅', '警匪'],
  movie: SHARED_GENRES,
  anime: [...SHARED_GENRES, '热血', '治愈', '搞笑', '日常', '校园', '料理', '机甲', '星际', '赛博', '异世界', '修仙', '玄幻', '励志'],
  documentary: [...SHARED_GENRES, '自然', '生态', '动物', '海洋', '天文', '宇宙', '地理', '科技', '人文', '美食', '社会', '艺术', '考古', '民俗', '旅行']
});
const TAG_LOOKUP = new Map(Object.entries(GENRE_VOCABULARY).map(([channelId, words]) =>
  [channelId, new Map(words.map((word) => [word, word]))]));

/**
 * 展示副标签：先整串清洗（剥 HTML/URL/实体），再按分隔符切分，最后**只允许受控词表精确命中**。
 * 去重、保序、最多 6 个，每项 1–12 码点。无供应返回空数组，调用方据此省略字段。
 *
 * 清洗必须在切分之前：切分会把 `http://t.cn/x,剧情` 拆出一个游离的 `剧情`，
 * 虽然仍过得了词表、不构成泄露，但那是 URL 残渣而非上游给的题材，口径上不能算供给。
 */
export function normalizeDisplayTags(channelId, raw) {
  const vocabulary = TAG_LOOKUP.get(channelId);
  if (vocabulary === undefined || raw === null || raw === undefined) return [];
  const accepted = [];
  const seen = new Set();
  for (const part of cleanPlainText(raw).split(/[,，、;；|/]+/)) {
    const candidate = vocabulary.get(part.trim());
    if (candidate === undefined || seen.has(candidate)) continue;
    if (codePoints(candidate) < TAG_MIN_CODE_POINTS || codePoints(candidate) > TAG_MAX_CODE_POINTS) continue;
    seen.add(candidate);
    accepted.push(candidate);
    if (accepted.length === TAGS_MAX_ITEMS) break;
  }
  return accepted;
}

/**
 * 原料 → 公开可选元数据的唯一映射入口；缺供的字段整个不出现在对象里。
 * `stripPlatformNames` 只由打包侧注入（`platform-lexicon.mjs`），端侧读取路径不传。
 */
export function publicWorkMetadata(channelId, raw, stripPlatformNames) {
  const metadata = {};
  const synopsis = normalizeSynopsis(raw?.vod_blurb || raw?.vod_content, stripPlatformNames);
  if (synopsis !== undefined) metadata.synopsis = synopsis;
  const year = normalizeReleaseYear(raw?.vod_year);
  if (year !== undefined) metadata.releaseYear = year;
  const region = normalizeSourceText(raw?.vod_area, stripPlatformNames);
  if (region !== undefined) metadata.region = region;
  const language = normalizeSourceText(raw?.vod_lang, stripPlatformNames);
  if (language !== undefined) metadata.language = language;
  const tags = normalizeDisplayTags(channelId, raw?.vod_tag);
  if (tags.length > 0) metadata.tags = tags;
  return metadata;
}

/**
 * 越界即脏：公开资产里的可选元数据必须逐条符合本模块口径，否则拒绝发布。
 * `platformPattern` 由发布侧注入的品牌词表正则（不带 `g`，见 `platform-lexicon.mjs`）；
 * 缺省时只跑形态判据——端侧读取不需要、也不应该在交付物里带上站源名清单。
 */
export function assertMetadataBounds(item, label, platformPattern) {
  const problems = [];
  const brandResidue = (/** @type {unknown} */ text) =>
    typeof text === 'string' && (typeof platformPattern === 'function' ? platformPattern(text) : false);
  if (item.synopsis !== undefined) {
    if (typeof item.synopsis !== 'string' || codePoints(item.synopsis) > SYNOPSIS_MAX_CODE_POINTS) {
      problems.push(`synopsis 超出 ${SYNOPSIS_MAX_CODE_POINTS} 码点或类型错误`);
    } else if (/<[^>]*>|&[a-z]+;|&#\d+;/i.test(item.synopsis) || RESIDUAL_URL_PATTERN.test(item.synopsis)) {
      problems.push('synopsis 残留 HTML 或 URL 原文');
    } else if (brandResidue(item.synopsis)) problems.push('synopsis 残留上游站源品牌名');
  }
  if (item.releaseYear !== undefined &&
      (!Number.isSafeInteger(item.releaseYear) || item.releaseYear < RELEASE_YEAR_MIN || item.releaseYear > RELEASE_YEAR_MAX)) {
    problems.push(`releaseYear 不是 ${RELEASE_YEAR_MIN}–${RELEASE_YEAR_MAX} 的整数`);
  }
  for (const field of ['region', 'language']) {
    const value = item[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || codePoints(value) > SOURCE_TEXT_MAX_CODE_POINTS) {
      problems.push(`${field} 超出 ${SOURCE_TEXT_MAX_CODE_POINTS} 码点或类型错误`);
    } else if (/<[^>]*>/i.test(value) || RESIDUAL_URL_PATTERN.test(value)) problems.push(`${field} 残留 HTML 或 URL 原文`);
    else if (brandResidue(value)) problems.push(`${field} 残留上游站源品牌名`);
  }
  if (item.tags !== undefined) {
    if (!Array.isArray(item.tags) || item.tags.length === 0 || item.tags.length > TAGS_MAX_ITEMS ||
        new Set(item.tags).size !== item.tags.length) {
      problems.push(`tags 必须是 1–${TAGS_MAX_ITEMS} 项的去重数组；空数组属"假值形态的缺席"，一律按缺供处理`);
    } else for (const tag of item.tags) {
      const text = String(tag);
      if (typeof tag !== 'string' || codePoints(text) < TAG_MIN_CODE_POINTS || codePoints(text) > TAG_MAX_CODE_POINTS) {
        problems.push(`tags 每项须为 ${TAG_MIN_CODE_POINTS}–${TAG_MAX_CODE_POINTS} 码点字符串：${text}`);
      }
    }
  }
  if (problems.length > 0) throw new Error(`[公开元数据判据失败] ${label}\n  - ${problems.join('\n  - ')}`);
  return true;
}

/**
 * 端侧/边缘解析用的**就地消毒**：越界或带原文 HTML 的可选字段整个丢弃，合法的按本口径收敛。
 * 与 assert 的分工：打包侧宁可报错拒发布，读取侧宁可少显示也不能让一部剧因为上游脏字段而打不开。
 * 返回新对象，绝不原地改写。
 */
export function sanitizePublicMetadata(item) {
  const clean = {};
  if (typeof item.synopsis === 'string') {
    const text = normalizeSynopsis(item.synopsis);
    if (text !== undefined) clean.synopsis = text;
  }
  const year = normalizeReleaseYear(item.releaseYear);
  if (year !== undefined) clean.releaseYear = year;
  for (const field of ['region', 'language']) {
    if (typeof item[field] !== 'string') continue;
    const text = normalizeSourceText(item[field]);
    if (text !== undefined) clean[field] = text;
  }
  if (Array.isArray(item.tags)) {
    const accepted = [];
    for (const tag of item.tags) {
      if (typeof tag !== 'string') continue;
      const text = cleanPlainText(tag);
      if (text === '' || codePoints(text) > TAG_MAX_CODE_POINTS || accepted.includes(text)) continue;
      accepted.push(text);
      if (accepted.length === TAGS_MAX_ITEMS) break;
    }
    if (accepted.length > 0) clean.tags = accepted;
  }
  return clean;
}
