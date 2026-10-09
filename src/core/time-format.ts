/**
 * R15 / 候选契约 §1 的唯一时间展示口径：**一律北京时间**（Asia/Shanghai, UTC+8），
 * 不随设备时区漂移。输入统一为项目内部口径的 UTC Unix 秒（或毫秒 epoch 原语）。
 *
 * 为什么不用 `toLocaleString` / `Intl`：展示结果必须与设备时区、语言环境完全无关；
 * 北京不实行夏令时（固定 UTC+8），所以"平移 8 小时 + 全用 getUTC* 读数"是确定性做法，
 * 在 jsdom / Android WebView / 任意桌面浏览器上输出逐字节一致，且无 Intl 可用性差异。
 */
export const BEIJING_UTC_OFFSET_SECONDS = 8 * 3600;

/** 把 epoch 毫秒平移为"北京时间读数"的 Date：此后一律用 `getUTC*` 系列读取。 */
export function beijingClock(epochMs: number): Date {
  return new Date(epochMs + BEIJING_UTC_OFFSET_SECONDS * 1000);
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** `YYYY-MM-DD`（北京时间）。非法输入不伪造时间，返回占位符。 */
export function formatBeijingDate(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) return '—';
  const d = beijingClock(Math.floor(unixSeconds) * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** `YYYY-MM-DD HH:mm`（北京时间，到分）。 */
export function formatBeijingDateTime(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) return '—';
  const d = beijingClock(Math.floor(unixSeconds) * 1000);
  return `${formatBeijingDate(unixSeconds)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/** `YYYY-MM-DD HH:mm:ss`（北京时间，到秒；诊断报告与导出使用）。 */
export function formatBeijingDateTimeFull(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) return '—';
  const d = beijingClock(Math.floor(unixSeconds) * 1000);
  return `${formatBeijingDateTime(unixSeconds)}:${pad(d.getUTCSeconds())}`;
}

/** `HH:mm:ss.mmm`（北京时间，日志行内时间戳；毫秒来自 epoch 原值）。 */
export function formatBeijingClockMs(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return '—';
  const d = beijingClock(epochMs);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')}`;
}
