import type { ErrorResponse, ErrorCode } from '../types/api';

/**
 * HTTP status per error code — the single mapping table in API-SPEC §八.一.
 * A route must not pick its own status for the same code.
 */
export const HTTP_STATUS_BY_ERROR_CODE: Readonly<Record<ErrorCode, number>> = {
  COUPON_NOT_FOUND: 400,
  COUPON_REVOKED: 400,
  COUPON_DEVICE_LIMIT_EXCEEDED: 400,
  COUPON_INVALID_FORMAT: 400,
  DEVICE_ID_INVALID: 400,
  RATE_LIMITED: 429,
  PRIVATE_SESSION_REQUIRED: 403,
  TIER_INSUFFICIENT: 403,
  NOT_FOUND: 404,
  SERVICE_UNAVAILABLE: 503,
  PLATFORM_UNSUPPORTED: 400,
  CREDENTIAL_EXPIRED: 401,
  VALIDATION_ERROR: 400,
  PROXY_SIGNATURE_INVALID: 403,
  CATALOG_REVISION_CONFLICT: 409,
  CATALOG_CURSOR_EXPIRED: 410
};

export const DEFAULT_ERROR_MESSAGE: Readonly<Record<ErrorCode, string>> = {
  COUPON_NOT_FOUND: '卡密不存在，请核对后重试',
  COUPON_REVOKED: '该卡密已被作废，请联系发放方',
  COUPON_DEVICE_LIMIT_EXCEEDED: '该卡密绑定的共享设备已达上限（最多允许 10 台）',
  COUPON_INVALID_FORMAT: '卡密格式不正确，应形如 GY-Q90D-A7F2-8899',
  DEVICE_ID_INVALID: '设备标识不合法，应由客户端持久化的 GY- 前缀安装标识组成',
  RATE_LIMITED: '兑换尝试过于频繁，请稍后再试',
  PRIVATE_SESSION_REQUIRED: '请先阅读并接受免责声明后再开启个人探索',
  TIER_INSUFFICIENT: '当前授权档位不足以开启个人探索',
  NOT_FOUND: '内容不存在或已下架',
  SERVICE_UNAVAILABLE: '该分集暂无可用播放源，请稍后重试',
  PLATFORM_UNSUPPORTED: '本期仅支持 Android 客户端，platform 必须为 android',
  CREDENTIAL_EXPIRED: '授权凭证已过期或无效，请重新核销卡密',
  VALIDATION_ERROR: '请求参数不合法，请修正后重试',
  PROXY_SIGNATURE_INVALID: '代理地址校验未通过，请重新获取播放地址',
  CATALOG_REVISION_CONFLICT: '公开目录已更新，请重新拉取快照',
  CATALOG_CURSOR_EXPIRED: '增量游标已超出保留窗口，请重新获取公开目录快照'
};

export function buildErrorResponse(code: ErrorCode, message?: string): ErrorResponse {
  return { success: false, code, message: message ?? DEFAULT_ERROR_MESSAGE[code] };
}

export function errorResponse(code: ErrorCode, message?: string, status?: number): Response {
  const body = buildErrorResponse(code, message);
  return new Response(JSON.stringify(body), {
    status: status ?? HTTP_STATUS_BY_ERROR_CODE[code],
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

/**
 * Supervision ruling A-2: an unusable credential answers 401 with the dedicated closed-set code
 * instead of borrowing TIER_INSUFFICIENT.
 */
export function unauthorizedResponse(message?: string): Response {
  return errorResponse('CREDENTIAL_EXPIRED', message);
}

/**
 * Protocol-level refusals (bad parameter, revision conflict, expired cursor, refused proxy target)
 * must never be cached: a stored 400/409/410/403 would keep rejecting a client that already fixed its
 * request. `errorResponse` alone carries no cache header, so those sites go through this helper.
 */
export function errorResponseNoStore(code: ErrorCode, message?: string, status?: number): Response {
  const body = buildErrorResponse(code, message);
  return new Response(JSON.stringify(body), {
    status: status ?? HTTP_STATUS_BY_ERROR_CODE[code],
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

/** Undifferentiated 404: private content without admission and unknown content look identical. */
export function notFoundResponse(): Response {
  return errorResponse('NOT_FOUND');
}
