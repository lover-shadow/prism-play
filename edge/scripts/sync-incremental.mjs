/**
 * 每日无人值守增量追新执行脚本 (GitHub Actions 专用)
 * 对应 CLOUD-SYNC-JIT-PIPELINE-SPEC.md §4.1
 */

import fs from 'node:fs';
import path from 'node:path';

const CHANNELS = [
  { id: 'drama', typeId: 38, name: '短剧' },
  { id: 'movie', typeId: 1, name: '电影' },
  { id: 'anime', typeId: 3, name: '动漫' },
  { id: 'documentary', typeId: 4, name: '纪录片' }
];

const BASE_URL = 'https://caiji.moduapi.cc/api.php/provide/vod?ac=detail';

function escapeSql(str) {
  if (str === null || str === undefined) return 'NULL';
  return `'${String(str).replace(/'/g, "''")}'`;
}

function parseEpochSeconds(val) {
  if (!val) return Math.floor(Date.now() / 1000);
  const d = new Date(val);
  const ts = Math.floor(d.getTime() / 1000);
  return Number.isFinite(ts) && ts > 0 ? ts : Math.floor(Date.now() / 1000);
}

function normalizeCategory(channelId, title, rawType) {
  const t = title || '';
  if (channelId === 'drama') {
    if (/侯门|王爷|和离|大乾|驸马|千金|世子|江山|大秦|天下|贵妃|皇|臣/.test(t)) return '古装';
    if (/镇命|神医|镇天|龙王|至尊|天尊|兵王|无双|战神|狂飙|战帝/.test(t)) return '战神';
    if (/娇妻|独美|婚|爱|宠|恋爱|替嫁|夫人|姐姐|前妻|白月光/.test(t)) return '甜宠';
    if (/重生|翻盘|首富|系统|觉醒|董事长|少爷|摆摊|逆袭|开局|逆天/.test(t)) return '逆袭';
    if (/忘川|通灵|迷|诡|局|案|死|神秘|阴阳|道士|诡异/.test(t)) return '悬疑';
    return '都市';
  }
  if (channelId === 'movie') {
    if (/喜剧|笑|幽默/.test(t) || /喜剧/.test(rawType)) return '喜剧';
    if (/科幻|未来|宇宙|太空|机器人/.test(t) || /科幻/.test(rawType)) return '科幻';
    if (/悬疑|惊悚|恐怖|侦探|破案|凶手/.test(t) || /悬疑|惊悚/.test(rawType)) return '悬疑';
    if (/爱情|恋|浪漫/.test(t) || /爱情/.test(rawType)) return '爱情';
    return '动作';
  }
  if (channelId === 'anime') {
    if (/治愈|日常|搞笑|萌|校园/.test(t) || /治愈/.test(rawType)) return '治愈';
    if (/修仙|仙尊|玄幻|万界|斗罗|武神|至尊/.test(t) || /玄幻/.test(rawType)) return '玄幻';
    if (/机甲|高达|未来|科幻/.test(t) || /科幻/.test(rawType)) return '科幻';
    if (/冒险|猎人|探索|海贼|西行/.test(t) || /冒险/.test(rawType)) return '冒险';
    return '热血';
  }
  if (channelId === 'documentary') {
    if (/自然|深境|海|极|动物|野|山|地球/.test(t) || /自然/.test(rawType)) return '自然';
    if (/文明|古|风云|史|战|迹|大国/.test(t) || /历史/.test(rawType)) return '历史';
    if (/量子|光|宙|未来|星|机|科技|AI/.test(t) || /科技/.test(rawType)) return '科技';
    if (/人间|烟火|味|食|厨|舌尖/.test(t) || /美食/.test(rawType)) return '美食';
    return '探索';
  }
  return '精选';
}

function computeHotScore(hitsWeek, hitsTotal, publishedAt, nowSeconds) {
  const w = Math.max(0, hitsWeek);
  const t = Math.max(0, hitsTotal);
  const base = Math.log10(w + 1) * 0.6 + Math.log10(t + 1) * 0.2;
  const daysDiff = (nowSeconds - publishedAt) / 86400;
  const boost = daysDiff <= 3 && daysDiff >= 0 ? 0.8 : 0;
  return Number((base + boost).toFixed(3));
}

async function fetchChannelPage(typeId, page = 1) {
  const url = `${BASE_URL}&t=${typeId}&pg=${page}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return await res.json();
}

async function run() {
  console.log('=== [Scheduled Sync] 开始执行每日增量追新 ===');
  const now = Math.floor(Date.now() / 1000);
  const sqlStatements = [];

  for (const ch of CHANNELS) {
    try {
      console.log(`拉取频道: ${ch.name} (ID: ${ch.id}, type: ${ch.typeId}) 第 1 页...`);
      const data = await fetchChannelPage(ch.typeId, 1);
      const list = data.list || [];
      console.log(`获取到 ${list.length} 条作品数据`);

      for (const item of list) {
        const id = `${ch.id}_modu_${item.vod_id}`;
        const title = (item.vod_name || '').trim();
        if (!title) continue;

        const coverUrl = (item.vod_pic || '').trim();
        const synopsis = (item.vod_content || item.vod_blurb || `${title} 精彩热播`).replace(/<[^>]+>/g, '').trim().slice(0, 400);
        const category = normalizeCategory(ch.id, title, item.type_name || '');
        const pubTime = parseEpochSeconds(item.vod_time);
        const hitsWeek = Number(item.vod_hits_week || 0);
        const hitsTotal = Number(item.vod_hits || 0);
        const hotScore = computeHotScore(hitsWeek, hitsTotal, pubTime, now);
        const isAi = (/AI|人工智能|虚拟|漫剧|生成|数字人/i.test(title) || /AI/i.test(item.vod_class || '')) ? 1 : 0;
        const isHot = hotScore >= 2.0 ? 1 : 0;

        sqlStatements.push(`INSERT OR REPLACE INTO content_items (
          id, channel_id, title, cover_url, cover_version, synopsis, category,
          is_private, shareable, enabled, first_published_at, created_at, updated_at,
          hits_week, hits_total, hot_score, is_ai, is_hot
        ) VALUES (
          ${escapeSql(id)}, ${escapeSql(ch.id)}, ${escapeSql(title)}, ${escapeSql(coverUrl)}, 'v1',
          ${escapeSql(synopsis)}, ${escapeSql(category)}, 0, 1, 1, ${pubTime}, ${pubTime}, ${now},
          ${hitsWeek}, ${hitsTotal}, ${hotScore}, ${isAi}, ${isHot}
        );`);

        // 解析分集 (前 3 集)
        const playUrlStr = item.vod_play_url || '';
        const epEntries = playUrlStr.split('#').filter(Boolean);
        for (let idx = 0; idx < Math.min(epEntries.length, 3); idx++) {
          const parts = epEntries[idx].split('$');
          const epTitle = parts.length > 1 ? parts[0] : `第${idx + 1}集`;
          const mediaUrl = parts.length > 1 ? parts[1] : parts[0];
          if (!mediaUrl || !mediaUrl.startsWith('http')) continue;

          const epId = (Number(item.vod_id) * 100 + (idx + 1));
          sqlStatements.push(`INSERT OR REPLACE INTO content_episodes (
            id, content_id, episode_number, title, duration_seconds, created_at, updated_at
          ) VALUES (
            ${epId}, ${escapeSql(id)}, ${idx + 1}, ${escapeSql(epTitle)}, 120, ${now}, ${now}
          );`);

          sqlStatements.push(`INSERT OR REPLACE INTO episode_sources (
            episode_id, provider_id, upstream_media_url, enabled, created_at, updated_at
          ) VALUES (
            ${epId}, 'provider_modu_hls', ${escapeSql(mediaUrl)}, 1, ${now}, ${now}
          );`);
        }

        // FTS 倒排索引
        sqlStatements.push(`INSERT OR REPLACE INTO public_search_fts (
          content_id, title_tokens, alias_tokens, pinyin_tokens, tag_tokens
        ) VALUES (
          ${escapeSql(id)}, ${escapeSql(title)}, '', '', ${escapeSql(category)}
        );`);

        // 增量目录修订号
        sqlStatements.push(`INSERT INTO public_catalog_changes (
          content_id, operation, is_visible, changed_at
        ) VALUES (
          ${escapeSql(id)}, 'upsert', 1, ${now}
        );`);
      }
    } catch (err) {
      console.error(`频道 ${ch.name} 抓取失败:`, err.message);
    }
  }

  const outDir = path.resolve('edge/scripts');
  const outFile = path.join(outDir, 'sync-incremental.sql');
  fs.writeFileSync(outFile, sqlStatements.join('\n'), 'utf8');
  console.log(`生成增量同步 SQL 完成: ${outFile}, 共 ${sqlStatements.length} 条语句`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
