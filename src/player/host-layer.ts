/**
 * 播放宿主「层」的三态外壳（HP-03 / §3.1 状态机：closed → loading → ready，失败落 error/retry）。
 *
 * 旧缺陷是 `open()` 先 await 偏好刷新、再 await 详情请求，之后才建层注册返回：期间界面零反馈，
 * 失败直接 `return false` 静默。本模块把"层的创建与挂载"变成**同步**动作，三态共用同一批节点，
 * 因此成功路径不需要二次重建（也就不该出现两次闪烁）：
 *   loading —— 只有语义状态，严禁任何受保护元信息：不读 `titleOf()`、不贴卡片标题/海报/剧目名；
 *   error   —— 复用 `hud.ts` 的同一套口径（私密/未知/不存在三者同构），并在层内交出「返回」与「重试」
 *              两个真实出口，绝不停成一个关不掉的黑遮罩；
 *   ready   —— 详情身份核验通过后，由宿主写入标题槽并把内核装进同一个 stage。
 */
import { icon } from '../components/icons';
import { ApiError } from '../core/api/client';
import { createStateOverlay, type OverlayState } from './hud';

export interface HostLayer {
  shell: HTMLElement;
  /** 内核挂载点与选集面板槽位：三态共用，升级时不重建。 */
  stage: HTMLElement;
  sheet: HTMLElement;
  showState(kind: OverlayState): void;
  /** 重试出口由宿主接线（本模块不知道要重开哪一部剧），且一个实例只允许挂一条监听。 */
  onRetry(action: (() => void) | null): void;
  /** 详情身份核验通过后才能调用：这一刻才允许把标题写进层里。 */
  promote(title: string): void;
  destroy(): void;
}

/**
 * 详情阶段的层内口径：私密未准入、档位不足、未知故障与不存在**共用 `missing` 那一句**，
 * 只有传输级失败才如实说"需要网络"——那描述的是本机连接，不泄露任何剧目身份。
 * 这里与 `prism-player.ts:30` 的内核映射有意不同：内核面对的是"线路坏了没有"，本层面对的是
 * "能不能拿到详情"，反探测边界（AC-02 / SPEC §S-2「私有与未知一律 404」）必须先收紧。
 */
export function hostErrorFor(error: unknown): OverlayState {
  return error instanceof ApiError && error.code === 'NETWORK_ERROR' ? 'offline' : 'missing';
}

export function createHostLayer(deps: { mount: HTMLElement; onClose(): void }): HostLayer {
  const shell = document.createElement('div');
  shell.className = 'prism-player-host';
  shell.dataset.phase = 'loading';
  shell.setAttribute('role', 'dialog');
  shell.setAttribute('aria-modal', 'true');
  shell.setAttribute('aria-label', '正在载入');
  shell.setAttribute('aria-busy', 'true');
  const bar = document.createElement('header');
  bar.className = 'prism-player-host__bar';
  const exit = document.createElement('button');
  exit.type = 'button';
  exit.className = 'touch-target prism-player-host__exit';
  exit.dataset.action = 'exit';
  exit.innerHTML = icon('close', { size: 24 });
  const label = document.createElement('span');
  label.className = 'visually-hidden';
  label.textContent = '退出播放';
  exit.append(label);
  // 退出键从 loading 起就是活的：层的整个生命周期只有一条关闭去处（宿主自己的 `close()`）。
  exit.addEventListener('click', () => deps.onClose());
  // 标题槽先建出来但不写内容：loading 期它必须是空的，这正是"零元信息"的可见证据。
  const title = document.createElement('span');
  title.className = 'prism-player-host__title';
  bar.append(exit, title);
  const stage = document.createElement('div');
  stage.className = 'prism-player-host__stage';
  // 选集面板的正文槽位排在舞台之后：非全屏即视频下方，不覆盖画面（R26-05）。
  const sheet = document.createElement('div');
  sheet.className = 'prism-player-host__sheet';
  shell.append(bar, stage, sheet);
  /**
   * 状态浮层直接落在宿主根上：`.prism-player__state` 是 `position:absolute; inset:0` 的整层覆盖，
   * 会连顶栏一起盖住，所以层内必须自带一颗点得动的返回键，不能只靠被遮住的退出按钮。
   */
  const state = createStateOverlay(shell);
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'prism-player__retry';
  back.dataset.el = 'host-back';
  back.textContent = '返回';
  back.addEventListener('click', () => deps.onClose());
  state.el.append(back);
  state.retryButton.dataset.el = 'host-retry';
  let retryAction: (() => void) | null = null;
  state.retryButton.addEventListener('click', () => retryAction?.());
  deps.mount.appendChild(shell);

  return {
    shell,
    stage,
    sheet,
    showState(kind: OverlayState) {
      shell.dataset.phase = kind === 'loading' ? 'loading' : 'error';
      shell.setAttribute('aria-busy', kind === 'loading' ? 'true' : 'false');
      shell.setAttribute('aria-label', kind === 'loading' ? '正在载入' : '播放不可用');
      // promote 之后状态节点被摘过；万一还要退回错误态（例：详情回来却没有可播集），必须装得回来，
      // 否则就是一个"看不见也关不掉"的哑层。
      if (state.el.parentElement === null) shell.append(state.el);
      state.show(kind);
      // `missing` 在内核口径里不给重试；但"失败层不能是死路"是 HP-03 的硬要求：出口一律亮着。
      state.retryButton.hidden = kind === 'loading';
      back.hidden = false;
    },
    onRetry(action) {
      retryAction = action;
    },
    promote(text: string) {
      shell.dataset.phase = 'ready';
      shell.setAttribute('aria-busy', 'false');
      shell.setAttribute('aria-label', '播放');
      title.textContent = text;
      state.destroy(); // 只摘状态节点，shell / stage / sheet 原样复用
    },
    destroy() {
      retryAction = null;
      state.destroy();
      shell.remove();
    }
  };
}
