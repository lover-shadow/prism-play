import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectS1 } from '../../edge/scripts/collect-s1-candidates.mjs';
const totals = { '7688375879554042904': 118, '7687547133393652798': 149, '7688405253909122073': 30 };
const html = (loaderData) => `window._ROUTER_DATA=${JSON.stringify({ loaderData })}`;
test('complete-only candidates, bounded sequential public GETs and sanitized final report', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 's1-collect-'));
  let calls = 0, delays = 0, active = 0, clock = 0, deadline;
  const originalTimeout = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => { assert.equal(ms, 15000); deadline = clock + ms; return new AbortController().signal; };
  try {
    const fetcher = async (url, init) => {
      assert.equal(deadline - clock, 15000);
      clock += 400; assert.ok(clock < deadline);
      calls++; active++; assert.equal(active, 1); assert.equal(init.redirect, 'manual'); assert.equal(init.headers.Cookie, undefined);
      const u = new URL(url); let body;
      if (u.pathname === '/detail') {
        const id = u.searchParams.get('series_id');
        body = html({ detail_page: { seriesDetail: { series_id: id, series_name: '同名剧', episode_cnt: totals[id], vid_list: Array.from({ length: totals[id] }, (_, i) => String(i + 1)) } } });
      } else {
        const [, , series_id, vid] = u.pathname.split('/');
        body = html({ player_page: { series_id, vid, video_player_info: { main_url: 'https://media.example/real.mp4?token=secret' } } });
      }
      active--; return new Response(body);
    };
    const result = await collectS1({ outDir, staging: false, fetcher, sleep: async (ms) => { assert.equal(ms, 1200); clock += ms; delays++; } });
    assert.equal(result.complete, true); assert.equal(result.candidateEpisodes, 297);
    assert.equal(calls, 300); assert.equal(delays, 299);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    const candidates = JSON.parse(fs.readFileSync(path.join(outDir, 's1-candidates.json'))).candidates;
    assert.equal(candidates.length, 3);
    assert.ok(candidates.every((fact) => !fact.classificationEvidence && fact.aiClassification === 'unknown'));
    assert.equal(result.totalRequests, 300);
  } finally { AbortSignal.timeout = originalTimeout; fs.rmSync(outDir, { recursive: true, force: true }); }
});
test('one failed player quarantines only that work and still reads every episode once', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 's1-partial-'));
  let calls = 0;
  try {
    const result = await collectS1({ outDir, sleep: async () => {}, fetcher: async (url) => {
      calls++;
      const u = new URL(url);
      if (u.pathname === '/detail') {
        const id = u.searchParams.get('series_id');
        return new Response(html({ detail_page: { seriesDetail: { series_id: id, series_name: '真实标题', episode_cnt: totals[id], vid_list: Array.from({ length: totals[id] }, (_, i) => String(i + 1)) } } }));
      }
      const [, , series_id, vid] = u.pathname.split('/');
      if (series_id === Object.keys(totals)[0] && vid === '2') return new Response('token=secret', { status: 403 });
      return new Response(html({ player_page: { series_id, vid, video_player_info: { main_url: 'https://media.example/1.mp4' } } }));
    } });
    assert.equal(calls, 300);
    assert.equal(result.candidateWorks, 2);
    assert.equal(result.candidateEpisodes, 179);
    assert.equal(result.works[0].resolvedEpisodes, 117);
    assert.equal(result.works[0].failedEpisodes, 1);
    assert.deepEqual(result.failures[0].episodes.map((f) => [f.episodeNumber, f.reason, f.httpStatus]), [[2, 'http', 403]]);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});
test('explicit staging reuses only identity-bound detail and excludes it from network counts', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 's1-staging-'));
  try {
    const id = Object.keys(totals)[0];
    fs.writeFileSync(path.join(outDir, 's1-detail-staging.json'), JSON.stringify({ id, html: html({ detail_page: { seriesDetail: { series_id: id, series_name: '真实剧', episode_cnt: 118, vid_list: Array.from({ length: 118 }, (_, i) => String(i + 1)) } } }) }));
    const result = await collectS1({ outDir, staging: true, sleep: async () => {}, fetcher: async () => { throw new DOMException('secret', 'TimeoutError'); } });
    assert.equal(result.reusedDetails, 1);
    assert.equal(result.details, 2);
    assert.equal(result.players, 118);
    assert.equal(result.totalRequests, 120);
    assert.equal(result.works[0].failedEpisodes, 118);
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});
test('detail count mismatch is quarantined before any player request', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 's1-count-'));
  try {
    const result = await collectS1({ outDir, sleep: async () => {}, fetcher: async (url) => {
      const u = new URL(url); assert.equal(u.pathname, '/detail');
      return new Response(html({ detail_page: { seriesDetail: { series_id: u.searchParams.get('series_id'), series_name: '真实标题', episode_cnt: 1, vid_list: ['1'] } } }));
    } });
    assert.equal(result.totalRequests, 3);
    assert.equal(result.players, 0);
    assert.ok(result.failures.every((f) => f.reason === 'identity'));
    assert.ok(result.works.every((w) => w.observedEpisodes === 1));
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});
test('mismatched staging identity cannot be reused or trigger players', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 's1-staging-invalid-'));
  try {
    fs.writeFileSync(path.join(outDir, 's1-detail-staging.json'), JSON.stringify({ id: '999', html: 'secret' }));
    const result = await collectS1({ outDir, staging: true, sleep: async () => {}, fetcher: async () => { throw new DOMException('secret', 'TimeoutError'); } });
    assert.equal(result.reusedDetails, 0);
    assert.equal(result.totalRequests, 2);
    assert.equal(result.players, 0);
    assert.equal(result.failures[0].reason, 'identity');
    assert.equal(JSON.stringify(result).includes('secret'), false);
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});
test('previous report and candidates are backed up verbatim before requests', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 's1-backup-'));
  try {
    for (const name of ['s1-candidates.json', 's1-candidates-report.json']) fs.writeFileSync(path.join(outDir, name), 'previous');
    await collectS1({ outDir, fetcher: async () => {
      const backups = fs.readdirSync(outDir).filter((name) => name.endsWith('.bak'));
      assert.equal(backups.length, 2);
      assert.ok(backups.every((name) => fs.readFileSync(path.join(outDir, name), 'utf8') === 'previous'));
      throw new DOMException('secret', 'TimeoutError');
    }, sleep: async () => {} });
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});
test('timeouts never retry, failed works isolated without partial media', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 's1-block-')); let calls = 0;
  try {
    const result = await collectS1({ outDir, staging: false, fetcher: async () => { calls++; throw new DOMException('sensitive media token', 'TimeoutError'); }, sleep: async () => {} });
    assert.equal(calls, 3); assert.equal(result.complete, false); assert.equal(result.failures.length, 3);
    assert.equal(JSON.stringify(result).includes('sensitive'), false);
    assert.equal(result.totalRequests, 3);
    assert.ok(result.failures.every((failure) => failure.reason === 'timeout'));
    assert.equal(result.works.length, 3);
    assert.equal(JSON.parse(fs.readFileSync(path.join(outDir, 's1-candidates.json'))).candidates.length, 0);
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
});
