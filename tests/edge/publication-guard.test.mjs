import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emitAssets, mergeRawsIntoState, emptyState } from '../../edge/scripts/sync-incremental.mjs';
import { validatePublication } from '../../edge/scripts/publication-guard.mjs';
import { buildPublicationEntries } from '../../edge/scripts/sync-incremental.mjs';
import { publishFiles } from '../../edge/scripts/publish.mjs';
const target = { channelId: 'drama', typeId: 38, isPrivate: false, provider: { id: 'provider_m1', shortCode: 'm' } };
test('publication guard verifies blobs and rejects private sources, corruption and missing projection before pointer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-guard-'));
  try {
    const state = emptyState(false);
    const merged = mergeRawsIntoState(state, [{ target, item: { vod_id: 1, vod_name: '真实剧', vod_play_url: '第1集$https://media.invalid/1' } }], 1);
    const emitted = emitAssets(state, merged.resolved, { revision: 2, outDir: dir, nowSeconds: 1, isPrivate: false });
    const manifest = { revision: 2, pageSize: 60, channels: emitted.channels, workFacts: emitted.workFacts,
      coverOrigins: emitted.coverOrigins, publicSearch: emitted.publicSearch };
    const entries = [{ key: 'config:sources', value: '{}' }, { key: 'catalog:manifest', value: JSON.stringify(manifest) }];
    assert.equal(validatePublication(emitted.files, entries, false), true);
    assert.equal(validatePublication(emitted.files, buildPublicationEntries(manifest, {}, false), false), true);
    assert.throws(() => validatePublication(emitted.files, entries, true), /Private publication/);
    assert.throws(() => validatePublication(emitted.files, [...entries].reverse(), false), /last/);
    const file = emitted.files.find((file) => file.key.startsWith('library/facts/'));
    const original = fs.readFileSync(file.file);
    fs.writeFileSync(file.file, '{}');
    assert.throws(() => validatePublication(emitted.files, entries, false), /hash|bytes/);
    fs.writeFileSync(file.file, original);
    assert.throws(() => validatePublication(emitted.files.filter((file) => file.key !== manifest.publicSearch.key), entries, false), /Missing/);
    const bad = JSON.parse(original);
    bad.works.drama_m_1.episodes[0].lines[0].providerId = 'provider_hg1';
    fs.writeFileSync(file.file, JSON.stringify(bad));
    assert.throws(() => validatePublication(emitted.files, entries, false));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mock publication completes all blobs before config and final manifest; config failure prevents pointer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-publish-order-'));
  const oldFetch = globalThis.fetch;
  const oldToken = process.env.CLOUDFLARE_API_TOKEN, oldAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
  process.env.CLOUDFLARE_API_TOKEN = 'mock-token'; process.env.CLOUDFLARE_ACCOUNT_ID = 'mock-account';
  try {
    const state = emptyState(false);
    const merged = mergeRawsIntoState(state, [{ target, item: { vod_id: 1, vod_name: '真实剧', vod_play_url: '第1集$https://media.invalid/1' } }], 1);
    const emitted = emitAssets(state, merged.resolved, { revision: 2, outDir: dir, nowSeconds: 1, isPrivate: false });
    const manifest = { revision: 2, channels: emitted.channels, workFacts: emitted.workFacts, publicSearch: emitted.publicSearch };
    const entries = buildPublicationEntries(manifest, {}, false), completed = [];
    let failConfig = false;
    globalThis.fetch = async (url, options) => {
      assert.equal(options.method, 'PUT');
      const key = decodeURIComponent(url.split('/values/')[1] ?? url.split('/objects/')[1]);
      if (key.startsWith('config:') || key === 'catalog:manifest') {
        assert.equal(completed.filter((entry) => !entry.includes(':')).length, emitted.files.length);
      }
      if (failConfig && key === 'config:sources') return new Response('mock failure', { status: 400 });
      await Promise.resolve(); completed.push(key);
      return new Response('{}', { status: 200 });
    };
    const options = { dryRun: false, publish: true, isPrivate: false, skipState: true };
    await publishFiles(emitted.files, entries, options);
    assert.deepEqual(completed.slice(-2), ['config:sources', 'catalog:manifest']);
    completed.length = 0; failConfig = true;
    await assert.rejects(publishFiles(emitted.files, entries, options), /mock failure/);
    assert.ok(!completed.includes('catalog:manifest'));
  } finally {
    globalThis.fetch = oldFetch;
    if (oldToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = oldToken;
    if (oldAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID; else process.env.CLOUDFLARE_ACCOUNT_ID = oldAccount;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
