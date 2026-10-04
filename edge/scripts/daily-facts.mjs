import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { PUBLIC_CHANNEL_IDS, PAGE_SIZE, TAXONOMY_VERSION, providerById, buildCatalogChunk, chunkKey, assertPublicAssetClean } from './config-sources.mjs';
import { toCatalogItem, sortForSharding } from './compute-hotscore.mjs';
import { buildWorkFactPacks, serializeManifest } from './work-fact-packs.mjs';
import { buildPublicSearch } from './public-search-projection.mjs';
import { workFactDescriptors } from './publication-guard.mjs';

const channelsTopology = [
  ['drama', '短剧精选', ['战神', '逆袭', '都市', '古装', '甜宠', '悬疑']],
  ['movie', '院线电影', ['动作', '喜剧', '科幻', '悬疑', '爱情']],
  ['anime', '热血动漫', ['热血', '玄幻', '科幻', '治愈', '冒险']],
  ['documentary', '人文纪录', ['自然', '历史', '科技', '美食', '探索']]
].map(([id, name, categories], i) => ({ id, name, categories, order: i + 1, requiresTier: [] }));

function assertCompleteFact(fact, strictCandidate = false) {
  if (!fact || fact.id !== fact.workId || fact.isPrivate !== false || fact.enabled !== true ||
      !PUBLIC_CHANNEL_IDS.includes(fact.channelId) || !Array.isArray(fact.episodes) ||
      (strictCandidate && !fact.episodes.length) || fact.episodeCount !== fact.episodes.length) throw new Error('Invalid complete public fact');
  const sourceIds = new Set(), numbers = new Set();
  // Prior facts are a finite set, not an invented continuous season; empty facts/lines remain unplayable.
  for (const [index, ep] of fact.episodes.entries()) {
    if (!Number.isSafeInteger(ep.episodeNumber) || ep.episodeNumber < 1 || ep.episodeNumber > 999999 ||
        numbers.has(ep.episodeNumber) || !Array.isArray(ep.lines)) throw new Error('Invalid complete fact episodes');
    numbers.add(ep.episodeNumber);
    if (strictCandidate && (ep.episodeNumber !== index + 1 || !ep.lines.length)) throw new Error('Incomplete continuous playback episodes');
    if (ep.sourceEpisodeId !== undefined) {
      if (typeof ep.sourceEpisodeId !== 'string' || !/^[0-9]{1,32}$/.test(ep.sourceEpisodeId) || sourceIds.has(ep.sourceEpisodeId)) throw new Error('Invalid stable source episode identity');
      sourceIds.add(ep.sourceEpisodeId);
    }
    for (const line of ep.lines) {
      if (providerById(line.providerId)?.privacy !== 'public') throw new Error('Private or unknown playback provider');
    }
  }
  // Existing pack validator checks target URLs, covers and serialization bounds.
  buildWorkFactPacks(new Map([[fact.id, fact]]));
}

/** Explicit importer: blocked refreshes preserve old full facts and never create playable records. */
export function importPublicResults(state, results, nowSeconds) {
  if (state.isPrivate !== false || !state.works) throw new Error('Public state required');
  const candidates = results.filter((result) => result.status === 'candidate');
  for (const { fact } of candidates) {
    if (fact?.providerId !== 'provider_s1' || fact.id !== `drama_s_${fact.sourceItemId}` ||
        fact.episodes?.some((ep) => !ep.sourceEpisodeId || ep.lines?.some((line) => line.providerId !== 'provider_s1'))) throw new Error('Invalid s1 candidate');
    assertCompleteFact(fact, true);
  }
  let added = 0, updated = 0;
  const resolved = [];
  for (const { fact } of candidates) {
    const previous = state.works[fact.id];
    const record = { ...fact, firstPublishedAt: previous?.firstPublishedAt ?? nowSeconds,
      fact: structuredClone({ ...fact, generatedAt: 0 }) };
    if (previous) updated++; else added++;
    state.works[fact.id] = record;
    resolved.push({ record });
  }
  return { added, updated, resolved, blocked: results.filter((result) => result.status === 'blocked') };
}

/** Offline bootstrap from the complete prior manifest and content-addressed local R2 mirror. */
export function bootstrapDailyState(manifest, rootDir, { expectedRevision = manifest?.revision } = {}) {
  if (!Number.isSafeInteger(manifest?.revision) || manifest.revision < 1 || manifest.revision !== expectedRevision ||
      !manifest.workFacts || !manifest.channels) throw new Error('Invalid bootstrap generation');
  serializeManifest(manifest);
  const root = path.resolve(rootDir), works = {}, counts = {};
  for (const descriptor of workFactDescriptors(manifest.workFacts)) {
    const { prefix } = descriptor;
    const file = path.resolve(root, descriptor.key);
    if (!file.startsWith(root + path.sep)) throw new Error('Unsafe bootstrap path');
    const bytes = fs.readFileSync(file);
    if (bytes.length !== descriptor.bytes || createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) throw new Error('Bootstrap pack hash/bytes mismatch');
    const pack = JSON.parse(bytes.toString('utf8'));
    if (pack.schema !== 1 || !pack.works || Array.isArray(pack.works)) throw new Error('Invalid bootstrap pack');
    for (const [id, fact] of Object.entries(pack.works)) {
      if (id !== fact.id || works[id] || !createHash('sha256').update(id).digest('hex').startsWith(prefix)) throw new Error('Bootstrap pack identity mismatch');
      assertCompleteFact(fact);
      works[id] = { ...fact, fact };
      counts[fact.channelId] = (counts[fact.channelId] ?? 0) + 1;
    }
  }
  for (const [channel, inventory] of Object.entries(manifest.channels)) {
    if (!PUBLIC_CHANNEL_IDS.includes(channel) || !Number.isSafeInteger(inventory.total) || inventory.total < 0 ||
        inventory.total !== (counts[channel] ?? 0)) throw new Error('Incomplete bootstrap generation inventory');
  }
  if (Object.keys(counts).some((channel) => !manifest.channels[channel])) throw new Error('Missing generation channel');
  return { schema: 1, revision: manifest.revision, taxonomyVersion: manifest.taxonomyVersion ?? TAXONOMY_VERSION,
    updatedAt: manifest.generatedAt ?? 0, isPrivate: false, works };
}

/** Complete prior facts are mandatory: touched-only state cannot become the next public library. */
export function emitDailyFacts(state, resolved, { revision, outDir, nowSeconds }) {
  if (!Number.isSafeInteger(revision) || revision <= state.revision) throw new Error('Daily revision must advance');
  const facts = new Map(), items = [], files = [], channels = {};
  for (const record of Object.values(state.works)) {
    if (record.isPrivate !== false || !PUBLIC_CHANNEL_IDS.includes(record.channelId)) throw new Error('Private data in public state');
    if (record.enabled === false) continue;
    if (!record.fact || record.fact.workId !== record.id || !Array.isArray(record.fact.episodes) ||
        record.fact.episodes.length !== record.episodeCount) throw new Error('State requires complete fact for every public work');
    const item = { ...toCatalogItem(record), enabled: true, shareable: record.fact.shareable };
    for (const key of ['episodes', 'coverTargetUrl', 'workId', 'generatedAt']) delete item[key];
    const fact = { ...record.fact, ...item, generatedAt: 0 };
    assertPublicAssetClean(item, record.id);
    if (new Set(fact.episodes.map((ep) => ep.episodeNumber)).size !== fact.episodes.length ||
        fact.episodes.some((ep) => !Number.isSafeInteger(ep.episodeNumber) || ep.episodeNumber < 1 || !Array.isArray(ep.lines))) throw new Error('Invalid complete fact episodes');
    assertCompleteFact(fact);
    facts.set(record.id, fact); items.push(item);
  }
  const packed = buildWorkFactPacks(facts), search = buildPublicSearch(facts, revision);
  // All validation, including manifest size, happens before writes/pointer publication.
  const write = (key, value) => {
    const file = path.join(outDir, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value); files.push({ key, file });
  };
  for (const object of [...packed.objects, search.object]) write(object.key, object.value);
  for (const channelId of PUBLIC_CHANNEL_IDS) {
    const list = items.filter((item) => item.channelId === channelId).sort(sortForSharding);
    channels[channelId] = { chunks: Math.ceil(list.length / PAGE_SIZE), total: list.length };
    for (let i = 0; i < channels[channelId].chunks; i++) write(chunkKey(revision, channelId, i),
      JSON.stringify(buildCatalogChunk(list.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE), i, list.length, revision)));
  }
  const bundle = JSON.stringify({ version: 1, revision, generatedAt: nowSeconds, channels: channelsTopology, items });
  assertPublicAssetClean(bundle, 'daily bundle');
  write('assets/catalog-bundle.json', bundle);
  write('assets/catalog-bundle.json.gz', zlib.gzipSync(bundle));
  return { files, channels, touched: resolved.map(({ record }) => record.id),
    workFacts: packed.workFacts, coverOrigins: packed.coverOrigins, publicSearch: search.publicSearch };
}
