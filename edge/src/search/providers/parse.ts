import { cleanPlainText, sanitizePublicMetadata } from '../../library/metadata-policy.mjs';
import { stripPlatformNames } from '../../library/platform-lexicon.mjs';
import type { DiscoveryCandidate, DiscoveryConfig, DiscoveryPublicFact } from '../discovery-provider';
import { invalid, protectedData, safeUrl } from './transport';

export type Row = Record<string, unknown>;
export function record(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Row;
}
export function publicText(value: unknown, config: DiscoveryConfig): string {
  let text = stripPlatformNames(cleanPlainText(value)).replace(/红果|hongguo/gi, ' ').trim();
  for (const origin of [config.origin, ...config.originAllowlist]) {
    text = text.split(new URL(origin).hostname).join('');
  }
  return text.replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();
}
/** Balanced JSON extraction only; never execute a router script. Select by payload identity. */
export function router(text: string, prefix: string, accepts: (row: Row) => boolean): Row {
  const match = /(?:window\.)?_ROUTER_DATA\s*=\s*/.exec(text);
  let data: Row;
  if (!match) data = record(JSON.parse(text));
  else {
    const start = match.index + match[0].length;
    const scriptEnd = text.indexOf('</script>', start);
    const limit = scriptEnd > start ? scriptEnd : Math.min(text.length, start + 65536);
    const semi = text.indexOf(';', start);
    let parsedData: Row | undefined;
    if (semi > start && semi < limit) {
      try { parsedData = record(JSON.parse(text.slice(start, semi))); } catch { /* fall back */ }
    }
    if (parsedData) data = parsedData;
    else {
      let depth = 0, quoted = false, escaped = false, end = -1;
      for (let i = start; i < limit; i++) {
        const c = text[i];
        if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
        if (c === '"') { quoted = true; continue; }
        if (c === '{' || c === '[') depth++;
        if (c === '}' || c === ']') { depth--; if (!depth) { end = i + 1; break; } }
      }
      if (end < 0) throw invalid();
      data = record(JSON.parse(text.slice(start, end)));
    }
  }
  const matches = Object.entries(record(data.loaderData)).filter(([key, value]) => {
    if (!key.startsWith(prefix)) return false;
    try { return accepts(record(value)); } catch { return false; }
  });
  if (matches.length !== 1) throw invalid();
  const result = record(matches[0][1]);
  if (protectedData(result)) throw invalid();
  return result;
}
export function factBase(candidate: DiscoveryCandidate, row: Row, config: DiscoveryConfig, s1 = false): DiscoveryPublicFact {
  if (protectedData(row)) throw invalid();
  const metadata = sanitizePublicMetadata({ synopsis: publicText(s1 ? row.series_intro ?? row.video_desc : row.vod_content, config),
    releaseYear: row.vod_year, region: publicText(row.vod_area, config), language: publicText(row.vod_lang, config) });
  const fact: DiscoveryPublicFact = { ...candidate, ...metadata, workId: candidate.id, enabled: true,
    isPrivate: false, shareable: true, generatedAt: Math.floor(Date.now() / 1000), episodeCount: 0, episodes: [] };
  const status = s1 ? row.release_status : publicText(row.vod_remarks, config);
  if (status === 'finished' || (!s1 && /^(?:全\s*\d+\s*集|完结|已完结)$/.test(String(status)))) fact.releaseStatus = 'finished';
  else if (status === 'ongoing' || (!s1 && /^更新(?:至|到)?\s*\d+/.test(String(status)))) fact.releaseStatus = 'ongoing';
  const cover = s1 ? row.series_cover ?? row.cover : row.vod_pic;
  if (cover !== undefined && cover !== '') fact.coverTargetUrl = safeUrl(String(cover), config.coverAllowlist);
  return fact;
}
export function completeFact(fact: DiscoveryPublicFact): DiscoveryPublicFact {
  if (!fact.episodes.length || fact.episodes.length > 5000 || fact.episodes.some((ep, i) => ep.episodeNumber !== i + 1 || !ep.lines.length) ||
    new TextEncoder().encode(JSON.stringify(fact)).byteLength > 524288) throw invalid();
  fact.episodeCount = fact.episodes.length;
  fact.lastSyncedEpisode = fact.episodes.length; fact.lastSyncedAt = Math.floor(Date.now() / 1000);
  return fact;
}
