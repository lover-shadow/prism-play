import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { PROVIDERS, PUBLIC_CHANNEL_IDS, KV_KEYS, sourceConfigPayload, assertPublicAssetClean } from './config-sources.mjs';
import { MAX_PACK_BYTES, serializeManifest } from './work-fact-packs.mjs';

/** Shared local-only decoder: directory schema changes, fact blob schema does not. */
export function workFactDescriptors(workFacts) {
  if (![1, 2].includes(workFacts?.schema)) throw new Error('Invalid work facts schema');
  if (!workFacts.packs || typeof workFacts.packs !== 'object' || Array.isArray(workFacts.packs)) {
    throw new Error('Invalid pack descriptor directory');
  }
  return Object.entries(workFacts.packs).map(([prefix, value]) => {
    const compact = workFacts.schema === 2;
    if (!/^[a-f0-9]{2,64}$/.test(prefix) || (compact ? !Array.isArray(value) || value.length !== 2 :
      !value || typeof value !== 'object' || Array.isArray(value))) throw new Error('Invalid pack descriptor');
    const bytes = compact ? value[0] : value.bytes, sha256 = compact ? value[1] : value.sha256;
    if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_PACK_BYTES ||
        typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid pack descriptor');
    const key = `library/facts/${sha256}.json`;
    if (!compact && value.key !== key) throw new Error('Invalid pack descriptor key');
    return { prefix, key, bytes, sha256 };
  });
}

/** Blob uploads are awaited by publishFiles before this ordered KV list is applied. */
export function buildPublicationEntries(manifest, privateStats, isPrivate) {
  return [{ key: KV_KEYS.sources, value: JSON.stringify(sourceConfigPayload()) },
    { key: isPrivate ? KV_KEYS.privateManifest : KV_KEYS.manifest, value: JSON.stringify(isPrivate ? privateStats : manifest) }];
}

/** Local preflight, before auth discovery/upload. Private prefix is not an access boundary. */
export function validatePublication(files, kvEntries, isPrivate) {
  if (isPrivate) throw new Error('Private publication requires independently verified resource isolation');
  const pointer = kvEntries.find((entry) => entry.key === 'catalog:manifest');
  if (!pointer || kvEntries.at(-1) !== pointer) throw new Error('Public manifest pointer must be last');
  const manifest = JSON.parse(pointer.value);
  if (Buffer.byteLength(pointer.value, 'utf8') > 65536) throw new Error('Manifest exceeds 64 KiB');
  serializeManifest(manifest);
  if (!manifest.workFacts || !manifest.publicSearch) throw new Error('Public publication requires complete facts/search');
  const byKey = new Map(files.map((file) => [file.key, file.file]));
  if (byKey.size !== files.length || files.some((file) => file.key.startsWith('private/'))) throw new Error('Invalid public file set');
  const privateProviders = new Set(PROVIDERS.filter((p) => p.privacy === 'private-all').map((p) => p.id));
  const ids = new Map();
  for (const descriptor of [...workFactDescriptors(manifest.workFacts), manifest.publicSearch]) {
    const file = byKey.get(descriptor.key);
    if (!file) throw new Error(`Missing declared blob: ${descriptor.key}`);
    const bytes = fs.readFileSync(file);
    if (bytes.length !== descriptor.bytes || createHash('sha256').update(bytes).digest('hex') !== descriptor.sha256) throw new Error('Declared blob bytes/hash mismatch');
    const raw = JSON.parse(bytes);
    if (raw.schema !== 1) throw new Error('Invalid blob schema');
    if (descriptor === manifest.publicSearch) {
      assertPublicAssetClean(raw, 'search');
      if (raw.revision !== manifest.revision || raw.entries.length !== descriptor.count) throw new Error('Search generation mismatch');
    } else for (const [id, fact] of Object.entries(raw.works ?? {})) {
      if (fact.id !== id || fact.workId !== id || fact.isPrivate !== false || fact.enabled !== true ||
          !PUBLIC_CHANNEL_IDS.includes(fact.channelId) || ids.has(id) || fact.episodes.length !== fact.episodeCount) throw new Error('Invalid public fact isolation');
      for (const episode of fact.episodes) for (const line of episode.lines) {
        if (privateProviders.has(line.providerId)) throw new Error('Private source in public facts');
      }
      ids.set(id, fact);
    }
  }
  const search = JSON.parse(fs.readFileSync(byKey.get(manifest.publicSearch.key)));
  if (search.entries.length !== ids.size) throw new Error('Incomplete search inventory');
  for (const { item } of search.entries) {
    const fact = ids.get(item.id);
    if (!fact || item.title !== fact.title || item.channelId !== fact.channelId || item.episodeCount !== fact.episodeCount) throw new Error('Search/facts mismatch');
  }
  for (const [channel, inventory] of Object.entries(manifest.channels)) {
    const total = [...ids.values()].filter((fact) => fact.channelId === channel).length;
    if (inventory.total !== total || inventory.chunks !== Math.ceil(total / 60)) throw new Error('Channel inventory mismatch');
    for (let i = 0; i < inventory.chunks; i++) {
      const key = `library/v${manifest.revision}/${channel}/chunk-${i}.json`, file = byKey.get(key);
      if (!file) throw new Error('Missing catalog shard');
      const raw = JSON.parse(fs.readFileSync(file));
      assertPublicAssetClean(raw, key);
      if (raw.revision !== manifest.revision || raw.total !== total) throw new Error('Shard generation mismatch');
    }
  }
  const bundleFile = byKey.get('assets/catalog-bundle.json');
  if (!bundleFile) throw new Error('Missing full bundle');
  const bundle = JSON.parse(fs.readFileSync(bundleFile));
  assertPublicAssetClean(bundle, 'bundle');
  if (bundle.revision !== manifest.revision || bundle.items.length !== ids.size) throw new Error('Bundle generation mismatch');
  return true;
}
