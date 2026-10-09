import type { Clock } from '../core/clock';
import { deleteVisitor } from '../db/analytics-repo';
import { analyticsFailure } from '../analytics/collect';
import { hashVisitor, privacyOptOut, readVisitor, visitorCookie, type AnalyticsEnv } from '../analytics/visitor';

const CONSENT_PATH = '/api/analytics/consent';
const SECURITY_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
};

/** Main may embed this plain link into public HTML without a script or any auto-navigation. */
export const PRIVACY_ENTRY_SNIPPET = '<a href="/privacy">隐私与统计设置</a>';

function document(content: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>光影Play · 隐私与统计</title></head><body><main>${content}</main></body></html>`;
}

/** Pure GET document: visiting this page never sets an identifier or grants consent. */
export function privacyPage(): Response {
  return new Response(document(`<h1>隐私与统计设置</h1>
<p>默认仅统计公开页面访问请求和下载触发次数，不代表实际播放、下载完成或安装。</p>
<p>只有您明确同意后，才设置最长180天的随机浏览器标识 Cookie，用于去重、新浏览器、回访及转化统计。服务端仅保存独立密钥生成的摘要，不保存 Cookie 明文、完整网址、剧目标识或浏览器指纹。</p>
<p>浏览器标识不代表人数，无法连接网页与应用身份。清除 Cookie、隐私模式及不同浏览器会造成统计误差；密钥轮换会中断关联。</p>
<p>我们遵循 GPC 和 DNT，不为这些请求关联浏览器标识。撤回会清除 Cookie 并删除对应标识与去重记录，历史匿名汇总不重写。</p>
<p>去重日记录保留90天，浏览器记录最长180天，匿名汇总保留365天；到期记录由限量定时任务清理。</p>
<form method="post" action="${CONSENT_PATH}"><button type="submit" name="action" value="agree">同意浏览器去重统计</button> <button type="submit" name="action" value="revoke">拒绝或撤回同意</button></form>
<p><a href="/">返回首页</a></p>`), { headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' } });
}

function result(status: number, code: string, form: boolean, cookie?: string): Response {
  const headers = new Headers(SECURITY_HEADERS);
  if (cookie !== undefined) headers.set('Set-Cookie', cookie);
  if (status === 405) headers.set('Allow', 'POST');
  headers.set('Content-Type', form ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8');
  const messages: Record<string, string> = {
    AGREED: '已同意浏览器去重统计。', REVOKED: '已拒绝或撤回同意，对应记录已删除。',
    FORBIDDEN: '您的浏览器开启了「请勿跟踪」（DNT/GPC），本站尊重该设置，未授予同意；如需统计请关闭后再试。',
    UNAVAILABLE: '统计设置暂不可用，未确认记录删除成功，请稍后重试。',
    INVALID_REQUEST: '请求格式不正确，设置未更改。', TOO_LARGE: '请求超过大小限制，设置未更改。',
    METHOD_NOT_ALLOWED: '请通过隐私设置页主动提交您的选择。'
  };
  return new Response(form ? document(`<h1>统计设置</h1><p>${messages[code]}</p><p><a href="/privacy">返回隐私与统计设置</a></p>`)
    : JSON.stringify({ code }), { status, headers });
}

async function readAction(request: Request, form: boolean): Promise<'agree' | 'revoke' | 400 | 413> {
  const reader = request.body?.getReader();
  if (!reader) return 400;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8192) {
        // Cancellation itself may fail; oversized input still must never be parsed.
        try { await reader.cancel(); } catch { /* No input/error details logged. */ }
        return 413;
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    let action: unknown;
    if (form) {
      const entries = Array.from(new URLSearchParams(text).entries());
      if (entries.length !== 1 || entries[0][0] !== 'action') return 400;
      action = entries[0][1];
    } else {
      const value: unknown = JSON.parse(text);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return 400;
      const body = value as Record<string, unknown>;
      if (Object.keys(body).length !== 1) return 400;
      action = body.action;
    }
    return action === 'agree' || action === 'revoke' ? action : 400;
  } catch { return 400; } finally { reader.releaseLock(); }
}

/** Route independently before public CORS; only explicit exact-origin POST can change consent.
 * `Sec-Fetch-Site` accepts `same-origin` and `same-site`: the Origin equality check above already
 * pins the exact host, and strict `same-origin` alone 403s real user submissions that arrive via a
 * scheme upgrade (http → https) or an edge redirect, where Chrome reports `same-site`. */
export async function handleAnalyticsConsent(request: Request, env: AnalyticsEnv, _clock: Clock): Promise<Response> {
  const type = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
  const form = type === 'application/x-www-form-urlencoded';
  if (request.method !== 'POST') return result(405, 'METHOD_NOT_ALLOWED', form);
  const url = new URL(request.url);
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (url.protocol !== 'https:' || request.headers.get('Origin') !== url.origin ||
    (fetchSite !== null && fetchSite !== 'same-origin' && fetchSite !== 'same-site')) {
    return result(403, 'FORBIDDEN', form);
  }
  if (!form && type !== 'application/json') return result(400, 'INVALID_REQUEST', false);
  const action = await readAction(request, form);
  if (action === 400 || action === 413) return result(action, action === 413 ? 'TOO_LARGE' : 'INVALID_REQUEST', form);
  if (action === 'agree') {
    if (privacyOptOut(request)) return result(403, 'FORBIDDEN', form, visitorCookie('', 0));
    if (env.ANALYTICS_ENABLED !== 'true' || !env.ANALYTICS_HASH_SECRET) return result(503, 'UNAVAILABLE', form);
    // Repeated agreement does not rotate an existing valid identity and orphan its server records.
    return result(200, 'AGREED', form, visitorCookie(readVisitor(request) ?? crypto.randomUUID()));
  }
  const cleared = visitorCookie('', 0);
  const visitor = readVisitor(request);
  if (visitor !== null) {
    if (!env.ANALYTICS_HASH_SECRET) return result(503, 'UNAVAILABLE', form, cleared);
    try {
      await deleteVisitor(env.DB, await hashVisitor(visitor, env.ANALYTICS_HASH_SECRET));
    } catch {
      analyticsFailure('analytics_revoke_failed');
      return result(503, 'UNAVAILABLE', form, cleared);
    }
  }
  return result(200, 'REVOKED', form, cleared);
}
