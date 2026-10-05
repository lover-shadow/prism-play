import type { ContentItem, TitleDetail } from '../../../edge/src/types/api';
import { PUBLIC_METADATA_FIELDS, sanitizePublicMetadata } from '../../../edge/src/library/metadata-policy.mjs';

/** Client-only identity: episodeNumber is local to a work, NEVER a D1 content_episodes id. */
const LOCAL_EPISODE_IDS = Symbol('manifest-local-episode-ids');
type LocalTitleDetail = TitleDetail & { [LOCAL_EPISODE_IDS]: true };
export function usesLocalEpisodeIds(detail: TitleDetail | null): boolean {
  return detail !== null && (detail as Partial<LocalTitleDetail>)[LOCAL_EPISODE_IDS] === true;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const positiveId = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Validate before projection; malformed new responses must not masquerade as legacy D1 details. */
export function adaptTitleDetail(value: unknown, workId: string): TitleDetail {
  if (!record(value) || !record(value.item) || !Array.isArray(value.episodes)) throw new Error('Invalid title detail');
  const item = value.item;
  if (item.id !== workId || typeof item.title !== 'string' || typeof item.category !== 'string'
    || typeof item.channelId !== 'string' || typeof item.isPrivate !== 'boolean') throw new Error('Invalid title item');
  const manifest = 'workId' in value;
  if (manifest && (value.workId !== workId || typeof value.title !== 'string'
    || typeof value.isPrivate !== 'boolean' || value.channelId !== item.channelId
    || value.isPrivate !== item.isPrivate)) throw new Error('Invalid title manifest');
  const seen = new Set<number>();
  const episodes = value.episodes.map((entry) => {
    if (!record(entry) || !positiveId(entry.episodeNumber)) throw new Error('Invalid episode number');
    const id = manifest ? entry.episodeNumber : entry.episodeId;
    if (!positiveId(id) || seen.has(id)) throw new Error('Invalid episode identity');
    seen.add(id);
    if (manifest) {
      if (!Array.isArray(entry.lines) || entry.lines.some((line: unknown) => !record(line)
        || typeof line.providerId !== 'string' || line.providerId === ''
        || typeof line.mediaUrl !== 'string' || !/^https?:\/\//i.test(line.mediaUrl))) throw new Error('Invalid episode lines');
    }
    return {
      episodeId: id, episodeNumber: entry.episodeNumber,
      ...(typeof entry.title === 'string' ? { title: entry.title } : {}),
      ...(typeof entry.durationSeconds === 'number' && Number.isFinite(entry.durationSeconds)
        ? { durationSeconds: entry.durationSeconds } : {})
    };
  });
  const detail: TitleDetail = { item: sanitizeCard(item), episodes };
  return manifest ? Object.assign(detail, { [LOCAL_EPISODE_IDS]: true as const }) : detail;
}

/**
 * HP-11/HP-12：详情卡片上的可选元数据一律过策略源消毒。先删干净这五个键再写回合规值，
 * 越界或残留 HTML 的原料才会**物理消失**——只 Object.assign 会留下越界原值，那是最坏的假绿。
 * 纯函数：不改动传入的响应对象；读侧消毒而非抛错，一部剧不能因为一条脏摘要就打不开。
 */
function sanitizeCard(item: Record<string, unknown>): ContentItem {
  const card = { ...item } as Record<string, unknown>;
  for (const key of PUBLIC_METADATA_FIELDS) delete card[key];
  return Object.assign(card, sanitizePublicMetadata(item)) as unknown as ContentItem;
}
