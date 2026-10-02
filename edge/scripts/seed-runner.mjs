import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAllContent, indexTokenColumn } from './seed-production-content.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function classifyDrama(title, desc) {
  const text = `${title} ${desc}`;
  if (/神医|千亿|总裁|首富|亿万|豪门|逆袭|继承|暴富|打脸|少爷|千金/i.test(text)) return '逆袭';
  if (/战神|修罗|龙王|至尊|兵王|镇天|无双|狂龙|天下|盖世|武神|阎罗/i.test(text)) return '战神';
  if (/娇妻|甜宠|夫人|闪婚|替嫁|心动|虐恋|独宠|青梅|初恋|婚后/i.test(text)) return '甜宠';
  if (/王妃|驸马|皇|侯门|古代|穿书|重回|大唐|大明|公主|逍遥|前夫|和离|王爷/i.test(text)) return '古装';
  if (/天师|通灵|诡|悬案|惊魂|猎罪|破案|迷局|镇命|玄术|凶手/i.test(text)) return '悬疑';
  return '都市';
}

function classifyAnime(title, desc, index) {
  const text = `${title} ${desc}`;
  if (/玄幻|修仙|斗罗|仙尊|九天|天道|神级|剑主|万界/i.test(text)) return '玄幻';
  if (/机甲|星际|未来|科技|觉醒|机械|赛博/i.test(text)) return '科幻';
  if (/治愈|日常|搞笑|萌|欢乐|轻松|学院/i.test(text)) return '治愈';
  if (/冒险|猎人|旅行|征途|海贼|探索|勇者/i.test(text)) return '冒险';
  return '热血';
}

function classifyDoc(title, desc, index) {
  const text = `${title} ${desc}`;
  if (/地球|自然|海洋|动物|生态|森林|荒野|深蓝|地理/i.test(text)) return '自然';
  if (/历史|古国|文明|王朝|考古|遗迹|封建|帝陵/i.test(text)) return '历史';
  if (/科技|宇宙|量子|人工智能|能源|未来|人造太阳|芯片/i.test(text)) return '科技';
  if (/美食|味道|食堂|烟火|舌尖|小吃|厨|寻味/i.test(text)) return '美食';
  return '探索';
}

function parseEpisodes(vodPlayUrl, defaultDuration = 120, maxEpisodes = 50) {
  if (!vodPlayUrl) return [];
  // 格式可能是: "第1集$url#第2集$url" 或单 url
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
  console.log('=== 开始构建生产内容 SQL ===');
  const { dramaRaw, movieRaw, animeRaw, docRaw } = await collectAllContent();

  const now = Math.floor(Date.now() / 1000);
  const sqlStatements = [];
  const providersMap = new Map(); // origin -> provider_id

  // 辅助函数：根据 mediaUrl 提取 origin 并登记 provider
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

  // 1. 处理短剧 (drama)
  console.log('正在清洗短剧...');
  const dramaItems = [];
  for (const item of dramaRaw) {
    const title = cleanTitle(item.vod_name);
    const synopsis = cleanSynopsis(item.vod_content || item.vod_blurb);
    const category = classifyDrama(title, synopsis);
    const id = `drama_modu_${item.vod_id}`;
    const coverUrl = item.vod_pic || '';
    if (coverUrl.startsWith('http')) getProviderId(coverUrl, 'drama');

    const episodes = parseEpisodes(item.vod_play_url, 120, 60);
    if (episodes.length === 0) continue;

    for (const ep of episodes) {
      getProviderId(ep.mediaUrl, 'drama');
    }

    dramaItems.push({
      id,
      channelId: 'drama',
      title,
      coverUrl,
      synopsis,
      category,
      episodes
    });
  }

  // 2. 处理电影 (movie)
  console.log('正在清洗电影...');
  const movieItems = [];
  for (const item of movieRaw) {
    const title = cleanTitle(item.vod_name);
    const synopsis = cleanSynopsis(item.vod_content || item.vod_blurb);
    const category = item._cat || '动作';
    const id = `movie_modu_${item.vod_id}`;
    const coverUrl = item.vod_pic || '';
    if (coverUrl.startsWith('http')) getProviderId(coverUrl, 'movie');

    const episodes = parseEpisodes(item.vod_play_url, 5400, 1);
    if (episodes.length === 0) continue;

    for (const ep of episodes) {
      getProviderId(ep.mediaUrl, 'movie');
    }

    movieItems.push({
      id,
      channelId: 'movie',
      title,
      coverUrl,
      synopsis,
      category,
      episodes
    });
  }

  // 3. 处理动漫 (anime)
  console.log('正在清洗动漫...');
  const animeItems = [];
  let aIdx = 0;
  for (const item of animeRaw) {
    const title = cleanTitle(item.vod_name);
    const synopsis = cleanSynopsis(item.vod_content || item.vod_blurb);
    const category = classifyAnime(title, synopsis, aIdx++);
    const id = `anime_modu_${item.vod_id}`;
    const coverUrl = item.vod_pic || '';
    if (coverUrl.startsWith('http')) getProviderId(coverUrl, 'anime');

    const episodes = parseEpisodes(item.vod_play_url, 1200, 24);
    if (episodes.length === 0) continue;

    for (const ep of episodes) {
      getProviderId(ep.mediaUrl, 'anime');
    }

    animeItems.push({
      id,
      channelId: 'anime',
      title,
      coverUrl,
      synopsis,
      category,
      episodes
    });
  }

  // 4. 处理纪录片 (documentary)
  console.log('正在清洗纪录片...');
  const docItems = [];
  let dIdx = 0;
  for (const item of docRaw) {
    const title = cleanTitle(item.vod_name);
    const synopsis = cleanSynopsis(item.vod_content || item.vod_blurb);
    const category = classifyDoc(title, synopsis, dIdx++);
    const id = `doc_modu_${item.vod_id}`;
    const coverUrl = item.vod_pic || '';
    if (coverUrl.startsWith('http')) getProviderId(coverUrl, 'documentary');

    const episodes = parseEpisodes(item.vod_play_url, 2700, 12);
    if (episodes.length === 0) continue;

    for (const ep of episodes) {
      getProviderId(ep.mediaUrl, 'documentary');
    }

    docItems.push({
      id,
      channelId: 'documentary',
      title,
      coverUrl,
      synopsis,
      category,
      episodes
    });
  }

  const allWorks = [...dramaItems, ...movieItems, ...animeItems, ...docItems];
  console.log(`\n清洗完成！有效作品总计: ${allWorks.length} 部`);
  console.log(`- 短剧: ${dramaItems.length} 部`);
  console.log(`- 电影: ${movieItems.length} 部`);
  console.log(`- 动漫: ${animeItems.length} 部`);
  console.log(`- 纪录片: ${docItems.length} 部`);
  console.log(`- 发现上游 Origin 数量: ${providersMap.size} 个`);

  // 生成 source_providers 注册语句
  for (const [origin, p] of providersMap.entries()) {
    sqlStatements.push(`INSERT OR IGNORE INTO source_providers (id, name, channel_id, upstream_url, priority, latency_ms, healthy, last_checked_at, created_at, updated_at) VALUES (${escapeSql(p.id)}, ${escapeSql('聚合流节点_' + p.id)}, ${escapeSql(p.channelId)}, ${escapeSql(origin)}, 1, 15, 1, ${now}, ${now}, ${now});`);
  }

  // 生成 content_items, content_episodes, episode_sources, FTS, changes
  for (const work of allWorks) {
    // 1. content_items
    sqlStatements.push(
      `INSERT OR REPLACE INTO content_items (id, channel_id, title, cover_url, cover_version, synopsis, category, is_private, shareable, enabled, first_published_at, created_at, updated_at) VALUES (${escapeSql(work.id)}, ${escapeSql(work.channelId)}, ${escapeSql(work.title)}, ${escapeSql(work.coverUrl)}, 'v1', ${escapeSql(work.synopsis)}, ${escapeSql(work.category)}, 0, 1, 1, ${now}, ${now}, ${now});`
    );

    // 2. content_episodes & episode_sources
    for (const ep of work.episodes) {
      const pId = getProviderId(ep.mediaUrl, work.channelId);
      sqlStatements.push(
        `INSERT OR REPLACE INTO content_episodes (content_id, episode_number, title, duration_seconds, created_at, updated_at) VALUES (${escapeSql(work.id)}, ${ep.episodeNumber}, ${escapeSql(ep.title)}, ${ep.duration}, ${now}, ${now});`
      );
      sqlStatements.push(
        `INSERT OR REPLACE INTO episode_sources (episode_id, provider_id, upstream_media_url, enabled, created_at, updated_at) VALUES ((SELECT id FROM content_episodes WHERE content_id = ${escapeSql(work.id)} AND episode_number = ${ep.episodeNumber}), ${escapeSql(pId)}, ${escapeSql(ep.mediaUrl)}, 1, ${now}, ${now});`
      );
    }

    // 3. FTS5 搜索索引
    const titleTokens = indexTokenColumn(work.title);
    const tagTokens = indexTokenColumn(work.category);
    sqlStatements.push(
      `DELETE FROM public_search_fts WHERE content_id = ${escapeSql(work.id)};`
    );
    sqlStatements.push(
      `INSERT INTO public_search_fts (content_id, title_tokens, alias_tokens, pinyin_tokens, tag_tokens) VALUES (${escapeSql(work.id)}, ${escapeSql(titleTokens)}, '', '', ${escapeSql(tagTokens)});`
    );

    // 4. public_catalog_changes 增量发布变更记录
    sqlStatements.push(
      `INSERT INTO public_catalog_changes (content_id, operation, changed_at) VALUES (${escapeSql(work.id)}, 'upsert', ${now});`
    );
  }

  const outPath = path.join(__dirname, 'seed-data.sql');
  fs.writeFileSync(outPath, sqlStatements.join('\n'), 'utf8');
  console.log(`\n生成 SQL 成功！已写入 ${outPath}，总 SQL 行数: ${sqlStatements.length}`);
}

main().catch(console.error);
