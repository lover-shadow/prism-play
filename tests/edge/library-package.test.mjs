import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLibraryCatalog, sortCandidateSupply, readHarvestMetadata } from '../../edge/scripts/library-catalog.mjs';
import { packageAndPublish } from '../../edge/scripts/package-and-publish-library.mjs';
import { publicTargets, makeWorkId, PAGE_SIZE, assertPublicAssetClean } from '../../edge/scripts/config-sources.mjs';

const now = 1800000000;
const row = (id, extra = {}) => ({ id, channel_id: 'drama', title: '重生逆袭',
  category: '短剧', enabled: 1, is_private: 0, shareable: 0,
  is_ai: 0, is_hot: 0, episode_count: 7, ...extra });
const fakeDb = (rows) => ({ prepare: () => ({ all: () => rows }) });

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
