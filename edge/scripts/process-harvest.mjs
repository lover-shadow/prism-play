import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'cache', 'harvest');
const SQL_OUTPUT = path.join(__dirname, 'seed-public-baseline.sql');

// CJK 字符分词
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
function isCjkChar(char) {
  return CJK_RUN.test(char);
}

function normalized(value) {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function gramsOfRun(run) {
  const grams = [];
  for (const char of run) grams.push(char);
  const characters = [...run];
  for (let index = 0; index + 1 < characters.length; index += 1) grams.push(characters[index] + characters[index + 1]);
  if (characters.length > 1) grams.push(run);
  return grams;
}

function indexTokens(value) {
  const source = normalized(value);
  if (source === '') return [];
  const tokens = [];
  let cjkRun = '';
  let latinRun = '';

  const flushCjk = () => {
    if (cjkRun !== '') {
      tokens.push(...gramsOfRun(cjkRun));
      cjkRun = '';
    }
  };
  const flushLatin = () => {
    if (latinRun !== '') {
      tokens.push(latinRun);
      latinRun = '';
    }
  };

  for (const char of source) {
    if (isCjkChar(char)) {
      flushLatin();
      cjkRun += char;
      continue;
    }
    flushCjk();
    if (char === ' ') {
      flushLatin();
      continue;
    }
    latinRun += char;
  }
  flushCjk();
  flushLatin();

  return [...new Set(tokens)];
}

function indexTokenColumn(value) {
  return indexTokens(value).join(' ');
}

function escapeSql(str) {
  if (str === null || str === undefined) return "''";
  return "'" + String(str).replace(/'/g, "''") + "'";
}

function cleanSynopsis(raw) {
  if (!raw) return '暂无简介';
  return raw.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function cleanTitle(raw) {
  if (!raw) return '未知剧目';
  return raw.trim().replace(/\s+/g, ' ').slice(0, 50);
}

// 规则引擎：分类归一化到 21 个双字分类
function classifyDrama(title, desc) {
  const text = `${title} ${desc}`;
  if (/侯门|王爷|和离|大乾|驸马|千金|世子|江山|大秦|天下|公主|大唐|大宋|皇|穿书|古代/i.test(text)) return '古装';
  if (/战神|修罗|龙王|至尊|兵王|镇天|无双|狂龙|盖世|武神|阎罗|镇命|天尊/i.test(text)) return '战神';
  if (/娇妻|独美|闪婚|替嫁|心动|虐恋|独宠|青梅|初恋|婚后|甜宠|夫人|爱恋|爱意/i.test(text)) return '甜宠';
  if (/重生|翻盘|首富|系统|觉醒|董事长|少爷|摆摊|神豪|千亿|亿万|打脸|逆袭|商业帝国/i.test(text)) return '逆袭';
  if (/忘川|通灵|迷局|诡事|凶手|悬案|惊魂|猎罪|破案|玄术|侦探|死局|神秘/i.test(text)) return '悬疑';
  return '都市';
}

function classifyMovie(rawCat, title, desc) {
  if (rawCat === '动作' || /动作|枪战|格斗|武打|特工|杀手|暗杀/i.test(title)) return '动作';
  if (rawCat === '喜剧' || /喜剧|爆笑|欢乐|滑稽|搞笑|开心/i.test(title)) return '喜剧';
  if (rawCat === '科幻' || /科幻|未来|宇宙|外星|末日|星际|AI|太空|生化/i.test(title)) return '科幻';
  if (rawCat === '悬疑' || /悬疑|惊悚|恐怖|凶杀|破案|迷案|烧脑|犯罪/i.test(title)) return '悬疑';
  if (rawCat === '爱情' || /爱情|恋爱|恋人|初恋|前任|情书|深情/i.test(title)) return '爱情';
  return '动作';
}

function classifyAnime(title, desc, index) {
  const text = `${title} ${desc}`;
  if (/玄幻|修仙|斗罗|仙尊|九天|天道|神级|剑主|万界|吞噬|遮天/i.test(text)) return '玄幻';
  if (/机甲|星际|未来|科技|觉醒|机械|赛博|高达/i.test(text)) return '科幻';
  if (/治愈|日常|搞笑|萌|欢乐|轻松|学院|料理|猫/i.test(text)) return '治愈';
  if (/冒险|猎人|旅行|征途|海贼|探索|勇者|异界|地下城/i.test(text)) return '冒险';
  return '热血';
}

function classifyDoc(title, desc, index) {
  const text = `${title} ${desc}`;
  if (/地球|自然|海洋|动物|生态|森林|荒野|深蓝|地理|国家公园/i.test(text)) return '自然';
  if (/历史|古国|文明|王朝|考古|遗迹|封建|帝陵|大战|故宫/i.test(text)) return '历史';
  if (/科技|宇宙|量子|人工智能|能源|未来|人造太阳|芯片|火星/i.test(text)) return '科技';
  if (/美食|味道|食堂|烟火|舌尖|小吃|厨|寻味|烧烤|一餐/i.test(text)) return '美食';
  return '探索';
}

function parseEpisodes(vodPlayUrl, defaultDuration = 120, maxEpisodes = 3) {
  if (!vodPlayUrl) return [];
  const parts = vodPlayUrl.split('#');
  const episodes = [];
  let epNum = 1;

  for (const part of parts) {
    if (!part.trim()) continue;
    let title = `第${epNum}集`;
    let mediaUrl = part.trim();
    if (part.includes('$')) {
      const segs = part.split('$');
      title = segs[0].trim() || `第${epNum}集`;
      mediaUrl = segs[1].trim();
    }
    if (mediaUrl.startsWith('http')) {
      episodes.push({
        episodeNumber: epNum,
        title,
        mediaUrl,
        duration: defaultDuration
      });
      epNum++;
    }
    if (episodes.length >= maxEpisodes) break;
  }
  return episodes;
}

async function main() {
  console.log('=== 开始处理全量缓存并构建万部级生产 SQL ===');

  if (!fs.existsSync(CACHE_DIR)) {
    console.error('缓存目录不存在，请先运行 harvest-all.mjs');
    return;
  }

  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
  console.log(`读取到 ${files.length} 个缓存页文件...`);

  const uniqueWorks = new Map(); // id -> work
  const providersMap = new Map(); // origin -> provider info

  function getProviderId(mediaUrl, channelId) {
    try {
      const u = new URL(mediaUrl);
      const origin = u.origin;
      if (!providersMap.has(origin)) {
        const pId = 'provider_' + origin.replace(/[^a-zA-Z0-9]/g, '_').slice(-20);
        providersMap.set(origin, { id: pId, origin, channelId });
      }
      return providersMap.get(origin).id;
    } catch {
      return 'provider_modu_hls';
    }
  }

  let totalParsed = 0;
  for (const file of files) {
    const raw = fs.readFileSync(path.join(CACHE_DIR, file), 'utf8');
    const data = JSON.parse(raw);
    const { channelId, categoryTag, list } = data;

    for (const item of list) {
      totalParsed++;
      const title = cleanTitle(item.vod_name);
      const synopsis = cleanSynopsis(item.vod_content || item.vod_blurb);
      const coverUrl = item.vod_pic || '';
      const id = `${channelId}_m_${item.vod_id}`;

      if (uniqueWorks.has(id)) continue;

      let category = '都市';
      if (channelId === 'drama') {
        category = classifyDrama(title, synopsis);
      } else if (channelId === 'movie') {
        category = classifyMovie(categoryTag, title, synopsis);
      } else if (channelId === 'anime') {
        category = classifyAnime(title, synopsis);
      } else if (channelId === 'documentary') {
        category = classifyDoc(title, synopsis);
      }

      // 提取核心分集 (每部保留前 2 集或全集)
      const maxEp = channelId === 'movie' ? 1 : 2;
      const episodes = parseEpisodes(item.vod_play_url, channelId === 'movie' ? 5400 : 120, maxEp);
      if (episodes.length === 0) continue;

      if (coverUrl.startsWith('http')) getProviderId(coverUrl, channelId);
      for (const ep of episodes) {
        getProviderId(ep.mediaUrl, channelId);
      }

      uniqueWorks.set(id, {
        id,
        channelId,
        title,
        coverUrl,
        synopsis,
        category,
        episodes
      });
    }
  }

  console.log(`原始条目: ${totalParsed} 条，去重后独立精品剧目: ${uniqueWorks.size} 部！`);
  console.log(`发现上游安全 Origin: ${providersMap.size} 个`);

  // 统计各频道分布
  const counts = { drama: 0, movie: 0, anime: 0, documentary: 0 };
  const catCounts = {};
  for (const w of uniqueWorks.values()) {
    counts[w.channelId] = (counts[w.channelId] || 0) + 1;
    const k = `${w.channelId}:${w.category}`;
    catCounts[k] = (catCounts[k] || 0) + 1;
  }
  console.log('各频道最终规模:');
  console.log(` - 短剧精选 (drama): ${counts.drama} 部`);
  console.log(` - 院线电影 (movie): ${counts.movie} 部`);
  console.log(` - 热血动漫 (anime): ${counts.anime} 部`);
  console.log(` - 人文纪录 (documentary): ${counts.documentary} 部`);

  const now = Math.floor(Date.now() / 1000);
  const sqlStatements = [];

  // 1. 注册 source_providers
  for (const [origin, p] of providersMap.entries()) {
    sqlStatements.push(
      `INSERT OR IGNORE INTO source_providers (id, name, channel_id, upstream_url, priority, latency_ms, healthy, last_checked_at, created_at, updated_at) VALUES (${escapeSql(p.id)}, ${escapeSql('聚合流节点_' + p.id)}, ${escapeSql(p.channelId)}, ${escapeSql(origin)}, 1, 15, 1, ${now}, ${now}, ${now});`
    );
  }

  // 2. 生成作品、分集、播放源与 FTS
  for (const w of uniqueWorks.values()) {
    sqlStatements.push(
      `INSERT OR REPLACE INTO content_items (id, channel_id, title, cover_url, cover_version, synopsis, category, is_private, shareable, enabled, first_published_at, created_at, updated_at) VALUES (${escapeSql(w.id)}, ${escapeSql(w.channelId)}, ${escapeSql(w.title)}, ${escapeSql(w.coverUrl)}, 'v1', ${escapeSql(w.synopsis)}, ${escapeSql(w.category)}, 0, 1, 1, ${now}, ${now}, ${now});`
    );

    for (const ep of w.episodes) {
      const pId = getProviderId(ep.mediaUrl, w.channelId);
      sqlStatements.push(
        `INSERT OR REPLACE INTO content_episodes (content_id, episode_number, title, duration_seconds, created_at, updated_at) VALUES (${escapeSql(w.id)}, ${ep.episodeNumber}, ${escapeSql(ep.title)}, ${ep.duration}, ${now}, ${now});`
      );
      sqlStatements.push(
        `INSERT OR REPLACE INTO episode_sources (episode_id, provider_id, upstream_media_url, enabled, created_at, updated_at) VALUES ((SELECT id FROM content_episodes WHERE content_id = ${escapeSql(w.id)} AND episode_number = ${ep.episodeNumber}), ${escapeSql(pId)}, ${escapeSql(ep.mediaUrl)}, 1, ${now}, ${now});`
      );
    }

    const titleTokens = indexTokenColumn(w.title);
    const tagTokens = indexTokenColumn(w.category);
    sqlStatements.push(
      `DELETE FROM public_search_fts WHERE content_id = ${escapeSql(w.id)};`
    );
    sqlStatements.push(
      `INSERT INTO public_search_fts (content_id, title_tokens, alias_tokens, pinyin_tokens, tag_tokens) VALUES (${escapeSql(w.id)}, ${escapeSql(titleTokens)}, '', '', ${escapeSql(tagTokens)});`
    );
  }

  // 3. 递增公共变更版本
  sqlStatements.push(
    `INSERT INTO public_catalog_changes (content_id, operation, changed_at) VALUES ('batch_baseline_${now}', 'upsert', ${now});`
  );

  fs.writeFileSync(SQL_OUTPUT, sqlStatements.join('\n'), 'utf8');
  const sizeMb = (fs.statSync(SQL_OUTPUT).size / (1024 * 1024)).toFixed(2);
  console.log(`\n=== SQL 构建成功！===`);
  console.log(`产物文件: ${SQL_OUTPUT}`);
  console.log(`总 SQL 语句数: ${sqlStatements.length} 条`);
  console.log(`SQL 文件大小: ${sizeMb} MB`);
}

main().catch(console.error);
