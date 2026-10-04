import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { publicTargets, makeWorkId, toEpochSeconds } from './config-sources.mjs';
import { cleanTitle, shortSynopsis, deriveCategory, isAiFlag, durationSeconds } from './compute-hotscore.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ORIGINAL = path.join(ROOT, 'build/library_full.db');
function mediaUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid media URL'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[\s\\\u0000-\u001f]/u.test(raw)) throw new Error('Unsafe media URL');
  return raw;
}
/** Unlimited real lines/episodes; explicit source numbers survive invalid entries and gaps. */
export function parseFullEpisodes(raw, duration) {
  const episodes = new Map();
  for (const group of String(raw ?? '').split('$$$')) {
    for (const [index, entry] of group.split('#').entries()) {
      if (!entry.trim()) continue;
      const separator = entry.indexOf('$');
      const title = separator < 0 ? `第${index + 1}集` : entry.slice(0, separator).trim();
      const value = (separator < 0 ? entry : entry.slice(separator + 1)).trim();
      if (!/^https?:\/\//i.test(value)) continue;
      const match = /第\s*(\d+)\s*[集话話期]|^(\d+)(?:[集话話期]|$)/.exec(title);
      const episodeNumber = match ? Number(match[1] ?? match[2]) : index + 1;
      if (!Number.isSafeInteger(episodeNumber) || episodeNumber < 1) throw new Error('Invalid episode number');
      const bucket = episodes.get(episodeNumber) ?? { episodeNumber, title: title || `第${episodeNumber}集`, lines: [], durationSeconds: 0 };
      const url = mediaUrl(value);
      if (!bucket.lines.includes(url)) bucket.lines.push(url);
      episodes.set(episodeNumber, bucket);
    }
  }
  const result = [...episodes.values()].sort((a, b) => a.episodeNumber - b.episodeNumber);
  for (const ep of result) ep.durationSeconds = durationSeconds(duration, ep.episodeNumber, result.length) ?? 0;
  return result;
}
function readInputs(directory) {
  const targets = publicTargets(), works = new Map();
  for (const name of fs.readdirSync(directory).sort()) {
    const match = /^t_(\d+)_p_(\d+)\.json$/.exec(name);
    if (!match) continue;
    const candidates = targets.filter((entry) => entry.typeId === Number(match[1]));
    if (candidates.length !== 1) throw new Error(`Non-public/ambiguous input type: ${name}`);
    const target = candidates[0], data = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
    if (!Array.isArray(data.list)) throw new Error(`Invalid harvest list: ${name}`);
    for (const item of data.list) {
      if (Number(item.type_id ?? match[1]) !== target.typeId) throw new Error(`Input type mismatch: ${name}`);
      if (!/^\d+$/.test(String(item.vod_id)) || (typeof item.vod_id === 'number' && !Number.isSafeInteger(item.vod_id))) throw new Error('Lossy source ID');
      const id = makeWorkId(target.channelId, target.provider, item.vod_id), title = cleanTitle(item.vod_name);
      if (!title) throw new Error(`Missing title: ${id}`);
      const work = { id, title, target, item, episodes: parseFullEpisodes(item.vod_play_url, item.vod_duration),
        stamp: toEpochSeconds(item.vod_time, null, 0) };
      if (!works.has(id) || work.stamp > works.get(id).stamp) works.set(id, work);
    }
  }
  return [...works.values()];
}
export function databaseCounts(db) {
  const scalar = (sql) => Number(db.prepare(sql).get().n);
  return { works: scalar('SELECT COUNT(*) n FROM content_items'), episodes: scalar('SELECT COUNT(*) n FROM content_episodes'),
    sources: scalar('SELECT COUNT(*) n FROM episode_sources'), ai: scalar('SELECT COUNT(*) n FROM content_items WHERE is_ai=1'),
    channels: db.prepare('SELECT channel_id, COUNT(*) count FROM content_items GROUP BY channel_id ORDER BY channel_id').all() };
}
function columns(db, table) { return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name)); }
/** Named-column UPSERT never REPLACE: existing unknown schema columns and IDs remain intact. */
function writeRow(db, table, key, values) {
  const existingColumns = columns(db, table);
  const pairs = Object.entries(values).filter(([name, value]) => existingColumns.has(name) && value !== undefined);
  if (db.prepare(`SELECT 1 FROM ${table} WHERE ${key}=?`).get(values[key])) {
    const changes = pairs.filter(([name]) => name !== key);
    db.prepare(`UPDATE ${table} SET ${changes.map(([name]) => `${name}=?`).join(',')} WHERE ${key}=?`).run(...changes.map(([, value]) => value), values[key]);
  } else {
    db.prepare(`INSERT INTO ${table} (${pairs.map(([name]) => name).join(',')}) VALUES (${pairs.map(() => '?').join(',')})`).run(...pairs.map(([, value]) => value));
  }
}
function markStatus(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS repair_work_status(content_id TEXT PRIMARY KEY,playable INTEGER NOT NULL,reason TEXT NOT NULL);
    DELETE FROM repair_work_status;
    INSERT INTO repair_work_status
    SELECT c.id,
      CASE WHEN COUNT(e.id)=0 OR MIN(e.episode_number)<>1 OR MAX(e.episode_number)<>COUNT(e.id)
        OR COUNT(DISTINCT e.episode_number)<>COUNT(e.id) OR SUM(CASE WHEN e.id IS NOT NULL AND NOT EXISTS
          (SELECT 1 FROM episode_sources s WHERE s.episode_id=e.id AND s.enabled=1) THEN 1 ELSE 0 END)>0 THEN 0 ELSE 1 END,
      CASE WHEN COUNT(e.id)=0 THEN 'zero-episodes'
        WHEN MIN(e.episode_number)<>1 OR MAX(e.episode_number)<>COUNT(e.id) OR COUNT(DISTINCT e.episode_number)<>COUNT(e.id) THEN 'episode-gap'
        WHEN SUM(CASE WHEN e.id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM episode_sources s WHERE s.episode_id=e.id AND s.enabled=1) THEN 1 ELSE 0 END)>0 THEN 'missing-lines'
        ELSE 'structurally-complete-unverified' END
    FROM content_items c LEFT JOIN content_episodes e ON e.content_id=c.id GROUP BY c.id;`);
  return db.prepare('SELECT reason, COUNT(*) count FROM repair_work_status GROUP BY reason').all();
}
export function mergeLibrary({ sourceDb = ORIGINAL, outDb = path.join(ROOT, 'build/library_repair.db'),
  harvestDir = path.join(ROOT, 'build/repair-harvest'), dryRun = false, nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  sourceDb = path.resolve(sourceDb); outDb = path.resolve(outDb); harvestDir = path.resolve(harvestDir);
  const same = (a, b) => a.toLowerCase() === b.toLowerCase();
  if (same(sourceDb, outDb) || same(outDb, ORIGINAL) || (fs.existsSync(outDb) && same(fs.realpathSync(sourceDb), fs.realpathSync(outDb)))) throw new Error('Cannot modify original database');
  if (!fs.existsSync(sourceDb) || !fs.existsSync(path.dirname(outDb))) throw new Error('Required input/parent directory missing');
  const works = readInputs(harvestDir);
  const prior = new DatabaseSync(fs.existsSync(outDb) ? outDb : sourceDb, { readOnly: true });
  let before;
  try { before = databaseCounts(prior); } finally { prior.close(); }
  if (dryRun) return { dryRun, before, inputWorks: works.length, outDb };
  // VACUUM INTO makes a consistent full-schema snapshot without writes to the source DB.
  if (!fs.existsSync(outDb)) {
    const source = new DatabaseSync(sourceDb, { readOnly: true });
    try { source.exec(`VACUUM INTO '${outDb.replace(/'/g, "''")}'`); } finally { source.close(); }
  }
  const db = new DatabaseSync(outDb);
  try {
    // Indexes are non-unique so even imperfect legacy rows remain untouched.
    db.exec(`CREATE INDEX IF NOT EXISTS repair_episode_lookup ON content_episodes(content_id,episode_number);
      CREATE INDEX IF NOT EXISTS repair_source_lookup ON episode_sources(episode_id,provider_id,upstream_media_url); BEGIN IMMEDIATE;`);
    let added = 0, updated = 0;
    for (const work of works) {
      const { id, item, target, episodes, title } = work;
      const existing = db.prepare('SELECT * FROM content_items WHERE id=?').get(id);
      if (existing && (existing.channel_id !== target.channelId || existing.is_private !== 0)) throw new Error(`Identity/privacy conflict: ${id}`);
      existing ? updated++ : added++;
      const published = toEpochSeconds(item.vod_time, item.vod_time_add, undefined);
      writeRow(db, 'content_items', 'id', { id, channel_id: target.channelId, title,
        cover_url: item.vod_pic || existing?.cover_url || '', cover_version: existing?.cover_version ?? 'v1',
        synopsis: shortSynopsis(item.vod_blurb || item.vod_content) ?? existing?.synopsis ?? '',
        category: deriveCategory(target.channelId, title, target.typeId, item.type_name), is_private: 0,
        shareable: existing?.shareable ?? 1, enabled: existing?.enabled ?? 1,
        first_published_at: existing?.first_published_at ?? published ?? 0,
        created_at: existing?.created_at ?? nowSeconds, updated_at: nowSeconds,
        is_ai: existing?.is_ai === 1 || isAiFlag(target.forceAi, title, item.vod_class) ? 1 : 0,
        is_hot: existing?.is_hot ?? 0, hot_score: existing?.hot_score ?? 0,
        hits_total: item.vod_hits === undefined ? undefined : Number(item.vod_hits),
        hits_week: item.vod_hits_week === undefined ? undefined : Number(item.vod_hits_week) });
      for (const ep of episodes) {
        const old = db.prepare('SELECT * FROM content_episodes WHERE content_id=? AND episode_number=?').all(id, ep.episodeNumber);
        if (old.length > 1) throw new Error(`Duplicate legacy episode: ${id}/${ep.episodeNumber}`);
        const values = { content_id: id, episode_number: ep.episodeNumber, title: ep.title,
          duration_seconds: ep.durationSeconds || old[0]?.duration_seconds || 0,
          created_at: old[0]?.created_at ?? nowSeconds, updated_at: nowSeconds };
        let episodeId;
        if (old.length) { episodeId = old[0].id; writeRow(db, 'content_episodes', 'id', { id: episodeId, ...values }); }
        else {
          const names = Object.keys(values);
          episodeId = Number(db.prepare(`INSERT INTO content_episodes (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`).run(...Object.values(values)).lastInsertRowid);
        }
        for (const url of ep.lines) {
          if (!db.prepare('SELECT 1 FROM episode_sources WHERE episode_id=? AND provider_id=? AND upstream_media_url=?').get(episodeId, target.provider.id, url)) {
            db.prepare('INSERT INTO episode_sources(episode_id,provider_id,upstream_media_url,enabled,created_at,updated_at) VALUES(?,?,?,1,?,?)').run(episodeId, target.provider.id, url, nowSeconds, nowSeconds);
          }
        }
      }
      // Preserve other work search rows and unknown schema fields; only refresh the touched work.
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='public_search_fts'").get()) {
        db.prepare('DELETE FROM public_search_fts WHERE content_id=?').run(id);
        db.prepare('INSERT INTO public_search_fts(content_id,title_tokens,alias_tokens,pinyin_tokens,tag_tokens) VALUES(?,?,\'\',\'\',?)').run(id, title, deriveCategory(target.channelId, title, target.typeId, item.type_name));
      }
    }
    const quarantine = markStatus(db), after = databaseCounts(db);
    db.exec('COMMIT');
    return { dryRun: false, sourceDb, outDb, before, after, added, updated, inputWorks: works.length, quarantine,
      note: 'playable=1 means structurally complete only; no claim of live media availability. Original episode identities and other channels preserved.' };
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { db.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const argv = process.argv.slice(2), options = { dryRun: argv.includes('--dry-run') };
    for (const arg of argv) {
      if (arg === '--dry-run') continue;
      const match = /^--(source-db|out-db|harvest)=(.+)$/.exec(arg);
      if (!match) throw new Error('Unsupported argument (no publish support)');
      options[{ 'source-db': 'sourceDb', 'out-db': 'outDb', harvest: 'harvestDir' }[match[1]]] = match[2];
    }
    console.log(JSON.stringify(mergeLibrary(options), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
