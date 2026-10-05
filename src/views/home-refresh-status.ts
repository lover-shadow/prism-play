/**
 * HP-06b：刷新反馈状态条（HOME-PLAYER-REPAIR-SPEC-AND-PLAN §HP-06「状态必须齐」）。
 *
 * 一条状态条只说三件事：**联网同步**的结论、**本地重新编排**的结论、以及下一步去处（重试）。
 * 两个结论必须分行给出，绝不合成"已更新"这类含糊话术——同步失败但本地重排成功时，
 * 用户看到的是"离线：已按本机数据重新推荐"加一条独立的同步失败说明，而不是假的成功。
 *
 * 本模块只管文本与语义角色（`role=status` / `aria-live=polite`）；视觉承载归 B6 的样式批次，
 * 这里零裸色值、零 emoji（P0-1 / P0-3），jsdom 也无法验证观感，一切视觉结论标"待浏览器验证"。
 */

import { STATE_PRESETS, detailForError, element, stateKindForError } from '../components/state-views';
import type { RefreshFeedback, RefreshPhase } from './home-repeat';

export const REFRESH_STATUS_LABEL: Readonly<Record<RefreshPhase, string>> = Object.freeze({
  idle: '',
  refreshing: '正在重新发现片单…',
  updated: '已按当前候选完成新一轮编排。',
  'no-new': '没有新内容。',
  offline: '离线：本机数据重新编排完成。',
  failed: '刷新失败。'
});

export interface RefreshStatus {
  show(state: RefreshFeedback): void;
  clear(): void;
  destroy(): void;
}

export interface RefreshStatusDeps {
  host: HTMLElement;
  /** 重试走的是与下拉、标题重复点击同一条刷新入口，不在这里另立第二套语义。 */
  retry: () => void;
}

/** 同步失败的措辞沿用五态预设的标题：同一件事在首页与状态视图里说法必须一致。 */
function syncLine(error: unknown): string {
  const preset = STATE_PRESETS[stateKindForError(error)];
  const detail = detailForError(error);
  return `云端同步：${preset.title}${detail === undefined || detail === '' ? '' : `（${detail}）`}。`;
}

export function createRefreshStatus(deps: RefreshStatusDeps): RefreshStatus {
  const band = element('div', 'home-refresh-status');
  band.dataset.el = 'home-refresh-status';
  band.dataset.phase = 'idle';
  band.dataset.local = 'none';
  band.setAttribute('role', 'status');
  band.setAttribute('aria-live', 'polite');
  band.hidden = true;

  const local = element('p', 'home-refresh-status-local');
  local.dataset.el = 'home-refresh-local';
  const sync = element('p', 'home-refresh-status-sync');
  sync.dataset.el = 'home-refresh-sync';
  band.append(local, sync);
  deps.host.appendChild(band);

  function localLine(state: RefreshFeedback): string {
    const report = state.report;
    if (state.phase === 'refreshing') return REFRESH_STATUS_LABEL.refreshing;
    if (state.phase === 'failed') {
      return report === undefined || report.candidates === 0
        ? '刷新失败：本机没有可用候选，未编造片单。'
        : '刷新失败：本机候选无法重新编排，请重试。';
    }
    if (state.phase === 'offline') {
      // `report` 缺席只有一种来路：首次加载时云端目录整条没读到、画的是本机已有快照，
      // 此时既没"重新推荐"也没"候选已尽"，只能陈述这一件事，不许顺手写成刷新结论。
      if (report === undefined) return '云端目录本次没读到：以下片单来自本机已缓存的公开快照。';
      return report.changed
        ? `离线：已按本机数据重新推荐（候选 ${report.candidates} 部，本页 ${report.delivered} 部）。`
        : '离线：已按本机数据重排，未看过的候选已尽，没有新内容。';
    }
    if (state.phase === 'updated') {
      return report === undefined
        ? REFRESH_STATUS_LABEL.updated
        : `${REFRESH_STATUS_LABEL.updated}候选 ${report.candidates} 部，本页 ${report.delivered} 部。`;
    }
    return report !== undefined && report.exhausted
      ? '没有新内容：本机公开候选大多已展示过，不做随机洗牌冒充新意。'
      : '没有新内容：本轮候选与可见序列均未变化，排名保持不变。';
  }

  return {
    show(state: RefreshFeedback): void {
      band.dataset.phase = state.phase;
      band.dataset.local = state.phase === 'failed' ? 'none'
        : state.phase === 'refreshing' ? 'pending'
          : state.report === undefined ? 'none' : state.report.changed ? 'reordered' : 'unchanged';
      local.textContent = localLine(state);
      band.hidden = state.phase === 'idle';
      sync.textContent = state.syncError === undefined ? '' : syncLine(state.syncError);
      const stale = band.querySelector('[data-el="home-refresh-retry"]');
      if (stale !== null) stale.remove();
      if (state.phase === 'failed') {
        const button = element('button', 'home-refresh-retry touch-target', '重试');
        button.type = 'button';
        button.dataset.el = 'home-refresh-retry';
        button.addEventListener('click', () => deps.retry());
        band.appendChild(button);
      }
    },
    clear(): void {
      band.dataset.phase = 'idle';
      band.dataset.local = 'none';
      local.textContent = '';
      sync.textContent = '';
      band.hidden = true;
    },
    destroy(): void { band.remove(); }
  };
}
