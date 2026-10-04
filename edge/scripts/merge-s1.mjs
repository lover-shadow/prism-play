import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parsePublicPlayer } from './public-provider.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const numeric = (v) => typeof v === 'string' && /^\d{1,32}$/.test(v);
export function validateCandidates(input) {
  if (!Array.isArray(input?.candidates)) throw new Error('Invalid candidate envelope');
  const ids = new Set();
  for (const f of input.candidates) {
    if (!numeric(f.sourceItemId) || f.id !== `drama_s_${f.sourceItemId}` || f.workId !== f.id || ids.has(f.id) ||
        f.providerId !== 'provider_s1' || f.channelId !== 'drama' || f.isPrivate !== false || f.enabled !== true || f.shareable !== true ||
        typeof f.title !== 'string' || !f.title.trim() || !Array.isArray(f.episodes) || !f.episodes.length || f.episodes.length > 1000 || f.episodeCount !== f.episodes.length ||
        !['ai-drama', 'comic-drama', 'real-drama'].includes(f.classificationEvidence?.category) ||
        f.classificationEvidence?.basis !== 'authorized-category-screenshot') throw new Error('Invalid complete public candidate');
    ids.add(f.id);
    if (f.coverTargetUrl) {
      const u = new URL(f.coverTargetUrl);
      if (u.protocol !== 'https:' || u.username || u.password) throw new Error('Unsafe cover');
    }
    const episodes = new Set();
    for (const [i, ep] of f.episodes.entries()) {
      if (ep.episodeNumber !== i + 1 || !numeric(ep.sourceEpisodeId) || episodes.has(ep.sourceEpisodeId) ||
          !Array.isArray(ep.lines) || !ep.lines.length || (ep.durationSeconds !== undefined && (!Number.isSafeInteger(ep.durationSeconds) || ep.durationSeconds < 0))) throw new Error('Incomplete episode identity');
      episodes.add(ep.sourceEpisodeId);
      for (const line of ep.lines) {
        if (line.providerId !== 'provider_s1') throw new Error('Invalid line provider');
        const page = { series_id: f.sourceItemId, vid: ep.sourceEpisodeId, video_player_info: { main_url: line.mediaUrl } };
        parsePublicPlayer(`window._ROUTER_DATA=${JSON.stringify({ loaderData: { player_page: page } })}`, f.sourceItemId, ep.sourceEpisodeId);
      }
    }
  }
  return input.candidates;
}
function upsert(db, table, values) {
  const names = Object.keys(values);
  db.prepare(`INSERT INTO ${table}(${names.join(',')}) VALUES(${names.map(() => '?')}) ON CONFLICT(id) DO UPDATE SET ${names.filter((n) => n !== 'id').map((n) => `${n}=excluded.${n}`).join(',')}`).run(...Object.values(values));
}
/** Caller owns connection. One transaction for all candidates; no title-based merging. */
export function mergeS1(db, input, now = Math.floor(Date.now() / 1000)) {
  const works = validateCandidates(input);
  let added = 0, updated = 0, episodes = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS s1_episode_identity(content_id TEXT NOT NULL,episode_number INTEGER NOT NULL,source_episode_id TEXT NOT NULL,PRIMARY KEY(content_id,episode_number),UNIQUE(content_id,source_episode_id));
      CREATE TABLE IF NOT EXISTS s1_work_evidence(content_id TEXT PRIMARY KEY,source_item_id TEXT NOT NULL,classification_json TEXT NOT NULL);`);
    for (const f of works) {
      const old = db.prepare('SELECT * FROM content_items WHERE id=?').get(f.id);
      if (old && (old.is_private !== 0 || old.channel_id !== 'drama')) throw new Error('Work identity/privacy conflict');
      old ? updated++ : added++;
      upsert(db, 'content_items', { id: f.id, channel_id: 'drama', title: f.title, cover_url: f.coverTargetUrl ?? old?.cover_url ?? '', cover_version: old?.cover_version ?? 'v1',
        synopsis: f.synopsis ?? old?.synopsis ?? '', category: f.category ?? '都市', is_private: 0, shareable: 1, enabled: 1,
        first_published_at: old?.first_published_at ?? 0, created_at: old?.created_at ?? now, updated_at: now,
        is_ai: f.classificationEvidence.category === 'ai-drama' ? 1 : 0, is_hot: old?.is_hot ?? 0, hot_score: old?.hot_score ?? 0 });
      db.prepare('INSERT INTO s1_work_evidence VALUES(?,?,?) ON CONFLICT(content_id) DO UPDATE SET source_item_id=excluded.source_item_id,classification_json=excluded.classification_json').run(f.id, f.sourceItemId, JSON.stringify(f.classificationEvidence));
      if (db.prepare('SELECT count(*) n FROM content_episodes WHERE content_id=?').get(f.id).n > f.episodeCount) throw new Error('Existing extra episodes');
      for (const ep of f.episodes) {
        const rows = db.prepare('SELECT * FROM content_episodes WHERE content_id=? AND episode_number=?').all(f.id, ep.episodeNumber);
        if (rows.length > 1) throw new Error('Duplicate existing episode');
        const identity = db.prepare('SELECT source_episode_id FROM s1_episode_identity WHERE content_id=? AND episode_number=?').get(f.id, ep.episodeNumber);
        if (identity && identity.source_episode_id !== ep.sourceEpisodeId) throw new Error('Episode identity conflict');
        const values = { content_id: f.id, episode_number: ep.episodeNumber, title: ep.title ?? `第${ep.episodeNumber}集`, duration_seconds: ep.durationSeconds ?? 0, created_at: rows[0]?.created_at ?? now, updated_at: now };
        let episodeId = rows[0]?.id;
        if (episodeId !== undefined) upsert(db, 'content_episodes', { id: episodeId, ...values });
        else episodeId = db.prepare(`INSERT INTO content_episodes(${Object.keys(values)}) VALUES(${Object.keys(values).map(() => '?')})`).run(...Object.values(values)).lastInsertRowid;
        db.prepare('INSERT INTO s1_episode_identity VALUES(?,?,?) ON CONFLICT(content_id,episode_number) DO NOTHING').run(f.id, ep.episodeNumber, ep.sourceEpisodeId);
        for (const line of ep.lines) {
          const source = db.prepare('SELECT id FROM episode_sources WHERE episode_id=? AND provider_id=? AND upstream_media_url=?').get(episodeId, 'provider_s1', line.mediaUrl);
          if (source) db.prepare('UPDATE episode_sources SET enabled=1,updated_at=? WHERE id=?').run(now, source.id);
          else db.prepare('INSERT INTO episode_sources(episode_id,provider_id,upstream_media_url,enabled,created_at,updated_at) VALUES(?,?,?,1,?,?)').run(episodeId, 'provider_s1', line.mediaUrl, now, now);
        }
        episodes++;
      }
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='public_search_fts'").get()) {
        db.prepare('DELETE FROM public_search_fts WHERE content_id=?').run(f.id);
        db.prepare("INSERT INTO public_search_fts(content_id,title_tokens,alias_tokens,pinyin_tokens,tag_tokens) VALUES(?,?, '', '', ?)").run(f.id, f.title, f.category ?? '都市');
      }
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='repair_work_status'").get()) {
        db.prepare("INSERT INTO repair_work_status VALUES(?,1,'structurally-complete-unverified') ON CONFLICT(content_id) DO UPDATE SET playable=1,reason=excluded.reason").run(f.id);
      }
    }
    db.exec('COMMIT');
    return { added, updated, episodes, providerId: 'provider_s1', note: 'Complete public player parse only; no live media availability promise.' };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let db;
  try {
    const argv = process.argv.slice(2);
    if (argv.some((a) => !/^(--dry-run|--db=.+|--candidates=.+)$/.test(a))) throw new Error('Unsupported argument');
    const read = (key, fallback) => argv.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
    const dbPath = path.resolve(read('db', path.join(ROOT, 'build/library_repair.db')));
    if (dbPath.toLowerCase() !== path.join(ROOT, 'build/library_repair.db').toLowerCase()) throw new Error('Only authorized repair database is allowed');
    const input = JSON.parse(fs.readFileSync(path.resolve(read('candidates', path.join(ROOT, 'build/repair-harvest/s1-candidates.json'))), 'utf8'));
    const works = validateCandidates(input);
    if (argv.includes('--dry-run')) console.log(JSON.stringify({ dryRun: true, works: works.length, episodes: works.reduce((n, f) => n + f.episodeCount, 0), dbPath }));
    else {
      if (!fs.existsSync(dbPath) || fs.lstatSync(dbPath).isSymbolicLink() || fs.statSync(dbPath).nlink > 1) throw new Error('Unsafe/missing database');
      db = new DatabaseSync(dbPath);
      console.log(JSON.stringify(mergeS1(db, input)));
    }
  } catch { console.error('S1 merge rejected or rolled back; no media details logged'); process.exitCode = 1; }
  finally { db?.close(); }
}
