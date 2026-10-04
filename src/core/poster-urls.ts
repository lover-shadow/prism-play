import type { ContentItem } from '../../edge/src/types/api';

/** 展示/请求边界共用；不改写快照，私密签名查询串原样保留，解析过程不落盘。 */
export function createPosterUrls(baseUrl: string = '') {
  const pageOrigin = typeof location === 'undefined' ? undefined : location.origin;
  let base: URL | null = null;
  try {
    const candidate = new URL(baseUrl || pageOrigin || '');
    if (['http:', 'https:'].includes(candidate.protocol) && !candidate.username && !candidate.password) base = candidate;
  } catch { /* 无可用 API origin 时拒绝，不猜上游地址。 */ }

  function resolve(raw: unknown): string | null {
    if (base === null || typeof raw !== 'string') return null;
    const value = raw.trim();
    if (/[\\\s\u0000-\u001f\u007f]/u.test(value)) return null;
    // 检查原始路径，避免 URL 的点段规范化把非法路径变成合法代理地址。
    const path = value.replace(/^https?:\/\/[^/]+/i, '');
    const match = /^\/proxy\/img\/([^/?#]+)(?:\?[^#]*)?$/.exec(path);
    if (match === null) return null;
    let handle: string;
    try { handle = decodeURIComponent(match[1]!); } catch { return null; }
    if (handle.includes('..') || /[/\\%\s\u0000-\u001f\u007f]/u.test(handle)) return null;
    let target: URL;
    try { target = new URL(value, base.origin); } catch { return null; }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) return null;
    // 只接纳 API 同源或旧页面同源代理；后者也归一到 API，外部同形路径不构成准入。
    if (target.origin !== base.origin && target.origin !== pageOrigin) return null;
    return new URL(`${target.pathname}${target.search}`, base.origin).href;
  }

  const items = (entries: readonly ContentItem[]): ContentItem[] => entries.map((entry) => ({
    ...entry, coverUrl: resolve(entry.coverUrl) ?? undefined
  }));
  return { resolve, items };
}
