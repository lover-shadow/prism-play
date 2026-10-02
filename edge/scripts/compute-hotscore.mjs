import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '..', 'cache', 'harvest');
const SQL_OUTPUT = path.join(__dirname, 'backfill-hotscore.sql');

// 与 edge/src/core/constants.ts 保持一致的权重（此处为生成期计算，不在请求路径执行）
const WEEK_WEIGHT = 0.6;
const TOTAL_WEIGHT = 0.2;
const RECENCY_BOOST = 0.8;
const FRESH_WINDOW_SECONDS = 72 * 3600;
const HOT_TOP_PERCENT = 0.15;

// AI 剧 / 漫剧特征：上游 AI 专区 + 标题/简介特征词
const AI_TID = new Set([42]);
const AI_PATTERN = /AI漫剧|AI短剧|虚拟人|AI剧|AI动漫/i;

function escapeSql(value) {
  if (value === null || value === undefined) return "''";
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function parseEpochSeconds(raw) {
  if (!raw) return null;
  // 上游形如 "2026-10-02 20:20:35"（北京时间）
  const matched = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(String(raw).trim());
  if (matched === null) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = matched;
  const utc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  // 上游时间为 UTC+8
  return Math.floor(utc / 1000) - 8 * 3600;
}

async function main() {
  if (!fs.existsSync(CACHE_DIR)) {
    console.error('缓存目录不存在，请先运行 harvest-all.mjs');
    return;
  }
  const files = fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.json'));
  const nowSeconds = Math.floor(Date.now() / 1000);

  const rows = new Map(); // contentId -> { hitsWeek, hitsTotal, isAi, publishedAt }

  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf8'));
    const { channelId, list } = data;
    for (const item of list) {
      const id = `${channelId}_m_${item.vod_id}`;
      if (rows.has(id)) continue;
      const synopsis = item.vod_content || item.vod_blurb || '';
      const isAi =
        AI_TID.has(Number(item.type_id)) || AI_PATTERN.test(`${item.vod_name} ${synopsis}`) ? 1 : 0;
      rows.set(id, {
        channelId,
        hitsWeek: num(item.vod_hits_week),
        hitsTotal: num(item.vod_hits),
        isAi,
        publishedAt: parseEpochSeconds(item.vod_time)
      });
    }
  }

  // 计算 HotScore：周点击主导，总点击为辅，72 小时内上新/更新额外提振
  const scored = [...rows.entries()].map(([id, r]) => {
    const fresh =
      r.publishedAt !== null && nowSeconds - r.publishedAt <= FRESH_WINDOW_SECONDS ? RECENCY_BOOST : 0;
    const score =
      Math.log10(r.hitsWeek + 1) * WEEK_WEIGHT + Math.log10(r.hitsTotal + 1) * TOTAL_WEIGHT + fresh;
    return { id, ...r, score: Number(score.toFixed(4)) };
  });

  // is_hot 按频道内取前 15%，而非全库取前 15%。
  // 客户端是按频道浏览的：上游短剧的绝对点击量远低于电影/动漫，若按全库取前 15%，
  // 短剧频道（本产品主频道）几乎分不到热门位，"35% 全网热门"轨在该频道将无米下锅。
  const hotIds = new Set();
  const byChannel = new Map();
  for (const row of scored) {
    const key = row.channelId;
    if (!byChannel.has(key)) byChannel.set(key, []);
    byChannel.get(key).push(row);
  }
  let hotCount = 0;
  for (const list of byChannel.values()) {
    list.sort((a, b) => b.score - a.score);
    const take = Math.max(1, Math.round(list.length * HOT_TOP_PERCENT));
    for (const row of list.slice(0, take)) hotIds.add(row.id);
    hotCount += take;
  }

  const statements = [];
  const BATCH_SIZE = 200;
  let batchCount = 0;

  for (let i = 0; i < scored.length; i++) {
    const row = scored[i];
    if (i % BATCH_SIZE === 0) {
      if (i > 0) statements.push('COMMIT;');
      statements.push('BEGIN TRANSACTION;');
      batchCount++;
    }
    statements.push(
      `UPDATE content_items SET hits_week = ${row.hitsWeek}, hits_total = ${row.hitsTotal}, ` +
        `hot_score = ${row.score}, is_ai = ${row.isAi}, is_hot = ${hotIds.has(row.id) ? 1 : 0}, ` +
        `updated_at = ${nowSeconds} WHERE id = ${escapeSql(row.id)};`
    );
  }
  if (scored.length > 0) {
    statements.push('COMMIT;');
  }

  fs.writeFileSync(SQL_OUTPUT, statements.join('\n'), 'utf8');

  const withWeek = scored.filter((r) => r.hitsWeek > 0).length;
  const aiCount = scored.filter((r) => r.isAi === 1).length;
  console.log('=== HotScore / AI 标定计算完成 ===');
  console.log(`参与计算作品: ${scored.length} 部`);
  console.log(`其中有周点击数据: ${withWeek} 部（${((withWeek / scored.length) * 100).toFixed(1)}%）`);
  console.log(`标定为 AI 剧: ${aiCount} 部`);
  console.log(`标定为全网热门: ${hotCount} 部（按频道内前 ${HOT_TOP_PERCENT * 100}% 取）`);
  // 展示用的排序副本：hotIds 是按频道内排名得到的，全局数组本身未排序，直接 slice 会给出错误印象。
  const top5 = [...scored].sort((a, b) => b.score - a.score).slice(0, 5);
  console.log(`Top5 热度: ${top5.map((r) => `${r.id}(${r.score})`).join(', ')}`);
  console.log(`SQL 产物: ${SQL_OUTPUT}（${statements.length} 条）`);
  console.log('');
  console.log('诚实边界：上游绝大多数作品未返回周点击（hits_week=0），');
  console.log('因此实际排序主要由总点击与时效提振决定，周点击项对这些作品贡献为 0 且对所有作品一致。');
}

main().catch(console.error);
