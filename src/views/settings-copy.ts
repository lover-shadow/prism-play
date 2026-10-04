import type { ErrorCode } from '../../edge/src/types/api';
import { PERMANENT_EXPIRES_AT } from '../../edge/src/types/api';
import { ApiError } from '../core/api/client';
import { errorCopy } from './history-view';
const NETWORK_COPY = '网络不可用：版本检测与卡密核销都需联网，离线期只可验证已存授权。';
export const ERROR_COPY: Readonly<Record<ErrorCode | 'NETWORK_ERROR' | 'UNEXPECTED_RESPONSE', string>> = {
  COUPON_NOT_FOUND: '卡密不存在，请核对后重试。', COUPON_REVOKED: '该卡密已被作废，无法核销。',
  COUPON_DEVICE_LIMIT_EXCEEDED: '该卡密可绑定的设备数已达上限，请在已绑定设备上观看或联系发卡方。',
  COUPON_INVALID_FORMAT: '卡密格式不正确，应按 GY- 开头分段填写。', DEVICE_ID_INVALID: '本机设备标识不合法，请重新安装或稍后重试。',
  RATE_LIMITED: '核销尝试过于频繁，请稍后再试。', PRIVATE_SESSION_REQUIRED: '当次私密探索授权未被确认，请重新勾选并确认免责声明。',
  TIER_INSUFFICIENT: '当前档位不在云端开放的准入档位内，无法开启个人探索。', NOT_FOUND: '请求的内容不存在或已下架。',
  SERVICE_UNAVAILABLE: '服务端暂时不可用，请稍后重试。', PLATFORM_UNSUPPORTED: '本期仅支持 Android 端核销。',
  CREDENTIAL_EXPIRED: '授权已过期，请重新核销卡密。', VALIDATION_ERROR: '提交内容未通过校验，请检查卡密格式。',
  PROXY_SIGNATURE_INVALID: '取流地址已过期或被篡改，请重新选集后再试。', CATALOG_REVISION_CONFLICT: '公开目录刚刚发生变化，请重新拉取后再试。',
  CATALOG_CURSOR_EXPIRED: '本机目录游标已过期，将改拉完整快照。', NETWORK_ERROR: NETWORK_COPY, UNEXPECTED_RESPONSE: '服务端返回了无法识别的响应，请稍后重试。'
};
export function copyFor(error: unknown): string {
  return error instanceof ApiError ? ERROR_COPY[error.code] : errorCopy(error, NETWORK_COPY);
}
export function formatExpiry(expiresAt: number, nowSeconds: number): string {
  if (expiresAt === PERMANENT_EXPIRES_AT) return '永久有效';
  if (expiresAt <= nowSeconds) return '已到期，需重新核销';
  return `${new Date(expiresAt * 1000).toLocaleDateString('zh-CN')} 到期（剩余 ${Math.ceil((expiresAt - nowSeconds) / 86400)} 天）`;
}
