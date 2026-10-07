import { describe, expect, it, vi } from 'vitest';
import { asD1, createInMemoryD1 } from '../support/sqlite-d1';
import { createDiscoveryService } from '../../edge/src/search/discovery-service';
import { readDiscoveryConfig, createDiscoveryProviders } from '../../edge/src/search/discovery-config';
import { createDiscoveryContext } from '../../edge/src/search/discovery-runtime';
import { acquireDiscoveryLease, discoveryQueryKey } from '../../edge/src/search/discovery-query';
import type { DiscoveryContext } from '../../edge/src/search/discovery-store';
import type { DiscoveryCandidate, DiscoveryProvider, DiscoveryPublicFact } from '../../edge/src/search/discovery-provider';
import type { Env } from '../../edge/src/types/env';

function fixture() {
  const sqlite = createInMemoryD1(), DB = asD1(sqlite), objects = new Map<string, Uint8Array>();
  const bucket = {
    get: vi.fn(async (key: string) => {
      const bytes = objects.get(key);
      return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } : null;
    }),
    put: vi.fn(async (key: string, bytes: Uint8Array) => { objects.set(key, bytes.slice()); return { key }; })
  } as unknown as R2Bucket;
  let clock = 100;
  const authority = vi.fn<DiscoveryContext['authority']>(async () => ({ authoritative: false }));
  const context: DiscoveryContext = { bindings: { DB, DISCOVERY_BUCKET: bucket }, authority, nowSeconds: () => clock };
  const candidate: DiscoveryCandidate = { providerId: 'provider_s1', sourceItemId: '123', id: 'drama_s_123', title: '公共故事', channelId: 'drama' };
  const fact: DiscoveryPublicFact = { ...candidate, workId: candidate.id, enabled: true, isPrivate: false,
    shareable: true, generatedAt: 0, episodeCount: 1, episodes: [{ episodeNumber: 1, title: '第1集',
      mediaValidation: 'url-only-not-playback-verified', lines: [{ providerId: 'provider_s1', mediaUrl: 'https://media.invalid/1.mp4' }] }] };
  const provider: DiscoveryProvider = { id: 'provider_s1', search: vi.fn(async () => [candidate]),
    resolve: vi.fn(async () => ({ status: 'complete' as const, fact })) };
  const service = createDiscoveryService(context, [provider]);
  const request = new Request('https://app.invalid/search', { headers: { 'CF-Connecting-IP': '192.0.2.1' } });
  return { sqlite, DB, context, provider, candidate, fact, service, request, authority,
    setClock: (value: number) => { clock = value; } };
}

describe('discovery service bounded query interface', () => {
  it('publishes full facts with canonical identity and empty category, then shares D1 query cache', async () => {
    const f = fixture();
    const result = await f.service.query('公共故事', 1, f.request);
    expect(result).toMatchObject({ pending: false, failed: false, items: [{ item: { id: f.candidate.id, category: '' } }] });
    expect(JSON.stringify(result)).not.toMatch(/media\.invalid|provider_s1|sourceItemId/);
    expect(f.sqlite.count('discovery_works')).toBe(1);
    await createDiscoveryService(f.context, [f.provider]).query('公共故事', 1, f.request);
    expect(f.provider.search).toHaveBeenCalledTimes(1);
    expect(f.sqlite.count('discovery_leases')).toBe(0);
  });
  it('reuses a fresh candidate fact after query TTL, resolving again only after fact TTL', async () => {
    const f = fixture(); await f.service.query('公共故事', 1, f.request);
    f.setClock(401); await f.service.query('公共故事', 1, f.request);
    expect(f.provider.search).toHaveBeenCalledTimes(2);
    expect(f.provider.resolve).toHaveBeenCalledTimes(1);
    f.setClock(86501); await f.service.query('公共故事', 1, f.request);
    expect(f.provider.resolve).toHaveBeenCalledTimes(2);
  });
  it('exposes progress without publishing incomplete facts or caching query success', async () => {
    const f = fixture();
    vi.mocked(f.provider.resolve).mockResolvedValue({ status: 'progress', cursor: JSON.stringify({ next: 7 }),
      state: { version: 1, candidate: f.candidate, fact: f.fact, vids: ['1'], next: 0, refreshed: [], expiresAt: Date.now() + 60000 },
      resolvedEpisodes: 7, expectedEpisodes: 30 });
    expect(await f.service.query('公共故事', 1, f.request)).toMatchObject({ pending: true, failed: false, items: [] });
    expect(f.provider.resolve).toHaveBeenCalledWith(f.candidate, undefined, { maxRequests: 8, timeoutMs: 15000 });
    expect(f.sqlite.count('discovery_queries')).toBe(0);
    expect(f.sqlite.count('discovery_works')).toBe(0);
    expect(f.sqlite.count('discovery_leases')).toBe(0);
  });
  it('short caches successful empty responses but never failures', async () => {
    const f = fixture(); vi.mocked(f.provider.search).mockResolvedValue([]);
    expect(await f.service.query('空', 1, f.request)).toEqual({ items: [], pending: false, failed: false, hasMore: false });
    await f.service.query('空', 1, f.request); expect(f.provider.search).toHaveBeenCalledTimes(1);
    f.setClock(131); vi.mocked(f.provider.search).mockRejectedValue(new Error('offline'));
    expect(await f.service.query('空', 1, f.request)).toMatchObject({ failed: true });
    await f.service.query('空', 1, f.request); expect(f.provider.search).toHaveBeenCalledTimes(2);
    // Failed durable queries are explicit and short-lived, never successful empty cache entries.
    expect(f.sqlite.selectOne("SELECT status FROM discovery_job_queries")?.status).toBe('failed');
    expect(f.sqlite.count('discovery_leases')).toBe(0);
  });
  it('does not cache blocked or unsafe complete resolutions', async () => {
    const f = fixture(); vi.mocked(f.provider.resolve).mockResolvedValueOnce({ status: 'blocked', providerId: 'provider_s1', reason: 'unavailable' });
    expect(await f.service.query('故事', 1, f.request)).toMatchObject({ failed: true });
    f.fact.episodeCount = 2;
    f.setClock(131); // Retry the failed snapshot after TTL, actually resolve the unsafe complete fact.
    expect(await f.service.query('故事', 1, f.request)).toMatchObject({ failed: true, items: [] });
    expect(f.provider.resolve).toHaveBeenCalledTimes(2);
    expect(f.sqlite.count('discovery_queries')).toBe(0);
  });
  it('does not resolve baseline-owned candidates including authoritative denial', async () => {
    const f = fixture(); f.authority.mockResolvedValue({ authoritative: true, read: { status: 'absent' } });
    expect(await f.service.query('故事', 1, f.request)).toMatchObject({ items: [], failed: false });
    expect(f.provider.resolve).not.toHaveBeenCalled();
    expect(f.sqlite.count('discovery_works')).toBe(0);
  });
  it('uses a cross-process query lease and returns pending when another owner is active', async () => {
    const f = fixture(), key = await discoveryQueryKey('故事', f.service.queryScope(1));
    await acquireDiscoveryLease(f.DB, `query:${key.qhash}`, 100, 300);
    expect(await f.service.query('故事', 1, f.request)).toMatchObject({ pending: true, failed: false });
    expect(f.provider.search).not.toHaveBeenCalled();
  });
  it('rate limits uncached queries and validates input without upstream traffic', async () => {
    const f = fixture(), service = createDiscoveryService(f.context, [f.provider], { rateLimit: 1 });
    await service.query('故事', 1, f.request);
    expect(await service.query('另一个', 1, f.request)).toMatchObject({ failed: true });
    expect(await service.query('', 0, f.request)).toMatchObject({ failed: true });
    expect(f.provider.search).toHaveBeenCalledTimes(1);
  });
  it('bounds total resolve request allowance to eight and leaves unprocessed candidates pending', async () => {
    const f = fixture(); vi.mocked(f.provider.search).mockResolvedValue([f.candidate, { ...f.candidate, sourceItemId: '124', id: 'drama_s_124' }]);
    expect(await f.service.query('故事', 1, f.request)).toMatchObject({ pending: true, items: [{ item: { title: '公共故事' } }] });
    expect(f.provider.resolve).toHaveBeenCalledTimes(1);
    expect(f.sqlite.count('discovery_queries')).toBe(0);
  });
  it('releases leases after publication errors', async () => {
    const f = fixture(); delete f.context.bindings.DISCOVERY_BUCKET;
    expect(await f.service.query('故事', 1, f.request)).toMatchObject({ failed: true });
    expect(f.sqlite.count('discovery_leases')).toBe(0);
  });
});

const config = { providers: { provider_s1: { origin: 'https://source.invalid', originAllowlist: ['https://source.invalid'],
  mediaAllowlist: ['https://media.invalid'], coverAllowlist: ['https://cover.invalid'] } } };
describe('server-only discovery configuration and runtime authority', () => {
  it('defaults off and constructs only allowlisted providers', () => {
    expect(readDiscoveryConfig({})).toEqual({ enabled: false, providers: {} });
    const parsed = readDiscoveryConfig({ SEARCH_DISCOVERY_ENABLED: 'true', SEARCH_DISCOVERY_CONFIG: JSON.stringify(config) });
    expect(createDiscoveryProviders(parsed).map((p) => p.id)).toEqual(['provider_s1']);
  });
  it.each(['{}', '{', JSON.stringify({ providers: { provider_s1: { ...config.providers.provider_s1, origin: 'https://evil.invalid' } } }),
    JSON.stringify({ providers: { provider_s1: { ...config.providers.provider_s1, mediaAllowlist: ['https://127.0.0.1'] } } })])
    ('rejects invalid enabled server configuration: %s', (text) => {
      expect(() => readDiscoveryConfig({ SEARCH_DISCOVERY_ENABLED: 'true', SEARCH_DISCOVERY_CONFIG: text })).toThrow();
    });
  it('preserves hasMatch authority even when disabled/absent and fails closed on missing manifests', async () => {
    const f = fixture(), match = vi.fn(async () => ({ hasMatch: true, workId: 'disabled_work' }));
    const context = createDiscoveryContext(f.context.bindings as Env, { manifest: async () => null, match });
    expect(await context.authority({ workId: 'discovery_test' })).toEqual({ authoritative: true, read: { status: 'rejected' } });
    const withManifest = createDiscoveryContext(f.context.bindings as Env, { manifest: async () => ({ workFacts: { packs: {} } } as never), match });
    expect(await withManifest.authority({ workId: 'discovery_test' })).toEqual({ authoritative: true, read: { status: 'absent' } });
    expect(match).toHaveBeenCalled();
  });
});
