/**
 * 设置中心 - 运行诊断与日志带组件 (SPEC §10 拆分文件，遵循单文件 ≤300 行红线)
 */

import { logger } from '../core/diagnostics';
import { band, button, make, rowLine, type Band, type ViewState } from './history-view';

export interface DiagnosticsBandController {
  wrap: HTMLElement;
  paint(toastMsg?: string): Promise<void>;
}

export function createDiagnosticsBand(options: {
  apiBaseUrl: string;
  nativeSource: () => string;
  paintRows: (target: Band, state: ViewState, text: string, rows: Node[]) => void;
}): DiagnosticsBandController {
  const diagnostics = band('运行诊断与日志', 'set-diagnostics');
  diagnostics.head.append(button('一键复制日志', () => void copyDiagnostics(), { icon: 'share', cls: 'pv-btn-primary', el: 'copy-logs' }));

  async function paint(toastMsg?: string): Promise<void> {
    const latestErr = logger.latestError();
    const endpoint = options.apiBaseUrl || 'https://play.prismos.org';
    const statusText = `接口: ${endpoint} · 网络: ${navigator.onLine ? '已连接' : '离线'} · 宿主: ${options.nativeSource()}`;
    const statusRow = rowLine('row-diag-status', '接口与网络', statusText, [
      button('刷新', () => void paint('诊断信息已刷新。'), { icon: 'refresh', cls: 'pv-btn-ghost', el: 'diag-refresh' })
    ]);
    const rows: Node[] = [statusRow];
    if (latestErr) {
      const errBox = make('pre', 'pv-state pv-state-error');
      errBox.style.whiteSpace = 'pre-wrap';
      errBox.style.wordBreak = 'break-all';
      errBox.textContent = `[最近异常 ${latestErr.time}] ${latestErr.tag}: ${latestErr.message}\n${latestErr.detail ?? ''}`;
      rows.push(errBox);
    }
    options.paintRows(diagnostics, latestErr ? 'error' : 'ready', toastMsg ?? (latestErr ? '检测到运行异常，可点击右上角一键复制完整流水。' : '运行正常；遇网络或播放异常可点击右上角复制诊断流水。'), rows);
  }

  async function copyDiagnostics(): Promise<void> {
    const report = await logger.buildReport(options.apiBaseUrl || 'https://play.prismos.org');
    let copied = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(report);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (!copied) {
      try {
        const ta = document.createElement('textarea');
        ta.value = report;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        copied = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch {
        copied = false;
      }
    }
    await paint(copied ? '诊断流水已复制到剪贴板，请粘贴发给开发人员！' : '自动复制受系统权限限制，请长按日志框手动复制。');
  }

  return {
    wrap: diagnostics.wrap,
    paint
  };
}
