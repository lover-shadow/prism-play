import type { EpisodeLine } from '../../library/title-asset';
import { IncompleteDiscoverySearch, type DiscoveryCandidate, type DiscoveryConfig, type DiscoveryProvider, type DiscoveryResolveState } from '../discovery-provider';
import { completeFact, factBase, publicText, record, router, type Row } from './parse';
import { fillSeasons } from './seasons';
import { resolveS1AppMedia, resolveS1PlaybackApi } from './s1-native';
import { DiscoveryHttpError, fetchAllowed, invalid, mediaExpiry, mediaUrl, numericId, requestScope, RESOLVE_TTL_MS, resumeState, searchInput, serverUrl, type RequestScope } from './transport';

/** Optional server-private sink; never attach to public responses or log upstream metadata. */
export interface S1Diagnostic {
  stage: 'input' | 'resume' | 'detail-fetch' | 'detail-parse' | 'detail-fact' | 'player-fetch' | 'player-parse' | 'player-media' | 'player-native' | 'player-backup' | 'complete';
  episodeNumber?: number;
  failure: 'http-rejected' | 'expired' | 'invalid';
  httpStatus?: number;
}

function seriesId(row: Row): string {
  // Router IDs must be lossless strings; large JSON numeric IDs have already lost evidence.
  const id = row.series_id_str ?? row.series_id;
  if (typeof id !== 'string') throw invalid();
  return numericId(id);
}
function candidate(row: Row, config: DiscoveryConfig): DiscoveryCandidate {
  const id = seriesId(row), title = publicText(row.series_title ?? row.series_name ?? row.title, config);
  if (!title || [...title].length > 240) throw invalid();
  const item: DiscoveryCandidate = { providerId: 'provider_s1', sourceItemId: id, id: `drama_s_${id}`, title, channelId: 'drama' };
  const metadata = factBase(item, row, config, true);
  const count = Number(row.episode_cnt);
  return { ...item, ...(Number.isSafeInteger(count) && count > 0 && count <= 5000 ? { episodeCount: count } : {}),
    ...(metadata.coverTargetUrl ? { coverTargetUrl: metadata.coverTargetUrl } : {}),
    ...(metadata.synopsis ? { synopsis: metadata.synopsis } : {}) };
}
export function createS1Provider(config: DiscoveryConfig, diagnosticSink?: (event: S1Diagnostic) => void): DiscoveryProvider {
  serverUrl(config);
  async function getSearch(query: string, scope: RequestScope): Promise<DiscoveryCandidate[]> {
    const text = await fetchAllowed(config, serverUrl(config, `/search/${encodeURIComponent(query)}`).href, scope);
    const page = router(text, 'search_', (value) => value.query === query && value.isSuccess === true && Array.isArray(value.searchList));
    const rows = page.searchList as unknown[];
    if (rows.length > 256) throw invalid();
    const found = new Map<string, DiscoveryCandidate>();
    for (const value of rows) {
      const row = record(value), data = row.video_data ? record(row.video_data) : row;
      const item = candidate(data, config); found.set(item.id, item);
    }
    if (config.suggestionPath) {
      // Optional protocol remains public, server-owned, identity-bound router JSON.
      const path = config.suggestionPath(query);
      if (!/^\/(?:search|suggestion)(?:\/|\?)/.test(path)) throw invalid();
      const extra = router(await fetchAllowed(config, serverUrl(config, path).href, scope), 'search_',
        (value) => value.query === query && value.isSuccess === true && Array.isArray(value.searchList));
      if ((extra.searchList as unknown[]).length > 256) throw invalid();
      for (const value of extra.searchList as unknown[]) {
        const row = record(value), item = candidate(row.video_data ? record(row.video_data) : row, config);
        found.set(item.id, item);
      }
    }
    return [...found.values()];
  }
  return {
    id: 'provider_s1',
    async search(query, page) {
      try {
        const q = searchInput(query, page);
        // Public router offers one search snapshot, not an invented pagination protocol.
        if (page !== 1) return [];
        const scope = requestScope(config.searchBudget ?? { maxRequests: 40, timeoutMs: 40000 });
        const found = await getSearch(q, scope);
        const all = await fillSeasons(q, found, (next) => getSearch(next, scope));
        if (all.length > 256) throw invalid();
        return all;
      } catch (error) {
        if (error instanceof IncompleteDiscoverySearch && error.candidates.length <= 256) throw error;
        throw invalid();
      }
    },
    async resolve(input, cursor, budget) {
      let stage: S1Diagnostic['stage'] = 'input', episodeNumber: number | undefined;
      try {
        const scope = requestScope(budget), id = numericId(input.sourceItemId);
        if (input.providerId !== 'provider_s1' || input.id !== `drama_s_${id}` || input.channelId !== 'drama') throw invalid();
        let state: DiscoveryResolveState;
        if (cursor !== undefined) {
          stage = 'resume';
          state = resumeState(cursor, input, config);
          for (const text of [state.fact.title, state.fact.synopsis, state.fact.region, state.fact.language,
            ...state.fact.episodes.map((ep) => ep.title)]) {
            if (text !== undefined && (typeof text !== 'string' || publicText(text, config) !== text)) throw invalid();
          }
        } else {
          stage = 'detail-fetch';
          const text = await fetchAllowed(config, serverUrl(config, `/detail?series_id=${id}`).href, scope);
          stage = 'detail-parse';
          const detail = router(text, 'detail_', (value) => seriesId(record(value.seriesDetail)) === id);
          const row = record(detail.seriesDetail);
          if (!Array.isArray(row.vid_list) || !row.vid_list.length || row.vid_list.length > 5000) throw invalid();
          const vids = row.vid_list.map((value) => { if (typeof value !== 'string') throw invalid(); return numericId(value); });
          if (new Set(vids).size !== vids.length || (row.episode_cnt !== undefined && Number(row.episode_cnt) !== vids.length)) throw invalid();
          const item = candidate(row, config);
          if (item.title !== input.title) throw invalid();
          stage = 'detail-fact';
          state = { version: 1, candidate: { ...input }, fact: factBase(item, row, config, true), vids, next: 0,
            refreshed: [], expiresAt: Date.now() + RESOLVE_TTL_MS };
        }
        // Redirect hops and expiry refreshes also spend the eight-player-request batch allowance.
        scope.remaining = Math.min(scope.remaining, 8);
        let playerRequests = 0;
        const staleIndex = () => state.fact.episodes.findIndex((ep) => ep.lines.some((line) =>
          !line.native && line.mediaUrl !== undefined && (mediaExpiry(line.mediaUrl) ?? Infinity) <= Date.now()));
        while (playerRequests < 8 && scope.remaining > 0 && Date.now() < scope.deadline) {
          const stale = staleIndex(), index = stale >= 0 ? stale : state.next;
          if (index === state.vids.length) break;
          const vid = state.vids[index], path = `/player/${id}/${vid}`;
          episodeNumber = index + 1; stage = 'player-fetch';
          playerRequests++;
          let url: string | undefined;
          let nativeDescriptor: EpisodeLine['native'];
          let durationSeconds: number | undefined;
          let lastError: unknown;
          let lastStage: S1Diagnostic['stage'] = stage;
          try {
            const text = await fetchAllowed(config, serverUrl(config, path).href, scope);
            stage = 'player-parse';
            const page = router(text, 'player_', (value) => value.series_id === id && value.vid === vid);
            const info = record(page.video_player_info);
            stage = 'player-media';
            if (typeof info.main_url === 'string') {
              url = mediaUrl(config, info.main_url);
              if (typeof info.duration === 'number' && Number.isFinite(info.duration) && info.duration > 0) {
                durationSeconds = Math.max(1, Math.round(info.duration));
              }
            }
          } catch (webErr) {
            if (webErr instanceof Error && webErr.message === 'discovery-budget') break;
            lastError = webErr;
            lastStage = stage;
          }

          if (!url) {
            stage = 'player-native';
            const native = await resolveS1AppMedia(config, vid, scope);
            if (native) {
              url = native.mediaUrl;
              if (native.cencKeyHex) nativeDescriptor = { kind: 's1-cenc', videoId: vid };
              if (native.durationSeconds) durationSeconds = native.durationSeconds;
            }
          }

          if (!url) {
            stage = 'player-backup';
            const backup = await resolveS1PlaybackApi(config, id, vid, scope);
            if (backup) {
              url = backup.mediaUrl;
              if (backup.cencKeyHex) nativeDescriptor = { kind: 's1-cenc', videoId: vid };
              if (backup.durationSeconds) durationSeconds = backup.durationSeconds;
            }
          }

          if (!url) {
            if (state.refreshed.includes(vid) || (lastError instanceof DiscoveryHttpError && lastError.httpStatus === 404)) {
              if (lastError) {
                stage = lastStage;
                throw lastError;
              }
              throw invalid();
            }
            state.refreshed.push(vid);
            continue;
          }

          state.refreshed = state.refreshed.filter((value) => value !== vid);
          const episode = { episodeNumber: index + 1, sourceEpisodeId: vid, title: `第${index + 1}集`,
            mediaValidation: 'url-only-not-playback-verified' as const,
            lines: [{ providerId: 'provider_s1' as const, mediaUrl: url,
              ...(nativeDescriptor ? { native: nativeDescriptor } : {}) }] };
          state.fact.episodes[index] = durationSeconds !== undefined && durationSeconds > 0
            ? { ...episode, durationSeconds } : episode;
          if (index === state.next) state.next++;
        }
        stage = 'complete'; episodeNumber = undefined;
        if (state.expiresAt <= Date.now()) throw invalid();
        if (state.next === state.vids.length && staleIndex() < 0) {
          return { status: 'complete', fact: completeFact(state.fact) };
        }
        return { status: 'progress', cursor: JSON.stringify(state), state,
          resolvedEpisodes: state.next, expectedEpisodes: state.vids.length };
      } catch (error) {
        const event: S1Diagnostic = { stage,
          ...(episodeNumber === undefined ? {} : { episodeNumber }),
          failure: error instanceof DiscoveryHttpError ? 'http-rejected'
            : error instanceof Error && error.message === 'discovery-expired' ? 'expired' : 'invalid',
          ...(error instanceof DiscoveryHttpError ? { httpStatus: error.httpStatus } : {}) };
        try { diagnosticSink?.(event); } catch { /* Diagnostics must not change fail-closed behavior. */ }
        return { status: 'blocked', providerId: 'provider_s1', reason: 'unavailable' };
      }
    }
  };
}
