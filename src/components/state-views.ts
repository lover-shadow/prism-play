/**
 * 五个视图状态（SPEC §7：loading / empty / error / offline / disabled）的唯一渲染器。
 *
 * 业务视图不得再各自发明异常态文案与结构：本模块给出语义角色（role / aria-live / aria-busy）、
 * Lucide 矢量图标（P0-1）与 Token 化样式钩子，颜色全部由 `home.css` 经 design-tokens 解析（P0-3）。
 *
 * 诚实边界：离线文案只说明「点播同样需要网络」，绝不承诺可离线播放（AC-15 / AC-18）。
 */

import { ApiError } from '../core/api/client';
import { icon, type IconName, type IconSize } from './icons';

export const VIEW_STATE_KINDS = ['loading', 'empty', 'error', 'offline', 'disabled'] as const;
export type ViewStateKind = (typeof VIEW_STATE_KINDS)[number];

export interface StateViewOptions {
  title?: string;
  detail?: string;
  actionLabel?: string;
  onAction?: () => void;
  /** loading 态的占位条数，用于与真实列表高度对齐，避免布局跳动。 */
  bars?: number;
}

interface StatePreset {
  glyph: IconName;
  title: string;
  detail: string;
}

/** 文案即契约：与 `docs/01-prd/UIUX-design-system.md` §8.2 的输入契约逐条对齐。 */
export const STATE_PRESETS: Readonly<Record<ViewStateKind, StatePreset>> = {
  loading: { glyph: 'refresh', title: '正在加载', detail: '正在同步视界拓扑与片单。' },
  empty: { glyph: 'film', title: '暂无可播放剧目', detail: '该视界尚未上架内容，换个频道或稍后再来。' },
  error: { glyph: 'alert', title: '内容加载失败', detail: '服务端暂时不可用，请稍后重试。' },
  offline: {
    glyph: 'offline',
    title: '网络不可用',
    detail: '片单需要联网加载，视频点播同样依赖网络。恢复连接后点击重试即可继续。'
  },
  disabled: { glyph: 'eyeOff', title: '该视界当前不可用', detail: '需要更高的授权档位，或已被运营下线。' }
};

export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function clearChildren(node: Element): void {
  while (node.firstChild !== null) node.removeChild(node.firstChild);
}

/**
 * 图标节点：字符串来自 `icons.ts` 的封闭表（属性已转义），不存在外部输入进入 markup 的路径。
 * `label` 缺省时图标是纯装饰并对辅助技术隐藏——可点击元素必须有相邻文字或 `aria-label`。
 */
export function iconNode(name: IconName, options: { size?: IconSize; label?: string; className?: string } = {}): HTMLSpanElement {
  const span = element('span', `icon-host${options.className === undefined ? '' : ` ${options.className}`}`);
  span.innerHTML = icon(name, { size: options.size ?? 20, label: options.label, className: 'icon-svg' });
  return span;
}

/** 语义角色：错误/离线/不可用需要被朗读（alert），加载与空态只作礼貌提示。 */
function roleOf(kind: ViewStateKind): string {
  return kind === 'error' || kind === 'offline' || kind === 'disabled' ? 'alert' : 'status';
}

export function renderStateView(kind: ViewStateKind, options: StateViewOptions = {}): HTMLElement {
  const preset = STATE_PRESETS[kind];
  const box = element('div', `state-view state-view--${kind}`);
  box.dataset.state = kind;
  box.setAttribute('role', roleOf(kind));
  if (kind === 'loading') box.setAttribute('aria-live', 'polite');
  box.appendChild(iconNode(preset.glyph, { size: 24, className: 'state-view-glyph' }));
  box.appendChild(element('p', 'state-view-title', options.title ?? preset.title));
  box.appendChild(element('p', 'state-view-detail', options.detail ?? preset.detail));

  const bars = options.bars ?? 0;
  for (let index = 0; index < bars; index += 1) {
    const bar = element('div', 'state-view-bar');
    bar.setAttribute('aria-hidden', 'true');
    box.appendChild(bar);
  }

  if (options.actionLabel !== undefined) {
    const button = element('button', 'state-view-action touch-target', options.actionLabel);
    button.type = 'button';
    if (options.onAction === undefined) button.disabled = true;
    else button.addEventListener('click', options.onAction);
    box.appendChild(button);
  }
  return box;
}

/**
 * 传输失败 → 视图状态的唯一映射。私有准入失败按 `disabled` 而不是 `error` 呈现：
 * 它是「当前不可用」的事实，不是故障。
 */
export function stateKindForError(error: unknown): ViewStateKind {
  if (error instanceof ApiError) {
    if (error.code === 'NETWORK_ERROR') return 'offline';
    if (error.code === 'PRIVATE_SESSION_REQUIRED' || error.code === 'TIER_INSUFFICIENT') return 'disabled';
    if (error.treatedAsMissing) return 'empty';
    return 'error';
  }
  return 'error';
}

/** 服务端文案优先（商业与运营文案由云端下发），本地兜底才用预设。 */
export function errorDetail(error: unknown): string | undefined {
  return error instanceof ApiError ? error.message : undefined;
}

/**
 * 离线态必须落回本地预设文案——预设里写死了「点播同样依赖网络」这条诚实边界（AC-15 / AC-18），
 * 传输层那句「请检查连接后重试」不足以说明点播不能离线看。其余状态沿用服务端文案。
 */
export function detailForError(error: unknown): string | undefined {
  return stateKindForError(error) === 'offline' ? undefined : errorDetail(error);
}
