import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLibraryCatalog, sortCandidateSupply, readHarvestMetadata } from '../../edge/scripts/library-catalog.mjs';
import { packageAndPublish, syncSeedFiles, assertCatalogDirectoryBudget } from '../../edge/scripts/package-and-publish-library.mjs';
import { publicTargets, makeWorkId, PAGE_SIZE, assertPublicAssetClean } from '../../edge/scripts/config-sources.mjs';
import { normalizeWork } from '../../edge/scripts/compute-hotscore.mjs';
import {
  SYNOPSIS_MAX_CODE_POINTS, TAGS_MAX_ITEMS, SOURCE_TEXT_MAX_CODE_POINTS, CATALOG_DIRECTORY_MAX_BYTES,
  PUBLIC_METADATA_FIELDS, assertMetadataBounds
} from '../../edge/src/library/metadata-policy.mjs';

test('merged caches preserve old evidence and new same-work fields win even with older stamps', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-merge-'));
  try {
    const target = publicTargets().find((value) => value.forceAi);
    for (const name of ['old', 'new']) fs.mkdirSync(path.join(dir, name));
    const file = `t_${target.typeId}_p_1.json`;
    fs.writeFileSync(path.join(dir, 'old', file), JSON.stringify({ list: [
      { vod_id: 1, vod_time: 200, vod_hits: 99, vod_class: 'AI' }, { vod_id: 2, vod_hits: 0 }
    ] }));
    fs.writeFileSync(path.join(dir, 'new', file), JSON.stringify({ list: [{ vod_id: 1, vod_time: 100, vod_blurb: '新简介' }] }));
    const merged = readHarvestMetadata([path.join(dir, 'old'), path.join(dir, 'new')]);
    assert.equal(merged.size, 2);
    assert.equal(merged.get(makeWorkId(target.channelId, target.provider, 1)).item.vod_hits, 99);
    assert.equal(merged.get(makeWorkId(target.channelId, target.provider, 1)).item.vod_blurb, '新简介');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('seed staging failure leaves every existing destination unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-seed-'));
  try {
    const source = path.join(dir, 'source'), first = path.join(dir, 'first'), second = path.join(dir, 'second');
    fs.writeFileSync(source, 'new'); fs.writeFileSync(first, 'old1'); fs.writeFileSync(second, 'old2');
    assert.throws(() => syncSeedFiles([[source, first], [path.join(dir, 'missing'), second]]));
    assert.equal(fs.readFileSync(first, 'utf8'), 'old1');
    assert.equal(fs.readFileSync(second, 'utf8'), 'old2');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['first', 'second', 'source']);
    syncSeedFiles([[source, first], [source, second]]);
    assert.equal(fs.readFileSync(first, 'utf8'), 'new');
    assert.equal(fs.readFileSync(second, 'utf8'), 'new');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

const now = 1800000000;
const row = (id, extra = {}) => ({ id, channel_id: 'drama', title: '重生逆袭',
  category: '短剧', enabled: 1, is_private: 0, shareable: 0,
  is_ai: 0, is_hot: 0, episode_count: 7, ...extra });
const fakeDb = (rows) => ({ prepare: () => ({ all: () => rows }) });

test('real dotted title survives sanitization instead of invalidating the whole bundle', () => {
  const result = buildLibraryCatalog(fakeDb([row('movie_m_32078', { channel_id: 'movie', title: 'K.O' })]), new Map(), now);
  assert.equal(result.channels.movie[0].title, 'K.O');
  assert.throws(() => buildLibraryCatalog(fakeDb([row('empty-title', { title: '' })]), new Map(), now), /no usable title/);
});

test('AI evidence, truthful metrics and normalized categories survive catalog stripping', () => {
  const target = publicTargets().find((value) => value.forceAi);
  const id = makeWorkId(target.channelId, target.provider, 123);
  const metadata = new Map([[id, { target, item: {
    vod_hits: 244, vod_hits_week: 0, vod_time_add: now - 864000,
    vod_blurb: '<b>真实简介</b>', type_name: target.typeLabel
  } }]]);
  const result = buildLibraryCatalog(fakeDb([row(id), row('drama_m_other', {
    first_published_at: now - 864000, hits_total: 1, hits_week: 0
  })]), metadata, now);
  const item = result.channels.drama.find((value) => value.id === id);
  assert.equal(item.isAi, true);
  assert.equal(item.isHot, true);
  assert.equal(item.hitsTotal, 244);
  assert.equal(item.episodeCount, 7);
  assert.equal(item.category, '逆袭');
  assert.equal(item.firstPublishedAt, now - 864000);
  assert.equal(item.shareable, false);
  assert.equal(item.synopsis, '真实简介');
  for (const key of ['hotScore', 'hitsWeek', 'providerId', 'mediaUrl']) assert.equal(key in item, false);
  assertPublicAssetClean({ items: result.channels.drama }, 'test');
});

test('no AI and absent metrics never manufacture signals or publication dates', () => {
  const result = buildLibraryCatalog(fakeDb([row('drama_m_1', { is_hot: 1 }), row('drama_m_2')]), new Map(), now);
  assert.equal(result.report.ai, 0);
  assert.equal(result.report.hotRecomputed, 0);
  assert.equal(result.report.missingHitsTotal, 2);
  assert.equal(result.report.missingFirstPublishedAt, 2);
  assert.equal(result.channels.drama.filter((item) => item.isHot).length, 1);
  for (const item of result.channels.drama) {
    assert.equal(item.isAi, false);
    assert.equal('hitsTotal' in item, false);
    assert.equal('firstPublishedAt' in item, false);
  }
});

test('database AI flags are preserved even without cached metadata', () => {
  const result = buildLibraryCatalog(fakeDb([row('drama_m_1', { is_ai: 1 })]), new Map(), now);
  assert.equal(result.channels.drama[0].isAi, true);
});

test('missing dates do not receive synthetic recency boost during hot scoring', () => {
  const result = buildLibraryCatalog(fakeDb([
    row('drama_m_a', { hits_total: 0 }),
    row('drama_m_b', { hits_total: 100, first_published_at: now - 864000 })
  ]), new Map(), now);
  assert.equal(result.channels.drama.find((item) => item.id === 'drama_m_b').isHot, true);
  assert.equal('firstPublishedAt' in result.channels.drama.find((item) => item.id === 'drama_m_a'), false);
});

test('first page supplies real AI with deterministic ordering and no dropped or duplicated IDs', () => {
  const records = Array.from({ length: 180 }, (_, i) => ({
    id: `drama_m_${String(i).padStart(3, '0')}`, isAi: i >= 150, hotScore: 180 - i
  }));
  const sorted = sortCandidateSupply(records);
  assert.equal(sorted.slice(0, PAGE_SIZE).filter((item) => item.isAi).length, 21);
  assert.equal(new Set(sorted.map((item) => item.id)).size, records.length);
  assert.deepEqual(sortCandidateSupply([...records].reverse()), sorted);
  const noAi = records.map((item) => ({ ...item, isAi: false }));
  assert.deepEqual(sortCandidateSupply(noAi), noAi);
});

test('offline cache type mapping uses config, ignores private types and preserves zero hits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-harvest-'));
  try {
    const target = publicTargets().find((value) => value.forceAi);
    fs.writeFileSync(path.join(dir, `t_${target.typeId}_p_1.json`), JSON.stringify({ list: [
      { vod_id: 123, type_id: target.typeId, vod_hits: 0 }
    ] }));
    const metadata = readHarvestMetadata(dir);
    assert.equal(metadata.size, 1);
    assert.equal(metadata.get(makeWorkId(target.channelId, target.provider, 123)).target.forceAi, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('required DB fails explicitly without silently using library_test.db or creating output', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-package-'));
  try {
    await assert.rejects(packageAndPublish({ dbPath: path.join(dir, 'missing.db'), outDir: path.join(dir, 'out') }), /Required input database missing/);
    assert.equal(fs.existsSync(path.join(dir, 'out')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** 取自真实 harvest 形状：长简介混 HTML/上游 URL，脏年份，多值地区语言，vod_tag 夹演员名与残句。 */
const harvestRaw = {
  vod_id: 9001, type_name: '剧情',
  vod_blurb: `<p>${'雨夜的码头，船长把最后一张船票塞进女儿手里。'.repeat(9)}</p> 评分见 http://site.douban.com/subject/12345 &amp;  www.other.example/PV`,
  vod_year: '2019', vod_area: '美国,英国,加拿大', vod_lang: '英语,法语',
  vod_tag: '剧情,惊悚,TomHiddleston,本片,）,http://a.b/c，剧情', vod_hits: 10, vod_time: 1700000000
};
const dirtyRaw = { vod_id: 9002, vod_blurb: '   ', vod_content: '<br/>', vod_year: '2026–', vod_area: '中国大陆', vod_lang: '内详', vod_tag: '动画,纪录片' };

test('HP-11 real harvest reaches the catalog with a 240-code-point safe synopsis', () => {
  const target = publicTargets().find((value) => value.channelId === 'movie');
  const id = makeWorkId(target.channelId, target.provider, harvestRaw.vod_id);
  const result = buildLibraryCatalog(fakeDb([row(id, { channel_id: 'movie', title: '码头' })]),
    new Map([[id, { target, item: harvestRaw }]]), now);
  const item = result.channels.movie.find((value) => value.id === id);
  assert.ok(item.synopsis.length > 30, '30 字硬截断必须已被替换，否则长简介仍然被丢掉');
  assert.ok([...item.synopsis].length <= SYNOPSIS_MAX_CODE_POINTS);
  assert.doesNotMatch(item.synopsis, /<|>|http|www\.|douban|\/\//);
  assert.ok(item.synopsis.startsWith('雨夜的码头'));
  assert.equal(item.releaseYear, 2019);
  assert.equal(item.region, '美国,英国,加拿大');
  assert.equal(item.language, '英语,法语');
  assert.deepEqual(item.tags, ['剧情', '惊悚']);
  assertMetadataBounds(item, 'HP-11 catalog item');
  assertPublicAssetClean({ items: result.channels.movie }, 'HP-11');
});

test('HP-11 and HP-12 dirty or absent supply omits fields instead of manufacturing them', () => {
  const target = publicTargets().find((value) => value.channelId === 'anime');
  const id = makeWorkId(target.channelId, target.provider, dirtyRaw.vod_id);
  const result = buildLibraryCatalog(fakeDb([row(id, { channel_id: 'anime', title: '无名作' })]),
    new Map([[id, { target, item: dirtyRaw }]]), now);
  const item = result.channels.anime.find((value) => value.id === id);
  for (const key of ['synopsis', 'releaseYear', 'tags']) assert.equal(key in item, false, `${key} 必须整个省略`);
  assert.equal(item.region, '中国大陆');
  assert.equal(item.language, '内详');
  assert.equal('暂无简介' in item, false);
});

test('HP-11 legacy catalog rows without any new field still build and pass every public gate', () => {
  const result = buildLibraryCatalog(fakeDb([row('drama_m_legacy')]), new Map(), now);
  const item = result.channels.drama.find((value) => value.id === 'drama_m_legacy');
  for (const key of PUBLIC_METADATA_FIELDS) if (key !== 'synopsis') assert.equal(key in item, false, key);
  assert.equal(item.category, '逆袭');
  assert.equal('synopsis' in item, false);
  assertMetadataBounds(item, 'HP-11 legacy item');
});

test('HP-12 short drama reports zero display-tag supply rather than promoting vod_tag raw text', () => {
  const target = publicTargets().find((value) => value.channelId === 'drama');
  const id = makeWorkId(target.channelId, target.provider, 5001);
  const polluted = { vod_id: 5001, vod_blurb: '她重生了。', vod_year: '2024', vod_area: '内地', vod_lang: '国语',
    vod_tag: `主演张三,${'李四'.repeat(20)},http://t.cn/abcdef,www.example.com/剧情,剧情,喜剧,爱情,动作,科幻,悬疑,恐怖,惊悚` };
  const result = buildLibraryCatalog(fakeDb([row(id, { channel_id: 'drama' })]),
    new Map([[id, { target, item: polluted }]]), now);
  const item = result.channels.drama.find((value) => value.id === id);
  assert.ok(Array.isArray(item.tags) && item.tags.length <= TAGS_MAX_ITEMS);
  assert.deepEqual(item.tags, ['剧情', '喜剧', '爱情', '动作', '科幻', '悬疑']);
  assert.equal(item.releaseYear, 2024);
  for (const tag of item.tags ?? []) assert.ok([...tag].length <= 12);
});

test('HP-11 normalizeWork carries the same metadata into the harvest state snapshot', () => {
  const target = publicTargets().find((value) => value.channelId === 'movie');
  const record = normalizeWork(target, harvestRaw, now);
  assert.equal(record.releaseYear, 2019);
  assert.deepEqual(record.tags, ['剧情', '惊悚']);
  assert.equal(record.region, '美国,英国,加拿大');
  assert.ok([...record.synopsis].length <= SYNOPSIS_MAX_CODE_POINTS);
  assert.equal('hotScore' in record, true);
  assert.equal('releaseYear' in normalizeWork(target, dirtyRaw, now), false);
});

test('HP-11 catalog build reports real per-channel metadata supply', () => {
  const movieTarget = publicTargets().find((value) => value.channelId === 'movie');
  const dramaTarget = publicTargets().find((value) => value.channelId === 'drama');
  const movieId = makeWorkId(movieTarget.channelId, movieTarget.provider, harvestRaw.vod_id);
  const dramaId = makeWorkId(dramaTarget.channelId, dramaTarget.provider, 77);
  const result = buildLibraryCatalog(fakeDb([
    row(movieId, { channel_id: 'movie', title: '码头' }), row(dramaId, { title: '重生' })
  ]), new Map([[movieId, { target: movieTarget, item: harvestRaw }],
    [dramaId, { target: dramaTarget, item: { vod_id: 77, vod_blurb: '她重生了。', vod_year: '内详', vod_area: '内地' } }]]), now);
  assert.deepEqual(result.report.metadataCoverage, {
    drama: { total: 1, synopsis: 1, releaseYear: 0, region: 1, language: 0, tags: 0 },
    movie: { total: 1, synopsis: 1, releaseYear: 1, region: 1, language: 1, tags: 1 },
    anime: { total: 0, synopsis: 0, releaseYear: 0, region: 0, language: 0, tags: 0 },
    documentary: { total: 0, synopsis: 0, releaseYear: 0, region: 0, language: 0, tags: 0 }
  });
});

test('HP-11 catalog directory budget rejects an oversized generation instead of dropping items', () => {
  const unit = { id: 'movie_m_0', synopsis: '长'.repeat(SYNOPSIS_MAX_CODE_POINTS) };
  assert.ok(assertCatalogDirectoryBudget({ movie: [unit, { ...unit, id: 'movie_m_1' }] }) < CATALOG_DIRECTORY_MAX_BYTES);
  const perItem = Buffer.byteLength(JSON.stringify(unit), 'utf8');
  const count = Math.ceil(CATALOG_DIRECTORY_MAX_BYTES / perItem) + 8;
  const huge = { movie: Array.from({ length: count }, (_, index) => ({ ...unit, id: `movie_m_${index}` })) };
  assert.throws(() => assertCatalogDirectoryBudget(huge), /budget/i);
  assert.throws(() => assertCatalogDirectoryBudget({ movie: [{ id: 'movie_m_2', releaseYear: 20240 }] }),
    /公开元数据判据失败/);
});
