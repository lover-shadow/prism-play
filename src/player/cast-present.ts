/**
 * 投屏的呈现层映射：状态 → 用户看到的这句话（SPEC §1.5.1，AC-24）。
 *
 * 文案与视图模型集中在这里，是因为这一层的每句话都必须对得上一个真实事实，而事实的判定在状态机里：
 *   • 一个组播包都没发出去时必须说"本机没有组播通道"，不能说"没发现设备"——后者是谎报扫描结果；
 *   • 状态条上"支持自动无缝连播"只能由定时器**真的武装了**来点亮；
 *   • 私密内容的拒绝文案只有一句，且必须与"该影片不存在"区分开，因为前者是产品规则不是数据缺失。
 * 把这三条写成纯函数，单测就能直接钉住"什么事实配什么话"，不必先把整个面板装起来。
 */
import type { CastDevice } from '../core/native/cast';
import type { CastPhase } from './cast-ports';

export const EMPTY_HINT = '未发现可用设备：请确认电视与手机在同一 Wi-Fi，且电视已开启 DLNA/投屏服务';
export const PRIVATE_REFUSAL = '该影片不支持投屏';
export const UNSUPPORTED_HINT = '投屏需在 Android 客户端内进行：网页版没有局域网组播能力';
export const SCANNING_HINT = '正在扫描同网段的电视与投影仪…';
export const NO_MULTICAST_HINT = '本机 Wi-Fi 组播通道不可用，无法扫描局域网设备';

export interface CastStatusView {
  phase: CastPhase;
  /** 状态机已经写好的具体原因（连接失败、设备拒绝等）；非空时优先于通用口径。 */
  message: string;
  deviceCount: number;
  activeName: string | null;
}

export function statusTextFor(status: CastStatusView): string {
  if (status.phase === 'unsupported') return UNSUPPORTED_HINT;
  if (status.phase === 'empty') return status.message === '' ? EMPTY_HINT : status.message;
  if (status.phase === 'error' || status.phase === 'connecting') return status.message;
  if (status.phase === 'scanning') return status.message === '' ? SCANNING_HINT : status.message;
  if (status.phase === 'ready') return `已发现 ${status.deviceCount} 台设备，选择一台开始投屏`;
  if (status.activeName !== null) return `正在投屏至 ${status.activeName}`;
  return '选择一台设备开始投屏';
}

/** 原生侧的错误优先自述；空 message 才落到本层的兜底口径，避免把 `unknown` 直接喷给用户。 */
export function errorTextFor(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback;
}

/** 扫描回报 → 下一态。`probesSent`/`multicastAvailable` 为假时不能说"没设备"，只能说"没通道"。 */
export function scanOutcome(report: { devices: CastDevice[]; probesSent: number; multicastAvailable: boolean }): {
  phase: CastPhase; message: string;
} {
  if (report.devices.length > 0) return { phase: 'ready', message: '' };
  const noChannel = report.probesSent === 0 || !report.multicastAvailable;
  return { phase: 'empty', message: noChannel ? NO_MULTICAST_HINT : '' };
}

export interface CastBannerState {
  activeName: string | null;
  /** 连播是否真的在计时。没有它，状态条就是一句空头承诺。 */
  relayArmed: boolean;
}

/** 呼吸状态条文案：`投屏中 · 支持自动无缝连播` 只在 relay 武装时出现。 */
export function bannerTextFor(banner: CastBannerState): string {
  if (banner.activeName === null) return '';
  return banner.relayArmed ? `正在投屏至 ${banner.activeName} · 支持自动无缝连播` : `正在投屏至 ${banner.activeName}`;
}
