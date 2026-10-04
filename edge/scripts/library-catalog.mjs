import fs from 'node:fs';
import path from 'node:path';
import {
  PAGE_SIZE, PUBLIC_CHANNEL_IDS, publicTargets, makeWorkId, coverHandle, toEpochSeconds
} from './config-sources.mjs';
import {
  deriveCategory, isAiFlag, assignHotFlags, toCatalogItem, sortForSharding,
  cleanTitle, shortSynopsis
} from './compute-hotscore.mjs';

/** Legacy cache filenames identify a type, not a provider: only accept unambiguous targets. */
export function readHarvestMetadata(directory) {
  if (Array.isArray(directory)) {
    const merged = new Map();
    for (const dir of directory) for (const [id, evidence] of readHarvestMetadata(dir)) {
      const previous = merged.get(id);
      merged.set(id, { ...evidence, item: { ...previous?.item, ...evidence.item } });
    }
    return merged;
  }
  const metadata = new Map();
  if (!fs.existsSync(directory)) return metadata;
  const targets = publicTargets();
  for (const name of fs.readdirSync(directory).sort()) {
    const match = /^t_(\d+)_p_\d+\.json$/.exec(name);
    if (!match) continue;
    const candidates = targets.filter((target) => target.typeId === Number(match[1]));
    if (candidates.length !== 1) continue;
    const target = candidates[0];
    const payload = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    if (!Array.isArray(payload.list)) throw new Error(`Invalid harvest list: ${name}`);
    for (const item of payload.list) {
      if (Number(item.type_id ?? match[1]) !== target.typeId) continue;
      const id = makeWorkId(target.channelId, target.provider, item.vod_id);
      const previous = metadata.get(id);
      const stamp = toEpochSeconds(item.vod_time, null, 0);
      if (!previous || stamp > previous.stamp) metadata.set(id, { target, item, stamp });
    }
  }
  return metadata;
}

function metric(value) {
  if (value === null || value === undefined || String(value).trim() === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : undefined;
}

/** Supply candidates, not recommendation slots. Never turn non-AI works into AI. */
export function sortCandidateSupply(records) {
  const ranked = [...records].sort(sortForSharding);
  const ai = ranked.filter((record) => record.isAi).slice(0, Math.floor(PAGE_SIZE * 0.35));
  const selected = new Set(ai.map((record) => record.id));
  const rest = ranked.filter((record) => !selected.has(record.id));
  const head = [...ai, ...rest.slice(0, PAGE_SIZE - ai.length)].sort(sortForSharding);
  return [...head, ...rest.slice(PAGE_SIZE - ai.length)];
}

export function buildLibraryCatalog(db, metadata, nowSeconds) {
  const rows = db.prepare(`
    SELECT c.*, COALESCE(e.episode_count, 0) AS episode_count
    FROM content_items c LEFT JOIN (
      SELECT content_id, COUNT(DISTINCT episode_number) AS episode_count
      FROM content_episodes GROUP BY content_id
    ) e ON e.content_id = c.id
    WHERE c.enabled = 1 AND c.is_private = 0
    ORDER BY c.id ASC
  `).all();
  const report = { total: 0, ai: 0, hot: 0, metadataMatched: 0,
    missingHitsTotal: 0, missingHitsWeek: 0, missingFirstPublishedAt: 0,
    positiveHitsTotal: 0, positiveHitsWeek: 0, hotRecomputed: 0 };
  const records = rows.filter((row) => PUBLIC_CHANNEL_IDS.includes(row.channel_id)).map((row) => {
    const evidence = metadata.get(row.id);
    const raw = evidence?.item;
    const channelId = evidence?.target.channelId ?? row.channel_id;
    const title = cleanTitle(row.title);
    const record = {
      id: row.id, channelId, title,
      category: deriveCategory(channelId, title, evidence?.target.typeId, raw?.type_name ?? row.category),
      isPrivate: false, enabled: true, shareable: row.shareable === 1,
      coverUrl: coverHandle(row.id), coverVersion: row.cover_version || 'v1',
      episodeCount: Number(row.episode_count),
      isAi: row.is_ai === 1 || isAiFlag(evidence?.target.forceAi, title, raw?.vod_class),
      isHot: row.is_hot === 1
    };
    const synopsis = shortSynopsis(raw ? (raw.vod_blurb || raw.vod_content) : row.synopsis);
    if (synopsis && synopsis !== '暂无简介') record.synopsis = synopsis;
    // No now/created_at fallback: upstream timestamps are evidence, packaging time is not.
    const published = raw
      ? toEpochSeconds(raw.vod_time, raw.vod_time_add, undefined)
      : metric(row.first_published_at);
    if (published > 0) record.firstPublishedAt = published;
    const total = metric(raw?.vod_hits) ?? metric(row.hits_total);
    const week = metric(raw?.vod_hits_week) ?? metric(row.hits_week);
    if (total !== undefined) record.hitsTotal = total;
    if (week !== undefined) record.hitsWeek = week;
    if (evidence) report.metadataMatched += 1;
    if (total === undefined) report.missingHitsTotal += 1;
    if (week === undefined) report.missingHitsWeek += 1;
    if (total > 0) report.positiveHitsTotal += 1;
    if (week > 0) report.positiveHitsWeek += 1;
    if (record.firstPublishedAt === undefined) report.missingFirstPublishedAt += 1;
    return record;
  });
  // Missing publication dates must not receive assignHotFlags' default "just published" boost.
  // Without ranking evidence retain the database flag rather than invent a popularity signal.
  for (const channelId of PUBLIC_CHANNEL_IDS) {
    const channel = records.filter((record) => record.channelId === channelId);
    if (channel.length && channel.every((record) => record.hitsTotal !== undefined || record.hitsWeek !== undefined)) {
      const scoring = channel.map((record) => ({ ...record, firstPublishedAt: record.firstPublishedAt ?? 0 }));
      assignHotFlags(scoring, nowSeconds);
      const byId = new Map(scoring.map((record) => [record.id, record]));
      for (const record of channel) {
        const scored = byId.get(record.id);
        record.isHot = scored.isHot;
        record.hotScore = scored.hotScore;
      }
      report.hotRecomputed += channel.length;
    }
  }
  report.total = records.length;
  report.ai = records.filter((record) => record.isAi).length;
  report.hot = records.filter((record) => record.isHot).length;
  const channels = Object.fromEntries(PUBLIC_CHANNEL_IDS.map((channelId) => [channelId,
    sortCandidateSupply(records.filter((record) => record.channelId === channelId)).map(toCatalogItem)]));
  return { channels, report };
}
