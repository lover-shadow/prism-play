export type DiscoveryProviderId = 'provider_m1' | 'provider_s1';
export type DiscoveryChannel = 'drama' | 'movie' | 'anime' | 'documentary';
/** Server-owned configuration only. Never populate from a client URL or candidate. */
export interface DiscoveryConfig {
  origin: string;
  originAllowlist: ReadonlySet<string>;
  mediaAllowlist: ReadonlySet<string>;
  coverAllowlist: ReadonlySet<string>;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Optional public suggestion adapter: returns router-backed search rows, not App/login data. */
  suggestionPath?: (query: string) => string;
  searchBudget?: DiscoveryBudget;
}
export interface DiscoveryBudget { maxRequests: number; timeoutMs: number }
export interface DiscoveryCandidate {
  providerId: DiscoveryProviderId; sourceItemId: string; id: string; title: string;
  channelId: DiscoveryChannel; category?: string; isAi?: boolean;
  episodeCount?: number; coverTargetUrl?: string; synopsis?: string;
}
export class IncompleteDiscoverySearch extends Error {
  constructor(readonly candidates: DiscoveryCandidate[]) { super('discovery-search-incomplete'); }
}
export interface DiscoveryEpisode {
  episodeNumber: number; sourceEpisodeId?: string; title: string; durationSeconds?: number;
  mediaValidation: 'url-only-not-playback-verified';
  lines: { providerId: DiscoveryProviderId; mediaUrl?: string; native?: { kind: 's1-cenc'; videoId: string } }[];
}
/** Admission evidence, not a playback promise. Optional category/AI fields require source evidence. */
export interface DiscoveryPublicFact extends DiscoveryCandidate {
  releaseStatus?: 'finished' | 'ongoing'; lastSyncedEpisode?: number; lastSyncedAt?: number;
  workId: string; enabled: true; isPrivate: false; shareable: true; generatedAt: number;
  episodeCount: number; episodes: DiscoveryEpisode[]; coverTargetUrl?: string;
  synopsis?: string; releaseYear?: number; region?: string; language?: string; tags?: string[];
}
/** Server-private checkpoint. Store only in private R2, never in client responses/logs.
 * JSON is a resumable token, not an authenticated capability: only the trusted private
 * coordinator may supply it. Validation rejects unsafe structure but cannot prove provenance.
 * TTL is independent of media signature expiry; expired media is refreshed in bounded batches.
 */
export interface DiscoveryResolveState {
  version: 1; candidate: DiscoveryCandidate; fact: DiscoveryPublicFact;
  vids: string[]; next: number; refreshed: string[]; expiresAt: number;
}
export type DiscoveryResult = { status: 'complete'; fact: DiscoveryPublicFact }
  | { status: 'progress'; cursor: string; state: DiscoveryResolveState; resolvedEpisodes: number; expectedEpisodes: number }
  | { status: 'blocked'; providerId: DiscoveryProviderId; reason: 'unavailable' };
export interface DiscoveryProvider {
  readonly id: DiscoveryProviderId;
  search(query: string, page: number): Promise<DiscoveryCandidate[]>;
  /** Existing string callers pass JSON.stringify(state); old random instance tokens fail closed. */
  resolve(candidate: DiscoveryCandidate, cursor: string | DiscoveryResolveState | undefined, budget: DiscoveryBudget): Promise<DiscoveryResult>;
}
