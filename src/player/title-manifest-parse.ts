/**
 * 剧集清单的形状校验与口径工具（从 `title-manifest.ts` 拆出，仅为 §10 单文件红线）。
 *
 * 形状校验而不是类型断言：磁盘上的文件与云端返回都可能来自旧版本，认不下就整体当作"没有清单"，
 * 绝不半信半疑地把半份线路交给播放器——那会让回退链永远走不到。
 * 本模块是纯函数层，不做 I/O、不做缓存；缓存职责见 `core/api/title-facts`。
 */
import type { PlaybackLine, TitleManifest } from '../../edge/src/types/api';
import { isPrivateSubject } from '../core/storage/storage-domains';

/** 平台侧 HLS 清单的声明口径，与 `art-engine.ts` 的 `customType.m3u8` 分流一致。 */
export const HLS_MIME_TYPE = 'application/vnd.m3u8+playlist';
export const MP4_MIME_TYPE = 'video/mp4';

export function parseTitleManifest(value: unknown): TitleManifest | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.workId !== 'string' || raw.workId === '') return null;
  if (typeof raw.title !== 'string') return null;
  if (raw.isPrivate !== true && raw.isPrivate !== false) return null;
  if (!Array.isArray(raw.episodes)) return null;
  const episodes: TitleManifest['episodes'] = [];
  for (const entry of raw.episodes) {
    if (entry === null || typeof entry !== 'object') return null;
    const episode = entry as Record<string, unknown>;
    if (!Number.isInteger(episode.episodeNumber) || (episode.episodeNumber as number) < 1) return null;
    if (!Array.isArray(episode.lines)) return null;
    const lines: PlaybackLine[] = [];
    for (const candidate of episode.lines) {
      if (candidate === null || typeof candidate !== 'object') return null;
      const line = candidate as Record<string, unknown>;
      if (typeof line.providerId !== 'string' || line.providerId === '') return null;
      if (line.mediaUrl !== undefined && (typeof line.mediaUrl !== 'string' || !/^https?:\/\//i.test(line.mediaUrl))) return null;
      if ('native' in line) {
        const native = line.native as Record<string, unknown> | null;
        if (line.providerId !== 'provider_s1' || !native || typeof native !== 'object' || Array.isArray(native) ||
          Object.keys(native).length !== 2 || Object.keys(native).some((key) => key !== 'kind' && key !== 'videoId') ||
          native.kind !== 's1-cenc' || typeof native.videoId !== 'string' || !/^\d{1,32}$/.test(native.videoId)) return null;
        lines.push({ providerId: line.providerId, ...(line.mediaUrl === undefined ? {} : { mediaUrl: line.mediaUrl as string }),
          native: { kind: 's1-cenc', videoId: native.videoId } });
      } else {
        if (typeof line.mediaUrl !== 'string') return null;
        lines.push({ providerId: line.providerId, mediaUrl: line.mediaUrl });
      }
    }
    episodes.push({
      episodeNumber: episode.episodeNumber as number,
      title: typeof episode.title === 'string' ? episode.title : undefined,
      durationSeconds: Number.isFinite(episode.durationSeconds) ? (episode.durationSeconds as number) : undefined,
      lines
    });
  }
  return {
    workId: raw.workId,
    title: raw.title,
    channelId: typeof raw.channelId === 'string' ? (raw.channelId as TitleManifest['channelId']) : 'drama',
    isPrivate: raw.isPrivate === true,
    episodes,
    generatedAt: Number.isFinite(raw.generatedAt) ? (raw.generatedAt as number) : 0
  };
}

/** 私密判定只读载荷本身：清单若自称公开却挂在 private 频道，仍按私密处置（`isPrivateSubject` 唯一口径）。 */
export function isPrivateManifest(manifest: TitleManifest): boolean {
  return isPrivateSubject({ isPrivate: manifest.isPrivate, channelId: manifest.channelId, contentId: manifest.workId });
}

/** 上游地址没有独立的 MIME 字段，只有后缀可依据；非 mp4 一律按 HLS 清单解析（与分享页同一口径）。 */
export function mimeTypeOfMediaUrl(url: string): string {
  const path = url.split('#')[0].split('?')[0].toLowerCase();
  return path.endsWith('.mp4') || path.endsWith('.m4v') ? MP4_MIME_TYPE : HLS_MIME_TYPE;
}
