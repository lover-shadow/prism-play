import { createHash } from 'node:crypto';
import { cleanTitle, shortSynopsis } from './compute-hotscore.mjs';
import { providerById, PROVIDERS } from './config-sources.mjs';

// Public source only. Never dispatch this router adapter through the macCMS crawler.
export const PUBLIC_PROVIDER = providerById('provider_s1');
const numericId = (value) => typeof value === 'string' && /^[0-9]{1,32}$/.test(value);
const count = (value) => /^(0|[1-9]\d*)$/.test(String(value)) && Number.isSafeInteger(Number(value));

/** Parse a JSON assignment, never eval HTML/JavaScript. Keep large upstream IDs as strings. */
function loader(html, prefix, accepts) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > 4194304) throw new Error('Invalid public page size');
  const match = /(?:window\.)?_ROUTER_DATA\s*=\s*/.exec(html);
  if (!match) throw new Error('Missing public router data');
  const start = match.index + match[0].length;
  let depth = 0, quoted = false, escaped = false, end = -1;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error('Incomplete public router data');
  const data = JSON.parse(html.slice(start, end));
  // Layout loaders share the prefix. Select by payload identity, never key order.
  const matches = Object.entries(data.loaderData ?? {}).filter(([key, value]) =>
    key.startsWith(prefix) && value && typeof value === 'object' && !Array.isArray(value) && accepts(value));
  if (matches.length !== 1) throw new Error('Ambiguous public loader');
  return matches[0][1];
}
function sourceId(row) {
  const id = row.series_id_str ?? row.series_id;
  if (!numericId(id)) throw new Error('Invalid public source ID (must be a lossless string)');
  return id;
}
function work(row) {
  const id = sourceId(row), title = cleanTitle(row.series_title ?? row.series_name ?? row.title);
  if (!title) throw new Error('Missing public title');
  const result = { id: `drama_s_${id}`, workId: `drama_s_${id}`, providerId: PUBLIC_PROVIDER.id,
    sourceItemId: id, title, channelId: 'drama', category: '都市', isPrivate: false, enabled: true, shareable: true };
  const synopsis = shortSynopsis(row.series_intro ?? row.video_desc);
  if (synopsis) result.synopsis = synopsis;
  if (count(row.episode_cnt)) result.episodeCount = Number(row.episode_cnt);
  const cover = row.series_cover ?? row.cover;
  if (typeof cover === 'string') {
    const url = new URL(cover);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Unsafe public cover');
    result.coverTargetUrl = cover; result.coverUrl = `/proxy/img/${result.id}`;
  }
  return result;
}
export function parsePublicCategory(html, page, previousSignature = '') {
  if (!Number.isSafeInteger(page) || page < 1 || page > 200) throw new Error('Public page limit exceeded');
  const data = loader(html, 'category_', (page) => Array.isArray(page.recommendList));
  if (data.isSuccess !== true || !Array.isArray(data.recommendList) || !count(data.pagination?.totalPages) || Number(data.pagination.totalPages) < page) throw new Error('Invalid public pagination');
  const items = data.recommendList.map((row) => work(row.video_data ?? row));
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error('Duplicate public page IDs');
  const signature = createHash('sha256').update(items.map((item) => item.id).sort().join('\n')).digest('hex');
  if (items.length && signature === previousSignature) throw new Error('Public page repeated');
  return { items, signature, totalPages: Math.min(200, Number(data.pagination.totalPages)), limited: Number(data.pagination.totalPages) > 200 };
}
export function parsePublicDetail(html, expectedId) {
  if (!numericId(expectedId)) throw new Error('Invalid requested source ID');
  const detail = loader(html, 'detail_', (page) => {
    const id = page.seriesDetail?.series_id_str ?? page.seriesDetail?.series_id;
    return numericId(id) && id === expectedId;
  }).seriesDetail;
  if (!detail || sourceId(detail) !== expectedId || !Array.isArray(detail.vid_list)) throw new Error('Public detail identity mismatch');
  const result = work(detail), seen = new Set();
  result.episodes = detail.vid_list.map((id, i) => {
    if (!numericId(id) || seen.has(id)) throw new Error('Invalid or duplicate public episode ID');
    seen.add(id);
    // Source ID is useful supply evidence, NOT a fabricated playable HTTP URL.
    return { episodeNumber: i + 1, sourceEpisodeId: id, title: `第${i + 1}集`, lines: [] };
  });
  if (!result.episodes.length || result.episodes.length > 999999 ||
      (result.episodeCount !== undefined && result.episodeCount !== result.episodes.length)) throw new Error('Incomplete public episodes');
  result.episodeCount = result.episodes.length;
  return result;
}
export function publicFailure(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return { reason: 'timeout' };
  const status = /^Public GET HTTP (\d{3})$/.exec(error?.message ?? '');
  if (status) return { reason: 'http', httpStatus: Number(status[1]) };
  if (/identity|loader|source ID|episode|count mismatch|staging/i.test(error?.message ?? '')) return { reason: 'identity' };
  if (error?.message === 'Expired public media') return { reason: 'media-expired' };
  if (/media|cover/i.test(error?.message ?? '')) return { reason: 'media-unavailable-or-unsafe' };
  if (error?.message === 'budget') return { reason: 'request-budget' };
  return { reason: 'network-or-invalid-response' };
}
export async function publicGet(relativePath, fetcher = fetch, { beforeRequest = async () => {} } = {}) {
  if (typeof relativePath !== 'string' || !/^\/(category\/(real-drama|comic-drama|ai-drama)|detail|player\/\d{1,32}\/\d{1,32})(\?|$)/.test(relativePath) || relativePath.startsWith('//')) throw new Error('Invalid public GET path');
  const url = new URL(relativePath, PUBLIC_PROVIDER.baseUrl);
  if (url.origin !== PUBLIC_PROVIDER.baseUrl) throw new Error('Invalid public GET origin');
  await beforeRequest();
  const response = await fetcher(url.href, { redirect: 'manual', signal: AbortSignal.timeout(15000),
    headers: { Accept: 'text/html' } });
  if (!response.ok) throw new Error(`Public GET HTTP ${response.status}`);
  const body = await response.text();
  if (Buffer.byteLength(body) > 4194304) throw new Error('Public GET response too large');
  return body;
}

/** Reference web protocol: identity-bound player loader, not a guessed playlist path. */
export function parsePublicPlayer(html, seriesId, videoId) {
  if (!numericId(seriesId) || !numericId(videoId)) throw new Error('Invalid player identity');
  const page = loader(html, 'player_', (value) => value.series_id === seriesId && value.vid === videoId);
  if (page.series_id !== seriesId || page.vid !== videoId) throw new Error('Player identity mismatch');
  const info = page.video_player_info;
  if (!info || ['kid', 'key_id', 'spade_a', 'drm', 'encrypt', 'encrypted'].some((key) => info[key])) {
    throw new Error('Encrypted or unavailable public media');
  }
  const value = info.main_url;
  if (typeof value !== 'string' || value.length > 8192 || /[\s\\\u0000-\u001f]/u.test(value)) throw new Error('Unavailable public media URL');
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const privateHost = PROVIDERS.filter((p) => p.privacy === 'private-all').some((p) => {
    const privateDomain = new URL(p.baseUrl).hostname;
    return host === privateDomain || host.endsWith(`.${privateDomain}`);
  });
  if (privateHost || url.protocol !== 'https:' || url.username || url.password ||
      host === 'localhost' || host.endsWith('.local') || host.includes(':') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host) || !host.includes('.') ||
      /\/(?:proxy|player)(?:\/|$)/i.test(url.pathname)) throw new Error('Unsafe public media URL');
  // Only explicit, recognized expiry timestamps are evidence; no media GET or playback claim.
  const expiries = ['expires', 'expire', 'expire_time', 'x-expires'].map((key) => url.searchParams.get(key));
  const signedTime = url.searchParams.get('auth_key')?.split('-')[0];
  if (signedTime) expiries.push(signedTime);
  for (const raw of expiries) {
    if (!raw || !/^\d{1,16}$/.test(raw)) continue;
    const timestamp = Number(raw), seconds = timestamp > 1e12 ? timestamp / 1000 : timestamp;
    if (seconds <= Date.now() / 1000) throw new Error('Expired public media');
  }
  const episode = { sourceEpisodeId: videoId, mediaValidation: 'url-only-not-playback-verified', lines: [{ providerId: PUBLIC_PROVIDER.id, mediaUrl: value }] };
  const duration = Number(info.duration);
  if (info.duration !== undefined && Number.isFinite(duration) && duration > 0) episode.durationSeconds = Math.round(duration);
  return episode;
}

/** Explicit per-work budget, sequential GETs, no credentials or fallback to private/App APIs. */
export async function resolvePublicDetail(detail, { maxEpisodeRequests = 0, fetcher = fetch, beforeRequest } = {}) {
  const blocked = (reason) => ({ status: 'blocked', id: detail?.id, reason });
  if (detail?.providerId !== PUBLIC_PROVIDER.id || detail.isPrivate !== false ||
      !numericId(detail.sourceItemId) || !Array.isArray(detail.episodes) || !detail.episodes.length ||
      detail.episodeCount !== detail.episodes.length) return blocked('invalid-detail');
  if (!Number.isSafeInteger(maxEpisodeRequests) || maxEpisodeRequests < detail.episodes.length || maxEpisodeRequests > 1000) return blocked('episode-budget');
  const seen = new Set();
  for (const [i, ep] of detail.episodes.entries()) {
    if (ep.episodeNumber !== i + 1 || !numericId(ep.sourceEpisodeId) || seen.has(ep.sourceEpisodeId)) return blocked('incomplete-episodes');
    seen.add(ep.sourceEpisodeId);
  }
  const episodes = [], failures = [];
  for (const ep of detail.episodes) {
    try {
      const body = await publicGet(`/player/${detail.sourceItemId}/${ep.sourceEpisodeId}`, fetcher, { beforeRequest });
      episodes.push({ ...ep, ...parsePublicPlayer(body, detail.sourceItemId, ep.sourceEpisodeId) });
    } catch (error) {
      // Scan the remaining authorized episodes once; never retry or expose partial media.
      failures.push({ episodeNumber: ep.episodeNumber, sourceEpisodeId: ep.sourceEpisodeId, ...publicFailure(error) });
    }
  }
  const summary = { expectedEpisodes: detail.episodeCount, resolvedEpisodes: episodes.length, failedEpisodes: failures.length };
  if (failures.length) return { ...blocked('public-player-unavailable'), ...summary, failures };
  return { status: 'candidate', ...summary, fact: { ...detail, episodes } };
}
