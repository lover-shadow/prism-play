/**
 * Gate G2 upstream seam — the only module in the Worker that performs an outbound media call.
 *
 * Two rules keep API-SPEC §六 (白名单 + 防 SSRF) honest:
 * 1. the target is validated against the D1-derived whitelist at the moment of the request, never once
 *    at mint time, so a retired provider or a hand-crafted sealed handle can aim the edge nowhere;
 * 2. every fetch is `redirect: 'manual'` and every hop is re-validated, so an allowlisted host can not
 *    be used as a one-hop jump into an internal one.
 * Tests inject a fake `UpstreamFetcher`; nothing here may reach the network in CI.
 */

export interface UpstreamFetcher {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/** Default implementation: the runtime global, used only outside the test suite. */
export const globalFetcher: UpstreamFetcher = {
  fetch: (url, init) => fetch(url, init)
};

export type TargetRejectionReason =
  | 'unparseable'
  | 'scheme'
  | 'credentials'
  | 'forbidden_ip'
  | 'reserved_hostname'
  | 'not_allowlisted';

/**
 * `reason` and `message` are for server-side logs only. A route must never echo either to the client,
 * because "which host did you try" is exactly the upstream identity the contract keeps internal.
 */
export class UpstreamTargetRejectedError extends Error {
  readonly reason: TargetRejectionReason;

  constructor(reason: TargetRejectionReason, message: string) {
    super(message);
    this.name = 'UpstreamTargetRejectedError';
    this.reason = reason;
  }
}

export type UpstreamFailureReason = 'network' | 'redirect';

export class UpstreamFetchFailure extends Error {
  readonly reason: UpstreamFailureReason;

  constructor(reason: UpstreamFailureReason, message: string) {
    super(message);
    this.name = 'UpstreamFetchFailure';
    this.reason = reason;
  }
}

/** Only these two; `file:`/`data:`/`gopher:`/`javascript:` never leave the edge. */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['https:', 'http:']);

/** mDNS / service-discovery suffixes plus the loopback name, refused before the whitelist is consulted. */
const FORBIDDEN_HOST_SUFFIXES = ['.local', '.internal', '.localhost', '.home.arpa'];

/** Anything past three hops is a loop or an SSRF stall; both are refused. */
export const MAX_UPSTREAM_HOPS = 3;

const V6_UNSPECIFIED = '0,0,0,0,0,0,0,0';
const V6_LOOPBACK = '0,0,0,0,0,0,0,1';

/** The fourth octet needs no rule of its own: every special-purpose block is decided by the first two. */
function forbiddenIpv4(a: number, b: number, c: number, _d: number): boolean {
  if (a === 0) return true;                                          // 0/8 本网络与未指定地址
  if (a === 10) return true;                                         // 10/8
  if (a === 100 && b >= 64 && b <= 127) return true;                 // 100.64/10 运营商级内网
  if (a === 127) return true;                                        // 127/8 环回
  if (a === 169 && b === 254) return true;                           // 169.254/16 链路本地，含 169.254.169.254 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true;                  // 172.16/12
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;     // 192.0.0/24 与 192.0.2/24
  if (a === 192 && b === 168) return true;                           // 192.168/16
  if (a === 198 && (b === 51 || (b >= 18 && b <= 19))) return true;  // 198.51.100/24 与 198.18/15
  if (a === 203 && b === 0 && c === 113) return true;                // 203.0.113/24
  return a >= 224;                                                   // 组播、保留与广播
}

/** `127.1`, `2130706433`, `0x7f000001`: non-canonical literals that different parsers reinterpret. */
function isNumericLookalike(host: string): boolean {
  return /^[0-9.]+$/.test(host) || /^0[xX][0-9a-fA-F.]+$/.test(host);
}

function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets;
}

/** Splits an IPv6 literal into exactly eight 16-bit words, expanding `::` and an embedded IPv4 tail. */
function ipv6Words(value: string): number[] | null {
  const fill = (text: string): number[] | null => {
    if (text === '') return [];
    const words: number[] = [];
    for (const segment of text.split(':')) {
      const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(segment);
      if (dotted !== null) {
        words.push(Number(dotted[1]) * 256 + Number(dotted[2]), Number(dotted[3]) * 256 + Number(dotted[4]));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(segment)) return null;
      words.push(parseInt(segment, 16));
    }
    return words;
  };
  const compressed = value.indexOf('::');
  if (compressed === -1) {
    const words = fill(value);
    return words !== null && words.length === 8 ? words : null;
  }
  const head = fill(value.slice(0, compressed));
  const tail = fill(value.slice(compressed + 2));
  if (head === null || tail === null || head.length + tail.length > 7) return null;
  return [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
}

const high = (word: number): number => Math.floor(word / 256);
const low = (word: number): number => word % 256;

/** IPv6 ranges the edge may never contact, including the forms that smuggle an IPv4 inside them. */
function forbiddenIpv6(bracketed: string): boolean {
  const words = ipv6Words(bracketed.replace(/^\[/, '').replace(/\]$/, ''));
  // An IPv6 literal this guard cannot classify is refused, never guessed at.
  if (words === null) return true;
  const joined = words.join(',');
  if (joined === V6_UNSPECIFIED || joined === V6_LOOPBACK) return true;
  const [first] = words;
  if ((first & 0xffc0) === 0xfe80) return true;   // fe80::/10 链路本地
  if ((first & 0xfe00) === 0xfc00) return true;   // fc00::/7 唯一本地
  if ((first & 0xff00) === 0xff00) return true;   // ff00::/12 组播
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    return forbiddenIpv4(high(words[6]), low(words[6]), high(words[7]), low(words[7])); // ::ffff:a.b.c.d
  }
  if (first === 0x2002) return forbiddenIpv4(high(words[1]), low(words[1]), high(words[2]), low(words[2]));
  if (first === 0x2001 && words[1] === 0) {
    const client = 255;                            // Teredo 客户端 IPv4 是按位取反存储的
    return forbiddenIpv4(client - high(words[6]), client - low(words[6]), client - high(words[7]), client - low(words[7]));
  }
  return false;
}

/** `URL.hostname` keeps an IPv6 literal bracketed, so brackets are the only reliable marker. */
function isIpAddressLiteral(host: string): boolean {
  return host.startsWith('[') || isIpv4Literal(host);
}

/**
 * Absolute-URL guard used by every outbound hop. Throws `UpstreamTargetRejectedError` on refusal, so a
 * caller can never accidentally treat a rejected target as "just another upstream error".
 */
export function assertAllowedTarget(rawUrl: string, allowedOrigins: ReadonlySet<string>): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UpstreamTargetRejectedError('unparseable', '目标不是可解析的绝对 URL');
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UpstreamTargetRejectedError('scheme', `拒绝协议 ${url.protocol}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new UpstreamTargetRejectedError('credentials', '拒绝内嵌凭据的 URL');
  }
  const host = url.hostname.replace(/\.$/, '');
  if (host === '' || host.includes('%')) {
    throw new UpstreamTargetRejectedError('forbidden_ip', '主机标识不合法');
  }
  if (host === 'localhost' || FORBIDDEN_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new UpstreamTargetRejectedError('reserved_hostname', '拒绝保留主机名');
  }
  if (isNumericLookalike(host) && !isIpv4Literal(host)) {
    throw new UpstreamTargetRejectedError('forbidden_ip', '拒绝非规范 IP 字面量');
  }
  if (isIpAddressLiteral(host)) {
    const octets = isIpv4Literal(host) ? ipv4Octets(host) : null;
    const refused = octets !== null ? forbiddenIpv4(octets[0], octets[1], octets[2], octets[3]) : forbiddenIpv6(host);
    if (refused) throw new UpstreamTargetRejectedError('forbidden_ip', '拒绝内网与特殊用途 IP 字面量');
  }
  // Exact origin equality or wildcard subdomain matching (e.g. `https://*.domain.com`).
  const inAllowlist = allowedOrigins.has(url.origin) || Array.from(allowedOrigins).some((entry) => {
    if (entry.startsWith('https://*.') && url.protocol === 'https:' && url.port === '') {
      const suffix = entry.slice('https://*'.length);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return false;
  });
  if (!inAllowlist) {
    throw new UpstreamTargetRejectedError('not_allowlisted', '目标不在上游白名单内');
  }
  return url;
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status <= 399;
}

function nextHop(response: Response, base: URL): string {
  const location = response.headers.get('Location');
  if (location === null || location.trim() === '') {
    throw new UpstreamFetchFailure('redirect', '上游重定向未给出目标');
  }
  try {
    return new URL(location, base).toString();
  } catch {
    throw new UpstreamFetchFailure('redirect', '上游重定向目标不可解析');
  }
}

async function attemptFetch(fetcher: UpstreamFetcher, url: URL, headers: HeadersInit | undefined): Promise<Response> {
  try {
    return await fetcher.fetch(url.toString(), { redirect: 'manual', headers });
  } catch {
    // The cause may name the upstream host, so it is deliberately not carried into the message.
    throw new UpstreamFetchFailure('network', '上游网络不可达');
  }
}

/**
 * Opens an upstream resource: validate, fetch with manual redirects, re-validate every hop.
 * Returns the terminal response with any status; the caller decides what a non-2xx means. A 3xx we
 * cannot follow surfaces as `UpstreamFetchFailure('redirect')` — never as a client-visible Location.
 */
export async function openUpstream(input: {
  url: string;
  allowedOrigins: ReadonlySet<string>;
  fetcher?: UpstreamFetcher;
  headers?: HeadersInit;
}): Promise<Response> {
  const fetcher = input.fetcher ?? globalFetcher;
  let cursor = input.url;
  for (let hop = 0; ; hop += 1) {
    const validated = assertAllowedTarget(cursor, input.allowedOrigins);
    const response = await attemptFetch(fetcher, validated, input.headers);
    // A response a runtime refuses to expose (status 0, e.g. an opaque redirect) cannot be validated,
    // and `Location` is unreadable from it — so it is refused rather than relayed.
    if (response.status === 0) throw new UpstreamFetchFailure('redirect', '上游重定向不可核验');
    if (!isRedirectStatus(response.status)) return response;
    if (hop >= MAX_UPSTREAM_HOPS) throw new UpstreamFetchFailure('redirect', '上游重定向跳数超出上限');
    cursor = nextHop(response, validated);
  }
}
