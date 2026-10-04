import { describe, expect, it } from 'vitest';
import { createTestEnv } from '../support/test-env';
import { seedContent, seedStandardChannels } from '../support/seed';
import { factsHash } from '../../edge/src/library/work-facts';
import { handleSearch } from '../../edge/src/routes/search';
import { handleSearchSuggestions } from '../../edge/src/routes/search-suggestions';
import { handleRelated } from '../../edge/src/routes/related';
import { handleTitles } from '../../edge/src/routes/titles';
import type { SearchResponse, SuggestionsResponse, RelatedResponse, TitleManifest } from '../../edge/src/types/api';

async function fixture() {
  const env = await createTestEnv();
  seedStandardChannels(env.db);
  seedContent(env.db, { id: 'anime_old', channelId: 'anime', title: '末世求生' });
  const objects = new Map<string, Uint8Array>();
  const gets: string[] = [];
  const descriptor = async (payload: unknown, prefix: string) => {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    const sha256 = await factsHash(bytes), key = `${prefix}/${sha256}.json`;
    objects.set(key, bytes);
    return { key, bytes: bytes.length, sha256 };
  };
  const entries = Array.from({ length: 130 }, (_, i) => ({
    item: { id: `drama_s_${i}`, channelId: 'drama', title: `末世${i}`, category: '求生',
      isPrivate: false, enabled: true, shareable: true, episodeCount: 118, firstPublishedAt: 200 - i },
    aliases: ['生存故事'], pinyin: ['moshi', 'ms'], tags: ['求生']
  }));
  entries.push({ ...entries[0], item: { ...entries[0].item, id: 'drama_s_exact', title: '末世求生', firstPublishedAt: 1 } });
  const packs: Record<string, { key: string; bytes: number; sha256: string }> = {};
  for (const entry of entries) {
    const id = entry.item.id;
    const leaf = await factsHash(new TextEncoder().encode(id));
    packs[leaf] = await descriptor({ schema: 1, works: { [id]: { ...entry.item, workId: id, generatedAt: 0,
      episodes: Array.from({ length: 118 }, (_, i) => ({ episodeNumber: i + 1,
        lines: [{ providerId: 'provider_s1', mediaUrl: `https://media.invalid/${i + 1}.mp4` }] })) } } }, 'library/facts');
  }
  const publicSearch = { schema: 1, count: entries.length,
    ...await descriptor({ schema: 1, revision: 8, entries }, 'library/search') };
  const manifest = { revision: 8, pageSize: 60, channels: { drama: { total: entries.length, chunks: 3 } },
    coverOrigins: [], workFacts: { schema: 1, maxBytes: 524288, packs }, publicSearch };
  await env.KV.put('catalog:manifest', JSON.stringify(manifest));
  env.APK_BUCKET = { get: async (key: string) => {
    gets.push(key); const bytes = objects.get(key);
    return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.buffer } : null;
  } } as unknown as R2Bucket;
  const request = (path: string) => new Request(`https://app.invalid${path}`);
  return { env, objects, gets, manifest, entries, descriptor, request };
}

describe('R26-02 same-generation public retrieval', () => {
  it('finds exact titles beyond 120 broad recalls, excludes D1, retains all 118 episodes', async () => {
    const f = await fixture();
    const response = await handleSearch(f.request('/api/search?q=末世求生'), f.env, f.env.clock);
    expect(response.status).toBe(200);
    const body = await response.json() as SearchResponse;
    expect(body.items[0].item.id).toBe('drama_s_exact');
    expect(body.items[0].item.episodeCount).toBe(118);
    expect(JSON.stringify(body)).not.toContain('anime_old');
    const detail = await handleTitles(f.request('/api/titles/drama_s_exact'), f.env, f.env.clock);
    expect((await detail.json() as TitleManifest).episodes).toHaveLength(118);
    expect(f.gets.length).toBeLessThan(25);
  });
  it('suggestions and related use generation vocabulary, no D1 IDs', async () => {
    const f = await fixture();
    const response = await handleSearchSuggestions(f.request('/api/search/suggestions?q=末世求生'), f.env, f.env.clock);
    expect((await response.json() as SuggestionsResponse).suggestions[0].contentId).toBe('drama_s_exact');
    const related = await handleRelated(f.request('/api/titles/drama_s_exact/related'), f.env, f.env.clock);
    expect(related.status).toBe(200);
    const body = await related.json() as RelatedResponse;
    expect(body.items).toHaveLength(10);
    expect(body.items.every((item: { id: string }) => item.id.startsWith('drama_s_') && item.id !== 'drama_s_exact')).toBe(true);
    expect((await handleRelated(f.request('/api/titles/anime_old/related'), f.env, f.env.clock)).status).toBe(404);
  });
  it.each(['missing', 'corrupt', 'revision', 'private'])('rejects %s projection without legacy fallback', async (mode) => {
    const f = await fixture();
    if (mode === 'missing') f.objects.delete(f.manifest.publicSearch.key);
    if (mode === 'corrupt') f.objects.get(f.manifest.publicSearch.key)![0] ^= 1;
    if (mode === 'revision' || mode === 'private') {
      if (mode === 'private') f.entries[0].item.isPrivate = true;
      Object.assign(f.manifest.publicSearch, await f.descriptor({ schema: 1, revision: mode === 'revision' ? 7 : 8, entries: f.entries }, 'library/search'));
      await f.env.KV.put('catalog:manifest', JSON.stringify(f.manifest));
    }
    const responses = await Promise.all([
      handleSearch(f.request('/api/search?q=末世求生'), f.env, f.env.clock),
      handleSearchSuggestions(f.request('/api/search/suggestions?q=末世求生'), f.env, f.env.clock),
      handleRelated(f.request('/api/titles/drama_s_exact/related'), f.env, f.env.clock)
    ]);
    expect(responses.map((r) => r.status)).toEqual([503, 503, 503]);
  });
  it('missing matching fact fails closed even with a warm projection', async () => {
    const f = await fixture();
    const leaf = await factsHash(new TextEncoder().encode('drama_s_exact'));
    f.objects.delete(f.manifest.workFacts.packs[leaf].key);
    expect((await handleSearch(f.request('/api/search?q=末世求生'), f.env, f.env.clock)).status).toBe(503);
  });
  it('changed pointer never uses cached old projection', async () => {
    const f = await fixture();
    expect((await handleSearch(f.request('/api/search?q=末世求生'), f.env, f.env.clock)).status).toBe(200);
    f.objects.clear();
    f.manifest.revision = 9;
    await f.env.KV.put('catalog:manifest', JSON.stringify(f.manifest));
    expect((await handleSearch(f.request('/api/search?q=末世求生'), f.env, f.env.clock)).status).toBe(503);
  });
});
