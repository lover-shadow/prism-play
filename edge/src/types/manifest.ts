import type { ChannelId } from './api';

/** 一条可切换播放线路（SPEC-CLOUD-REFACTOR v2 §3.2）。上游真实播放地址只存在于剧集清单，不进目录分片。 */
export interface PlaybackLine {
  providerId: string;
  mediaUrl?: string;
  native?: { kind: 's1-cenc'; videoId: string };
}

/** C-3b 剧集清单：`/api/titles/{workId}` 的响应形态，App 打开剧目时惰性拉取并本地缓存。 */
export interface TitleManifest {
  workId: string;
  title: string;
  channelId: ChannelId;
  isPrivate: boolean;
  episodes: { episodeNumber: number; title?: string; durationSeconds?: number; lines: PlaybackLine[] }[];
  generatedAt: number;
}
