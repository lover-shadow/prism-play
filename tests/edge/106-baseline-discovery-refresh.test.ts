import { describe, expect, it, vi } from 'vitest';
import { asD1, createInMemoryD1 } from '../support/sqlite-d1';
import { discoveryWorkId, validateDiscoveryFact } from '../../edge/src/search/discovery-facts';
import { publishDiscoveryFact, readDiscoveryFact, readDiscoveryChanges, type DiscoveryContext } from '../../edge/src/search/discovery-store';
import { createDiscoveryService } from '../../edge/src/search/discovery-service';
import { publicDiscoveryContext, readPublicFact } from '../../edge/src/search/public-facts';
import { factsHash } from '../../edge/src/library/work-facts';
import type { Env } from '../../edge/src/types/env';
import type { CatalogManifest } from '../../edge/src/library/manifest';
import type { DiscoveryProvider } from '../../edge/src/search/discovery-provider';
import { searchWithDiscovery } from '../../edge/src/routes/search-discovery';
import { itemFromAsset } from '../../edge/src/library/title-asset';

async function fixture() {
  const sqlite = createInMemoryD1(), DB = asD1(sqlite), objects = new Map<string, Uint8Array>();
  const bucket = { get: vi.fn(async (key: string) => {
    const bytes = objects.get(key);
    return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } : null;
  }), put: vi.fn(async (key: string, bytes: Uint8Array) => { objects.set(key, bytes.slice()); return { key }; }) } as unknown as R2Bucket;
  const id = 'drama_s_123', episodes = (count: number) => Array.from({ length: count }, (_, i) => ({
    episodeNumber: i + 1, title: `第${i + 1}集`, mediaValidation: 'url-only-not-playback-verified' as const,
    lines: [{ providerId: 'provider_s1' as const, mediaUrl: `https://media.invalid/${i + 1}.mp4` }] }));
  const raw = { workId: id, title: '公共故事', channelId: 'drama' as const, category: '', generatedAt: 0,
    enabled: true as const, isPrivate: false as const, shareable: true as const, episodeCount: 2, episodes: episodes(2) };
  const base = validateDiscoveryFact(raw, id)!.fact;
  let now = 100;
  const authority = vi.fn<DiscoveryContext['authority']>(async () => ({ authoritative: true, read: { status: 'ok', fact: base }, overlayEligible: true, canonicalId: id }));
  const context: DiscoveryContext = { bindings: { DB, DISCOVERY_BUCKET: bucket }, authority, nowSeconds: () => now };
  const fresh = { ...raw, generatedAt: 100, episodeCount: 3, episodes: episodes(3) };
  const publish = (value = fresh) => publishDiscoveryFact(context, 'provider_s1', '123', value, now, 100, id);
  return { sqlite, DB, bucket, objects, id, raw, fresh, base, context, authority, publish, setClock: (v: number) => { now = v; } };
}

describe('stable baseline discovery refresh', () => {
  it('publishes complete newer overlay under baseline ID and emits an upsert, then expires back to base', async () => {
    const f = await fixture();
    expect(await f.publish()).toEqual({ status: 'published', workId: f.id });
    expect(await readDiscoveryFact(f.context, f.id, 101)).toMatchObject({ status: 'ok', fact: { row: { episode_count: 3 } } });
    expect((await readDiscoveryChanges(f.context, 0, 101)).changes[0]).toMatchObject({ operation: 'upsert', card: { id: f.id, episodeCount: 3 } });
    f.setClock(200);
    expect(await readDiscoveryFact(f.context, f.id, 200)).toMatchObject({ status: 'ok', fact: { row: { episode_count: 2 } } });
  });
  it.each(['fewer', 'title', 'channel', 'incomplete', 'old'])('does not publish unsafe baseline replacement: %s', async (mode) => {
    const f = await fixture(), raw = structuredClone(f.fresh);
    if (mode === 'fewer') { raw.episodeCount = 1; raw.episodes = raw.episodes.slice(0, 1); }
    if (mode === 'title') raw.title = '其他故事';
    if (mode === 'channel') raw.channelId = 'movie' as never;
    if (mode === 'incomplete') raw.episodes.pop();
    if (mode === 'old') raw.generatedAt = 0;
    expect((await f.publish(raw)).status).toBe('rejected');
    expect(f.sqlite.count('discovery_works')).toBe(0);
  });
  it('accepts m1 channel-bound canonical IDs without changing hashed store defaults', async () => {
    const f = await fixture(), id = 'anime_m_123';
    f.context.authority = async () => ({ authoritative: false });
    const raw = { ...f.fresh, workId: id, channelId: 'anime' };
    expect((await publishDiscoveryFact(f.context, 'provider_m1', '123', raw, 100, 100, id)).status).toBe('published');
    expect((await readDiscoveryFact(f.context, id, 101)).status).toBe('ok');
    expect((await publishDiscoveryFact(f.context, 'provider_s1', '123', raw, 100, 100, id)).status).toBe('rejected');
  });
  it('disabled baselines deny overlays even if eligibility is mistakenly marked true', async () => {
    const f = await fixture(); f.base.row.enabled = 0;
    expect((await f.publish()).status).toBe('baseline');
    expect(f.sqlite.count('discovery_works')).toBe(0);
  });
  it('corrupt overlays fall back and a baseline denial during object IO blocks publication', async () => {
    const f = await fixture(); await f.publish();
    const key = [...f.objects.keys()][0]; f.objects.set(key, new Uint8Array([0]));
    expect(await readDiscoveryFact(f.context, f.id, 101)).toMatchObject({ status: 'ok', fact: { row: { episode_count: 2 } } });
    const g = await fixture();
    vi.mocked(g.bucket.put).mockImplementationOnce(async () => {
      g.authority.mockResolvedValue({ authoritative: true, read: { status: 'absent' } });
      return {} as never;
    });
    expect((await g.publish()).status).toBe('baseline');
    expect(g.sqlite.count('discovery_works')).toBe(0);
  });
  it('keeps authoritative denials and canonical source mismatch closed', async () => {
    const f = await fixture(); await f.publish();
    f.authority.mockResolvedValue({ authoritative: true, read: { status: 'rejected' } });
    expect((await readDiscoveryFact(f.context, f.id, 101)).status).toBe('rejected');
    expect((await f.publish()).status).toBe('baseline');
    expect((await publishDiscoveryFact(f.context, 'provider_s1', '124', f.fresh, 100, 100, f.id)).status).toBe('rejected');
  });
  it('refreshes stale baseline once, reuses fresh facts after query TTL and refreshes after fact expiry', async () => {
    const f = await fixture(), candidate = { providerId: 'provider_s1' as const, sourceItemId: '123', id: f.id, title: f.raw.title, channelId: 'drama' as const };
    const provider: DiscoveryProvider = { id: 'provider_s1', search: vi.fn(async () => [candidate]),
      resolve: vi.fn(async () => ({ status: 'complete' as const, fact: { ...f.fresh, ...candidate } })) };
    const service = createDiscoveryService(f.context, [provider]), request = new Request('https://app.invalid/search');
    expect(await service.query('公共故事', 1, request)).toMatchObject({ failed: false, items: [{ item: { id: f.id, episodeCount: 3 } }] });
    f.setClock(401); await service.query('公共故事', 1, request);
    expect(provider.resolve).toHaveBeenCalledTimes(1);
    f.setClock(86501); await service.query('公共故事', 1, request);
    expect(provider.resolve).toHaveBeenCalledTimes(2);
  });
  it('public helper uses overlay first and strict provider identity while default store hashes remain unchanged', async () => {
    const f = await fixture(), bytes = new TextEncoder().encode(JSON.stringify({ schema: 1, works: { [f.id]: f.raw } }));
    const leaf = (await factsHash(new TextEncoder().encode(f.id))).slice(0, 2), key = 'base.json';
    const baseBucket = { get: async () => ({ size: bytes.length, arrayBuffer: async () => bytes.buffer }) } as unknown as R2Bucket;
    const manifest = { revision: 106, workFacts: { packs: { [leaf]: { key, bytes: bytes.length, sha256: await factsHash(bytes) } } } } as unknown as CatalogManifest;
    const env = { DB: f.DB, APK_BUCKET: baseBucket, DISCOVERY_BUCKET: f.bucket } as Env;
    const context = publicDiscoveryContext(env, manifest, () => 100);
    expect(await context.authority({ workId: f.id, providerId: 'provider_m1', sourceId: '123' })).toMatchObject({ authoritative: true, read: { status: 'rejected' } });
    expect((await publishDiscoveryFact(context, 'provider_s1', '123', f.fresh, 100, 100, f.id)).status).toBe('published');
    expect(await readPublicFact(env, manifest, f.id, 101)).toMatchObject({ status: 'ok', fact: { row: { episode_count: 3 } } });
    const response = await searchWithDiscovery(new Request('https://app.invalid/api/search?q=公共故事'), env,
      { nowSeconds: () => 101, nowMillis: () => 101000 },
      { manifest, entries: [{ item: { ...itemFromAsset(f.base.asset), enabled: true, shareable: true }, aliases: [], pinyin: [], tags: [] }] },
      { query: '公共故事' }, 1, 20, 1);
    expect(await response.json()).toMatchObject({ items: [{ item: { id: f.id, episodeCount: 3 } }] });
    expect(await discoveryWorkId('provider_s1', '123')).toMatch(/^discovery_/);
  });
});
