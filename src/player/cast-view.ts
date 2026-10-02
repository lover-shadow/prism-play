/**
 * 投屏的视图层（SPEC §1.5.1，AC-24）：半屏设备面板 + 呼吸状态条的 DOM 与事件出口。
 *
 * 与 `cast-panel.ts` 分开的理由不是"整洁"这种软目标，而是 §10 的 300 行红线加上一个更硬的约束：
 * 视图必须**只看状态**，不能自己记状态。历史上投屏这类浮层最容易长的毛病是"渲染函数里顺手改状态"
 * （点了就自己把 phase 设成 scanning），于是状态权威分裂，界面和真实机器各说各话。这里视图只接
 * `CastViewState` 值对象、只往外报意图，一行状态都不持有。
 *
 * 所有外部文本（设备名、剧名、错误说明）都走 `textContent`，只有来自 `icons.ts` 封闭表的几何才用
 * `innerHTML`——目录字段永远进不了标记（P0-1 零 emoji 图标、图标尺寸仅 16/20/24）。
 */
import { icon } from '../components/icons';
import type { CastDevice } from '../core/native/cast';
import type { CastPhase } from './cast-ports';

export interface CastViewState {
  visible: boolean;
  phase: CastPhase;
  status: string;
  devices: CastDevice[];
  activeId: string | null;
  bannerVisible: boolean;
  bannerText: string;
  paused: boolean;
  /** 平台不支持或已在扫描时，重扫键必须显式禁用，而不是"点了没反应"。 */
  rescanDisabled: boolean;
}

export interface CastViewHandlers {
  onClose(): void;
  onRescan(): void;
  onPause(): void;
  onExit(): void;
  onPick(device: CastDevice): void;
}

export interface CastView {
  sheet: HTMLElement;
  banner: HTMLElement;
  render(state: CastViewState): void;
  destroy(): void;
}

export function createCastView(doc: Document, handlers: CastViewHandlers): CastView {
  const sheet = doc.createElement('div');
  sheet.className = 'prism-cast';
  sheet.dataset['prismUi'] = 'cast';
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-modal', 'true');
  sheet.setAttribute('aria-label', '投屏设备');
  sheet.hidden = true;

  const scrim = doc.createElement('div');
  scrim.className = 'prism-cast__scrim';
  scrim.addEventListener('click', handlers.onClose);

  const panel = doc.createElement('div');
  panel.className = 'prism-cast__sheet';

  const heading = doc.createElement('div');
  heading.className = 'prism-cast__head';
  const headingTitle = doc.createElement('span');
  headingTitle.className = 'prism-cast__title';
  headingTitle.textContent = '投屏设备';
  const headFill = doc.createElement('span');
  headFill.className = 'prism-cast__head-fill';
  const rescan = doc.createElement('button');
  rescan.type = 'button';
  rescan.className = 'prism-cast__rescan';
  rescan.innerHTML = icon('refresh', { size: 16 });
  // 标签进 DOM 而不是 CSS content：CSS 里的字读屏读不到，也不跟着组件走。
  const rescanLabel = doc.createElement('span');
  rescanLabel.textContent = '重新扫描';
  rescan.append(rescanLabel);
  rescan.addEventListener('click', handlers.onRescan);
  const dismiss = doc.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'prism-cast__dismiss';
  dismiss.innerHTML = icon('close', { size: 16 });
  dismiss.setAttribute('aria-label', '关闭投屏面板');
  dismiss.addEventListener('click', handlers.onClose);
  heading.append(headingTitle, headFill, rescan, dismiss);

  const status = doc.createElement('p');
  status.className = 'prism-cast__status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const list = doc.createElement('div');
  list.className = 'prism-cast__list';
  panel.append(heading, status, list);
  sheet.append(scrim, panel);

  const banner = doc.createElement('div');
  banner.className = 'prism-cast-banner';
  banner.hidden = true;
  banner.setAttribute('role', 'status');
  const dot = doc.createElement('span');
  dot.className = 'prism-cast-banner__dot';
  const bannerText = doc.createElement('span');
  bannerText.className = 'prism-cast-banner__text';
  const pauseBtn = doc.createElement('button');
  pauseBtn.type = 'button';
  pauseBtn.className = 'prism-cast-banner__btn';
  pauseBtn.textContent = '暂停';
  pauseBtn.addEventListener('click', handlers.onPause);
  const exitBtn = doc.createElement('button');
  exitBtn.type = 'button';
  exitBtn.className = 'prism-cast-banner__btn is-ghost';
  exitBtn.textContent = '退出投屏';
  exitBtn.addEventListener('click', handlers.onExit);
  banner.append(dot, bannerText, pauseBtn, exitBtn);

  function row(device: CastDevice, active: boolean): HTMLElement {
    const item = doc.createElement('button');
    item.type = 'button';
    item.className = 'prism-cast__device';
    item.dataset['deviceId'] = device.id;
    if (active) item.classList.add('is-active');
    const name = doc.createElement('span');
    name.className = 'prism-cast__device-name';
    name.textContent = device.name;
    const meta = doc.createElement('span');
    meta.className = 'prism-cast__device-meta';
    meta.textContent = `${device.ip}:${device.port}`;
    item.append(name, meta);
    item.addEventListener('click', () => handlers.onPick(device));
    return item;
  }

  return {
    sheet,
    banner,
    render(state: CastViewState): void {
      sheet.hidden = !state.visible;
      status.textContent = state.status;
      status.dataset['phase'] = state.phase;
      list.hidden = state.devices.length === 0;
      list.replaceChildren(...state.devices.map((device) => row(device, device.id === state.activeId)));
      rescan.disabled = state.rescanDisabled;
      banner.hidden = !state.bannerVisible;
      banner.classList.toggle('is-paused', state.paused);
      bannerText.textContent = state.bannerText;
      pauseBtn.textContent = state.paused ? '继续' : '暂停';
    },
    destroy(): void {
      sheet.remove();
      banner.remove();
    }
  };
}
