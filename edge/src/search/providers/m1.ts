import type { DiscoveryCandidate, DiscoveryConfig, DiscoveryEpisode, DiscoveryProvider } from '../discovery-provider';
import { completeFact, factBase, publicText, record, type Row } from './parse';
import { fetchAllowed, invalid, mediaUrl, numericId, protectedData, requestScope, searchInput, serverUrl } from './transport';

const genres: Record<number, string> = { 10: '动作', 16: '动作', 23: '动作', 11: '喜剧', 18: '喜剧',
  13: '科幻', 12: '爱情', 14: '悬疑', 17: '悬疑', 21: '悬疑', 22: '悬疑' };
function candidate(row: Row, config: DiscoveryConfig): DiscoveryCandidate {
  if (protectedData(row)) throw invalid();
  const type = Number(row.type_id), id = numericId(row.vod_id);
  const channelId = [38, 42].includes(type) ? 'drama' : [7, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23].includes(type) ? 'movie'
    : [1, 2, 3, 4].includes(type) ? 'anime' : type === 24 ? 'documentary' : undefined;
  if (!channelId) throw invalid();
  const title = publicText(row.vod_name, config);
  if (!title || [...title].length > 240) throw invalid();
  const item: DiscoveryCandidate = { providerId: 'provider_m1', sourceItemId: id, id: `${channelId}_m_${id}`, title, channelId,
    ...(genres[type] ? { category: genres[type] } : {}), ...(type === 42 ? { isAi: true } : {}) };
  const metadata = factBase(item, row, config);
  const count = Number(row.vod_total);
  return { ...item, ...(Number.isSafeInteger(count) && count > 0 && count <= 5000 ? { episodeCount: count } : {}),
    ...(metadata.coverTargetUrl ? { coverTargetUrl: metadata.coverTargetUrl } : {}),
    ...(metadata.synopsis ? { synopsis: metadata.synopsis } : {}) };
}
function responseRows(text: string): Row[] {
  const body = record(JSON.parse(text));
  if (Number(body.code) !== 1 || !Array.isArray(body.list) || body.list.length > 256) throw invalid();
  return body.list.map(record);
}
function episodes(row: Row, config: DiscoveryConfig): DiscoveryEpisode[] {
  if (typeof row.vod_play_url !== 'string') throw invalid();
  const groups = row.vod_play_url.split('$$$');
  if (groups.length > 32) throw invalid();
  const all = groups.map((group) => group.split('#').map((entry, i) => {
    const split = entry.indexOf('$');
    if (split < 1) throw invalid();
    const label = entry.slice(0, split), explicit = /^(?:第\s*)?(\d+)\s*(?:集|话|期)?$/.exec(label.trim());
    if (explicit && Number(explicit[1]) !== i + 1) throw invalid();
    return { title: publicText(label, config), mediaUrl: mediaUrl(config, entry.slice(split + 1)) };
  }));
  const count = all[0].length;
  if (!count || count > 5000 || all.some((group) => group.length !== count)) throw invalid();
  if (row.vod_total !== undefined && row.vod_total !== '' && Number(row.vod_total) !== 0 && Number(row.vod_total) !== count) throw invalid();
  return all[0].map((ep, i) => ({ episodeNumber: i + 1, title: ep.title || `第${i + 1}集`,
    mediaValidation: 'url-only-not-playback-verified', lines: all.map((group) => ({ providerId: 'provider_m1', mediaUrl: group[i].mediaUrl })) }));
}
export function createM1Provider(config: DiscoveryConfig): DiscoveryProvider {
  serverUrl(config);
  return {
    id: 'provider_m1',
    async search(query, page) {
      try {
        const q = searchInput(query, page), url = serverUrl(config);
        url.search = new URLSearchParams({ ac: 'detail', wd: q, pg: String(page) }).toString();
        const rows = responseRows(await fetchAllowed(config, url.href, config.searchBudget ?? { maxRequests: 8, timeoutMs: 15000 }));
        const found = new Map<string, DiscoveryCandidate>();
        for (const row of rows) { try { const item = candidate(row, config); found.set(item.id, item); } catch { /* Never surface rejected metadata. */ } }
        return [...found.values()];
      } catch { throw invalid(); }
    },
    async resolve(input, cursor, budget) {
      try {
        if (input.providerId !== 'provider_m1' || cursor !== undefined) throw invalid();
        // All playlists arrive in one identity-bound detail response, so no partial checkpoint is needed.
        const id = numericId(input.sourceItemId), scope = requestScope(budget), url = serverUrl(config);
        scope.remaining = Math.min(scope.remaining, 8);
        url.search = new URLSearchParams({ ac: 'detail', ids: id }).toString();
        for (let attempt = 0; attempt < 2; attempt++) {
          const rows = responseRows(await fetchAllowed(config, url.href, scope));
          if (rows.length !== 1 || numericId(rows[0].vod_id) !== id) throw invalid();
          const item = candidate(rows[0], config);
          if (item.id !== input.id || item.channelId !== input.channelId) throw invalid();
          const fact = factBase(item, rows[0], config);
          try { fact.episodes = episodes(rows[0], config); return { status: 'complete', fact: completeFact(fact) }; }
          catch (error) { if (attempt || !(error instanceof Error) || error.message !== 'discovery-expired') throw invalid(); }
        }
        throw invalid();
      } catch { return { status: 'blocked', providerId: 'provider_m1', reason: 'unavailable' }; }
    }
  };
}
