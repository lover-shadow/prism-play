import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mergeS1, validateCandidates } from '../../edge/scripts/merge-s1.mjs';
const fact = (id = '123') => ({ id: `drama_s_${id}`, workId: `drama_s_${id}`, sourceItemId: id, providerId: 'provider_s1', title: '同名剧', channelId: 'drama', category: '都市', isPrivate: false, enabled: true, shareable: true, episodeCount: 1, classificationEvidence: { category: 'ai-drama', basis: 'authorized-category-screenshot' }, episodes: [{ episodeNumber: 1, sourceEpisodeId: `${id}1`, title: '第1集', lines: [{ providerId: 'provider_s1', mediaUrl: 'https://media.example/real.mp4' }] }] });
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE content_items(id TEXT PRIMARY KEY,channel_id TEXT,title TEXT,cover_url TEXT,cover_version TEXT,synopsis TEXT,category TEXT,is_private INT,shareable INT,enabled INT,first_published_at INT,created_at INT,updated_at INT,is_ai INT,is_hot INT,hot_score REAL);
  CREATE TABLE content_episodes(id INTEGER PRIMARY KEY,content_id TEXT,episode_number INT,title TEXT,duration_seconds INT,created_at INT,updated_at INT);
  CREATE TABLE episode_sources(id INTEGER PRIMARY KEY,episode_id INT,provider_id TEXT,upstream_media_url TEXT,enabled INT,created_at INT,updated_at INT);`);
  return db;
}
test('independent IDs, exact episodes, unknown duration zero, AI category evidence, idempotent sources', () => {
  const db = fixture();
  try {
    const input = { candidates: [fact(), fact('456')] };
    mergeS1(db, input, 10); mergeS1(db, input, 11);
    assert.equal(db.prepare('SELECT count(*) n FROM content_items').get().n, 2);
    assert.equal(db.prepare('SELECT count(*) n FROM episode_sources').get().n, 2);
    assert.equal(db.prepare('SELECT duration_seconds FROM content_episodes LIMIT 1').get().duration_seconds, 0);
    assert.equal(db.prepare('SELECT is_ai FROM content_items LIMIT 1').get().is_ai, 1);
    assert.equal(db.prepare('SELECT source_episode_id FROM s1_episode_identity WHERE content_id=?').get('drama_s_123').source_episode_id, '1231');
  } finally { db.close(); }
});
test('reject partial, private, duplicate, unsafe URL, missing classification evidence before transaction', () => {
  for (const change of [{ episodeCount: 2 }, { isPrivate: true }, { providerId: 'provider_m1' }, { classificationEvidence: undefined }, { episodes: [] }]) {
    assert.throws(() => validateCandidates({ candidates: [{ ...fact(), ...change }] }));
  }
  assert.throws(() => validateCandidates({ candidates: [fact(), fact()] }));
  const f = fact(); f.episodes[0].lines[0].mediaUrl = 'http://media.example/1';
  assert.throws(() => validateCandidates({ candidates: [f] }));
});
test('CLI dry-run accepts candidates without opening database; protects original and unsupported options', () => {
  const cli = fileURLToPath(new URL('../../edge/scripts/merge-s1.mjs', import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  const dry = run('--dry-run');
  assert.equal(dry.status, 0);
  assert.equal(JSON.parse(dry.stdout).dryRun, true);
  assert.equal(run('--db=D:/DEV/prism-play/build/library_full.db').status, 1);
  assert.equal(run('--publish').status, 1);
});
test('transaction rollback preserves previous works on late identity conflict', () => {
  const db = fixture();
  try {
    mergeS1(db, { candidates: [fact('456')] });
    db.prepare('UPDATE content_items SET is_private=1 WHERE id=?').run('drama_s_456');
    assert.throws(() => mergeS1(db, { candidates: [fact(), fact('456')] }));
    assert.equal(db.prepare('SELECT count(*) n FROM content_items').get().n, 1);
  } finally { db.close(); }
});
