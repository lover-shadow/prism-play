import { describe, expect, it } from 'vitest';
import { createTestEnv } from '../support/test-env';
import { seedContent, seedEpisode, seedStandardChannels } from '../support/seed';
import { factsHash } from '../../edge/src/library/work-facts';
import { validatePublicManifest } from '../../edge/src/library/manifest';
import { handleTitles } from '../../edge/src/routes/titles';
import { handleShare } from '../../edge/src/routes/share';
import { handleProxy } from '../../edge/src/routes/proxy';

const id = 'd_fact', origin = 'https://covers.invalid';
async function fixture(overrides: Record<string, unknown> = {}, corrupt = false) {
  const env = await createTestEnv();
  seedStandardChannels(env.db);
  seedContent(env.db, { id, channelId: 'drama', title: '旧 D1 标题', coverUrl: 'https://old.invalid/old.jpg' });
  seedEpisode(env.db, id, 1, 30);
  const fact = { id, workId: id, title: '事实标题', channelId: 'drama', category: '都市', isPrivate: false,
    enabled: true, shareable: true, coverTargetUrl: `${origin}/real.jpg`, coverVersion: 'fact-v2', generatedAt: 0,
    episodes: [{ episodeNumber: 7, title: '精确第七集', durationSeconds: 77, lines: [{ providerId: 'provider_s1', mediaUrl: 'https://play.invalid/7.mp4' }] }], ...overrides };
  const bytes = new TextEncoder().encode(JSON.stringify({ schema: 1, works: { [id]: fact } }));
  const hash = await factsHash(bytes), leaf = (await factsHash(new TextEncoder().encode(id))).slice(0, 2);
  const manifest = { revision: 1, pageSize: 60, channels: { drama: { chunks: 1, total: 1 } }, coverOrigins: [origin],
    workFacts: { schema: 1, maxBytes: 524288, packs: { [leaf]: { key: `library/facts/${hash}.json`, bytes: bytes.length, sha256: hash } } } };
  await env.KV.put('catalog:manifest', JSON.stringify(manifest));
  const gets: string[] = [], calls: string[] = [];
  env.APK_BUCKET = { get: async (key: string) => { gets.push(key); return { size: bytes.length, arrayBuffer: async () => {
    const result = bytes.slice(); if (corrupt) result[0] ^= 1; return result.buffer;
  } }; } } as unknown as R2Bucket;
  const fetcher = { fetch: async (url: string) => { calls.push(url); return new Response('poster', { headers: { 'Content-Type': 'image/jpeg' } }); } };
  const responses = async (workId = id) => Promise.all([
    handleTitles(new Request(`https://app.invalid/api/titles/${workId}`), env, env.clock),
    handleShare(new Request(`https://app.invalid/s/${workId}?ep=7`), env, env.clock),
    handleProxy(new Request(`https://app.invalid/proxy/img/${workId}`), env, env.clock, { fetcher })
  ]);
  return { env, manifest, responses, gets, calls, fetcher };
}

describe('public work facts: one verified source for titles/share/poster', () => {
  it('ignores contradictory D1 and projects the same fact into all three routes', async () => {
    const f = await fixture();
    const result = await f.responses();
    expect(result.map((r) => r.status)).toEqual([200, 200, 200]);
    const title = await result[0].text(), share = await result[1].text();
    expect(title).toContain('事实标题'); expect(share).toContain('事实标题');
    expect(title).not.toContain('coverTargetUrl'); expect(title).not.toContain(origin);
    expect(title).not.toContain('旧 D1 标题'); expect(share).toContain('精确第七集');
    expect(f.calls).toEqual([`${origin}/real.jpg`]);
    expect(result[2].headers.get('ETag')).toBe('"img-d_fact-fact-v2"');
    expect(f.gets).toHaveLength(3); expect(new Set(f.gets).size).toBe(1);
    expect((await handleShare(new Request(`https://app.invalid/s/${id}?ep=1`), f.env, f.env.clock)).status).toBe(404);
  });
  it.each([{ enabled: false }, { isPrivate: true }, { channelId: 'private' }])('hides disabled/private entries %j', async (flags) => {
    const f = await fixture(flags);
    const responses = await f.responses();
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404]);
    expect(new Set(await Promise.all(responses.map((r) => r.text()))).size).toBe(1);
    expect(f.calls).toEqual([]);
  });
  it('unknown ids are uniformly 404', async () => {
    const f = await fixture();
    expect((await f.responses('unknown')).map((r) => r.status)).toEqual([404, 404, 404]);
  });
  it('hash corruption is 503 on every route, never D1 fallback', async () => {
    const f = await fixture({}, true);
    expect((await f.responses()).map((r) => r.status)).toEqual([503, 503, 503]);
    expect(f.calls).toEqual([]);
  });
  it.each([{ episodeCount: 2 }, { episodes: [{ episodeNumber: 7, lines: [] }, { episodeNumber: 7, lines: [] }] }, { workId: 'other' }])('rejects malformed fact %j', async (raw) => {
    expect((await (await fixture(raw)).responses()).map((r) => r.status)).toEqual([503, 503, 503]);
  });
  it('unshareable works remain available to titles/poster only', async () => {
    expect((await (await fixture({ shareable: false })).responses()).map((r) => r.status)).toEqual([200, 404, 200]);
  });
  it('checks redirects against manifest origins, not the requested URL', async () => {
    const f = await fixture(), calls: string[] = [];
    const response = await handleProxy(new Request(`https://app.invalid/proxy/img/${id}`), f.env, f.env.clock, {
      fetcher: { fetch: async (url) => { calls.push(url); return new Response(null, { status: 302, headers: { Location: 'https://unauthorized.invalid/image.jpg' } }); } }
    });
    expect(response.status).toBe(403); expect(calls).toHaveLength(1);
    f.manifest.coverOrigins = ['https://different.invalid'];
    await f.env.KV.put('catalog:manifest', JSON.stringify(f.manifest));
    expect((await f.responses())[2].status).toBe(403);
    expect(f.calls).toEqual([]);
  });
  it('allows only explicitly trusted redirect hops and preserves ETag revalidation', async () => {
    const f = await fixture(), calls: string[] = [];
    const response = await handleProxy(new Request(`https://app.invalid/proxy/img/${id}`), f.env, f.env.clock, {
      fetcher: { fetch: async (url, init) => {
        calls.push(url); expect(init?.redirect).toBe('manual');
        return calls.length === 1 ? new Response(null, { status: 302, headers: { Location: `${origin}/next.jpg` } }) : new Response('image');
      } }
    });
    expect(response.status).toBe(200); expect(calls).toEqual([`${origin}/real.jpg`, `${origin}/next.jpg`]);
    const cached = await handleProxy(new Request(`https://app.invalid/proxy/img/${id}`, { headers: { 'If-None-Match': '"img-d_fact-fact-v2"' } }), f.env, f.env.clock, { fetcher: f.fetcher });
    expect(cached.status).toBe(304); expect(f.calls).toEqual([]);
  });
  it('rejects declared byte mismatches, missing objects and wrong pack schemas', async () => {
    const f = await fixture();
    const pack = Object.values(f.manifest.workFacts.packs)[0];
    pack.bytes++;
    await f.env.KV.put('catalog:manifest', JSON.stringify(f.manifest));
    expect((await f.responses()).map((r) => r.status)).toEqual([503, 503, 503]);
    f.env.APK_BUCKET = { get: async () => null } as unknown as R2Bucket;
    expect((await f.responses()).map((r) => r.status)).toEqual([503, 503, 503]);
    const bytes = new TextEncoder().encode(JSON.stringify({ schema: 2, works: {} })), hash = await factsHash(bytes);
    Object.assign(pack, { key: `library/facts/${hash}.json`, sha256: hash, bytes: bytes.length });
    await f.env.KV.put('catalog:manifest', JSON.stringify(f.manifest));
    f.env.APK_BUCKET = { get: async () => ({ size: bytes.length, arrayBuffer: async () => bytes.buffer }) } as unknown as R2Bucket;
    expect((await f.responses()).map((r) => r.status)).toEqual([503, 503, 503]);
  });
  it('rejects non-prefix-free indexes, inconsistent keys, size caps and non-origins', async () => {
    const { manifest } = await fixture();
    const [leaf, pack] = Object.entries(manifest.workFacts.packs)[0];
    expect(validatePublicManifest({ ...manifest, workFacts: { ...manifest.workFacts, packs: { [leaf]: pack, [`${leaf}ab`]: pack } } })).toBeNull();
    expect(validatePublicManifest({ ...manifest, workFacts: { ...manifest.workFacts, maxBytes: 1 } })).toBeNull();
    expect(validatePublicManifest({ ...manifest, workFacts: { ...manifest.workFacts, packs: { [leaf]: { ...pack, key: 'library/facts/wrong.json' } } } })).toBeNull();
    expect(validatePublicManifest({ ...manifest, coverOrigins: [`${origin}/path`] })).toBeNull();
  });
});
