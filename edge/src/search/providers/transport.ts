import { assertAllowedTarget } from '../../media/upstream';
import { isNativeDescriptor } from '../../library/title-asset';
import type { DiscoveryBudget, DiscoveryCandidate, DiscoveryConfig, DiscoveryResolveState } from '../discovery-provider';

export const invalid = () => new Error('discovery-invalid');
/** Internal evidence only: message remains generic, no URL, headers or response body. */
export class DiscoveryHttpError extends Error {
  constructor(readonly httpStatus: number) { super('discovery-invalid'); }
}
export interface RequestScope { remaining: number; deadline: number }
export function requestScope(budget: DiscoveryBudget): RequestScope {
  if (!Number.isSafeInteger(budget.maxRequests) || budget.maxRequests < 1 || budget.maxRequests > 64 ||
    !Number.isSafeInteger(budget.timeoutMs) || budget.timeoutMs < 1 || budget.timeoutMs > 40000) throw invalid();
  return { remaining: budget.maxRequests, deadline: Date.now() + budget.timeoutMs };
}
export function safeUrl(raw: string, allowed: ReadonlySet<string>): string {
  if (typeof raw !== 'string' || raw.length > 8192 || /[\s\\\u0000-\u001f]/u.test(raw)) throw invalid();
  try {
    const url = assertAllowedTarget(raw, allowed);
    if (url.protocol !== 'https:') throw invalid();
    return url.href;
  } catch { throw invalid(); }
}
export interface FetchAllowedOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

/** A deadline covers every redirect and stream read, even a fetcher that ignores AbortSignal. */
export async function fetchAllowedWithOptions(
  config: DiscoveryConfig,
  raw: string,
  budget: DiscoveryBudget | RequestScope,
  options: FetchAllowedOptions = {}
): Promise<string> {
  const scope = 'remaining' in budget ? budget : requestScope(budget);
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { stopped = true; controller.abort(); void reader?.cancel().catch(() => {}); reject(invalid()); }, Math.max(0, scope.deadline - Date.now()));
  });
  const operation = async () => {
    let target = raw;
    const method = options.method ?? 'GET';
    for (let hop = 0; hop <= 3; hop++) {
      if (stopped || Date.now() >= scope.deadline) throw invalid();
      if (scope.remaining <= 0) throw new Error('discovery-budget');
      scope.remaining--;
      target = safeUrl(target, config.originAllowlist);
      const reqInit: RequestInit = {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: { Accept: 'text/html, application/json', ...(options.headers ?? {}) }
      };
      if (method === 'POST' && options.body !== undefined) {
        reqInit.body = options.body instanceof Uint8Array ? Buffer.from(options.body) : options.body;
      }
      const response = await (config.fetcher ?? fetch)(target, reqInit);
      if (stopped) { void response.body?.cancel().catch(() => {}); throw invalid(); }
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {});
        const location = response.headers.get('Location');
        if (!location || hop === 3) throw invalid();
        target = new URL(location, target).href; continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {}); throw new DiscoveryHttpError(response.status);
      }
      if (!response.body || Number(response.headers.get('Content-Length')) > 4194304) {
        void response.body?.cancel().catch(() => {}); throw invalid();
      }
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
      let bytes = 0, text = '';
      for (;;) {
        const part = await reader.read();
        if (stopped) throw invalid();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 4194304) { void reader.cancel().catch(() => {}); throw invalid(); }
        text += decoder.decode(part.value, { stream: true });
      }
      return text + decoder.decode();
    }
    throw invalid();
  };
  try { return await Promise.race([operation(), timeout]); }
  catch (error) {
    if (error instanceof DiscoveryHttpError || (error instanceof Error && error.message === 'discovery-budget')) throw error;
    throw invalid();
  }
  finally { clearTimeout(timer); }
}

export function fetchAllowed(config: DiscoveryConfig, raw: string, budget: DiscoveryBudget | RequestScope): Promise<string> {
  return fetchAllowedWithOptions(config, raw, budget);
}
export function serverUrl(config: DiscoveryConfig, path?: string): URL {
  const base = new URL(safeUrl(config.origin, config.originAllowlist));
  if (!path) return base;
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u001f]/u.test(path)) throw invalid();
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw invalid();
  return url;
}
export function searchInput(query: string, page: number): string {
  const q = query.normalize('NFKC').trim();
  if (!q || [...q].length > 80 || /[\u0000-\u001f\u007f]|[\ud800-\udfff]/u.test(q) ||
    !Number.isSafeInteger(page) || page < 1 || page > 200) throw invalid();
  return q;
}
export function numericId(value: unknown): string {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof id !== 'string' || !/^\d{1,32}$/.test(id)) throw invalid();
  return id;
}
export function protectedData(value: unknown, depth = 0): boolean {
  if (depth > 20) return true;
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, v]) =>
    (/^(?:drm|drm_info|encrypt|encrypted|encryption|isEncrypted|key|key_id|keyUrl|license|licenseUrl|kid|spade_a|isPrivate|is_private)$/i.test(key) &&
      v !== undefined && v !== null && v !== false && v !== 0 && v !== '' && v !== '0') || protectedData(v, depth + 1));
}
/** Earliest known signature deadline in milliseconds; absence means unknown, not infinite validity. */
export function mediaExpiry(raw: string): number | undefined {
  const url = new URL(raw);
  const times = ['expires', 'expire', 'expire_time', 'x-expires'].map((key) => url.searchParams.get(key));
  times.push(url.searchParams.get('auth_key')?.split('-')[0] ?? null);
  const deadlines = times.filter((time): time is string => time !== null && time !== '').map((time) => {
    if (!/^\d{1,16}$/.test(time)) throw invalid();
    const n = Number(time);
    if (!Number.isSafeInteger(n)) throw invalid();
    return n > 1e12 ? n : n * 1000;
  });
  return deadlines.length ? Math.min(...deadlines) : undefined;
}
export function mediaUrl(config: DiscoveryConfig, raw: string, allowExpired = false): string {
  const value = safeUrl(raw, config.mediaAllowlist), url = new URL(value);
  if (/\/(?:proxy|player)(?:\/|$)/i.test(url.pathname)) throw invalid();
  const expiry = mediaExpiry(value);
  if (!allowExpired && expiry !== undefined && expiry <= Date.now()) throw new Error('discovery-expired');
  return value;
}

export const RESOLVE_TTL_MS = 24 * 60 * 60 * 1000;
/** Clone even object inputs: failed validation/resolution must not mutate the stored checkpoint. */
export function resumeState(input: DiscoveryResolveState | string, candidate: DiscoveryCandidate, config: DiscoveryConfig): DiscoveryResolveState {
  const json = typeof input === 'string' ? input : JSON.stringify(input);
  if (new TextEncoder().encode(json).byteLength > 1048576) throw invalid();
  const state = JSON.parse(json) as DiscoveryResolveState;
  if (!state || typeof state !== 'object' || protectedData(state) || state.version !== 1) throw invalid();
  const same = (value: DiscoveryCandidate) => value && value.providerId === candidate.providerId &&
    value.sourceItemId === candidate.sourceItemId && value.id === candidate.id && value.channelId === candidate.channelId &&
    value.title === candidate.title && value.category === candidate.category && value.isAi === candidate.isAi;
  const keys = (value: object, allowed: string[]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw invalid();
  };
  const candidateKeys = ['providerId', 'sourceItemId', 'id', 'title', 'channelId', 'category', 'isAi', 'episodeCount', 'coverTargetUrl', 'synopsis'];
  keys(state, ['version', 'candidate', 'fact', 'vids', 'next', 'refreshed', 'expiresAt']);
  keys(state.candidate, candidateKeys);
  const fact = state.fact;
  keys(fact, [...candidateKeys, 'workId', 'enabled', 'isPrivate', 'shareable', 'generatedAt', 'episodeCount', 'episodes',
    'coverTargetUrl', 'synopsis', 'releaseYear', 'region', 'language', 'tags', 'releaseStatus']);
  if (fact.releaseStatus !== undefined && fact.releaseStatus !== 'finished' && fact.releaseStatus !== 'ongoing') throw invalid();
  if (!same(state.candidate) || !same(fact) || fact.workId !== candidate.id || fact.enabled !== true ||
    fact.isPrivate !== false || fact.shareable !== true || fact.episodeCount !== 0 ||
    !Number.isSafeInteger(fact.generatedAt) || fact.generatedAt < 0 || fact.generatedAt > Math.floor(Date.now() / 1000) ||
    !Number.isSafeInteger(state.expiresAt) || state.expiresAt <= Date.now() || state.expiresAt > Date.now() + RESOLVE_TTL_MS ||
    !Array.isArray(state.vids) || !state.vids.length || state.vids.length > 5000 ||
    state.vids.some((vid) => typeof vid !== 'string' || numericId(vid) !== vid) || new Set(state.vids).size !== state.vids.length ||
    !Number.isSafeInteger(state.next) || state.next < 0 || state.next > state.vids.length ||
    !Array.isArray(fact.episodes) || fact.episodes.length !== state.next || !Array.isArray(state.refreshed) ||
    new Set(state.refreshed).size !== state.refreshed.length || state.refreshed.some((vid) => !state.vids.includes(vid))) throw invalid();
  if (fact.coverTargetUrl !== undefined) safeUrl(fact.coverTargetUrl, config.coverAllowlist);
  for (const [i, ep] of fact.episodes.entries()) {
    keys(ep, ['episodeNumber', 'sourceEpisodeId', 'title', 'mediaValidation', 'lines', 'durationSeconds']);
    if (!ep || ep.episodeNumber !== i + 1 || ep.sourceEpisodeId !== state.vids[i] || typeof ep.title !== 'string' ||
      ep.mediaValidation !== 'url-only-not-playback-verified' || !Array.isArray(ep.lines) || ep.lines.length !== 1 ||
      (ep.durationSeconds !== undefined && (!Number.isSafeInteger(ep.durationSeconds) || ep.durationSeconds <= 0))) throw invalid();
    for (const line of ep.lines) {
      keys(line, ['providerId', 'mediaUrl', 'native']);
      if (!line || line.providerId !== candidate.providerId) throw invalid();
      if ('native' in line && (!isNativeDescriptor(line.native, line.providerId) || line.native.videoId !== state.vids[i])) throw invalid();
      if (line.mediaUrl !== undefined) mediaUrl(config, line.mediaUrl, true);
      else if (!line.native) throw invalid();
    }
  }
  return state;
}
