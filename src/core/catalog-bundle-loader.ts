import { DEVICE_TIERS, PUBLIC_CHANNEL_IDS, type ChannelsResponse, type ContentItem } from '../../edge/src/types/api';
import {
  RELEASE_YEAR_MAX, RELEASE_YEAR_MIN, SOURCE_TEXT_MAX_CODE_POINTS, SYNOPSIS_MAX_CODE_POINTS,
  TAGS_MAX_ITEMS, TAG_MAX_CODE_POINTS, TAG_MIN_CODE_POINTS
} from '../../edge/src/library/metadata-policy.mjs';
import { ApiError } from './api/client';

type Bundle = { revision: number; channels: ChannelsResponse; items: ContentItem[] };
type FetchBundle = (url: string, init?: RequestInit) => Promise<Response>;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const publicId = (value: unknown): boolean => (PUBLIC_CHANNEL_IDS as readonly unknown[]).includes(value);
const invalid = (): never => { throw new ApiError('UNEXPECTED_RESPONSE', 200, '公开目录整包校验失败：修订、拓扑、条目或数量不完整（私密内容禁止混入）'); };
const codePoints = (value: unknown): number => [...String(value)].length;

/**
 * HP-11/HP-12：可选公开元数据的形态与边界只在 `metadata-policy` 一处定义，这里按同一口径复核。
 * 缺键是合法的（旧 generation 就是这样），越界则判定整包损坏——目录由本仓库打包器写出，
 * 写出后还能出现越界，只能是这一代资产本身坏了，不能靠丢字段装作读得懂。
 */
const metadataIntact = (item: Record<string, unknown>): boolean => {
  if (item.synopsis !== undefined && codePoints(item.synopsis) > SYNOPSIS_MAX_CODE_POINTS) return false;
  if (item.releaseYear !== undefined && (!Number.isSafeInteger(item.releaseYear) ||
      (item.releaseYear as number) < RELEASE_YEAR_MIN || (item.releaseYear as number) > RELEASE_YEAR_MAX)) return false;
  for (const key of ['region', 'language']) {
    if (item[key] !== undefined && codePoints(item[key]) > SOURCE_TEXT_MAX_CODE_POINTS) return false;
  }
  if (item.tags === undefined) return true;
  const tags = item.tags;
  if (!Array.isArray(tags) || tags.length === 0 || tags.length > TAGS_MAX_ITEMS || new Set(tags).size !== tags.length) return false;
  return tags.every((tag) => typeof tag === 'string' &&
    codePoints(tag) >= TAG_MIN_CODE_POINTS && codePoints(tag) <= TAG_MAX_CODE_POINTS);
};

/** 先校验整个单元再交给 importBundle，绝不依赖其过滤私密条目的行为。 */
export function parseCatalogBundle(value: unknown): Bundle {
  if (!record(value) || !positive(value.revision)) return invalid();
  const topology = Array.isArray(value.channels) ? { version: value.version ?? value.revision, channels: value.channels } : value.channels;
  if (!record(topology) || !positive(topology.version) || !Array.isArray(topology.channels) || topology.channels.length === 0) return invalid();
  const ids = new Set<string>();
  for (const channel of topology.channels) {
    if (!record(channel) || !publicId(channel.id) || ids.has(channel.id as string) || !text(channel.name)
      || !Number.isSafeInteger(channel.order) || !Array.isArray(channel.requiresTier)
      || !channel.requiresTier.every((tier) => (DEVICE_TIERS as readonly unknown[]).includes(tier))
      || !Array.isArray(channel.categories) || !channel.categories.every(text)) return invalid();
    ids.add(channel.id as string);
  }
  if (!Array.isArray(value.items) || value.items.length === 0) return invalid();
  const itemIds = new Set<string>();
  for (const item of value.items) {
    if (!record(item) || !text(item.id) || itemIds.has(item.id) || !publicId(item.channelId)
      || !ids.has(item.channelId as string) || item.isPrivate !== false || !text(item.title) || !text(item.category)) return invalid();
    for (const key of ['coverUrl', 'coverVersion', 'synopsis']) if (item[key] !== undefined && typeof item[key] !== 'string') return invalid();
    for (const key of ['region', 'language']) if (item[key] !== undefined && typeof item[key] !== 'string') return invalid();
    if (!metadataIntact(item)) return invalid();
    for (const key of ['enabled', 'shareable', 'isAi', 'isHot']) if (item[key] !== undefined && typeof item[key] !== 'boolean') return invalid();
    for (const key of ['episodeCount', 'firstPublishedAt', 'hitsTotal']) if (item[key] !== undefined && (!Number.isSafeInteger(item[key]) || (item[key] as number) < 0)) return invalid();
    itemIds.add(item.id);
  }
  // 历史 seed 无声明数量；存在数量声明时必须与去重前后的完整条目数一致。
  for (const key of ['total', 'itemCount']) if (value[key] !== undefined && value[key] !== itemIds.size) return invalid();
  return { revision: value.revision, channels: topology as unknown as ChannelsResponse, items: value.items as ContentItem[] };
}

/** null 仅表示明确 404 未部署；所有其他 HTTP/传输/JSON 错误均阻止分页风暴。 */
export async function fetchCatalogBundle(url: string, fetchImpl: FetchBundle): Promise<Bundle | null> {
  let response: Response;
  try { response = await fetchImpl(url, { cache: 'no-store' }); }
  catch { throw new ApiError('NETWORK_ERROR', 0, '公开目录整包下载失败'); }
  if (response.status === 404) return null;
  if (!response.ok) throw new ApiError(response.status === 503 ? 'SERVICE_UNAVAILABLE' : 'UNEXPECTED_RESPONSE', response.status, `公开目录整包 HTTP ${response.status}`);
  try { return parseCatalogBundle(await response.json()); }
  catch (error) { if (error instanceof ApiError) throw error; return invalid(); }
}

export function catalogBundleUrl(baseUrl?: string): string {
  const base = new URL(baseUrl || (typeof location === 'undefined' ? '' : location.origin));
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw new Error('公开目录整包缺少有效 API origin');
  return new URL('/assets/catalog-bundle.json', base.origin).href;
}
