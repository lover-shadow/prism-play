/**
 * 上游条目 → 契约对象 的归一与派生字段标定 (SPEC-CLOUD-REFACTOR v2 §C-1 / §3.1 / §3.2)
 * 职责边界：本文件只做「条目级」派生（分类、短简介、AI 标定、剧集解析、热分、归一映射 SQL）；
 * 频道归属与路径命名来自 config-sources.mjs，三个采集脚本共用这里的构造器，
 * 因此不存在第二套 is_ai / category / 剧集解析口径。
 * CLI（`--dry-run` / `--state=<path>`）：对状态快照整体重算 hotScore / isHot / isAi 并回写。
 * C-5 之后 D1 内容表停用，本脚本不再产出 content_items 的 UPDATE SQL——标定结果直接落进 R2 资产。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LOCAL, MOVIE_CATEGORY_BY_TYPE, PRIVATE_CHANNEL_ID, TAXONOMY_VERSION, coverHandle, makeWorkId, positiveNumber, toEpochSeconds } from './config-sources.mjs';
import { cleanPlainText, normalizeSynopsis, publicWorkMetadata } from '../src/library/metadata-policy.mjs';
import { stripPlatformNames } from '../src/library/platform-lexicon.mjs';

// 与 edge/src/core/constants.ts 同源的权重：热分 = 周点击主导 + 总点击为辅 + 72h 内上新提振。
const WEEK_WEIGHT = 0.6;
const TOTAL_WEIGHT = 0.2;
const RECENCY_BOOST = 0.8;
const FRESH_WINDOW_SECONDS = 72 * 3600;
const HOT_TOP_PERCENT = 0.15;

// 标题特征词只作辅助信号；tid 级 forceAi 才是硬判据（C-1.2）。
const AI_PATTERN = /AI漫剧|AI短剧|AI剧|AI动漫|虚拟人|数字人/i;

/** 状态快照里的内部字段：绝不进目录分片，避免资产体积被无用键撑大。 */
const INTERNAL_FIELDS = ['hotScore', 'hitsWeek', 'providerId', 'sourceItemId', 'upstreamUpdatedAt', 'updatedAt', 'fact'];

const DRAMA_RULES = [
  [/侯门|王爷|和离|大乾|驸马|千金|世子|江山|大秦|天下|贵妃|皇|穿书|公主/, '古装'],
  [/镇命|神医|镇天|龙王|至尊|天尊|兵王|无双|战神|狂飙|战帝/, '战神'],
  [/娇妻|独美|婚|爱|宠|恋爱|替嫁|夫人|姐姐|前妻|白月光/, '甜宠'],
  [/重生|翻盘|首富|系统|觉醒|董事长|少爷|摆摊|逆袭|开局|逆天/, '逆袭'],
  [/忘川|通灵|迷|诡|局|案|死|神秘|阴阳|道士|诡异/, '悬疑']
];
const ANIME_RULES = [
  [/治愈|日常|搞笑|萌|校园|料理/, '治愈'],
  [/修仙|仙尊|玄幻|万界|斗罗|武神|至尊|天道/, '玄幻'],
  [/机甲|高达|未来|科幻|星际|赛博/, '科幻'],
  [/冒险|猎人|探索|海贼|西行|异界/, '冒险']
];
const DOC_RULES = [
  [/自然|深境|海|极|动物|野|山|地球|生态/, '自然'],
  [/文明|古|风云|史|战|迹|大国|王朝/, '历史'],
  [/量子|光|宙|星|机|科技|人工|能源/, '科技'],
  [/人间|烟火|味|食|厨|舌尖|小吃/, '美食']
];
const RULES_BY_CHANNEL = { drama: DRAMA_RULES, anime: ANIME_RULES, documentary: DOC_RULES };
const FALLBACK_CATEGORY = { drama: '都市', movie: '动作', anime: '热血', documentary: '探索', [PRIVATE_CHANNEL_ID]: '精选' };

/**
 * 文本归一（去标签、去 HTML 实体、去上游 URL、折叠空白）与公开可选元数据的边界
 * 只有 `edge/src/library/metadata-policy.mjs` 一份口径（HOME-PLAYER-REPAIR §3.3 B0 选定）。
 * 这里历史上写过一套 stripTags + 30 字截断，那正是「简介被 30 字硬截断」的根因，
 * 现在整段删除，只保留对策略源的调用；清洗规则改动一律发生在策略源，不在这里复刻。
 */
export function cleanTitle(raw) {
  return cleanPlainText(raw).slice(0, 50);
}

/**
 * §3.1 分片内 synopsis 的边界是 SYNOPSIS_MAX_CODE_POINTS（240 Unicode 码点），不再是 30 字。
 * 函数名保留 `shortSynopsis` 只因为四个既有调用点（本文件 / library-catalog / merge-public-library /
 * public-provider）都在用它；改名会波及 B3 范围外的文件，语义以策略源为准。
 * 空值与「暂无简介」占位返回 undefined，由调用方省略字段。
 */
export function shortSynopsis(raw) {
  return normalizeSynopsis(raw, stripPlatformNames);
}

/** 分类归一：电影优先用上游真实类型（tid 即类型），其余频道走标题特征词，兜底给频道默认值。 */
export function deriveCategory(channelId, title, typeId, rawType) {
  if (channelId === 'movie' && MOVIE_CATEGORY_BY_TYPE[typeId] !== undefined) return MOVIE_CATEGORY_BY_TYPE[typeId];
  const text = `${title} ${rawType ?? ''}`;
  for (const [pattern, value] of RULES_BY_CHANNEL[channelId] ?? []) if (pattern.test(text)) return value;
  if (channelId === 'movie') {
    if (/喜剧|笑|幽默/.test(text)) return '喜剧';
    if (/科幻|未来|宇宙|太空/.test(text)) return '科幻';
    if (/悬疑|惊悚|恐怖|凶|案/.test(text)) return '悬疑';
    if (/爱情|恋|浪漫/.test(text)) return '爱情';
    return '动作';
  }
  return FALLBACK_CATEGORY[channelId] ?? '精选';
}

export function isAiFlag(forceAi, title, rawClass) {
  return Boolean(forceAi) || AI_PATTERN.test(`${title} ${rawClass ?? ''}`);
}

/**
 * `vod_play_url` → 按集号聚合的多线路（`源A$第1集$url#第2集$url$$$源B$…`）。
 * 播放地址唯一出口：只进剧集清单，永不进目录分片。每集最多留 3 条线路。
 */
export function parseEpisodeLines(vodPlayUrl, providerId) {
  const episodes = new Map();
  for (const sourceGroup of String(vodPlayUrl ?? '').split('$$$')) {
    if (sourceGroup.trim() === '') continue;
    let index = 0;
    for (const entry of sourceGroup.split('#')) {
      if (entry.trim() === '') continue;
      const segments = entry.includes('$') ? entry.split('$') : [`第${index + 1}集`, entry];
      const url = String(segments[1] ?? '').trim();
      index += 1;
      if (!/^https?:\/\//i.test(url)) continue;
      const label = String(segments[0]).trim() || `第${index}集`;
      const numbered = /第\s*(\d+)\s*[集话話期]/.exec(label);
      const episodeNumber = numbered !== null ? Number(numbered[1]) : index;
      if (!Number.isSafeInteger(episodeNumber) || episodeNumber <= 0) continue;
      const bucket = episodes.get(episodeNumber) ?? { episodeNumber, title: label, lines: [] };
      if (bucket.lines.length < 3 && !bucket.lines.some((line) => line.mediaUrl === url)) {
        bucket.lines.push({ providerId, mediaUrl: url });
      }
      episodes.set(episodeNumber, bucket);
    }
  }
  return [...episodes.values()].sort((a, b) => a.episodeNumber - b.episodeNumber);
}

/** 状态快照记录：目录字段 + 派生标定 + 内部归一信息（INTERNAL_FIELDS 不出资产）。 */
export function normalizeWork(target, item, nowSeconds) {
  const workId = makeWorkId(target.channelId, target.provider, item.vod_id);
  const title = cleanTitle(item.vod_name);
  const episodes = parseEpisodeLines(item.vod_play_url, target.provider.id);
  const firstPublishedAt = toEpochSeconds(item.vod_time, item.vod_time_add, nowSeconds);
  const record = {
    id: workId,
    channelId: target.channelId,
    title,
    category: deriveCategory(target.channelId, title, target.typeId, item.type_name),
    isPrivate: target.isPrivate === true,
    episodeCount: episodes.length,
    isAi: isAiFlag(target.forceAi, title, item.vod_class),
    isHot: false,
    firstPublishedAt,
    hitsTotal: positiveNumber(item.vod_hits),
    hitsWeek: positiveNumber(item.vod_hits_week),
    providerId: target.provider.id,
    sourceItemId: String(item.vod_id),
    upstreamUpdatedAt: toEpochSeconds(item.vod_time, null, nowSeconds),
    updatedAt: nowSeconds,
    // HP-11/HP-12：可选公开元数据只在原料给得出可信值时长出来，缺供即无键。
    ...publicWorkMetadata(target.channelId, item, stripPlatformNames)
  };
  if (/^https?:\/\//i.test(String(item.vod_pic ?? '').trim())) {
    record.coverUrl = coverHandle(workId);
    record.coverVersion = 'v1';
  }
  record.hotScore = computeHotScore(record.hitsWeek, record.hitsTotal, firstPublishedAt, nowSeconds);
  return record;
}

/** §3.1 目录分片条目 = ContentItem 超集；剥掉内部字段，播放地址与上游域名根本不进这里。 */
export function toCatalogItem(record) {
  const item = {};
  for (const [key, value] of Object.entries(record)) {
    if (!INTERNAL_FIELDS.includes(key)) item[key] = value;
  }
  return item;
}

/**
 * 归一映射仍走 D1（C-2.5）：只记 `provider 编号 + 上游条目号 → 归一 workId`，绝不写内容表。
 * 这是采集侧唯一允许的 D1 写入，行数量级 = 本轮变更剧目数。
 */
export function emitAliasSql(resolved, nowSeconds, outFile) {
  const quoted = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const lines = ['-- 归一映射（trusted_work_mappings）；内容表按 C-5 停用，本文件不含任何 content_items 写入。'];
  const seen = new Set();
  for (const { record } of resolved) {
    const marker = `${record.providerId}:${record.sourceItemId}`;
    if (seen.has(marker)) continue;
    seen.add(marker);
    lines.push(
      'INSERT OR IGNORE INTO trusted_work_mappings (provider_id, source_item_id, content_id, evidence_ref, created_at) VALUES (' +
        `${quoted(record.providerId)}, ${quoted(record.sourceItemId)}, ${quoted(record.id)}, ${quoted(`taxonomy:${TAXONOMY_VERSION}`)}, ${nowSeconds});`
    );
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
  return { file: outFile, rows: seen.size };
}

/** Only explicit upstream minute values are converted; absent duration stays unknown. */
export function durationSeconds(rawDuration, episodeNumber, totalEpisodes) {
  const parts = String(rawDuration ?? '').split(/[,，]/).map((value) => Number(value.trim()));
  const single = parts.length === 1 ? parts[0] : parts[episodeNumber - 1];
  if (Number.isFinite(single) && single > 0 && single < 600) return Math.round(single * 60);
  return undefined;
}

/** §3.2 剧集清单；真实播放地址唯一的栖身之所（公开清单可 CDN 长缓存，私密清单必须由 Worker 准入后 no-store 返回）。 */
export function buildTitleManifest(record, item, { generatedAt, revision }) {
  const episodes = parseEpisodeLines(item.vod_play_url, record.providerId);
  return {
    workId: record.id,
    title: record.title,
    channelId: record.channelId,
    isPrivate: record.isPrivate,
    episodes: episodes.map((ep) => ({
      episodeNumber: ep.episodeNumber,
      title: ep.title,
      ...(durationSeconds(item.vod_duration, ep.episodeNumber, episodes.length) === undefined ? {} :
        { durationSeconds: durationSeconds(item.vod_duration, ep.episodeNumber, episodes.length) }),
      lines: ep.lines
    })),
    revision,
    generatedAt
  };
}

export function computeHotScore(hitsWeek, hitsTotal, publishedAt, nowSeconds) {
  const base = Math.log10(Math.max(0, hitsWeek) + 1) * WEEK_WEIGHT + Math.log10(Math.max(0, hitsTotal) + 1) * TOTAL_WEIGHT;
  const daysDiff = (nowSeconds - publishedAt) / 86400;
  const boost = daysDiff <= 3 && daysDiff >= 0 ? RECENCY_BOOST : 0;
  return Number((base + boost).toFixed(3));
}

/**
 * is_hot 按**频道内**前 15% 取，而非全库前 15%：客户端按频道浏览，
 * 上游短剧的绝对点击量远低于电影/动漫，全库口径会让主频道【短剧精选】几乎分不到热门位。
 */
export function assignHotFlags(records, nowSeconds) {
  const byChannel = new Map();
  for (const record of records) {
    record.hotScore = computeHotScore(record.hitsWeek ?? 0, record.hitsTotal ?? 0, record.firstPublishedAt ?? nowSeconds, nowSeconds);
    if (!byChannel.has(record.channelId)) byChannel.set(record.channelId, []);
    byChannel.get(record.channelId).push(record);
  }
  let flagged = 0;
  for (const list of byChannel.values()) {
    list.sort((a, b) => b.hotScore - a.hotScore || (a.id < b.id ? -1 : 1));
    const take = Math.max(1, Math.round(list.length * HOT_TOP_PERCENT));
    for (const [index, record] of list.entries()) {
      const hot = index < take;
      if (hot !== record.isHot) record.isHot = hot;
      if (hot) flagged += 1;
    }
  }
  return flagged;
}

/** 频道内确定性排序：热分 → 上新 → id，保证同一状态快照生成出逐字节一致的分片。 */
export function sortForSharding(a, b) {
  return (b.hotScore ?? 0) - (a.hotScore ?? 0)
    || (b.firstPublishedAt ?? 0) - (a.firstPublishedAt ?? 0)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

async function main(argv) {
  const dryRun = argv.includes('--dry-run');
  const stateArg = argv.find((arg) => arg.startsWith('--state='));
  const statePath = stateArg ? path.resolve(stateArg.slice('--state='.length)) : path.resolve(LOCAL.state());
  console.log('=== HotScore / AI 标定重算 ===');
  if (!fs.existsSync(statePath)) {
    console.error(`状态快照不存在: ${statePath}；请先跑 harvest-all.mjs（或 sync-incremental.mjs）生成快照。`);
    process.exitCode = 1;
    return;
  }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const records = Object.values(state.works ?? {});
  const nowSeconds = Math.floor(Date.now() / 1000);
  const flagged = assignHotFlags(records, nowSeconds);
  state.updatedAt = nowSeconds;

  const aiCount = records.filter((record) => record.isAi).length;
  const withWeek = records.filter((record) => (record.hitsWeek ?? 0) > 0).length;
  console.log(`参与标定作品: ${records.length} 部`);
  console.log(`其中有周点击: ${withWeek} 部（${records.length > 0 ? ((withWeek / records.length) * 100).toFixed(1) : '0.0'}%）`);
  console.log(`标定 is_ai=1: ${aiCount} 部（tid 级 forceAi 为硬判据，标题正则仅辅助）`);
  console.log(`标定 is_hot=1: ${flagged} 部（按频道内前 ${HOT_TOP_PERCENT * 100}% 取）`);
  const top5 = [...records].sort((a, b) => (b.hotScore ?? 0) - (a.hotScore ?? 0)).slice(0, 5);
  console.log(`Top5 热分: ${top5.map((record) => `${record.id}(${record.hotScore})`).join(', ') || '（空）'}`);
  if (dryRun) return void console.log('[dry-run] 未回写状态快照。');
  fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');
  console.log(`已回写: ${statePath}`);
  console.log('诚实边界：上游多数作品不返回周点击（hits_week=0），实际排序主要由总点击与时效提振决定。');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
