import { describe, expect, it } from 'vitest';
import { readReleaseProgress } from '../../edge/src/library/release-progress';
import { parseTitleAsset, itemFromAsset } from '../../edge/src/library/title-asset';
import { validateDiscoveryFact } from '../../edge/src/search/discovery-facts';
import { statusPillLabels } from '../../src/player/detail-facts';
import { completeFact, factBase } from '../../edge/src/search/providers/parse';
import type { DiscoveryConfig } from '../../edge/src/search/discovery-provider';

const config: DiscoveryConfig = { origin: 'https://source.example.test', originAllowlist: new Set(['https://source.example.test']),
  mediaAllowlist: new Set(['https://media.example.test']), coverAllowlist: new Set(['https://cover.example.test']) };
const candidate = { providerId: 'provider_m1' as const, sourceItemId: '10', id: 'anime_m_10', title: '故事', channelId: 'anime' as const };
describe('source-evidenced release progress', () => {
  it('does not guess finished status from a populated episode list', () => {
    expect(readReleaseProgress({ episodeCount: 100 }, 100)).toEqual({});
    expect(factBase(candidate, { vod_remarks: '更新至40集' }, config).releaseStatus).toBe('ongoing');
    expect(factBase(candidate, { vod_remarks: '全40集' }, config).releaseStatus).toBe('finished');
    expect(factBase(candidate, {}, config).releaseStatus).toBeUndefined();
  });
  it('validates status and synchronized episode count instead of accepting arbitrary metadata', () => {
    expect(readReleaseProgress({ releaseStatus: 'ongoing', lastSyncedEpisode: 3, lastSyncedAt: 100 }, 3))
      .toEqual({ releaseStatus: 'ongoing', lastSyncedEpisode: 3, lastSyncedAt: 100 });
    expect(readReleaseProgress({ releaseStatus: 'fake', lastSyncedEpisode: 4, lastSyncedAt: -1 }, 3)).toBeNull();
    expect(readReleaseProgress({ lastSyncedEpisode: 4, lastSyncedAt: 100 }, 3)).toBeNull();
  });
  it('stamps a completed refresh and preserves progress in card projection', () => {
    const base = factBase(candidate, { vod_remarks: '更新至1集' }, config);
    base.episodes = [{ episodeNumber: 1, title: '第一集', mediaValidation: 'url-only-not-playback-verified',
      lines: [{ providerId: 'provider_m1', mediaUrl: 'https://media.example.test/1.mp4' }] }];
    const completed = completeFact(base);
    expect(completed.lastSyncedEpisode).toBe(1); expect(completed.lastSyncedAt).toBeGreaterThan(0);
    const parsed = parseTitleAsset(JSON.stringify(completed), candidate.id);
    if (!parsed.ok) throw new Error('fact rejected');
    const card = itemFromAsset(parsed.value);
    expect(card).toMatchObject({ releaseStatus: 'ongoing', lastSyncedEpisode: 1, lastSyncedAt: completed.lastSyncedAt });
    expect(statusPillLabels({ item: card, episodes: [{ episodeId: 1, episodeNumber: 1 }] })).toContain('连载中');
    const stored = validateDiscoveryFact(completed, candidate.id);
    expect(stored?.stored).toMatchObject({ releaseStatus: 'ongoing', lastSyncedEpisode: 1, lastSyncedAt: completed.lastSyncedAt });
    expect(stored?.card.releaseStatus).toBe('ongoing');
  });
});
