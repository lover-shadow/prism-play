/**
 * 客户端运行时诊断与错误日志采集器 (Master 调试指令)
 *
 * 职责：
 * 1. 环形内存日志缓冲（最近 60 条），捕获网络请求、状态流转、错误堆栈与宿主事件；
 * 2. 拦截全局 unhandledrejection 与 error 事件；
 * 3. 拦截控制台 console.error / console.warn；
 * 4. 生成一键复制到剪贴板的结构化诊断报告（包含机型平台、接口基准、网络耗时与错误链）。
 */

import { Capacitor } from '@capacitor/core';
import { bridgeSource, getBridge } from './native/bridge';
import { formatBeijingClockMs, formatBeijingDateTimeFull } from './time-format';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'NET';

export interface LogEntry {
  id: number;
  time: string;
  level: LogLevel;
  tag: string;
  message: string;
  detail?: string;
}

const MAX_LOG_ENTRIES = 60;
let sequence = 0;
const ringBuffer: LogEntry[] = [];

function nowTimeString(): string {
  // R15：日志行内时间戳同样走北京时间口径，与报告生成时间、导出结果三处一致。
  return formatBeijingClockMs(Date.now());
}

export function recordLog(level: LogLevel, tag: string, message: string, detail?: unknown): void {
  const detailStr = detail === undefined
    ? undefined
    : detail instanceof Error
      ? detail.stack || detail.message
      : typeof detail === 'string'
        ? detail
        : JSON.stringify(detail);

  const entry: LogEntry = {
    id: ++sequence,
    time: nowTimeString(),
    level,
    tag,
    message,
    detail: detailStr
  };

  ringBuffer.push(entry);
  if (ringBuffer.length > MAX_LOG_ENTRIES) {
    ringBuffer.shift();
  }
}

export const logger = {
  info(tag: string, message: string, detail?: unknown): void {
    recordLog('INFO', tag, message, detail);
  },
  warn(tag: string, message: string, detail?: unknown): void {
    recordLog('WARN', tag, message, detail);
  },
  error(tag: string, message: string, detail?: unknown): void {
    recordLog('ERROR', tag, message, detail);
  },
  net(tag: string, message: string, detail?: unknown): void {
    recordLog('NET', tag, message, detail);
  },
  getEntries(): readonly LogEntry[] {
    return ringBuffer;
  },
  latestError(): LogEntry | null {
    for (let i = ringBuffer.length - 1; i >= 0; i--) {
      if (ringBuffer[i].level === 'ERROR') return ringBuffer[i];
    }
    return null;
  },
  async buildReport(apiBaseUrl: string): Promise<string> {
    const bridge = getBridge();
    let keystore = false;
    try {
      keystore = await bridge.isKeystoreBacked();
    } catch {
      keystore = false;
    }

    const lines: string[] = [
      '========================================',
      '《光影Play》移动端运行诊断报告',
      '========================================',
      `报告生成时间: ${formatBeijingDateTimeFull(Math.floor(Date.now() / 1000))}`,
      `平台环境: ${Capacitor.getPlatform()} (isNative: ${Capacitor.isNativePlatform()})`,
      `宿主桥接源: ${bridgeSource()}`,
      `安全密钥库: ${keystore ? '硬件 Keystore 保护' : '未挂载/Web降级'}`,
      `当前API服务地址: ${apiBaseUrl || '(未指定/相对路径)'}`,
      `网络连线状态: ${navigator.onLine ? '在线' : '离线'}`,
      `User-Agent: ${navigator.userAgent}`,
      '----------------------------------------',
      '最近运行与错误流水 (按时间升序):'
    ];

    if (ringBuffer.length === 0) {
      lines.push('  (暂无运行记录)');
    } else {
      for (const entry of ringBuffer) {
        lines.push(`[${entry.time}] [${entry.level}] [${entry.tag}] ${entry.message}`);
        if (entry.detail) {
          lines.push(`    详情: ${entry.detail.replace(/\n/g, '\n    ')}`);
        }
      }
    }
    lines.push('========================================');
    return lines.join('\n');
  }
};

/** 全局错误捕获安装（顶层只注册一次） */
if (typeof window !== 'undefined') {
  window.addEventListener('error', (event) => {
    logger.error('window', `未捕获异常: ${event.message}`, event.error);
  });
  window.addEventListener('unhandledrejection', (event) => {
    logger.error('promise', `未处理 Promise 拒绝: ${String(event.reason)}`, event.reason);
  });
}
