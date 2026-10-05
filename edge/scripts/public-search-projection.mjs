import { createHash } from 'node:crypto';
import { pinyin } from 'pinyin-pro';
import { PUBLIC_CHANNEL_IDS, assertPublicAssetClean } from './config-sources.mjs';
import { PUBLIC_METADATA_FIELDS, assertMetadataBounds } from '../src/library/metadata-policy.mjs';
import { containsPlatformName } from '../src/library/platform-lexicon.mjs';

export const MAX_SEARCH_BYTES = 16777216;
/**
 * 投影字段 = 目录 ContentItem 的公开面。HP-11/HP-12 的可选元数据由 `PUBLIC_METADATA_FIELDS`
 * 单点提供，这里不再手抄字段名——目录给了就投，目录没给就整个缺键，旧 generation 因此仍可解析。
 * 注意 `entry.tags`（检索词表，含 category 与别名）与 `item.tags`（展示副标签）是两回事：
 * 前者服务命中，后者才是观众看到的题材，二者互不冒充。
 */
const FIELDS = ['id', 'title', 'channelId', 'category', 'isPrivate', 'enabled', 'shareable',
  'coverUrl', 'coverVersion', 'episodeCount', 'isAi', 'isHot', 'firstPublishedAt', 'hitsTotal',
  ...PUBLIC_METADATA_FIELDS];
const unique = (values) => [...new Set(values.filter((v) => typeof v === 'string' && v.trim()))].sort();

/** One projection built from the very same facts, bounded independently of episode payloads. */
export function buildPublicSearch(facts, revision, vocabulary = new Map()) {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('Invalid search revision');
  const entries = [...facts].sort(([a], [b]) => a.localeCompare(b)).map(([id, fact]) => {
    if (id !== fact.workId || fact.id !== id || fact.enabled !== true || fact.isPrivate !== false ||
        !PUBLIC_CHANNEL_IDS.includes(fact.channelId) || !Array.isArray(fact.episodes) ||
        fact.episodeCount !== fact.episodes.length) throw new Error('Invalid public search fact');
    const item = Object.fromEntries(FIELDS.filter((key) => fact[key] !== undefined).map((key) => [key, fact[key]]));
    assertMetadataBounds(item, `public search item ${id}`, containsPlatformName);
    const terms = vocabulary.get(id) ?? {};
    const names = [item.title, ...(terms.aliases ?? [])];
    const pronunciation = names.flatMap((name) => [
      pinyin(name, { toneType: 'none', type: 'array' }).join(''),
      pinyin(name, { pattern: 'first', toneType: 'none', type: 'array' }).join('')
    ]);
    return { item, aliases: unique(terms.aliases ?? []),
      pinyin: unique([...(terms.pinyin ?? []), ...pronunciation]), tags: unique([item.category, ...(terms.tags ?? [])]) };
  });
  for (const entry of entries) for (const values of [entry.aliases, entry.pinyin, entry.tags]) {
    if (values.length > 64 || values.some((s) => [...s].length > 160)) throw new Error('Search vocabulary exceeds bound');
  }
  const payload = { schema: 1, revision, entries };
  assertPublicAssetClean(payload, 'public search projection');
  const value = JSON.stringify(payload), bytes = Buffer.byteLength(value);
  if (bytes > MAX_SEARCH_BYTES) throw new Error('Public search projection exceeds 16 MiB');
  const sha256 = createHash('sha256').update(value).digest('hex'), key = `library/search/${sha256}.json`;
  return { publicSearch: { schema: 1, count: entries.length, key, bytes, sha256 }, object: { key, value } };
}

/** Optional legacy term tables are packaging inputs only, never runtime D1 facts. */
export function readSearchVocabulary(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  const result = new Map();
  const get = (id) => { if (!result.has(id)) result.set(id, { aliases: [], pinyin: [], tags: [] }); return result.get(id); };
  if (tables.has('content_aliases')) for (const row of db.prepare('SELECT content_id, alias, pinyin, pinyin_initials FROM content_aliases ORDER BY content_id, alias').iterate()) {
    get(row.content_id).aliases.push(row.alias);
    get(row.content_id).pinyin.push(row.pinyin, row.pinyin_initials);
  }
  if (tables.has('content_tags')) for (const row of db.prepare('SELECT content_id, tag FROM content_tags ORDER BY content_id, tag').iterate()) get(row.content_id).tags.push(row.tag);
  return result;
}
