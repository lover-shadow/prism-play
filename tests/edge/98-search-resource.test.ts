import { describe, expect, it, vi } from 'vitest';
import { createTestEnv } from '../support/test-env';
import { factsHash, readWorkFact } from '../../edge/src/library/work-facts';
import { generationCandidates, generationSearch, generationResults, generationSuggestions, generationRelated } from '../../edge/src/search/generation';
import { covers, coversColumn } from '../../edge/src/search/lexical';
import { indexTokenColumn } from '../../edge/src/core/tokens';

async function fixture(count = 141) {
  const env = await createTestEnv(), objects = new Map<string, Uint8Array>();
  const descriptor = async (payload: unknown, prefix: string) => {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const sha256 = await factsHash(bytes), key = `${prefix}/${sha256}.json`;
    objects.set(key, bytes); return { key, bytes: bytes.length, sha256 };
  };
  const entries = Array.from({ length: count }, (_, i) => ({
    item: { id: `drama_resource_${i}`, title: `末世求生之长篇故事${i}`, channelId: 'drama' as const, category: '求生',
      enabled: true, isPrivate: false, shareable: true, episodeCount: 1, firstPublishedAt: count - i },
    aliases: ['生存故事'], pinyin: ['moshi'], tags: ['求生']
  }));
  const works = Object.fromEntries(entries.map(({ item }) => [item.id, { ...item, workId: item.id, generatedAt: 0,
    episodes: [{ episodeNumber: 1, lines: [{ providerId: 'provider_s1', mediaUrl: 'https://media.invalid/1.mp4' }] }] }]));
  const grouped: Record<string, Record<string, unknown>> = {};
  for (const [id, fact] of Object.entries(works)) {
    const leaf = (await factsHash(new TextEncoder().encode(id))).slice(0, 2);
    (grouped[leaf] ??= {})[id] = fact;
  }
  const packs: Record<string, { key: string; bytes: number; sha256: string }> = {};
  for (const [leaf, values] of Object.entries(grouped)) packs[leaf] = await descriptor({ schema: 1, works: values }, 'library/facts');
  const manifest = { revision: 98, pageSize: 60, channels: { drama: { total: count, chunks: Math.ceil(count / 60) } }, coverOrigins: [],
    workFacts: { schema: 1 as const, maxBytes: 524288 as const, packs },
    publicSearch: { schema: 1 as const, count, ...await descriptor({ schema: 1, revision: 98, entries }, 'library/search') } };
  const get = vi.fn(async (key: string) => {
    const bytes = objects.get(key); return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } : null;
  });
  env.APK_BUCKET = { get } as unknown as R2Bucket;
  const publish = () => env.KV.put('catalog:manifest', JSON.stringify(manifest));
  await publish();
  return { env, entries, works, manifest, get, objects, descriptor, publish };
}

describe('generation search resource regressions', () => {
  it('matches normalized contiguous long prefixes and infixes in display and legacy token columns', () => {
    for (const query of ['末世求生', '求生之长篇', ' ＡＢＣ 末世求生 ']) {
      const title = 'ABC末世求生之长篇故事';
      expect(covers(query, title)).toBe(true);
      expect(coversColumn(query, indexTokenColumn(title))).toBe(true);
    }
    expect(covers('末世求生', '末世重生')).toBe(false);
  });
  it('keeps all candidates, pages 20 past 120, and reuses query compilation', async () => {
    const f = await fixture();
    const generation = (await generationSearch(f.env, 'https://app.invalid'))!;
    const request = { query: '末世' };
    const first = generationCandidates(generation.entries, request);
    expect(first).toHaveLength(141);
    const normalize = vi.spyOn(String.prototype, 'normalize');
    try {
      expect(generationCandidates(generation.entries, request)).toEqual(first);
      expect(normalize.mock.calls.length).toBeLessThan(5);
      const page = await generationResults(f.env, generation, request, 7, 20);
      const body = await page.json() as { items: unknown[]; hasMore: boolean };
      expect(page.status).toBe(200); expect(body.items).toHaveLength(20); expect(body.hasMore).toBe(true);
      const last = await generationResults(f.env, generation, request, 8, 20);
      expect(await last.json()).toMatchObject({ hasMore: false, items: [expect.anything()] });
    } finally { normalize.mockRestore(); }
  });
  it('does not repeat full-corpus normalization on a 21963-work second page', async () => {
    const f = await fixture(1);
    const entries = Array.from({ length: 21963 }, (_, i) => ({ ...f.entries[0],
      item: { ...f.entries[0].item, id: `drama_large_${i}`, title: `末世长篇${i}` } }));
    expect(generationCandidates(entries, { query: '末世' })).toHaveLength(21963);
    const normalize = vi.spyOn(String.prototype, 'normalize');
    try {
      expect(generationCandidates(entries, { query: '末世' }).slice(20, 40)).toHaveLength(20);
      expect(normalize.mock.calls.length).toBeLessThan(5);
    } finally { normalize.mockRestore(); }
  });
  it('evicts bounded fact packs instead of retaining every loaded pack', async () => {
    const f = await fixture(80);
    const descriptors = Object.values(f.manifest.workFacts.packs).slice(0, 33);
    const ids = descriptors.map((pack) => Object.keys(JSON.parse(new TextDecoder().decode(f.objects.get(pack.key))).works)[0]);
    for (const id of ids) expect((await readWorkFact(f.env, f.manifest, id)).status).toBe('ok');
    await readWorkFact(f.env, f.manifest, ids[0]);
    expect(f.get.mock.calls.filter(([key]) => key === descriptors[0].key)).toHaveLength(2);
  });
  it('coalesces a shared fact pack, verifies once, and isolates buckets', async () => {
    const f = await fixture(80);
    const pack = Object.values(f.manifest.workFacts.packs).find((pack) =>
      Object.keys(JSON.parse(new TextDecoder().decode(f.objects.get(pack.key))).works).length > 1)!;
    const members = Object.keys(JSON.parse(new TextDecoder().decode(f.objects.get(pack.key))).works);
    const id = members[0];
    const digest = vi.spyOn(crypto.subtle, 'digest');
    try {
      expect((await Promise.all(members.map((member) => readWorkFact(f.env, f.manifest, member)))).every((r) => r.status === 'ok')).toBe(true);
      expect(f.get.mock.calls.filter(([key]) => key === pack.key)).toHaveLength(1);
      const calls = digest.mock.calls.length;
      await readWorkFact(f.env, f.manifest, id);
      expect(digest.mock.calls.length).toBe(calls);
      expect((await readWorkFact({ ...f.env, APK_BUCKET: { get: async () => null } as unknown as R2Bucket }, f.manifest, id)).status).toBe('rejected');
    } finally { digest.mockRestore(); }
  });
  it('rereads pointers and withdraws warm results while suggestions and related stay authoritative', async () => {
    const f = await fixture(12), origin = 'https://app.invalid';
    const old = (await generationSearch(f.env, origin))!;
    const suggestions = await generationSuggestions(f.env, old, '生存故事');
    expect(suggestions.status).toBe(200);
    expect(await suggestions.json()).toMatchObject({ suggestions: [{ text: '生存故事', type: 'alias' }] });
    const correction = await generationSuggestions(f.env, old, 'mosih');
    expect(await correction.json()).toMatchObject({ suggestions: [{ text: 'moshi', type: 'correction' }] });
    const related = await generationRelated(f.env, old, f.entries[0].item.id);
    expect(related.status).toBe(200);
    expect(await related.json()).toMatchObject({ items: Array.from({ length: 10 }, () => expect.anything()) });
    f.manifest.revision++;
    const entries = f.entries.slice(1);
    f.manifest.channels.drama.total = entries.length;
    Object.assign(f.manifest.publicSearch, { count: entries.length, ...await f.descriptor({ schema: 1, revision: f.manifest.revision, entries }, 'library/search') });
    const id = f.entries[0].item.id, leaf = (await factsHash(new TextEncoder().encode(id))).slice(0, 2);
    const pack = JSON.parse(new TextDecoder().decode(f.objects.get(f.manifest.workFacts.packs[leaf].key)));
    delete pack.works[id];
    f.manifest.workFacts.packs[leaf] = await f.descriptor(pack, 'library/facts'); await f.publish();
    const current = (await generationSearch(f.env, origin))!;
    expect(generationCandidates(current.entries, { query: '末世' })).toHaveLength(11);
    expect((await readWorkFact(f.env, current.manifest, id)).status).toBe('absent');
    expect((await generationRelated(f.env, current, id)).status).toBe(404);
    f.manifest.revision++;
    pack.works[id] = f.works[id];
    f.manifest.workFacts.packs[leaf] = await f.descriptor(pack, 'library/facts');
    expect((await readWorkFact(f.env, f.manifest, id)).status).toBe('ok');
    const other = { ...f.env, APK_BUCKET: { get: async () => null } as unknown as R2Bucket };
    expect(await generationSearch(other, origin)).toBeNull();
  });
  it.each(['sha', 'size', 'shape', 'work-hash'])('fails closed for invalid %s and never caches a failed pack', async (mode) => {
    const f = await fixture(1), id = f.entries[0].item.id;
    const leaf = (await factsHash(new TextEncoder().encode(id))).slice(0, 2);
    const original = f.manifest.workFacts.packs[leaf], bytes = f.objects.get(original.key)!;
    if (mode === 'sha') f.objects.set(original.key, bytes.map((v, i) => i === 0 ? v ^ 1 : v));
    if (mode === 'size') f.objects.set(original.key, bytes.slice(1));
    if (mode === 'shape' || mode === 'work-hash') {
      const works = mode === 'shape' ? { [id]: { ...f.works[id], episodeCount: 2 } } : { wrong_leaf_id: { ...f.works[id], workId: 'wrong_leaf_id', id: 'wrong_leaf_id' } };
      f.manifest.workFacts.packs[leaf] = await f.descriptor({ schema: 1, works }, 'library/facts');
    }
    expect((await readWorkFact(f.env, f.manifest, id)).status).toBe('rejected');
    f.manifest.workFacts.packs[leaf] = original; f.objects.set(original.key, bytes);
    expect((await readWorkFact(f.env, f.manifest, id)).status).toBe('ok');
  });
});
