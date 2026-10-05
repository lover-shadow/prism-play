import { createHash } from 'node:crypto';
import { PUBLIC_CHANNEL_IDS, PROVIDERS } from './config-sources.mjs';
import { assertMetadataBounds } from '../src/library/metadata-policy.mjs';
import { containsPlatformName } from '../src/library/platform-lexicon.mjs';
const PRIVATE_PROVIDERS = new Set(PROVIDERS.filter((p) => p.privacy === 'private-all').map((p) => p.id));

export const MAX_PACK_BYTES = 524288;
export const MAX_MANIFEST_BYTES = 65536;
const hash = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const encode = (entries) => JSON.stringify({ schema: 1, works: Object.fromEntries(entries) });

function targetUrl(value, httpsOnly = false) {
  if (typeof value !== 'string' || value !== value.trim() || /[\s\\\u0000-\u001f]/u.test(value)) {
    throw new Error('Invalid target URL');
  }
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid target URL'); }
  if (!(httpsOnly ? url.protocol === 'https:' : ['http:', 'https:'].includes(url.protocol)) ||
      !/^https?:\/\//i.test(value) || !url.hostname || url.username || url.password ||
      /^\/proxy(?:\/|$)/i.test(decodeURIComponent(url.pathname))) throw new Error('Invalid target URL');
  return url;
}

/** One ordered read joins all eligible episodes and enabled lines; never a per-work scan. */
export function buildWorkFacts(db, catalog, metadata) {
  const items = new Map();
  for (const item of Object.values(catalog.channels).flat()) {
    if (!PUBLIC_CHANNEL_IDS.includes(item.channelId) || item.isPrivate !== false ||
        item.enabled !== true || items.has(item.id)) throw new Error('Invalid public catalog item');
    items.set(item.id, item);
  }
  const facts = new Map();
  let currentId;
  let currentEpisode;
  let episodeId;
  const rows = db.prepare(`
    SELECT c.id AS work_id, c.channel_id, c.is_private, c.enabled, c.shareable, c.cover_url,
      e.id AS episode_id, e.episode_number, e.title AS episode_title, e.duration_seconds,
      s.provider_id, s.upstream_media_url
    FROM content_items c
    LEFT JOIN content_episodes e ON e.content_id = c.id
    LEFT JOIN episode_sources s ON s.episode_id = e.id AND s.enabled = 1
    WHERE c.enabled = 1 AND c.is_private = 0
    ORDER BY c.id, e.episode_number, e.id, s.provider_id, s.upstream_media_url, s.id
  `).iterate();
  for (const row of rows) {
    const item = items.get(row.work_id);
    if (!item) continue;
    if (row.is_private !== 0 || row.enabled !== 1 || row.channel_id !== item.channelId) {
      throw new Error(`Invalid public work: ${row.work_id}`);
    }
    if (row.work_id !== currentId) {
      currentId = row.work_id;
      currentEpisode = undefined;
      episodeId = undefined;
      const rawCover = metadata.get(currentId)?.item?.vod_pic;
      const isEmpty = (value) => value === undefined || value === null || value === '';
      // A stored same-work proxy handle is not recoverable without a raw target.
      // Only genuinely empty raw values may fall back; malformed values must fail.
      const dbProxy = row.cover_url === `/proxy/img/${currentId}` ||
        row.cover_url === `/proxy/cover/${currentId}`;
      const coverTargetUrl = !isEmpty(rawCover) ? rawCover :
        (isEmpty(row.cover_url) || dbProxy ? undefined : row.cover_url);
      if (coverTargetUrl !== undefined) {
        try { targetUrl(coverTargetUrl, true); }
        catch { throw new Error(`Invalid target URL for cover: ${currentId}`); }
      } else {
        // Keep the same catalog entry, but do not advertise a nonexistent poster.
        delete item.coverUrl;
      }
      const fact = { ...item, workId: currentId, title: item.title, channelId: item.channelId,
        isPrivate: false, enabled: true, shareable: row.shareable === 1,
        episodes: [], generatedAt: 0 };
      if (coverTargetUrl !== undefined) fact.coverTargetUrl = coverTargetUrl;
      facts.set(currentId, fact);
    }
    const fact = facts.get(currentId);
    if (row.episode_id === null) continue;
    if (!Number.isSafeInteger(row.episode_number) || row.episode_number < 1) {
      throw new Error(`Invalid episode number: ${currentId}`);
    }
    if (row.episode_id !== episodeId) {
      if (currentEpisode?.episodeNumber === row.episode_number) {
        throw new Error(`Duplicate episode number: ${currentId}/${row.episode_number}`);
      }
      episodeId = row.episode_id;
      currentEpisode = { episodeNumber: row.episode_number, lines: [] };
      if (row.episode_title) currentEpisode.title = row.episode_title;
      if (row.duration_seconds !== null) {
        if (!Number.isSafeInteger(row.duration_seconds) || row.duration_seconds < 0) {
          throw new Error(`Invalid duration: ${currentId}`);
        }
        currentEpisode.durationSeconds = row.duration_seconds;
      }
      fact.episodes.push(currentEpisode);
    }
    if (row.provider_id === null && row.upstream_media_url === null) continue;
    if (!/^provider_[a-z0-9_]+$/.test(row.provider_id ?? '')) throw new Error(`Invalid provider: ${currentId}`);
    targetUrl(row.upstream_media_url);
    const line = { providerId: row.provider_id, mediaUrl: row.upstream_media_url };
    if (currentEpisode.lines.some((entry) => entry.providerId === line.providerId && entry.mediaUrl === line.mediaUrl)) {
      throw new Error(`Duplicate playback line: ${currentId}`);
    }
    currentEpisode.lines.push(line);
  }
  if (facts.size !== items.size) throw new Error('Catalog work missing from public database');
  return facts;
}

/** UTF-8 limits include the final schema wrapper; split on successive ID hash nibbles. */
export function buildWorkFactPacks(facts) {
  const buckets = new Map();
  const coverOrigins = new Set();
  for (const [id, fact] of [...facts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (id !== fact.workId || fact.isPrivate !== false || fact.enabled !== true ||
        !PUBLIC_CHANNEL_IDS.includes(fact.channelId)) throw new Error(`Invalid public fact: ${id}`);
    // HP-11/HP-12：越界元数据在这里就拒，不给它进 R2 之后由 Worker 原样吐出去的机会。
    assertMetadataBounds(fact, `public fact ${id}`, containsPlatformName);
    for (const episode of fact.episodes) for (const line of episode.lines) {
      if (PRIVATE_PROVIDERS.has(line.providerId) || !/^provider_[a-z0-9_]+$/.test(line.providerId)) throw new Error('Private or invalid provider in public fact');
      targetUrl(line.mediaUrl);
    }
    if (Object.hasOwn(fact, 'coverTargetUrl')) {
      coverOrigins.add(targetUrl(fact.coverTargetUrl, true).origin);
    }
    if (Buffer.byteLength(encode([[id, fact]]), 'utf8') > MAX_PACK_BYTES) {
      throw new Error(`Oversized single work: ${id}`);
    }
    const digest = hash(id);
    const prefix = digest.slice(0, 2);
    if (!buckets.has(prefix)) buckets.set(prefix, []);
    buckets.get(prefix).push({ id, fact, digest });
  }
  const packs = {};
  const objects = [];
  function emit(prefix, entries) {
    const value = encode(entries.map(({ id, fact }) => [id, fact]));
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > MAX_PACK_BYTES) {
      if (prefix.length === 64) throw new Error('Unsplitable ID hash collision');
      const children = new Map();
      for (const entry of entries) {
        const child = entry.digest.slice(0, prefix.length + 1);
        if (!children.has(child)) children.set(child, []);
        children.get(child).push(entry);
      }
      for (const [child, members] of [...children].sort()) emit(child, members);
      return;
    }
    const sha256 = hash(value);
    const key = `library/facts/${sha256}.json`;
    packs[prefix] = { key, bytes, sha256 };
    objects.push({ key, value });
  }
  for (const [prefix, entries] of [...buckets].sort()) emit(prefix, entries);
  // Small inventories retain the legacy format. Compact tuples avoid storing each digest twice.
  const compact = Buffer.byteLength(JSON.stringify(packs), 'utf8') > 32768;
  const directory = compact ? Object.fromEntries(Object.entries(packs).map(([prefix, pack]) =>
    [prefix, [pack.bytes, pack.sha256]])) : packs;
  return { workFacts: { schema: compact ? 2 : 1, maxBytes: MAX_PACK_BYTES, packs: directory },
    coverOrigins: [...coverOrigins].sort(), objects,
    report: { works: facts.size, packs: objects.length,
      bytes: objects.reduce((sum, object) => sum + Buffer.byteLength(object.value, 'utf8'), 0),
      maxPackBytes: Math.max(0, ...Object.values(packs).map((pack) => pack.bytes)) } };
}

export function serializeManifest(manifest) {
  const value = JSON.stringify(manifest);
  if (Buffer.byteLength(value, 'utf8') > MAX_MANIFEST_BYTES) throw new Error('Manifest exceeds 64 KiB');
  return value;
}
