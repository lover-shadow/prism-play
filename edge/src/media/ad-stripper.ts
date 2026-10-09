/**
 * M3U8 通用广告切片手术刀（判定引擎）。
 *
 * 判定哲学（不枚举广告长什么样，先确认正片长什么样，再剔除脱离主群的入侵块）：
 * 五道闸门，任一道不过即原样放行——宁可漏杀，绝不错杀：
 *   ① 格式安检：非标准 VOD 清单 / 真实加密 / 初始化段 / 解析异常 / 超限 → 不处理；
 *   ② 主流确认：按累计时长统计目录签名占比，最高占比低于门槛（默认 0.55）→ 一条不删；
 *   ③ 少数派圈定：目录签名与主流不同的块即为候选；
 *   ④ 重复验证：同一异类签名必须在本清单出现 ≥2 个独立块（单次出现的异类块视为合法片段）；
 *   ⑤ 结构验证：块需存在 #EXT-X-DISCONTINUITY 边界且时长 ≤ 上限（默认 45s）。
 *
 * 实测依据（2026-10-09 对 provider_m1 多部剧目抓包校准）：广告池跨剧逐字节复用、恒定被
 * DISCONTINUITY 包裹、单块 17.64s、目录与正片完全不同；短剧集正片占比 63%~80%（2 分钟正片
 * 夹 2 条广告），长剧集 98%+，故主流门槛取 0.55；广告每集重复 2~8 块，故重复门槛取 2。
 *
 * 重建纪律：保留块按原顺序重排，EXTINF / BYTERANGE 等标签归属不变；被删块两侧的
 * 边界收敛为一个 DISCONTINUITY，保留"此处曾有边界"的事实，避免时间戳跳变引发解码故障。
 */

import type { AdStripParams } from './ad-strip-config';

export interface CleanOutcome {
  /** 输出文本；mode 为 unchanged / passthrough 时与原文本逐字节一致。 */
  text: string;
  mode: 'cleaned' | 'unchanged' | 'master' | 'passthrough';
  removedBlocks: number;
  removedSegments: number;
  removedSeconds: number;
  totalSeconds: number;
  /** 主流签名占比（0~1）；单签名清单为 1。 */
  dominantRatio: number;
}

interface Segment {
  /** EXTINF 之前的标签（如 PROGRAM-DATE-TIME）。 */
  pre: string[];
  inf: string;
  /** EXTINF 与 URI 之间的标签（BYTERANGE 等）。 */
  post: string[];
  uri: string;
  seconds: number;
}

interface Block {
  boundaryBefore: boolean;
  segments: Segment[];
}

interface ParsedPlaylist {
  headers: string[];
  blocks: Block[];
  trailer: string[];
  hasEndList: boolean;
}

const DURATION_PATTERN = /^#EXTINF:\s*([0-9]+(?:\.[0-9]+)?)/;

/** 清单级标签白名单：只有这些前缀允许进入头部，其余标签一律随段保存。 */
const HEADER_PREFIXES = [
  '#EXTM3U', '#EXT-X-VERSION', '#EXT-X-TARGETDURATION', '#EXT-X-MEDIA-SEQUENCE', '#EXT-X-PLAYLIST-TYPE',
  '#EXT-X-DISCONTINUITY-SEQUENCE', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-START', '#EXT-X-ALLOW-CACHE'
];

function resolveUri(reference: string, baseUrl: string): string | null {
  try {
    const url = new URL(reference, baseUrl);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/** 目录签名：路径目录部分（不含文件名与查询）；对 CDN 主机轮换不敏感。 */
export function segmentSignature(uri: string): string {
  try {
    const pathname = new URL(uri).pathname;
    const slash = pathname.lastIndexOf('/');
    return slash >= 0 ? pathname.slice(0, slash + 1) : pathname;
  } catch {
    return uri;
  }
}

/** 提取 `#EXT-X-KEY` 的 METHOD 属性值；属性缺失或畸形一律返回 null（按最保守处理）。 */
function keyMethodOf(line: string): string | null {
  const colon = line.indexOf(':');
  const attributes = colon < 0 ? '' : line.slice(colon + 1);
  const match = /(?:^|,)METHOD=([^,]+)/.exec(attributes);
  return match === null ? null : match[1].trim().toUpperCase();
}

function parseMediaPlaylist(lines: readonly string[], baseUrl: string, maxSegments: number): ParsedPlaylist | null {
  const headers: string[] = [];
  const blocks: Block[] = [];
  let block: Block = { boundaryBefore: false, segments: [] };
  let currentInf: string | null = null;
  let currentPre: string[] = [];
  let currentPost: string[] = [];
  let pending: string[] = [];
  let segmentCount = 0;
  let hasEndList = false;

  const sealBlock = (): void => {
    if (block.segments.length > 0) blocks.push(block);
    block = { boundaryBefore: false, segments: [] };
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (line === '#EXT-X-ENDLIST') {
      hasEndList = true;
      continue;
    }
    if (line === '#EXT-X-DISCONTINUITY') {
      sealBlock();
      block.boundaryBefore = true;
      continue;
    }
    // 真实加密与初始化段一律不做手术：删除可能破坏密钥继承关系，交回原链路最安全。
    // 唯一例外是 METHOD=NONE 明文声明（实测广告块自带）：它不改变解密状态，随段保留/删除均安全。
    if (line.startsWith('#EXT-X-MAP')) return null;
    if (line.startsWith('#EXT-X-KEY') && keyMethodOf(line) !== 'NONE') return null;
    if (line.startsWith('#EXTINF:')) {
      if (currentInf !== null || !DURATION_PATTERN.test(line)) return null;
      currentInf = line;
      currentPre = pending;
      pending = [];
      continue;
    }
    if (line.startsWith('#')) {
      if (currentInf !== null) currentPost.push(line);
      else if (segmentCount === 0 && blocks.length === 0 && HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))) headers.push(line);
      else pending.push(line);
      continue;
    }
    if (currentInf === null) return null;
    const uri = resolveUri(line, baseUrl);
    if (uri === null) return null;
    segmentCount += 1;
    if (segmentCount > maxSegments) return null;
    const seconds = Number(DURATION_PATTERN.exec(currentInf)?.[1] ?? 0);
    block.segments.push({ pre: currentPre, inf: currentInf, post: currentPost, uri, seconds });
    currentInf = null;
    currentPre = [];
    currentPost = [];
  }
  if (currentInf !== null) return null;
  sealBlock();
  if (!hasEndList) return null;
  return { headers, blocks, trailer: pending, hasEndList };
}

function blockSignature(b: Block): string {
  const local = new Map<string, number>();
  for (const s of b.segments) {
    const sig = segmentSignature(s.uri);
    local.set(sig, (local.get(sig) ?? 0) + s.seconds);
  }
  let top = '';
  let topSeconds = -1;
  for (const [sig, seconds] of local) {
    if (seconds > topSeconds) {
      top = sig;
      topSeconds = seconds;
    }
  }
  return top;
}

const blockSeconds = (b: Block): number => b.segments.reduce((sum, s) => sum + s.seconds, 0);

export function cleanHlsPlaylist(
  text: string,
  options: { baseUrl: string; params: AdStripParams; cleanBase?: string; workId?: string }
): CleanOutcome {
  const base: Omit<CleanOutcome, 'mode'> = {
    text,
    removedBlocks: 0,
    removedSegments: 0,
    removedSeconds: 0,
    totalSeconds: 0,
    dominantRatio: 1
  };
  if (!text.replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) return { ...base, mode: 'passthrough' };
  if (text.length > options.params.maxBytes) return { ...base, mode: 'passthrough' };

  const lines = text.split(/\r?\n/);
  if (lines.some((line) => line.includes('#EXT-X-STREAM-INF'))) {
    if (options.cleanBase === undefined) return { ...base, mode: 'passthrough' };
    return { ...base, mode: 'master', text: rewriteMaster(lines, options.baseUrl, options.cleanBase, options.workId) };
  }

  const parsed = parseMediaPlaylist(lines, options.baseUrl, options.params.maxSegments);
  if (parsed === null) return { ...base, mode: 'passthrough' };

  const totals = new Map<string, number>();
  let totalSeconds = 0;
  for (const b of parsed.blocks) {
    for (const s of b.segments) {
      const sig = segmentSignature(s.uri);
      totals.set(sig, (totals.get(sig) ?? 0) + s.seconds);
      totalSeconds += s.seconds;
    }
  }
  if (totalSeconds <= 0 || totals.size <= 1) return { ...base, mode: 'unchanged', totalSeconds, dominantRatio: 1 };

  let dominantSig = '';
  let dominantSeconds = 0;
  for (const [sig, seconds] of totals) {
    if (seconds > dominantSeconds) {
      dominantSig = sig;
      dominantSeconds = seconds;
    }
  }
  const dominantRatio = dominantSeconds / totalSeconds;
  // 闸门②：找不到绝对主流则不猜，整份清单原样放行。
  if (dominantRatio < options.params.dominantRatio) return { ...base, mode: 'unchanged', totalSeconds, dominantRatio };

  // 闸门③④：按签名圈出少数派块，同一签名须出现重复次数以上才视作证据。
  const foreignBySig = new Map<string, number[]>();
  parsed.blocks.forEach((b, index) => {
    const sig = blockSignature(b);
    if (sig === dominantSig) return;
    const list = foreignBySig.get(sig) ?? [];
    list.push(index);
    foreignBySig.set(sig, list);
  });

  const remove = new Set<number>();
  let removedBlocks = 0;
  let removedSegments = 0;
  let removedSeconds = 0;
  for (const indexes of foreignBySig.values()) {
    if (indexes.length < options.params.repeatBlocks) continue;
    for (const index of indexes) {
      const b = parsed.blocks[index];
      // 闸门⑤：两侧存在边界、时长在上限内才允许动刀。
      const bounding = b.boundaryBefore || (index + 1 < parsed.blocks.length && parsed.blocks[index + 1].boundaryBefore);
      if (!bounding) continue;
      if (blockSeconds(b) > options.params.maxBlockSeconds) continue;
      remove.add(index);
      removedBlocks += 1;
      removedSegments += b.segments.length;
      removedSeconds += blockSeconds(b);
    }
  }

  if (remove.size === 0) return { ...base, mode: 'unchanged', totalSeconds, dominantRatio };

  const out: string[] = [...parsed.headers];
  let kept = 0;
  parsed.blocks.forEach((b, index) => {
    if (remove.has(index)) return;
    if (kept > 0 && b.boundaryBefore) out.push('#EXT-X-DISCONTINUITY');
    for (const s of b.segments) out.push(...s.pre, s.inf, ...s.post, s.uri);
    kept += 1;
  });
  out.push(...parsed.trailer, '#EXT-X-ENDLIST');
  return { text: out.join('\n'), mode: 'cleaned', removedBlocks, removedSegments, removedSeconds, totalSeconds, dominantRatio };
}

/** 主清单：变体流地址重写为清洗入口（子清单继续走手术刀），URI 属性绝对化。 */
function rewriteMaster(lines: readonly string[], baseUrl: string, cleanBase: string, workId?: string): string {
  const suffix = workId === undefined || workId === '' ? '' : `&work=${encodeURIComponent(workId)}`;
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#')) {
      out.push(
        line.includes('URI="')
          ? line.replace(/URI="([^"]*)"/g, (whole, value: string) => {
              const resolved = resolveUri(value, baseUrl);
              return resolved === null ? whole : `URI="${resolved}"`;
            })
          : line
      );
      continue;
    }
    const resolved = resolveUri(line, baseUrl);
    out.push(resolved === null ? line : `${cleanBase}?target=${encodeURIComponent(resolved)}${suffix}`);
  }
  return out.join('\n');
}
