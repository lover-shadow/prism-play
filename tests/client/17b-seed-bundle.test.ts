// @vitest-environment jsdom
/**
 * 预置种子整包灌入验收（SPEC-APP-REFACTOR §A-6 / AC-01 冷启动）。
 *
 * 回归动机：真机首启"海报闪现后整屏不停刷新、无法操作"，根因是种子包把 `channels` 写成裸数组，
 * `importBundle → putChannels` 期望 `ChannelsResponse`（`{version, channels}`），数组形态令 `.filter()` 抛错、
 * 种子静默失败，bootstrap 退化成逐页全量重同步（几百次 `/api/catalog?` 分页）。客户端现对两种形态都归一。
 */
import { describe, expect, it } from 'vitest';
import type { ChannelId, ChannelItem, ContentItem } from '../../edge/src/types/api';
import { PrismApiClient } from '../../src/core/api/client';
import { createCatalogCacheService } from '../../src/core/catalog-cache';
import { MemoryCacheDisk, PublicCache } from '../../src/core/storage/public-cache';

const EDGE = 'https://play.prismos.org';
const content = (id: string, channelId: ChannelId): ContentItem =>
  ({ id, channelId, title: `剧目${id}`, category: '都市', isPrivate: false, coverUrl: `${EDGE}/proxy/img/${id}`, coverVersion: 'v1' } as ContentItem);
const channel = (id: ChannelId): ChannelItem => ({ id, name: `频道${id}`, order: 1, requiresTier: [], categories: ['都市'] });
const seedResponse = (body: unknown): Response => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response);
const emptyChanges: Response = { ok: true, status: 200, text: async () => JSON.stringify({ changes: [], nextRevision: 1, hasMore: false }) } as unknown as Response;

function serviceWithSeed(seed: unknown) {
  const seen: string[] = [];
  const client = new PrismApiClient({ baseUrl: EDGE, fetchImpl: async (input: string) => {
    const url = new URL(input, EDGE); seen.push(`${url.pathname}${url.search}`);
    return url.pathname === '/api/catalog/changes' ? emptyChanges : ({ ok: false, status: 599, text: async () => '{}' } as unknown as Response);
  } });
  const service = createCatalogCacheService({ client, cache: new PublicCache(new MemoryCacheDisk()), pageSize: 1, nowSeconds: () => 1_700_000_000,
    fetchImpl: async (url: string) => (url.includes('catalog-bundle.json') ? seedResponse(seed) : ({ ok: false, status: 599 } as unknown as Response)) });
  return { service, seen };
}

describe('bootstrap：预置种子整包灌入（AC-01 冷启动）', () => {
  it('channels 为裸数组的历史种子：归一后秒级灌入，冷启动不发任何分页目录', async () => {
    const { service, seen } = serviceWithSeed({ version: 1, revision: 1, generatedAt: 1_700_000_000,
      channels: [channel('drama')], items: [content('drama_a', 'drama'), content('drama_b', 'drama')] });
    const boot = await service.bootstrap();
    expect(boot).toMatchObject({ hadSnapshot: true, outcome: { appliedEntries: 2, revision: 1, full: true, offline: false } });
    expect(service.snapshotState()).toMatchObject({ revision: 1, items: 2, channels: 1 });
    expect(seen.some((url) => url.startsWith('/api/catalog?'))).toBe(false);
  });
  it('channels 已是 ChannelsResponse 对象形态：同样灌入，向后兼容', async () => {
    const { service } = serviceWithSeed({ revision: 2, channels: { version: 2, channels: [channel('movie')] },
      items: [content('movie_m1', 'movie')] });
    const boot = await service.bootstrap();
    expect(boot).toMatchObject({ hadSnapshot: true, outcome: { appliedEntries: 1, revision: 2, full: true } });
  });
});
