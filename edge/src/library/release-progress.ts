export interface ReleaseProgress {
  releaseStatus?: 'finished' | 'ongoing';
  lastSyncedEpisode?: number;
  lastSyncedAt?: number;
}

export function readReleaseProgress(raw: Record<string, unknown>, episodeCount: number): ReleaseProgress | null {
  const result: ReleaseProgress = {};
  if ('releaseStatus' in raw) {
    if (raw.releaseStatus !== 'finished' && raw.releaseStatus !== 'ongoing') return null;
    result.releaseStatus = raw.releaseStatus;
  }
  const hasEpisode = 'lastSyncedEpisode' in raw, hasTime = 'lastSyncedAt' in raw;
  if (hasEpisode !== hasTime) return null;
  if (hasEpisode) {
    if (!Number.isSafeInteger(raw.lastSyncedEpisode) || raw.lastSyncedEpisode !== episodeCount ||
        !Number.isSafeInteger(raw.lastSyncedAt) || Number(raw.lastSyncedAt) < 0) return null;
    result.lastSyncedEpisode = Number(raw.lastSyncedEpisode); result.lastSyncedAt = Number(raw.lastSyncedAt);
  }
  return result;
}
