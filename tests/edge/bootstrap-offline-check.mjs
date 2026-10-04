import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { bootstrapDailyState, emitDailyFacts } from '../../edge/scripts/daily-facts.mjs';
import { buildPublicationEntries, validatePublication, workFactDescriptors } from '../../edge/scripts/publication-guard.mjs';
import { buildManifest } from '../../edge/scripts/config-sources.mjs';
import { serializeManifest } from '../../edge/scripts/work-fact-packs.mjs';

// Explicit local-only integration runner: no cache import, state overwrite, auth or cloud writes.
const [manifestFile, mirrorRoot, outDir] = process.argv.slice(2);
if (!manifestFile || !mirrorRoot || !outDir) throw new Error('Usage: node bootstrap-offline-check.mjs MANIFEST MIRROR_ROOT NEW_OUTPUT');
const out = path.resolve(outDir);
if (fs.existsSync(out)) throw new Error('Refusing to overwrite existing output');
globalThis.fetch = () => { throw new Error('Offline check forbids network'); };
const prior = JSON.parse(fs.readFileSync(path.resolve(manifestFile)));
const state = bootstrapDailyState(prior, path.resolve(mirrorRoot));
// Decode both directory formats against the same stable blobs; never read a packer's in-flight output.
const descriptors = workFactDescriptors(prior.workFacts);
for (const schema of [1, 2]) {
  const alternate = { ...prior, workFacts: { ...prior.workFacts, schema,
    packs: Object.fromEntries(descriptors.map(({ prefix, key, bytes, sha256 }) =>
      [prefix, schema === 1 ? { key, bytes, sha256 } : [bytes, sha256]])) } };
  assert.deepEqual(bootstrapDailyState(alternate, path.resolve(mirrorRoot)), state);
}
const oldFacts = Object.values(state.works);
const revision = prior.revision + 1, nowSeconds = Math.floor(Date.now() / 1000);
const emitted = emitDailyFacts(state, [], { revision, outDir: out, nowSeconds });
const manifest = { ...buildManifest(revision, emitted.channels, nowSeconds), workFacts: emitted.workFacts,
  coverOrigins: emitted.coverOrigins, publicSearch: emitted.publicSearch };
const kvEntries = buildPublicationEntries(manifest, {}, false);
validatePublication(emitted.files, kvEntries, false);
const recovered = new Map(emitted.files.filter((file) => file.key.startsWith('library/facts/'))
  .flatMap((file) => Object.entries(JSON.parse(fs.readFileSync(file.file)).works)));
assert.equal(recovered.size, oldFacts.length);
for (const fact of oldFacts) assert.deepEqual(recovered.get(fact.id)?.episodes, fact.fact.episodes);
const mediaUrls = new Set(oldFacts.flatMap((fact) => fact.fact.episodes.flatMap((ep) => ep.lines.map((line) => line.mediaUrl))));
const catalogFiles = emitted.files.filter((file) => file.key.includes('/chunk-') ||
  file.key === 'assets/catalog-bundle.json' || file.key.startsWith('library/search/'));
const inspect = (value) => {
  if (typeof value === 'string') assert.ok(!mediaUrls.has(value), 'Media URL leaked into catalog');
  else if (Array.isArray(value)) value.forEach(inspect);
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) {
    assert.ok(!/^(mediaurl|covertargeturl|episodes|lines)$/i.test(key), `Playback field leaked: ${key}`);
    inspect(entry);
  }
};
for (const file of catalogFiles) inspect(JSON.parse(fs.readFileSync(file.file)));
fs.writeFileSync(path.join(out, 'catalog-manifest.json'), serializeManifest(manifest));
fs.writeFileSync(path.join(out, 'publication-kv.json'), JSON.stringify(kvEntries));
console.log(JSON.stringify({ output: out, oldRevision: prior.revision, revision, works: recovered.size,
  channels: emitted.channels, zeroEpisodes: oldFacts.filter((f) => !f.fact.episodes.length).length,
  gaps: oldFacts.filter((f) => f.fact.episodes.some((ep, i) => ep.episodeNumber !== i + 1)).length,
  emptyLines: oldFacts.reduce((n, f) => n + f.fact.episodes.filter((ep) => !ep.lines.length).length, 0),
  objects: emitted.files.length, checkedCatalogFiles: catalogFiles.length,
  manifestBytes: Buffer.byteLength(serializeManifest(manifest)), kvOrder: kvEntries.map((entry) => entry.key),
  inputSchema: prior.workFacts.schema, outputSchema: emitted.workFacts.schema, checkedImportSchemas: [1, 2],
  preservedEpisodeSets: true, networkCalls: 0 }, null, 2));
