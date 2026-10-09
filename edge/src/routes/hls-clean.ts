/**
 * `GET /proxy/hls/clean?target={encodedUrl}&work={workId}`
 *
 * 云端 M3U8 广告手术刀入口：只中转并实时清洗几 KB 的清单文本，视频分片仍由客户端
 * 直连上游 CDN——零视频带宽、零转码、对已安装客户端零改动。
 *
 * 安全边界（全部是"先验证、后请求"）：
 * - 仅 https 且目标主机在 AD_STRIP_TARGET_HOSTS 精确白名单内（绝不做子串匹配）；
 * - 重定向不自动跟随：每一跳的落点都要重新过同一份白名单，最多 2 跳；
 * - 全程共享一个超时预算；响应体按字节流式计费，超限即放弃清洗；
 * - 总开关关闭时 302 回目标地址——链路行为与未部署时完全一致；
 * - 清洗失败或解析放弃一律透传原清单，绝不因清洗缺位而中断播放。
 */

import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import { jsonResponse } from '../http/json';
import { buildErrorResponse } from '../http/errors';
import { originOf } from '../http/serialize';
import { cleanHlsPlaylist } from '../media/ad-stripper';
import { readAdStripSettings, resolveAllowedTarget } from '../media/ad-strip-config';
import { recordAdStripAudit } from '../media/ad-strip-audit';

export const HLS_CLEAN_CONTENT_TYPE = 'application/vnd.apple.mpegurl';
const WORK_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const FETCH_TIMEOUT_MS = 8000;
const MAX_REDIRECT_HOPS = 2;
/** 清洗后的清单允许在边缘缓存 5 分钟：广告池按天轮换，5 分钟足够收敛又不留陈旧。 */
const CLEANED_CACHE_SECONDS = 300;

export interface HlsCleanDeps {
  fetcher?: typeof fetch;
}

function textResponse(status: number, code: 'VALIDATION_ERROR' | 'SERVICE_UNAVAILABLE'): Response {
  return jsonResponse(buildErrorResponse(code), status, { 'Cache-Control': 'no-store' });
}

async function fetchWithinBudget(fetcher: typeof fetch, target: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(target, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.apple.mpegurl, application/x-mpegURL, text/plain, */*',
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 14; zh-CN) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 逐跳复核白名单的链路抓取；任何一跳越界都以失败收场，绝不把响应交给调用方。 */
async function fetchAllowedChain(
  fetcher: typeof fetch,
  start: URL,
  hosts: ReadonlySet<string>,
  timeoutMs: number
): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let current = start;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('deadline-exceeded');
    const response = await fetchWithinBudget(fetcher, current.href, remaining);
    if (response.status < 300 || response.status >= 400) return response;
    void response.body?.cancel().catch(() => {});
    const location = response.headers.get('Location');
    if (location === null) throw new Error('redirect-without-location');
    let resolvedNext: URL | null = null;
    try {
      resolvedNext = resolveAllowedTarget(new URL(location, current.href).href, hosts);
    } catch {
      resolvedNext = null;
    }
    if (resolvedNext === null) throw new Error('redirect-outside-allowlist');
    current = resolvedNext;
  }
  throw new Error('too-many-redirects');
}

/** 流式读取并按字节计费；超过上限立即放弃（返回 null 由调用方按失败处理）。 */
async function readCapped(response: Response, maxBytes: number): Promise<string | null> {
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        void reader.cancel().catch(() => {});
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    void reader.cancel().catch(() => {});
    return null;
  }
}

export async function handleCleanHls(
  request: Request,
  env: Env,
  clock: Clock,
  deps: HlsCleanDeps = {}
): Promise<Response> {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });

  const settings = readAdStripSettings(env);
  const url = new URL(request.url);
  const resolved = resolveAllowedTarget(url.searchParams.get('target'), settings.hosts);
  if (resolved === null) return textResponse(400, 'VALIDATION_ERROR');

  // 总开关关闭：302 回目标地址，播放行为与未部署清洗完全一致。
  if (!settings.enabled) {
    return new Response(null, {
      status: 302,
      headers: { Location: resolved.href, 'Cache-Control': 'no-store' }
    });
  }

  const fetcher = deps.fetcher ?? fetch;
  let upstream: Response;
  try {
    upstream = await fetchAllowedChain(fetcher, resolved, settings.hosts, FETCH_TIMEOUT_MS);
  } catch {
    return textResponse(502, 'SERVICE_UNAVAILABLE');
  }
  if (!upstream.ok) {
    void upstream.body?.cancel().catch(() => {});
    return textResponse(502, 'SERVICE_UNAVAILABLE');
  }

  const declaredLength = Number(upstream.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > settings.params.maxBytes) {
    void upstream.body?.cancel().catch(() => {});
    return textResponse(502, 'SERVICE_UNAVAILABLE');
  }
  const raw = await readCapped(upstream, settings.params.maxBytes);
  if (raw === null) return textResponse(502, 'SERVICE_UNAVAILABLE');

  const rawWorkId = url.searchParams.get('work');
  const workId = rawWorkId !== null && WORK_ID_PATTERN.test(rawWorkId) ? rawWorkId : undefined;
  const outcome = cleanHlsPlaylist(raw, {
    baseUrl: resolved.href,
    params: settings.params,
    cleanBase: `${originOf(request)}/proxy/hls/clean`,
    workId
  });

  if (outcome.removedBlocks > 0) {
    await recordAdStripAudit(env, {
      workId: workId ?? null,
      targetHost: resolved.hostname,
      removedBlocks: outcome.removedBlocks,
      removedSegments: outcome.removedSegments,
      removedSeconds: Number(outcome.removedSeconds.toFixed(2)),
      totalSeconds: Number(outcome.totalSeconds.toFixed(2)),
      dominantRatio: Number(outcome.dominantRatio.toFixed(4)),
      atSeconds: clock.nowSeconds()
    });
  }

  const headers = new Headers({
    'Content-Type': outcome.mode === 'cleaned' || outcome.mode === 'master'
      ? HLS_CLEAN_CONTENT_TYPE
      : upstream.headers.get('Content-Type') ?? HLS_CLEAN_CONTENT_TYPE,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': `public, max-age=${CLEANED_CACHE_SECONDS}`,
    'X-Content-Type-Options': 'nosniff',
    'X-Ad-Strip-Mode': outcome.mode
  });
  if (outcome.removedBlocks > 0) {
    headers.set('X-Ad-Strip-Blocks', String(outcome.removedBlocks));
    headers.set('X-Ad-Strip-Seconds', outcome.removedSeconds.toFixed(2));
  }
  return new Response(outcome.text, { status: 200, headers });
}
