import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeRawsIntoState, emitAssets, emptyState } from '../../edge/scripts/sync-incremental.mjs';
import { bootstrapDailyState, importPublicResults, emitDailyFacts } from '../../edge/scripts/daily-facts.mjs';
import { buildPublicationEntries, validatePublication } from '../../edge/scripts/publication-guard.mjs';
import { buildWorkFactPacks } from '../../edge/scripts/work-fact-packs.mjs';
const target = { channelId: 'drama', typeId: 38, isPrivate: false, provider: { id: 'provider_m1', shortCode: 'm' } };
const raw = (id, total = 3) => ({ vod_id: id, vod_name: `真实剧${id}`, vod_pic: 'https://covers.invalid/a.jpg',
  vod_play_url: Array.from({ length: total }, (_, i) => `第${i + 1}集$https://media.invalid/${id}/${i + 1}`).join('#') });

test('daily generation preserves untouched full facts and emits packs/search/bundle with changed episodes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-daily-'));
  try {
    const state = emptyState(false);
    mergeRawsIntoState(state, [1, 2].map((id) => ({ target, item: raw(id) })), 100);
    const changed = mergeRawsIntoState(state, [{ target, item: raw(2, 118) }], 200);
    const emitted = emitAssets(state, changed.resolved, { revision: 3, outDir: dir, isPrivate: false, nowSeconds: 200 });
    assert.ok(emitted.workFacts);
    assert.equal(emitted.publicSearch.count, 2);
    const recovered = emitted.files.filter((file) => file.key.startsWith('library/facts/'))
      .flatMap((file) => Object.values(JSON.parse(fs.readFileSync(file.file)).works));
    assert.equal(recovered.find((fact) => fact.id === 'drama_m_1').episodes.length, 3);
    assert.equal(recovered.find((fact) => fact.id === 'drama_m_2').episodes.length, 118);
    assert.ok(recovered.every((fact) => fact.generatedAt === 0 && !('durationSeconds' in fact.episodes[0])));
    const bundle = JSON.parse(fs.readFileSync(emitted.files.find((file) => file.key === 'assets/catalog-bundle.json').file));
    assert.equal(bundle.revision, 3);
    assert.equal(bundle.items.length, 2);
    assert.equal(bundle.items.find((item) => item.id === 'drama_m_2').episodeCount, 118);
    assert.ok(!JSON.stringify(bundle).includes('mediaUrl'));
    // A withdrawn work disappears from all next-generation inventories, including search.
    state.works.drama_m_1.enabled = false;
    const next = emitAssets(state, [], { revision: 4, outDir: dir, isPrivate: false, nowSeconds: 201 });
    assert.equal(next.publicSearch.count, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('bootstrap preserves zero episodes, real gaps and empty lines without weakening new candidate admission', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-bootstrap-'));
  try {
    const state = emptyState(false);
    mergeRawsIntoState(state, [1, 2, 3].map((id) => ({ target, item: raw(id) })), 100);
    const facts = new Map(Object.values(state.works).map((record) => [record.id, record.fact]));
    facts.get('drama_m_1').episodes = [];
    facts.get('drama_m_1').episodeCount = 0;
    facts.get('drama_m_2').episodes[1].episodeNumber = 5;
    facts.get('drama_m_2').episodes[2].episodeNumber = 9;
    facts.get('drama_m_3').episodes[0].lines = [];
    const packed = buildWorkFactPacks(facts);
    for (const object of packed.objects) {
      const file = path.join(dir, object.key);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, object.value);
    }
    const manifest = { revision: 7, workFacts: packed.workFacts, channels: { drama: { total: 3 } } };
    const restored = bootstrapDailyState(manifest, dir);
    const emitted = emitAssets(restored, [], { revision: 8, outDir: dir, nowSeconds: 200, isPrivate: false });
    const recovered = emitted.files.filter((file) => file.key.startsWith('library/facts/'))
      .flatMap((file) => Object.values(JSON.parse(fs.readFileSync(file.file)).works));
    assert.equal(recovered.length, 3);
    for (const fact of recovered) assert.deepEqual(fact.episodes, facts.get(fact.id).episodes);
    assert.equal(emitted.publicSearch.count, 3);
    const candidate = structuredClone(facts.get('drama_m_2'));
    candidate.id = candidate.workId = 'drama_s_2'; candidate.providerId = 'provider_s1'; candidate.sourceItemId = '2';
    candidate.episodes.forEach((ep, i) => { ep.sourceEpisodeId = String(i + 1); ep.lines.forEach((line) => { line.providerId = 'provider_s1'; }); });
    assert.throws(() => importPublicResults(restored, [{ status: 'candidate', fact: candidate }], 200), /continuous/);
    candidate.episodes = []; candidate.episodeCount = 0;
    assert.throws(() => importPublicResults(restored, [{ status: 'candidate', fact: candidate }], 200), /complete/);
    restored.works.drama_m_2.fact.episodes[1].episodeNumber = 1;
    assert.throws(() => emitAssets(restored, [], { revision: 9, outDir: dir, nowSeconds: 200 }), /episodes/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('schema1/2 bootstrap and publication validate descriptors without weakening bounds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-descriptors-'));
  try {
    const state = emptyState(false);
    mergeRawsIntoState(state, [{ target, item: raw(1) }], 100);
    const emitted = emitDailyFacts(state, [], { revision: 2, outDir: dir, nowSeconds: 100 });
    const entries = Object.entries(emitted.workFacts.packs).map(([prefix, value]) => {
      const [bytes, sha256] = Array.isArray(value) ? value : [value.bytes, value.sha256];
      return [prefix, { key: `library/facts/${sha256}.json`, bytes, sha256 }];
    });
    for (const schema of [1, 2]) {
      const packs = Object.fromEntries(entries.map(([prefix, d]) => [prefix, schema === 1 ? d : [d.bytes, d.sha256]]));
      const manifest = { revision: 2, channels: emitted.channels, publicSearch: emitted.publicSearch,
        workFacts: { schema, maxBytes: 524288, packs } };
      const check = (m) => validatePublication(emitted.files, buildPublicationEntries(m, {}, false), false);
      assert.deepEqual(bootstrapDailyState(manifest, dir).works.drama_m_1.fact.episodes, state.works.drama_m_1.fact.episodes);
      assert.equal(check(manifest), true);
      const [prefix, descriptor] = entries[0];
      for (const invalidPacks of [null, [], 'invalid', { x: packs[prefix] }]) {
        const bad = { ...manifest, workFacts: { ...manifest.workFacts, packs: invalidPacks } };
        assert.throws(() => bootstrapDailyState(bad, dir), /descriptor/);
        assert.throws(() => check(bad), /descriptor/);
      }
      const invalid = [null, {}, [], [descriptor.bytes], [descriptor.bytes, descriptor.sha256, 'extra'],
        ...[0, -1, 524289, 1.5, '100', null, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity].map((bytes) =>
          schema === 1 ? { ...descriptor, bytes } : [bytes, descriptor.sha256]),
        ...[null, 1, 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)].map((sha256) =>
          schema === 1 ? { ...descriptor, sha256 } : [descriptor.bytes, sha256]),
        schema === 1 ? [descriptor.bytes, descriptor.sha256] : descriptor];
      if (schema === 1) invalid.push({ ...descriptor, key: 'private/facts/x.json' });
      for (const value of invalid) {
        const bad = structuredClone(manifest); bad.workFacts.packs[prefix] = value;
        assert.throws(() => bootstrapDailyState(bad, dir), /descriptor/);
        assert.throws(() => check(bad), /descriptor/);
      }
      const corrupt = structuredClone(manifest);
      corrupt.workFacts.packs[prefix] = schema === 1 ? { ...descriptor, bytes: descriptor.bytes + 1 } : [descriptor.bytes + 1, descriptor.sha256];
      assert.throws(() => bootstrapDailyState(corrupt, dir), /hash\/bytes/);
      assert.throws(() => check(corrupt), /bytes\/hash/);
      const oversized = { ...manifest, padding: 'x'.repeat(65536) };
      assert.throws(() => bootstrapDailyState(oversized, dir), /64 KiB/);
      assert.throws(() => check(oversized), /64 KiB/);
      assert.throws(() => check({ ...manifest, workFacts: { ...manifest.workFacts, schema: 3 } }), /schema/);
      assert.throws(() => validatePublication(emitted.files, buildPublicationEntries(manifest, {}, false), true), /Private publication/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy incomplete state is rejected instead of publishing old microJSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-daily-bad-'));
  try {
    const state = emptyState(false);
    mergeRawsIntoState(state, [{ target, item: raw(1) }], 100);
    delete state.works.drama_m_1.fact;
    assert.throws(() => emitAssets(state, [], { revision: 2, outDir: dir, isPrivate: false, nowSeconds: 100 }), /complete fact/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
