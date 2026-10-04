import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildPublicSearch } from '../../edge/scripts/public-search-projection.mjs';

const fact = { id: 'drama_s_1', workId: 'drama_s_1', title: '末世求生', category: '悬疑', channelId: 'drama',
  isPrivate: false, enabled: true, shareable: true, generatedAt: 0, episodeCount: 118,
  episodes: Array.from({ length: 118 }, (_, i) => ({ episodeNumber: i + 1, lines: [] })) };
test('projection is deterministic, generation scoped, public only and contains no media payload', () => {
  const facts = new Map([[fact.id, fact]]);
  const result = buildPublicSearch(facts, 9, new Map([[fact.id, { aliases: ['生存'], tags: ['求生'], pinyin: ['msqs'] }]]));
  assert.deepEqual(result, buildPublicSearch(facts, 9, new Map([[fact.id, { aliases: ['生存'], tags: ['求生'], pinyin: ['msqs'] }]])));
  const raw = JSON.parse(result.object.value);
  assert.equal(raw.revision, 9);
  assert.equal(result.publicSearch.count, 1);
  assert.equal(result.publicSearch.bytes, Buffer.byteLength(result.object.value));
  assert.equal(result.publicSearch.sha256, createHash('sha256').update(result.object.value).digest('hex'));
  assert.ok(raw.entries[0].pinyin.includes('msqs'));
  assert.deepEqual(raw.entries[0].aliases, ['生存']);
  assert.ok(raw.entries[0].tags.includes('求生'));
  assert.equal(raw.entries[0].item.episodeCount, 118);
  assert.equal('episodes' in raw.entries[0].item, false);
  assert.equal('generatedAt' in raw.entries[0].item, false);
  for (const extra of [{ isPrivate: true }, { channelId: 'private' }, { enabled: false }, { episodeCount: 2 }]) {
    assert.throws(() => buildPublicSearch(new Map([[fact.id, { ...fact, ...extra }]]), 9));
  }
});
