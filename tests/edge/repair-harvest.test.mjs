import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { harvestAi, requestJson, probePublicWorks } from '../../edge/scripts/repair-harvest.mjs';
import { mergeLibrary, parseFullEpisodes } from '../../edge/scripts/merge-public-library.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'prism-repair-'));
const page = (n, count = 3) => ({ page: n, pagecount: count, list: [{ vod_id: String(n), type_id: 42, vod_name: '真实作品', vod_play_url: '第1集$https://media.invalid/1#第3集$https://media.invalid/3' }] });

test('live first page drives sequential plan, preserves cached copies and counts unique works', async () => {
  const dir = temp(), calls = [], pauses = [];
  try {
    fs.writeFileSync(path.join(dir, 't_42_p_1.json'), JSON.stringify(page(1, 1)));
    const result = await harvestAi({ outDir: dir, delayMs: 1000,
      sleep: async (ms) => pauses.push(ms), fetcher: async (url) => {
        const n = Number(new URL(url).searchParams.get('pg')); calls.push(n);
        return new Response(JSON.stringify(page(n)));
      } });
    assert.deepEqual(calls, [1, 2, 3]);
    assert.equal(result.uniqueWorks, 3);
    assert.equal(result.pagecount, 3);
    assert.equal(result.complete, true);
    assert.equal(pauses.length, 2);
    assert.ok(fs.readdirSync(dir).some((name) => name.includes('.previous-')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('dry-run is offline and write-free; pages over 96 are honestly limited', async () => {
  const dir = temp();
  try {
    const offline = await harvestAi({ outDir: dir, dryRun: true, fetcher: () => { throw Error('network'); } });
    assert.equal(offline.dryRun, true);
    assert.deepEqual(fs.readdirSync(dir), []);
    const result = await harvestAi({ outDir: dir, maxPages: 1, fetcher: async () => new Response(JSON.stringify(page(1, 100))) });
    assert.equal(result.complete, false);
    assert.equal(result.limited, true);
    await assert.rejects(harvestAi({ outDir: dir, maxPages: 97 }), /budget/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('bounded three attempts stop failed crawl instead of retrying other pages', async () => {
  const dir = temp(); let calls = 0;
  try {
    const result = await harvestAi({ outDir: dir, sleep: async () => {}, fetcher: async () => { calls++; throw Error('offline'); } });
    assert.equal(calls, 3);
    assert.equal(result.failures.length, 1);
    assert.equal(result.complete, false);
    assert.equal(result.uniqueWorks, 0);
    await assert.rejects(requestJson('https://example.invalid', { fetcher: async () => new Response('{}', { status: 401 }), sleep: async () => {} }), /401/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('full parser keeps episode numbers, all lines and unknown durations', () => {
  const groups = Array.from({ length: 4 }, (_, i) => `第1集$https://media.invalid/${i}/1#第3集$https://media.invalid/${i}/3`).join('$$$');
  const episodes = parseFullEpisodes(groups);
  assert.deepEqual(episodes.map((ep) => ep.episodeNumber), [1, 3]);
  assert.equal(episodes[0].lines.length, 4);
  assert.equal(episodes[0].durationSeconds, 0);
  assert.deepEqual(parseFullEpisodes('第1集$bad#第2集$https://media.invalid/2').map((ep) => ep.episodeNumber), [2]);
  assert.equal(parseFullEpisodes('HD$https://media.invalid/movie', '90')[0].durationSeconds, 5400);
  assert.throws(() => parseFullEpisodes('第1集$http://user:pass@media.invalid/a'), /URL/);
});
test('public probe is limited to three details and one identity-bound media sample', async () => {
  const dir = temp(), calls = [];
  const html = (key, data) => `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: { [key]: data } })}</script>`;
  try {
    const result = await probePublicWorks(['123'], { outDir: dir, sleep: async () => {}, fetcher: async (url, init) => {
      calls.push(url); assert.equal(init.headers?.Cookie, undefined);
      if (url.includes('/detail')) return new Response(html('detail_page', { seriesDetail: {
        series_id: '123', series_title: '已证作品', episode_cnt: 2, vid_list: ['901', '902'] } }));
      if (url.includes('/player')) return new Response(html('player_page', { series_id: '123', vid: '901',
        video_player_info: { main_url: 'https://media.invalid/main.mp4' } }));
      assert.equal(init.headers.Range, 'bytes=0-1023');
      return new Response(new Uint8Array(32), { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-31/999' } });
    } });
    assert.equal(calls.length, 3); assert.equal(result.player.verified, true);
    assert.equal(result.details[0].episodes.length, 2);
    assert.deepEqual(result.details[0].episodes[0].lines, []);
    await assert.rejects(probePublicWorks(['1','2','3','4']), /budget/);
    const dry = await probePublicWorks(['123'], { dryRun: true, fetcher: () => { throw Error('network'); } });
    assert.equal(dry.dryRun, true);
    const blocked = await probePublicWorks(['123','124'], { outDir: dir, fetcher: async () => new Response('', { status: 403 }) });
    assert.equal(blocked.failures.length, 1); assert.equal(blocked.details.length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('malformed live pages stop and protected cache refuses writes', async () => {
  const dir = temp();
  try {
    const result = await harvestAi({ outDir: dir, fetcher: async () => new Response(JSON.stringify({ pagecount: 1, list: [{ vod_id: '1', type_id: 39 }] })) });
    assert.equal(result.pages, 0); assert.match(result.failures[0].reason, /type/);
    await assert.rejects(harvestAi({ outDir: path.resolve('edge/cache/harvest'), dryRun: true }), /protected/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
function baseline(file) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE content_items(id TEXT PRIMARY KEY,channel_id TEXT,title TEXT,cover_url TEXT,cover_version TEXT,synopsis TEXT,category TEXT,is_private INT,shareable INT,enabled INT,first_published_at INT,created_at INT,updated_at INT,is_ai INT,is_hot INT,hot_score REAL,custom TEXT);
    CREATE TABLE content_episodes(id INTEGER PRIMARY KEY,content_id TEXT,episode_number INT,title TEXT,duration_seconds INT,created_at INT,updated_at INT);
    CREATE TABLE episode_sources(id INTEGER PRIMARY KEY,episode_id INT,provider_id TEXT,upstream_media_url TEXT,enabled INT,created_at INT,updated_at INT);
    INSERT INTO content_items VALUES('movie_m_old','movie','旧电影','','v1','','动作',0,1,1,10,10,10,0,0,4,'preserve');
    INSERT INTO content_items VALUES('anime_m_gap','anime','断号','','v1','','热血',0,1,1,10,10,10,0,0,4,'preserve');
    INSERT INTO content_episodes VALUES(10,'anime_m_gap',3,'第3集',0,10,10);
    INSERT INTO episode_sources VALUES(10,10,'provider_m1','https://media.invalid/old',1,10,10);`);
  db.close();
}
test('copy merge reuses full schema, preserves all channels and IDs, quarantines gaps, repeats idempotently', () => {
  const dir = temp(), source = path.join(dir, 'old.db'), output = path.join(dir, 'repair.db'), harvest = path.join(dir, 'harvest');
  try {
    baseline(source); fs.mkdirSync(harvest);
    const original = fs.readFileSync(source);
    fs.writeFileSync(path.join(harvest, 't_42_p_1.json'), JSON.stringify(page(1, 1)));
    const dry = mergeLibrary({ sourceDb: source, outDb: output, harvestDir: harvest, dryRun: true });
    assert.equal(dry.before.works, 2); assert.equal(fs.existsSync(output), false);
    const result = mergeLibrary({ sourceDb: source, outDb: output, harvestDir: harvest });
    assert.equal(result.after.works, 3); assert.equal(result.after.episodes, 3); assert.equal(result.after.ai, 1);
    mergeLibrary({ sourceDb: source, outDb: output, harvestDir: harvest });
    const db = new DatabaseSync(output, { readOnly: true });
    assert.equal(db.prepare("SELECT custom FROM content_items WHERE id='movie_m_old'").get().custom, 'preserve');
    assert.deepEqual(db.prepare("SELECT id,episode_number FROM content_episodes WHERE content_id='anime_m_gap'").all().map((r) => [r.id,r.episode_number]), [[10,3]]);
    assert.equal(db.prepare('SELECT count(*) AS n FROM content_episodes').get().n, 3);
    assert.equal(db.prepare("SELECT reason FROM repair_work_status WHERE content_id='movie_m_old'").get().reason, 'zero-episodes');
    assert.equal(db.prepare("SELECT playable FROM repair_work_status WHERE content_id='anime_m_gap'").get().playable, 0);
    assert.equal(db.prepare("SELECT duration_seconds FROM content_episodes WHERE content_id='drama_m_1' LIMIT 1").get().duration_seconds, 0);
    db.close(); assert.deepEqual(fs.readFileSync(source), original);
    assert.throws(() => mergeLibrary({ sourceDb: source, outDb: source, harvestDir: harvest }), /original/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('invalid/private input cannot partially modify an existing output', () => {
  const dir = temp(), source = path.join(dir, 'old.db'), output = path.join(dir, 'repair.db');
  try {
    baseline(source); fs.mkdirSync(path.join(dir, 'harvest'));
    fs.writeFileSync(path.join(dir, 'harvest/t_42_p_1.json'), JSON.stringify({ list: [{ ...page(1).list[0], type_id: 39 }] }));
    assert.throws(() => mergeLibrary({ sourceDb: source, outDb: output, harvestDir: path.join(dir, 'harvest') }), /type/);
    assert.equal(fs.existsSync(output), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
