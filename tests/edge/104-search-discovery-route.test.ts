import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentItem, SearchResponse } from '../../edge/src/types/api';
import type { Env } from '../../edge/src/types/env';
import { generationCandidates } from '../../edge/src/search/generation';
const mocks = vi.hoisted(() => ({ query: vi.fn(), fact: vi.fn(), publicFact: vi.fn(), changes: vi.fn(), generation: vi.fn(), verify: vi.fn(), jobs: vi.fn(), card: vi.fn() }));
vi.mock('../../edge/src/search/discovery-card-service', () => ({ createCardDiscoveryService: () => ({ query: mocks.query, queryScope: (page: number) => `page:${page}` }) }));
vi.mock('../../edge/src/search/discovery-cards', () => ({ readDiscoveryCard: mocks.card }));
vi.mock('../../edge/src/search/discovery-config', () => ({ createDiscoveryProviders: () => [], readDiscoveryConfig: () => ({}), discoveryConfigScope: async () => 'scope' }));
vi.mock('../../edge/src/search/public-facts', () => ({ publicDiscoveryContext: () => ({}), readPublicFact: mocks.publicFact }));
vi.mock('../../edge/src/search/discovery-store', () => ({ readDiscoveryFact: mocks.fact, readDiscoveryChanges: mocks.changes }));
vi.mock('../../edge/src/search/discovery-query', async (original) => ({ ...await original<typeof import('../../edge/src/search/discovery-query')>(), readDiscoveryQuery: mocks.jobs }));
vi.mock('../../edge/src/search/generation', async (original) => ({ ...await original<typeof import('../../edge/src/search/generation')>(), generationSearch: mocks.generation, generationResults: mocks.verify }));
import { handleSearch } from '../../edge/src/routes/search';
import { handleSearchDiscoveries } from '../../edge/src/routes/search-discovery';
const clock = { nowSeconds: () => 1000, nowMillis: () => 1000000 };
const card = (id: string, extra = {}): ContentItem => ({ id, title: '星河', channelId: 'drama', category: '都市', enabled: true, isPrivate: false, shareable: true, episodeCount: 1, ...extra });
const entry = (id: string) => ({ item: card(id), aliases: [], pinyin: [], tags: [] });
let rows: { work_id: string; card_json: string }[], env: Env;
const generation = { manifest: { revision: 8 }, entries: [entry('base')] };
const req = (query = 'q=星河') => new Request(`https://app.invalid/api/search?${query}`);
beforeEach(() => {
  vi.clearAllMocks(); rows = []; mocks.card.mockResolvedValue(null);
  env = { SEARCH_DISCOVERY_ENABLED: 'true', DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) } } as unknown as Env;
  mocks.generation.mockResolvedValue(generation); mocks.jobs.mockResolvedValue(null);
  mocks.query.mockResolvedValue({ items: [], pending: false, failed: false, hasMore: false });
  mocks.publicFact.mockImplementation(async (_env, _manifest, id, _now) => ({ status: 'ok', fact: {
    row: { enabled: 1, is_private: 0 },
    asset: { workId: id, title: '星河', channelId: 'drama', isPrivate: false, category: '都市', hasCover: false, episodes: [{}], generatedAt: 0 },
    shareable: true
  } }));
  mocks.verify.mockImplementation(async (_env, gen, filters, _page, size) => new Response(JSON.stringify({ items: generationCandidates(gen.entries, filters).slice(0, size).map((hit) => ({ item: hit.entry.item, matchType: hit.matchType })), page: 1 }), { status: 200 }));
  mocks.fact.mockImplementation(async (_context, id) => ({ status: 'ok', fact: { asset: { workId: id, title: '星河', channelId: 'drama', isPrivate: false, category: '都市', hasCover: true, episodes: [{}], generatedAt: 0, synopsis: '新简介', tags: ['冒险'], releaseYear: 2026 }, shareable: true } }));
});
describe('search discovery public route', () => {
  it('returns a new card immediately without reading its complete playback fact', async () => {
    rows = [{ work_id: 'new', card_json: JSON.stringify(card('new')) }];
    mocks.card.mockResolvedValue({ candidate: {}, item: card('new') });
    const body = await (await handleSearch(req(), env, clock)).json() as SearchResponse;
    expect(body.items.map((hit) => hit.item.id)).toEqual(['base', 'new']);
    expect(mocks.fact).not.toHaveBeenCalled();
  });
  it('merges baseline and verified shared discovery, normalizes covers, keeps metadata and hides source', async () => {
    rows = ['new', 'base'].map((id) => ({ work_id: id, card_json: JSON.stringify(card(id)) }));
    const body = await (await handleSearch(req(), env, clock)).json() as SearchResponse;
    expect(body.items.map((hit) => hit.item.id)).toEqual(['base', 'new']);
    expect(mocks.fact).toHaveBeenCalledTimes(1);
    expect(body.items[1].item).toMatchObject({ coverUrl: 'https://app.invalid/proxy/img/new', synopsis: '新简介', tags: ['冒险'], releaseYear: 2026 });
    expect(JSON.stringify(body)).not.toMatch(/provider_|mediaUrl|sourceId/);
  });
  it('keeps pending separate from provider pagination; repeats the same provider page', async () => {
    mocks.query.mockResolvedValue({ items: [], pending: true, failed: false, hasMore: true, retryAfterSeconds: 1 });
    const body = await (await handleSearch(req('q=星河&page=2&discoveryPage=3'), env, clock)).json() as SearchResponse;
    expect(body).toMatchObject({ page: 2, discoveryPage: 3, discoveryPending: true, discoveryHasMore: true, retryAfterSeconds: 1 });
    expect(mocks.query.mock.calls[0][1]).toBe(3);
  });
  it('does not expose private cards or rejected facts; private filter is always 404', async () => {
    rows = [{ work_id: 'private', card_json: JSON.stringify(card('private', { isPrivate: true })) }, { work_id: 'bad', card_json: JSON.stringify(card('bad')) }];
    mocks.fact.mockResolvedValue({ status: 'rejected' });
    const body = await (await handleSearch(req(), env, clock)).json() as SearchResponse;
    expect(body.items.map((hit) => hit.item.id)).toEqual(['base']);
    expect(mocks.fact).toHaveBeenCalledTimes(1);
    expect(mocks.fact.mock.calls[0][1]).toBe('bad');
    mocks.publicFact.mockResolvedValueOnce({ status: 'rejected' });
    const rejected = await (await handleSearch(req(), env, clock)).json() as SearchResponse;
    expect(rejected.items).toEqual([]);
    expect((await handleSearch(req('q=星河&channel=private'), env, clock)).status).toBe(404);
  });
  it('retains baseline on discovery failure and verifies only the <=20 merged window', async () => {
    const entries = Array.from({ length: 45 }, (_, i) => entry(`base_${i}`));
    mocks.generation.mockResolvedValue({ ...generation, entries }); mocks.query.mockRejectedValue(new Error('unavailable'));
    const body = await (await handleSearch(req(), env, clock)).json() as SearchResponse;
    expect(body.items).toHaveLength(20); expect(body.discoveryFailed).toBe(true);
    expect(mocks.verify.mock.calls[0][1].entries).toHaveLength(20); expect(mocks.fact).not.toHaveBeenCalled();
    expect(mocks.publicFact).toHaveBeenCalledTimes(20);
    expect(mocks.publicFact.mock.calls.map((call) => call[2])).toEqual(body.items.map((hit) => hit.item.id));
    expect(mocks.publicFact.mock.calls.every((call) => call[0] === env && call[1] === generation.manifest && call[3] === clock.nowSeconds())).toBe(true);
  });
  it('indexes nonlexical published jobs from earlier provider pages without repeating baseline IDs', async () => {
    rows = [{ work_id: 'resolved', card_json: JSON.stringify(card('resolved', { title: '其他标题' })) }];
    mocks.jobs.mockResolvedValue({ ids: ['resolved'] });
    const body = await (await handleSearch(req('q=星河&discoveryPage=2'), env, clock)).json() as SearchResponse;
    expect(body.items.map((hit) => hit.item.id)).toEqual(['base', 'resolved']); expect(mocks.jobs).toHaveBeenCalledTimes(2);
  });
  it('new source pages append after baseline without skipping the partial merged window', async () => {
    mocks.generation.mockResolvedValue({ ...generation, entries: Array.from({ length: 21 }, (_, i) => entry(`base_${i}`)) });
    rows = [{ work_id: 'new_1', card_json: JSON.stringify(card('new_1')) }];
    const first = await (await handleSearch(req('q=星河&page=2'), env, clock)).json() as SearchResponse;
    rows.push({ work_id: 'new_2', card_json: JSON.stringify(card('new_2')) });
    const next = await (await handleSearch(req('q=星河&page=2&discoveryPage=2'), env, clock)).json() as SearchResponse;
    expect(first.items.map((hit) => hit.item.id)).toEqual(['base_9', 'new_1']);
    expect(next.items.map((hit) => hit.item.id)).toEqual(['base_9', 'new_1', 'new_2']);
  });
  it('changes cursor advances even for unverifiable upserts, emitting metadata-free tombstones', async () => {
    mocks.changes.mockResolvedValue({ changes: [{ seq: 5, workId: 'bad', operation: 'upsert', updatedAt: 100, card: card('bad') }], cursor: 5, hasMore: true });
    mocks.fact.mockResolvedValue({ status: 'rejected' });
    const response = await handleSearchDiscoveries(new Request('https://app.invalid/api/search/discoveries?after=4&limit=1'), env, clock);
    expect(await response.json()).toEqual({ changes: [{ seq: 5, workId: 'bad', operation: 'withdraw', updatedAt: 100 }], cursor: 5, hasMore: true });
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect((await handleSearchDiscoveries(new Request('https://app.invalid/api/search/discoveries?after=-1'), env, clock)).status).toBe(400);
  });
});
