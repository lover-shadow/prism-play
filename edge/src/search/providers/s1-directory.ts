import type { DiscoveryBudget, DiscoveryCandidate, DiscoveryConfig, DiscoveryPublicFact } from '../discovery-provider';
import { factBase, record, router, publicText } from './parse';
import { fetchAllowed, numericId, serverUrl } from './transport';

export async function resolveS1Directory(candidate: DiscoveryCandidate, config: DiscoveryConfig,
  budget: DiscoveryBudget = { maxRequests: 4, timeoutMs: 15000 }): Promise<DiscoveryPublicFact> {
  const sid = numericId(candidate.sourceItemId);
  if (candidate.providerId !== 'provider_s1' || candidate.id !== `drama_s_${sid}` || candidate.channelId !== 'drama') {
    throw new Error('Invalid directory identity');
  }
  const text = await fetchAllowed(config, serverUrl(config, `/detail?series_id=${sid}`).href,
    budget);
  const detail = router(text, 'detail_', (value) => {
    const row = record(value.seriesDetail), id = row.series_id_str ?? row.series_id;
    return typeof id === 'string' && numericId(id) === sid;
  });
  const row = record(detail.seriesDetail);
  if (publicText(row.series_title ?? row.series_name ?? row.title, config) !== candidate.title ||
    !Array.isArray(row.vid_list) || !row.vid_list.length || row.vid_list.length > 5000) throw new Error('Invalid directory');
  const vids = row.vid_list.map((v) => {
    if (typeof v !== 'string') throw new Error('Invalid episode identity');
    return numericId(v);
  });
  if (new Set(vids).size !== vids.length || (row.episode_cnt !== undefined && Number(row.episode_cnt) !== vids.length)) {
    throw new Error('Invalid episode count');
  }
  const fact = factBase(candidate, row, config, true);
  fact.episodes = vids.map((videoId, i) => ({ episodeNumber: i + 1, title: `第${i + 1}集`,
    mediaValidation: 'url-only-not-playback-verified',
    lines: [{ providerId: 'provider_s1', native: { kind: 's1-cenc', videoId } }] }));
  fact.episodeCount = vids.length;
  return fact;
}
