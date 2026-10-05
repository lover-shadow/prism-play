import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildPublicSearch } from '../../edge/scripts/public-search-projection.mjs';
import {
  SYNOPSIS_MAX_CODE_POINTS, TAGS_MAX_ITEMS, PUBLIC_METADATA_FIELDS, assertMetadataBounds
} from '../../edge/src/library/metadata-policy.mjs';

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

/** HP-11/HP-12：同一批事实投影出的 search item 必须与目录携带同样的可选元数据。 */
const enriched = {
  ...fact,
  synopsis: '雨夜的码头，船长把最后一张船票塞进女儿手里。'.repeat(9),
  tags: ['剧情', '惊悚'], releaseYear: 2019, region: '美国,英国,加拿大', language: '英语,法语'
};

test('HP-11 search projection carries the bounded synopsis and every supplied metadata field', () => {
  const result = buildPublicSearch(new Map([[enriched.id, enriched]]), 9);
  const item = JSON.parse(result.object.value).entries[0].item;
  assert.ok([...item.synopsis].length <= SYNOPSIS_MAX_CODE_POINTS);
  assert.ok([...item.synopsis].length > 30, '投影不得把长摘要退回 30 字');
  assert.deepEqual(item.tags, ['剧情', '惊悚']);
  assert.equal(item.releaseYear, 2019);
  assert.equal(item.region, '美国,英国,加拿大');
  assert.equal(item.language, '英语,法语');
  assertMetadataBounds(item, 'HP-11 search item');
  assert.doesNotMatch(result.object.value, /mediaUrl|https?:\/\//);
});

test('HP-12 retrieval vocabulary stays separate from display tags and no episode payload leaks', () => {
  const result = buildPublicSearch(new Map([[enriched.id, enriched]]), 9,
    new Map([[enriched.id, { aliases: ['求生'], tags: ['末日', '丧尸围城'], pinyin: ['msqs'] }]]));
  const entry = JSON.parse(result.object.value).entries[0];
  assert.ok(entry.tags.includes('末日'), '检索词表继续服务搜索命中');
  assert.ok(entry.tags.includes(enriched.category));
  assert.ok(!entry.tags.includes('惊悚'), '展示副标签不许被并进检索词，反之检索词也不得升格为展示标签');
  assert.deepEqual(entry.item.tags, ['剧情', '惊悚']);
  assert.equal('episodes' in entry.item, false);
});

test('HP-11 a legacy fact without any new field still projects, and empty tags never materialise', () => {
  const legacy = buildPublicSearch(new Map([[fact.id, fact]]), 9).object.value;
  const item = JSON.parse(legacy).entries[0].item;
  for (const key of ['synopsis', 'releaseYear', 'region', 'language']) assert.equal(key in item, false, key);
  assert.equal('tags' in item, false, 'tags 只能来自目录侧供应，投影层不得凭空造键');
  const blank = buildPublicSearch(new Map([[fact.id, { ...fact, tags: ['剧情'] }]]), 9).object.value;
  assert.deepEqual(JSON.parse(blank).entries[0].item.tags, ['剧情']);
  // 空数组是"假值形态的缺席"：既不许进目录，也不许在投影层被静默吞掉，必须由同一判据拒发。
  assert.throws(() => buildPublicSearch(new Map([[fact.id, { ...fact, tags: [] }]]), 9), /公开元数据判据失败/);
});

test('HP-11 projection refuses a fact whose metadata breaks the shared boundary', () => {
  const oversized = { ...enriched, synopsis: '长'.repeat(SYNOPSIS_MAX_CODE_POINTS + 1) };
  assert.throws(() => assertMetadataBounds(oversized, 'HP-11 oversized'), /公开元数据判据失败/);
  const padded = { ...enriched, tags: Array.from({ length: TAGS_MAX_ITEMS + 1 }, (_, i) => `题材${i}`) };
  assert.throws(() => assertMetadataBounds(padded, 'HP-11 padded'), /公开元数据判据失败/);
});
