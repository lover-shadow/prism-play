import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildLibraryCatalog } from '../../edge/scripts/library-catalog.mjs';
import { packageAndPublish } from '../../edge/scripts/package-and-publish-library.mjs';
import { buildWorkFacts, buildWorkFactPacks, serializeManifest, MAX_PACK_BYTES } from '../../edge/scripts/work-fact-packs.mjs';

const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE content_items (id TEXT PRIMARY KEY, channel_id TEXT, title TEXT,
    enabled INT, is_private INT, shareable INT, cover_url TEXT, cover_version TEXT,
    is_ai INT, is_hot INT, category TEXT, synopsis TEXT, first_published_at INT,
    hits_total INT, hits_week INT);
    CREATE TABLE content_episodes (id INT PRIMARY KEY, content_id TEXT, episode_number INT,
      title TEXT, duration_seconds INT);
    CREATE TABLE episode_sources (id INT PRIMARY KEY, episode_id INT, provider_id TEXT,
      upstream_media_url TEXT, enabled INT);
    INSERT INTO content_items VALUES ('drama_m_1','drama','真实标题',1,0,1,
      '/proxy/cover/drama_m_1','v1',0,0,'逆袭','简介',100,3,0);
    INSERT INTO content_episodes VALUES (2,'drama_m_1',2,'第二集',120),(1,'drama_m_1',1,'第一集',NULL);
    INSERT INTO episode_sources VALUES (2,2,'provider_m1','https://media.example/2.m3u8',1),
      (1,1,'provider_m1','https://media.example/1.m3u8',1),
      (3,1,'provider_s1','http://alternate.example/1.m3u8',1),
      (4,1,'provider_s1','javascript:disabled',0);
    INSERT INTO content_items VALUES ('private','private','私有',1,1,0,'invalid','v1',0,0,'','',0,0,0),
      ('disabled','drama','停用',0,0,0,'invalid','v1',0,0,'','',0,0,0);`);
  const metadata = new Map([['drama_m_1', { target: { channelId: 'drama' }, item: { vod_pic: 'https://images.example/real.jpg' } }]]);
  const catalog = buildLibraryCatalog(db, metadata, 1800000000);
  return { db, catalog, metadata };
}
const fact = (id, extra = {}) => ({ id, workId: id, title: '标题', channelId: 'drama',
  isPrivate: false, enabled: true, shareable: false, coverTargetUrl: 'https://images.example/a.jpg',
  episodes: [{ episodeNumber: 1, lines: [{ providerId: 'provider_m1', mediaUrl: 'https://media.example/1' }] }],
  generatedAt: 0, ...extra });

/**
 * HP-11 之后，`synopsis` 是 240 码点硬边界，不能再拿来当体积杠杆——那样造出来的 fact
 * 本身就是一条非法公开资产，会被策略源判据拒掉。这里改用**契约内**的杠杆撑字节数：
 * 集数做粗调（每集边际恒定），第一集标题做 1 字节细调，所以能命中精确边界。
 */
function bulkyFact(id, targetBytes) {
  const lines = [{ providerId: 'provider_m1', mediaUrl: 'https://media.example/1.m3u8' }];
  const episode = (n) => ({ episodeNumber: n, title: '', lines });
  const size = (count) => Buffer.byteLength(JSON.stringify({ schema: 1, works: {
    [id]: { ...fact(id), episodes: Array.from({ length: count }, (_, i) => episode(i + 1)) } } }), 'utf8');
  const marginal = size(2) - size(1);
  let count = 1 + Math.max(0, Math.floor((targetBytes - size(1)) / marginal));
  while (size(count) > targetBytes) count -= 1;
  const episodes = Array.from({ length: count }, (_, i) => episode(i + 1));
  episodes[0].title = 'x'.repeat(targetBytes - size(count));
  return { ...fact(id), episodes };
}

test('one sorted JOIN merges lines, preserves catalog fields and uses raw cover before proxy DB cover', () => {
  const { db, catalog, metadata } = fixture();
  try {
    let reads = 0;
    const counted = { prepare(sql) {
      reads++;
      assert.match(sql, /LEFT JOIN episode_sources/);
      assert.match(sql, /ORDER BY c.id, e.episode_number/);
      return db.prepare(sql);
    } };
    const facts = buildWorkFacts(counted, catalog, metadata);
    assert.equal(reads, 1);
    assert.equal(facts.size, 1);
    const value = facts.get('drama_m_1');
    for (const [key, item] of Object.entries(catalog.channels.drama[0])) assert.deepEqual(value[key], item);
    assert.equal(value.generatedAt, 0);
    assert.equal(value.coverTargetUrl, 'https://images.example/real.jpg');
    assert.deepEqual(value.episodes.map((episode) => episode.episodeNumber), [1, 2]);
    assert.equal(value.episodes[0].lines.length, 2);
    assert.equal('durationSeconds' in value.episodes[0], false);
    assert.equal(value.episodes[1].durationSeconds, 120);
    assert.deepEqual(buildWorkFactPacks(facts).coverOrigins, ['https://images.example']);
  } finally { db.close(); }
});

test('reject duplicate episode numbers rather than merge distinct episode rows', () => {
  const { db, catalog, metadata } = fixture();
  try {
    db.exec("INSERT INTO content_episodes VALUES (3,'drama_m_1',1,'重复',120)");
    assert.throws(() => buildWorkFacts(db, catalog, metadata), /Duplicate episode number/);
  } finally { db.close(); }
});

test('reject invalid media and unsafe covers; preserve absent lines and accept direct HTTPS DB fallback', () => {
  for (const url of ['javascript:alert(1)', '/proxy/media', 'https://user:password@media.example/a',
    'https://media.example/proxy/cover/a', 'https://media.example/a\n']) {
    const { db, catalog, metadata } = fixture();
    try {
      db.prepare('UPDATE episode_sources SET upstream_media_url=? WHERE id=1').run(url);
      assert.throws(() => buildWorkFacts(db, catalog, metadata), /Invalid target URL/);
    } finally { db.close(); }
  }
  const { db, catalog, metadata } = fixture();
  try {
    assert.equal(Object.hasOwn(buildWorkFacts(db, catalog, new Map()).get('drama_m_1'), 'coverTargetUrl'), false);
    metadata.get('drama_m_1').item.vod_pic = 'http://images.example/a.jpg';
    assert.throws(() => buildWorkFacts(db, catalog, metadata), /Invalid target URL/);
    db.exec("UPDATE content_items SET cover_url='https://db.example/a.jpg' WHERE id='drama_m_1'");
    assert.equal(buildWorkFacts(db, catalog, new Map()).get('drama_m_1').coverTargetUrl, 'https://db.example/a.jpg');
    db.exec('UPDATE episode_sources SET enabled=0');
    assert.ok(buildWorkFacts(db, catalog, new Map()).get('drama_m_1').episodes.every((episode) => episode.lines.length === 0));
  } finally { db.close(); }
});

test('genuinely missing covers omit both fields without losing works or inventing episodes', () => {
  for (const raw of ['', null, undefined]) {
    for (const stored of ['', null, '/proxy/img/drama_m_1', '/proxy/cover/drama_m_1']) {
      const { db, catalog, metadata } = fixture();
      try {
        metadata.get('drama_m_1').item.vod_pic = raw;
        db.prepare('UPDATE content_items SET cover_url=? WHERE id=?').run(stored, 'drama_m_1');
        db.exec('DELETE FROM episode_sources; DELETE FROM content_episodes');
        const facts = buildWorkFacts(db, catalog, metadata);
        assert.equal(facts.size, 1);
        const value = facts.get('drama_m_1');
        assert.equal(Object.hasOwn(value, 'coverTargetUrl'), false);
        assert.equal(Object.hasOwn(value, 'coverUrl'), false);
        assert.equal(Object.hasOwn(catalog.channels.drama[0], 'coverUrl'), false);
        assert.deepEqual(value.episodes, []);
        const packed = buildWorkFactPacks(facts);
        assert.deepEqual(packed.coverOrigins, []);
        assert.equal(packed.report.works, 1);
        assert.deepEqual(JSON.parse(packed.objects[0].value).works.drama_m_1, value);
      } finally { db.close(); }
    }
  }
});

test('nonempty invalid raw or fallback covers never become missing covers', () => {
  const invalid = [' ', false, 0, 'javascript:alert(1)', 'http://images.example/a',
    'https://user:password@images.example/a', 'https://images.example/a\\n',
    '/proxy/img/another-work', 'https://images.example/proxy/img/drama_m_1'];
  for (const url of invalid) {
    const { db, catalog, metadata } = fixture();
    try {
      metadata.get('drama_m_1').item.vod_pic = url;
      db.exec("UPDATE content_items SET cover_url='https://valid.example/a'");
      assert.throws(() => buildWorkFacts(db, catalog, metadata), /Invalid target URL for cover/);
      metadata.get('drama_m_1').item.vod_pic = '';
      db.prepare('UPDATE content_items SET cover_url=? WHERE id=?').run(String(url), 'drama_m_1');
      assert.throws(() => buildWorkFacts(db, catalog, metadata), /Invalid target URL for cover/);
      assert.throws(() => buildWorkFactPacks(new Map([['a', fact('a', { coverTargetUrl: url })]])), /Invalid target URL/);
    } finally { db.close(); }
  }
});

test('cover origins include only present targets, with missing works retained', () => {
  const missing = fact('missing');
  delete missing.coverTargetUrl;
  missing.episodes = [];
  const result = buildWorkFactPacks(new Map([['missing', missing], ['a', fact('a')]]));
  assert.equal(result.report.works, 2);
  assert.deepEqual(result.coverOrigins, ['https://images.example']);
});

test('private and disabled facts are rejected even if injected by a caller', () => {
  for (const extra of [{ isPrivate: true }, { enabled: false }, { channelId: 'private' }]) {
    assert.throws(() => buildWorkFactPacks(new Map([['a', fact('a', extra)]])), /Invalid public fact/);
  }
  const { db, catalog, metadata } = fixture();
  try {
    catalog.channels.drama[0].isPrivate = true;
    assert.throws(() => buildWorkFacts(db, catalog, metadata), /Invalid public catalog item/);
  } finally { db.close(); }
});

test('recursive hash nibble splitting is deterministic, byte accurate and content addressed', () => {
  const ids = [];
  for (let i = 0; ids.length < 4; i++) {
    const id = `作品_${i}`;
    if (digest(id).startsWith('ab')) ids.push(id);
  }
  const facts = new Map(ids.map((id) => [id, bulkyFact(id, 180000)]));
  const result = buildWorkFactPacks(facts);
  assert.ok(result.objects.length > 1);
  assert.deepEqual(buildWorkFactPacks(new Map([...facts].reverse())), result);
  const recovered = [];
  for (const [prefix, info] of Object.entries(result.workFacts.packs)) {
    assert.ok(prefix.length > 2);
    const object = result.objects.find((entry) => entry.key === info.key);
    assert.equal(info.bytes, Buffer.byteLength(object.value, 'utf8'));
    assert.ok(info.bytes <= MAX_PACK_BYTES);
    assert.equal(info.sha256, digest(object.value));
    assert.equal(info.key, `library/facts/${info.sha256}.json`);
    const payload = JSON.parse(object.value);
    assert.equal(payload.schema, 1);
    for (const id of Object.keys(payload.works)) {
      assert.ok(digest(id).startsWith(prefix));
      recovered.push(id);
    }
  }
  assert.deepEqual(recovered.sort(), ids.sort());
});

test('large route inventory uses compact directory without dropping any facts or raising caps', () => {
  const facts = new Map(Array.from({ length: 1000 }, (_, i) => {
    const id = `drama_m_${i}`;
    return [id, bulkyFact(id, 130000)];
  }));
  const result = buildWorkFactPacks(facts);
  assert.equal(result.workFacts.schema, 2);
  assert.ok(Buffer.byteLength(serializeManifest({ workFacts: result.workFacts })) <= 65536);
  let count = 0;
  for (const [prefix, [bytes, sha256]] of Object.entries(result.workFacts.packs)) {
    const object = result.objects.find((entry) => entry.key === `library/facts/${sha256}.json`);
    assert.equal(bytes, Buffer.byteLength(object.value));
    assert.equal(sha256, digest(object.value));
    assert.ok(bytes <= MAX_PACK_BYTES);
    for (const id of Object.keys(JSON.parse(object.value).works)) { assert.ok(digest(id).startsWith(prefix)); count++; }
  }
  assert.equal(count, facts.size);
});

test('exact final UTF-8 boundary passes and oversized single work fails', () => {
  const value = bulkyFact('a', MAX_PACK_BYTES);
  assert.equal(buildWorkFactPacks(new Map([['a', value]])).report.maxPackBytes, MAX_PACK_BYTES);
  value.episodes[0].title += '中';
  assert.throws(() => buildWorkFactPacks(new Map([['a', value]])), /Oversized single work/);
  assert.equal(Buffer.byteLength(serializeManifest({ value: 'x'.repeat(65524) })), 65536);
  assert.throws(() => serializeManifest({ value: '中'.repeat(65536) }), /64 KiB/);
  assert.throws(() => buildWorkFactPacks(new Map([['a', fact('a', { synopsis: '长'.repeat(241) })]])),
    /公开元数据判据失败/);
  assert.equal(buildWorkFactPacks(new Map([['a', fact('a', { synopsis: '长'.repeat(240), tags: ['剧情'] })]]))
    .report.works, 1);
});

test('offline publisher persists facts and manifest, and orders manifest KV pointer last', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-facts-'));
  const { db } = fixture();
  try {
    const dbPath = path.join(dir, 'full.db');
    db.exec(`VACUUM INTO '${dbPath.replaceAll("'", "''")}'`);
    // Direct DB fallback deliberately avoids needing harvest fixtures.
    const disk = new DatabaseSync(dbPath);
    disk.exec("UPDATE content_items SET cover_url='https://images.example/real.jpg' WHERE id='drama_m_1'");
    disk.close();
    const result = await packageAndPublish({ dbPath, outDir: path.join(dir, 'out'), harvestDir: dir, revision: 17 });
    assert.equal(result.factsReport.works, 1);
    assert.equal(result.factsReport.packs, 1);
    assert.ok(result.manifestBytes <= 65536);
    assert.equal(result.kvEntries.at(-1).key, 'catalog:manifest');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'out/catalog-manifest.json'), 'utf8'));
    assert.deepEqual(manifest, result.manifest);
    const info = Object.values(manifest.workFacts.packs)[0];
    const bytes = fs.readFileSync(path.join(dir, 'out/assets', info.key));
    assert.equal(bytes.length, info.bytes);
    assert.equal(digest(bytes), info.sha256);
    assert.equal(JSON.parse(bytes).works.drama_m_1.generatedAt, 0);
    await assert.rejects(packageAndPublish({ publish: true, dbPath, outDir: dir }), /explicit revision/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
