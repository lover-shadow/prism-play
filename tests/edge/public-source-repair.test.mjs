import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as provider from '../../edge/scripts/public-provider.mjs';
import * as daily from '../../edge/scripts/daily-facts.mjs';
import { PROVIDERS } from '../../edge/scripts/config-sources.mjs';
import { parseCliArgs } from '../../edge/scripts/sync-incremental.mjs';
import { buildWorkFactPacks } from '../../edge/scripts/work-fact-packs.mjs';
const html = (page) => `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: page })};</script>`;
const detail = () => provider.parsePublicDetail(html({ detail_page: { seriesDetail: {
  series_id: '123', series_name: '真实剧', episode_cnt: 2, vid_list: ['901', '902']
} } }), '123');
const player = (vid, info = { main_url: `https://media.invalid/${vid}.mp4` }) => html({ player_page: {
  series_id: '123', vid, video_player_info: info
} });

test('daily CLI exposes explicit offline generation and candidate inputs', () => {
  const cli = parseCliArgs(['--dry-run', '--bootstrap-manifest=D:/local/manifest.json',
    '--bootstrap-root=D:/local/mirror', '--public-results=D:/local/results.json']);
  assert.equal(cli.bootstrapManifest, 'D:/local/manifest.json');
  assert.equal(cli.bootstrapRoot, 'D:/local/mirror');
  assert.equal(cli.publicResultsFile, 'D:/local/results.json');
});
test('s1 configuration is public but never dispatched as macCMS', () => {
  const config = PROVIDERS.find((p) => p.id === 'provider_s1');
  assert.equal(config?.privacy, 'public');
  assert.equal(config.crawlable, false);
  assert.equal(config.adapter, 'public-router');
});
test('controlled player resolution preserves IDs and imports complete facts', async () => {
  const calls = [];
  const result = await provider.resolvePublicDetail(detail(), { maxEpisodeRequests: 2,
    fetcher: async (url, init) => { calls.push(url); assert.equal(init.headers.Cookie, undefined);
      return new Response(player(url.split('/').at(-1))); } });
  assert.equal(result.status, 'candidate');
  assert.equal(result.fact.episodes[1].sourceEpisodeId, '902');
  assert.equal(result.fact.episodes[1].lines[0].mediaUrl, 'https://media.invalid/902.mp4');
  const state = { revision: 1, isPrivate: false, works: {} };
  const merged = daily.importPublicResults(state, [result], 100);
  assert.equal(merged.added, 1);
  assert.equal(state.works.drama_s_123.fact.episodes.length, 2);
  assert.equal(calls.length, 2);
});
test('mismatched, encrypted, unauthorized and budget-limited episodes remain blocked', async () => {
  for (const response of [() => new Response(player('999')),
    () => new Response(player('901', { main_url: 'https://media.invalid/1', kid: 'secret' })),
    () => new Response('', { status: 401 }), () => new Response(player('901', {}))]) {
    const result = await provider.resolvePublicDetail(detail(), { maxEpisodeRequests: 2, fetcher: async () => response() });
    assert.equal(result.status, 'blocked');
    assert.equal(result.fact, undefined);
  }
  let calls = 0;
  const result = await provider.resolvePublicDetail(detail(), { fetcher: async () => { calls++; } });
  assert.equal(result.status, 'blocked');
  assert.equal(calls, 0);
});
test('failed refresh leaves previous complete work intact; privacy and gaps cannot import', async () => {
  const fact = { ...detail(), episodes: detail().episodes.map((ep) => ({ ...ep,
    lines: [{ providerId: 'provider_s1', mediaUrl: 'https://media.invalid/a.mp4' }] })) };
  const state = { revision: 1, isPrivate: false, works: {} };
  daily.importPublicResults(state, [{ status: 'candidate', fact }], 100);
  const previous = state.works.drama_s_123;
  daily.importPublicResults(state, [{ status: 'blocked', id: fact.id }], 101);
  assert.equal(state.works.drama_s_123, previous);
  for (const altered of [{ ...fact, isPrivate: true }, { ...fact, providerId: 'provider_hg1' },
    { ...fact, episodes: [{ ...fact.episodes[0], episodeNumber: 2 }, fact.episodes[1]] },
    { ...fact, episodes: fact.episodes.map((ep) => ({ ...ep, lines: [] })) }]) {
    assert.throws(() => daily.importPublicResults(state, [{ status: 'candidate', fact: altered }], 102));
  }
});
test('player rejects private origins and path suffix tricks before network access', async () => {
  assert.throws(() => provider.parsePublicPlayer(player('901', { main_url: 'https://huangguoai.com/a.mp4' }), '123', '901'));
  let calls = 0;
  await assert.rejects(provider.publicGet('/player/123/901/extra', async () => { calls++; return new Response(''); }));
  assert.equal(calls, 0);
});
test('local bootstrap verifies hashes and generation and preserves untouched library', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-bootstrap-'));
  try {
    const fact = { id: 'drama_m_1', workId: 'drama_m_1', title: '旧剧', channelId: 'drama', category: '都市',
      isPrivate: false, enabled: true, shareable: true, episodeCount: 1,
      episodes: [{ episodeNumber: 1, lines: [{ providerId: 'provider_m1', mediaUrl: 'https://media.invalid/a' }] }] };
    const packed = buildWorkFactPacks(new Map([[fact.id, fact]]));
    for (const object of packed.objects) {
      fs.mkdirSync(path.dirname(path.join(dir, object.key)), { recursive: true });
      fs.writeFileSync(path.join(dir, object.key), object.value);
    }
    const manifest = { revision: 7, channels: { drama: { total: 1 } }, workFacts: packed.workFacts };
    const state = daily.bootstrapDailyState(manifest, dir, { expectedRevision: 7 });
    assert.equal(state.revision, 7);
    assert.equal(state.works.drama_m_1.fact.workId, fact.id);
    daily.importPublicResults(state, [{ status: 'candidate', fact: { ...detail(),
      episodes: detail().episodes.map((ep) => ({ ...ep, lines: [{ providerId: 'provider_s1', mediaUrl: 'https://media.invalid/a' }] })) } }], 100);
    const emitted = daily.emitDailyFacts(state, [], { revision: 8, outDir: dir, nowSeconds: 100 });
    assert.equal(emitted.publicSearch.count, 2);
    assert.throws(() => daily.bootstrapDailyState(manifest, dir, { expectedRevision: 8 }), /generation/);
    fs.appendFileSync(path.join(dir, packed.objects[0].key), ' ');
    assert.throws(() => daily.bootstrapDailyState(manifest, dir), /hash|bytes/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
