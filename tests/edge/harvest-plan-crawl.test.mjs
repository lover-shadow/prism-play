import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planCrawl } from '../../edge/scripts/harvest-all.mjs';

const target = { typeId: 42, channelId: 'drama', isPrivate: false,
  provider: { id: 'provider_m1', baseUrl: 'https://upstream.example/api' } };
const invalidCounts = [undefined, null, 0, -1, 1.5, 'nope', '', true, [], {}];
function fixture(t, first, cachedPages = []) {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harvest-plan-'));
  if (first !== undefined) fs.writeFileSync(path.join(cacheDir, 't_42_p_1.json'), first);
  for (const page of cachedPages) fs.writeFileSync(path.join(cacheDir, `t_42_p_${page}.json`), '{"list":[]}');
  const before = fs.readdirSync(cacheDir).map((name) => [name, fs.readFileSync(path.join(cacheDir, name), 'utf8')]);
  t.after(() => {
    try {
      assert.deepEqual(fs.readdirSync(cacheDir).map((name) => [name, fs.readFileSync(path.join(cacheDir, name), 'utf8')]), before);
    } finally {
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  });
  return cacheDir;
}
function probe(data) {
  const calls = [];
  return { calls, fetch: async (url) => { calls.push(url); return data; } };
}
const pagesOf = (jobs) => jobs.map((job) => job.page);

test('valid integer cache pagecount is reused with zero requests', async (t) => {
  for (const pagecount of [1, 4, '4']) {
    const cacheDir = fixture(t, JSON.stringify({ pagecount }), [2]);
    const request = probe({ pagecount: 99 });
    const jobs = await planCrawl([target], 10, { cacheDir, fetch: request.fetch });
    assert.deepEqual(pagesOf(jobs), Number(pagecount) === 1 ? [] : [3, 4]);
    assert.deepEqual(request.calls, []);
  }
});

test('missing or invalid cache pagecount probes first page and plans only uncached pages', async (t) => {
  for (const pagecount of invalidCounts) {
    const cacheDir = fixture(t, JSON.stringify({ pagecount, list: [] }), [2, 4]);
    const request = probe({ pagecount: '6' });
    const jobs = await planCrawl([target], 10, { cacheDir, fetch: request.fetch });
    assert.deepEqual(pagesOf(jobs), [3, 5, 6]);
    assert.deepEqual(request.calls, ['https://upstream.example/api?ac=detail&t=42&pg=1']);
    assert.equal(jobs[0].typeId, 42);
    assert.equal(jobs[0].url, 'https://upstream.example/api?ac=detail&t=42&pg=3');
  }
});

test('corrupt cache probes without overwriting or deleting the snapshot', async (t) => {
  for (const first of ['{broken', 'null']) {
    const cacheDir = fixture(t, first);
    const request = probe({ pagecount: 3 });
    assert.deepEqual(pagesOf(await planCrawl([target], 10, { cacheDir, fetch: request.fetch })), [2, 3]);
    assert.equal(request.calls.length, 1);
  }
});

test('absent first cache probes and retains page one in pending jobs', async (t) => {
  const cacheDir = fixture(t, undefined, [2]);
  const request = probe({ pagecount: 3 });
  assert.deepEqual(pagesOf(await planCrawl([target], 10, { cacheDir, fetch: request.fetch })), [1, 3]);
  assert.equal(request.calls.length, 1);
});

test('failed probe rejects explicitly instead of succeeding as one page', async (t) => {
  const cacheDir = fixture(t, '{"list":[]}');
  const error = new Error('simulated timeout');
  await assert.rejects(planCrawl([target], 10, { cacheDir, fetch: async () => { throw error; } }),
    (failure) => /tid=42.*pagecount.*simulated timeout/.test(failure.message) && failure.cause === error);
});

test('invalid probe pagecount rejects rather than fabricating a one-page plan', async (t) => {
  const cacheDir = fixture(t, '{"list":[]}');
  for (const pagecount of invalidCounts) {
    await assert.rejects(planCrawl([target], 10, { cacheDir, fetch: probe({ pagecount }).fetch }), /tid=42.*pagecount/);
  }
  await assert.rejects(planCrawl([target], 10, { cacheDir, fetch: probe(null).fetch }), /tid=42.*pagecount/);
});

test('maxPages caps cached and probed counts without scheduling beyond the limit', async (t) => {
  for (const first of ['{"pagecount":9}', '{"list":[]}']) {
    const cacheDir = fixture(t, first, [2]);
    const request = probe({ pagecount: 9 });
    const jobs = await planCrawl([target], 4, { cacheDir, fetch: request.fetch });
    assert.deepEqual(pagesOf(jobs), [3, 4]);
    assert.equal(request.calls.length, first.includes('pagecount') ? 0 : 1);
  }
});
