import { assertAllowedTarget } from './upstream';

/**
 * HLS manifest rewriting for `GET /proxy/media/{handle}`.
 *
 * The contract (API-SPEC §六, SPEC §12.1-4) requires that *every* child of a playlist — variant
 * sub-playlists, segments, `EXT-X-KEY` URIs, `EXT-X-MAP`, subtitle renditions — becomes a same-origin
 * controlled URL that still carries the content identity, so the proxy can re-authorize each sub-request.
 * The child's absolute upstream URL is sealed into a media handle (AES-256-GCM), which is what keeps
 * 零上游地址暴露 true for a manifest while leaving the target recoverable server-side only.
 *
 * Line order and line count are preserved exactly: only the URI values change, which is what lets the
 * suite diff the rewrite against the fixture line by line.
 */

export const HLS_MANIFEST_CONTENT_TYPE = 'application/vnd.apple.mpegurl';

export interface PlaylistRewriteInput {
  /** Absolute URL this playlist was fetched from; the base for every relative reference. */
  playlistUrl: string;
  /** D1-derived whitelist. A child that resolves outside it aborts the whole rewrite. */
  allowedOrigins: ReadonlySet<string>;
  /** Builds the same-origin signed `/proxy/media/...` URL for one already-resolved absolute target. */
  mintChildUrl(childTargetUrl: string): Promise<string>;
}

/** A reference we cannot turn into an allowlisted absolute URL; the route answers 503, never passthrough. */
export class HlsReferenceUnresolvableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HlsReferenceUnresolvableError';
  }
}

export function isHlsManifest(target: URL, upstreamContentType: string | null): boolean {
  if (/\.m3u8(?:$|[?#])/i.test(target.pathname)) return true;
  return upstreamContentType !== null && /mpegurl/i.test(upstreamContentType);
}

interface UriRange {
  /** First character of the attribute value, after the opening quote when quoted. */
  start: number;
  /** One past the last value character; the closing quote sits here when quoted. */
  end: number;
  quoted: boolean;
}

/**
 * Quote-aware location of every top-level `URI=` value in one directive line.
 *
 * A naive `,` split is wrong: `URI="https://k.test/key?a=1,2"` and `NAME="中文,字幕"` both carry commas
 * inside quotes. Scanning stops at the closing quote for a quoted value and at the next top-level comma
 * otherwise, and an attribute name is only read from a position that is itself outside any quote.
 */
function uriValueRanges(line: string): UriRange[] {
  const headerEnd = line.indexOf(':');
  if (headerEnd === -1) return [];
  const ranges: UriRange[] = [];
  let attributeStart = headerEnd + 1;
  let inQuotes = false;
  for (let index = headerEnd + 1; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (inQuotes) continue;
    if (char === ',') {
      attributeStart = index + 1;
      continue;
    }
    if (char !== '=' || line.slice(attributeStart, index) !== 'URI') continue;
    const quoted = line[index + 1] === '"';
    const start = index + (quoted ? 2 : 1);
    let end = start;
    while (end < line.length) {
      if (quoted ? line[end] === '"' : line[end] === ',') break;
      end += 1;
    }
    ranges.push({ start, end, quoted });
    // Skip the value and its quotes; the loop's own step lands on the next delimiter.
    index = quoted ? end : end - 1;
  }
  return ranges;
}

/** Resolves one reference against the playlist URL and proves its origin is allowlisted. */
async function resolveChildTarget(input: PlaylistRewriteInput, reference: string): Promise<string> {
  let absolute: string;
  try {
    absolute = new URL(reference, input.playlistUrl).toString();
  } catch {
    throw new HlsReferenceUnresolvableError('清单引用无法解析为绝对 URL');
  }
  // Refuse rather than emit: an off-whitelist child must never be handed to the client, sealed or not.
  return assertAllowedTarget(absolute, input.allowedOrigins).toString();
}

async function rewriteDirectiveLine(input: PlaylistRewriteInput, line: string): Promise<string> {
  if (!line.startsWith('#EXT-') || !line.includes('URI=')) return line;
  const ranges = uriValueRanges(line);
  if (ranges.length === 0) return line;
  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    out += line.slice(cursor, range.start);
    out += await input.mintChildUrl(await resolveChildTarget(input, line.slice(range.start, range.end)));
    if (range.quoted) out += '"';
    cursor = range.end + (range.quoted ? 1 : 0);
  }
  return out + line.slice(cursor);
}

async function rewriteReferenceLine(input: PlaylistRewriteInput, line: string): Promise<string> {
  const reference = line.trim();
  if (reference === '') return line;
  return input.mintChildUrl(await resolveChildTarget(input, reference));
}

/**
 * Rewrites a master or media playlist. Anything that is not a URI-bearing line is returned untouched,
 * so `#EXTM3U`, `#EXT-X-VERSION`, `#EXT-X-TARGETDURATION`, `#EXTINF` and `#EXT-X-ENDLIST` survive
 * byte-for-byte and `#EXT-X-KEY` keeps `IV=` / `KEYFORMAT=` with only its `URI` swapped.
 */
export async function rewriteMediaPlaylist(input: PlaylistRewriteInput, text: string): Promise<string> {
  const lines = text.split('\n');
  const rewritten: string[] = [];
  for (const line of lines) {
    rewritten.push(
      line.startsWith('#') ? await rewriteDirectiveLine(input, line) : await rewriteReferenceLine(input, line)
    );
  }
  return rewritten.join('\n');
}
