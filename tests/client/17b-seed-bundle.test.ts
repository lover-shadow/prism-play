// @vitest-environment jsdom
/**
 * 预置种子整包灌入验收（SPEC-APP-REFACTOR §A-6 / AC-01 冷启动）。
 *
 * 回归动机：真机首启"海报闪现后整屏不停刷新、无法操作"，根因是种子包把 `channels` 写成裸数组，
 * `importBundle → putChannels` 期望 `ChannelsResponse`（`{version, channels}`），数组形态令 `.filter()` 抛错、
 * 种子静默失败，bootstrap 退化成逐页全量重同步（几百次 `/api/catalog?` 分页）。客户端现对两种形态都归一。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { ChannelId, ChannelItem, ContentItem } from '../../edge/src/types/api';
import {
  SYNOPSIS_MAX_CODE_POINTS, TAGS_MAX_ITEMS, TAG_MAX_CODE_POINTS, SOURCE_TEXT_MAX_CODE_POINTS,
  RELEASE_YEAR_MAX, PUBLIC_METADATA_FIELDS, sanitizePublicMetadata
} from '../../edge/src/library/metadata-policy.mjs';
import { parseCatalogBundle } from '../../src/core/catalog-bundle-loader';
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
  it('实际交付种子可解析、两端同代、导航符合HP-04且不预置原始播放库', () => {
    const web = readFileSync('public/seed/catalog-bundle.json');
    const native = gunzipSync(readFileSync('android/app/src/main/assets/seed/catalog-bundle.json.gz'));
    expect(web.equals(native)).toBe(true);
    const seed = parseCatalogBundle(JSON.parse(web.toString('utf8')));
    expect(seed.channels.channels.map((entry) => [entry.id, entry.name])).toEqual([
      ['drama', '精彩短剧'], ['movie', '电影仓库'], ['documentary', '纪录片'], ['anime', '动漫']
    ]);
    expect(seed.items.length).toBeGreaterThan(0);
    expect(seed.items.some((entry) => entry.title === '')).toBe(false);
    expect(existsSync('android/app/src/main/assets/seed/library.db')).toBe(false);
  });
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

const bundle = (items: unknown[]) => ({ revision: 7, version: 7, channels: [channel('movie')], items });
const base = { id: 'movie_m1', channelId: 'movie', title: '码头', category: '剧情', isPrivate: false };

describe('HP-11 / HP-12：种子整包 DTO 解析公开可选元数据', () => {
  it('携带长摘要与元信息的历史种子仍可灌入，列表侧读得到真实字段', async () => {
    // 220 码点的真话摘要：远超旧的 30 字墙，又落在 240 边界内，所以整包解析必须原样保留而不是截半。
    const long = '雨夜的码头，船长把最后一张船票塞进女儿手里。'.repeat(10);
    const item = { ...base, synopsis: long,
      tags: ['剧情', '惊悚'], releaseYear: 2019, region: '美国,英国,加拿大', language: '英语,法语' };
    const parsed = parseCatalogBundle(bundle([item]));
    expect([...(parsed.items[0].synopsis as string)]).toHaveLength(220);
    expect([...(parsed.items[0].synopsis as string)]).toHaveLength([...long].length);
    expect(parsed.items[0].tags).toEqual(['剧情', '惊悚']);
    expect(parsed.items[0].releaseYear).toBe(2019);
    expect(parsed.items[0].region).toBe('美国,英国,加拿大');
    const { service } = serviceWithSeed({ revision: 7, version: 7, channels: [channel('movie')], items: [item] });
    const boot = await service.bootstrap();
    expect(boot).toMatchObject({ hadSnapshot: true, outcome: { appliedEntries: 1, revision: 7, full: true } });
  });

  it('旧 generation 缺全部新字段仍然可读，字段缺席而非假值', () => {
    const parsed = parseCatalogBundle(bundle([{ ...base, coverUrl: '/proxy/img/movie_m1' }]));
    for (const key of PUBLIC_METADATA_FIELDS) expect(key in parsed.items[0]).toBe(false);
    expect(parsed.items[0].title).toBe('码头');
  });

  it('越界或形态错误的可选元数据判定整包损坏：目录由本仓库打包器写出，宁可整包拒收也不静默修数据', () => {
    const rejects: Record<string, unknown>[] = [
      { ...base, synopsis: '长'.repeat(SYNOPSIS_MAX_CODE_POINTS + 1) },
      { ...base, tags: Array.from({ length: TAGS_MAX_ITEMS + 1 }, (_, i) => `题材${i}`) },
      { ...base, tags: ['x'.repeat(TAG_MAX_CODE_POINTS + 1)] },
      { ...base, tags: '剧情' },
      { ...base, releaseYear: RELEASE_YEAR_MAX + 1 },
      { ...base, releaseYear: '2019' },
      { ...base, region: '地'.repeat(SOURCE_TEXT_MAX_CODE_POINTS + 1) },
      { ...base, language: 7 }
    ];
    for (const item of rejects) expect(() => parseCatalogBundle(bundle([item]))).toThrow();
  });

  it('读取侧只做边界与纯文本消毒：越界丢弃、HTML 剥净；受控词表是供给侧门禁，不在此重复判定', () => {
    const clean = sanitizePublicMetadata({ synopsis: '<b>真话</b> http://upstream.example/a',
      releaseYear: '2026–', region: '国,'.repeat(40), language: '普通话', tags: ['剧情', '剧情', '主演张三'] });
    expect(clean).toEqual({ synopsis: '真话', language: '普通话', tags: ['剧情', '主演张三'] });
    expect('releaseYear' in clean).toBe(false);
    expect('region' in clean).toBe(false);
  });
});
