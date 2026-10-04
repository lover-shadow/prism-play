// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelsResponse, ContentItem } from '../../edge/src/types/api';
import { boot, type PrismApp } from '../../src/main';
import { PrismApiClient } from '../../src/core/api/client';
import { createCatalogCacheService } from '../../src/core/catalog-cache';
import { createPosterUrls } from '../../src/core/poster-urls';
import { MemoryCacheDisk, PublicCache } from '../../src/core/storage/public-cache';

// 只替代 SQLite 检索能力；结果 DTO 仍由真实 localItems 读面解析。
vi.mock('../../src/core/storage/search-index', async (original) => ({
  ...await original<typeof import('../../src/core/storage/search-index')>(),
  createSearchIndex: () => ({
    sync: async () => undefined, clear: async () => undefined,
    status: () => ({ available: true, docs: 1 }),
    search: async () => [{ contentId: 'a', matchType: 'exact', initials: 'hbhg' }]
  })
}));
vi.mock('../../src/core/native/platform-adapters', async (original) => ({
  ...await original<typeof import('../../src/core/native/platform-adapters')>(),
  createCacheDisk: async () => disk
}));

const BASE = 'https://play.prismos.org';
const channels: ChannelsResponse = { version: 7, channels: [
  { id: 'drama', name: '短剧精选', order: 1, requiresTier: [], categories: ['都市'] }
] };
const item = (coverUrl = '/proxy/img/a'): ContentItem => ({
  id: 'a', channelId: 'drama', title: '海报回归', category: '都市', isPrivate: false,
  coverUrl, coverVersion: 'v1', isHot: true
});
const bundle = { revision: 7, channels, items: [item()] };
const page = (entry = item()) => ({ items: [entry], page: 1, pageSize: 24, total: 1, revision: 7 });
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const offline = async (): Promise<Response> => { throw new TypeError('offline'); };
let disk: MemoryCacheDisk;
let app: PrismApp | null = null;

beforeEach(() => {
  disk = new MemoryCacheDisk();
  localStorage.clear();
  document.body.innerHTML = '<div id="app"><header id="app-header"></header><main id="app-main"></main><nav id="app-tabbar"></nav></div>';
});
afterEach(() => { app?.destroy(); app = null; vi.unstubAllGlobals(); });

async function assertHomeAndSearch(): Promise<void> {
  await vi.waitFor(() => {
    expect(document.querySelector<HTMLImageElement>('.home-poster-grid img')?.src).toBe(`${BASE}/proxy/img/a`);
  });
  document.querySelector<HTMLButtonElement>('.home-search-bar')?.click();
  const input = document.querySelector<HTMLInputElement>('[data-el="search-input"]');
  expect(input).not.toBeNull();
  input!.value = '海报';
  document.querySelector<HTMLButtonElement>('[data-el="search-submit"]')?.click();
  await vi.waitFor(() => {
    const images = [...document.querySelectorAll<HTMLImageElement>('[data-el="search-overlay"] img')];
    expect(images.length).toBeGreaterThan(0);
    expect(images.every((img) => img.src === `${BASE}/proxy/img/a`)).toBe(true);
  });
}

describe('Capacitor 首页与搜索读取边界', () => {
  it('seed 相对封面在首页与本地搜索榜单都指向 API，不重写种子快照', async () => {
    expect(location.origin).toBe('https://localhost');
    const fetchSeed = vi.fn(async () => json(bundle));
    vi.stubGlobal('fetch', fetchSeed);
    app = await boot({ apiBaseUrl: BASE, fetchImpl: offline });
    await assertHomeAndSearch();
    const reopened = new PublicCache(disk); await reopened.hydrate();
    expect(reopened.getItem('a')?.coverUrl).toBe('/proxy/img/a');
    expect(reopened.snapshotRevision()).toBe(7);
    expect(fetchSeed).toHaveBeenCalledTimes(1);
  });

  it.each(['/proxy/img/a', `${BASE}/proxy/img/a`])('旧缓存 %s 离线读出即解析，无额外全量请求/落盘', async (cover) => {
    const warm = new PublicCache(disk);
    await warm.importBundle({ ...bundle, items: [item(cover)] });
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(offline));
    app = await boot({ apiBaseUrl: BASE, fetchImpl: async (url) => { requests.push(url); return offline(); } });
    await assertHomeAndSearch();
    expect(requests.some((url) => url.includes('/api/catalog/changes'))).toBe(true);
    expect(requests.some((url) => url.includes('/seed/'))).toBe(false);
    const reopened = new PublicCache(disk); await reopened.hydrate();
    expect(reopened.getItem('a')?.coverUrl).toBe(cover);
    expect(reopened.snapshotRevision()).toBe(7);
  });

  it('homeApi 在线相对封面与随后缓存驱动的搜索都指向 API', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    app = await boot({ apiBaseUrl: BASE, fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path === '/api/channels') return json(channels);
      if (path === '/api/catalog') return json(page());
      return json({ changes: [], nextRevision: 7, hasMore: false });
    } });
    await assertHomeAndSearch();
  });
});

describe('统一受控海报入口', () => {
  const urls = () => createPosterUrls(BASE);
  it('相对路径、API 同源绝对路径与历史页面同源绝对路径统一到 API', () => {
    for (const raw of ['/proxy/img/a', `${BASE}/proxy/img/a`, 'https://localhost/proxy/img/a']) {
      expect(urls().resolve(raw)).toBe(`${BASE}/proxy/img/a`);
    }
    expect(urls().resolve('/proxy/img/a?v=1')).toBe(`${BASE}/proxy/img/a?v=1`);
    expect(urls().resolve(`${BASE}/proxy/img/a?exp=123&sig=abc%2Bdef&session=s1`))
      .toBe(`${BASE}/proxy/img/a?exp=123&sig=abc%2Bdef&session=s1`);
    expect(createPosterUrls('').resolve('/proxy/img/a')).toBe('https://localhost/proxy/img/a');
    expect(createPosterUrls(`${BASE}/api`).resolve('/proxy/img/a')).toBe(`${BASE}/proxy/img/a`);
  });
  it.each([
    undefined, '', 'https://other.example/proxy/img/a', '//other.example/proxy/img/a',
    'https://user:pass@play.prismos.org/proxy/img/a', 'javascript:alert(1)', 'data:image/png,a',
    '/proxy/media/a', '/proxy/img/', '/proxy/img/a/b', '/proxy/img/a..b',
    '/proxy/img/%2F', '/proxy/img/%2e%2e', '/proxy/img/%5c', '/proxy/img/%252f',
    '/proxy/img/../img/a', '/proxy/img/a#fragment', 'proxy/img/a', '/proxy/img/a\\b'
  ])('拒绝非受控输入 %s', (raw) => {
    expect(urls().resolve(raw)).toBeNull();
  });
  it('只复制展示 DTO，不修改原对象/私密出处，也不透传不合法封面', () => {
    const source = item('https://other.example/proxy/img/a');
    const mapped = urls().items([source]);
    expect(mapped[0]?.coverUrl).toBeUndefined();
    expect(source.coverUrl).toBe('https://other.example/proxy/img/a');
    expect(mapped[0]?.channelId).toBe(source.channelId);
    expect(mapped[0]?.isPrivate).toBe(source.isPrivate);
  });
  it('错误 API base 不回落页面 origin', () => {
    expect(createPosterUrls('not a url').resolve('/proxy/img/a')).toBeNull();
    expect(createPosterUrls('file:///tmp').resolve('/proxy/img/a')).toBeNull();
  });
});

describe('posterUrlFor 网络与回退复用统一入口', () => {
  it.each(['failure', 'empty', 'unknown-mime', 'cached-unknown-mime'])('%s 回退仍返回云端 URL', async (mode) => {
    const cache = new PublicCache(disk);
    await cache.importBundle(bundle);
    if (mode === 'cached-unknown-mime') await cache.putPoster('a', 'v1', new Uint8Array([1]), { contentId: 'a', channelId: 'drama' });
    const fetchImage = vi.fn(async () => {
      if (mode === 'failure') throw new Error('offline');
      return new Response(mode === 'empty' ? new Uint8Array() : new Uint8Array([1]));
    });
    const service = createCatalogCacheService({ baseUrl: BASE, cache,
      client: new PrismApiClient({ baseUrl: BASE, fetchImpl: offline }), fetchImpl: fetchImage });
    expect(await service.posterUrlFor(item())).toBe(`${BASE}/proxy/img/a`);
    if (mode === 'cached-unknown-mime') expect(fetchImage).not.toHaveBeenCalled();
    else expect(fetchImage).toHaveBeenCalledWith(`${BASE}/proxy/img/a`, { headers: { Accept: 'image/*' } });
  });
  it('外部代理形状不触发请求；私密封面取回但不落盘', async () => {
    const cache = new PublicCache(disk);
    const fetchImage = vi.fn(async () => new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47])));
    const service = createCatalogCacheService({ baseUrl: BASE, cache,
      client: new PrismApiClient({ baseUrl: BASE, fetchImpl: offline }), fetchImpl: fetchImage });
    expect(await service.posterUrlFor(item('https://other.example/proxy/img/a'))).toBeNull();
    expect(fetchImage).not.toHaveBeenCalled();
    expect(await service.posterUrlFor({ ...item(), channelId: 'private', isPrivate: true })).toBe(`${BASE}/proxy/img/a`);
    expect(await cache.getPoster('a', 'v1')).toBeNull();
    expect(cache.bytesUsed()).toEqual({ catalog: 0, posters: 0 });
  });
});
