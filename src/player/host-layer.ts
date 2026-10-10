/**
 * 播放宿主「层」的三态外壳（HP-03 / §3.1 状态机：closed → loading → ready，失败落 error/retry）。
 *
 * 旧缺陷是 `open()` 先 await 偏好刷新、再 await 详情请求，之后才建层注册返回：期间界面零反馈，
 * 失败直接 `return false` 静默。本模块把"层的创建与挂载"变成**同步**动作，三态共用同一批节点，
 * 因此成功路径不需要二次重建（也就不该出现两次闪烁）：
 *   loading —— 显示显式公开卡片/已核验公开缓存字段；未知与私密无预填，不读 `titleOf()`；
 *   error   —— 复用 `hud.ts` 的同一套口径（私密/未知/不存在三者同构），并在层内交出「返回」与「重试」
 *              两个真实出口，绝不停成一个关不掉的黑遮罩；
 *   ready   —— 详情身份核验通过后，由宿主写入标题槽并把内核装进同一个 stage。
 */
import { icon } from '../components/icons';
import { ApiError } from '../core/api/client';
import { createStateOverlay, type OverlayState } from './hud';
import { candidateDetail } from './open-candidate';
import type { OpenCandidate } from './host-contract';

export interface HostLayer {
  shell: HTMLElement;
  /** 内核挂载点与选集面板槽位：三态共用，升级时不重建。 */
  stage: HTMLElement;
  sheet: HTMLElement;
  showState(kind: OverlayState): void;
  /**
   * W1 渐进详情：首个 await 前挂出壳与舞台骨架（取代旧的整层 loading 遮罩）。
   * `candidate` 仅携带已展示的公开字段（标题/海报/分类/剧情/集数）；未提供时零元信息。
   */
  showSkeleton(candidate?: OpenCandidate): void;
  /** 首帧呈现后平滑退场，绝不提前让内核黑底或未决画面露出来。 */
  dismissSkeleton(): void;
  /** 重试出口由宿主接线（本模块不知道要重开哪一部剧），且一个实例只允许挂一条监听。 */
  onRetry(action: (() => void) | null): void;
  /** 详情身份核验通过后才能调用：这一刻才允许把标题写进层里。 */
  promote(title: string): void;
  destroy(): void;
}

/**
 * 在线标记不能证明服务可达；只有明确断网才显示离线，拒绝类错误仍隐藏剧目身份。
 */
export function hostErrorFor(error: unknown): OverlayState {
  if (error instanceof ApiError && error.code === 'NETWORK_ERROR') {
    return typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'connection';
  }
  if (error instanceof ApiError && error.code === 'SERVICE_UNAVAILABLE') return 'connection';
  return 'missing';
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
  // W1 舞台骨架：只在舞台（媒体区）内呈现，不遮挡顶栏与下方详情区；错误态与升级后即隐藏。
  const skeleton = document.createElement('div');
  skeleton.className = 'prism-player-host__skeleton';
  skeleton.dataset.el = 'host-skeleton';
  skeleton.setAttribute('aria-hidden', 'true');
  skeleton.hidden = true;
  stage.append(skeleton);
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
  let preview: HTMLElement | null = null;
  let retryAction: (() => void) | null = null;
  state.retryButton.addEventListener('click', () => retryAction?.());
  deps.mount.appendChild(shell);

  return {
    shell,
    stage,
    sheet,
    showState(kind: OverlayState) {
      skeleton.hidden = true;
      skeleton.replaceChildren(); preview?.remove(); preview = null; // 拒绝时连预填图片/剧情一起剔除
      title.textContent = '';
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
    showSkeleton(candidate) {
      // 换季复用壳层时 `close(retainStage)` 会清空 stage——骨架是 stage 的子节点，同样被清掉，
      // 因此这里必须保证它仍在舞台内（幂等的恢复挂载），否则换季加载期就没有首屏骨架。
      if (skeleton.parentElement !== stage) stage.append(skeleton);
      title.textContent = candidate?.title ?? '';
      preview?.remove(); preview = candidate ? candidateDetail(candidate) : null;
      if (preview) shell.append(preview);
      state.hide(); // 媒体载入不得用旧整页遮罩盖掉已知信息
      shell.dataset.phase = 'loading';
      shell.setAttribute('aria-busy', 'true');
      shell.setAttribute('aria-label', '正在载入');
      skeleton.replaceChildren();
      const coverUrl = candidate?.coverUrl;
      if (typeof coverUrl === 'string' && coverUrl !== '') {
        const cover = document.createElement('img');
        cover.className = 'prism-player-host__skeleton-cover';
        cover.src = coverUrl;
        cover.alt = '';
        skeleton.append(cover);
      }
      const glow = document.createElement('span');
      glow.className = 'prism-player-host__skeleton-glow';
      glow.innerHTML = icon('refresh', { size: 24 });
      skeleton.append(glow);
      skeleton.hidden = false;
    },
    onRetry(action) {
      retryAction = action;
    },
    dismissSkeleton() {
      skeleton.hidden = true;
      skeleton.replaceChildren();
    },
    promote(text: string) {
      shell.dataset.phase = 'ready';
      shell.setAttribute('aria-busy', 'false');
      shell.setAttribute('aria-label', '播放');
      title.textContent = text;
      preview?.remove(); preview = null;
      state.destroy(); // 只摘状态节点，shell / stage / sheet 原样复用
    },
    destroy() {
      retryAction = null;
      state.destroy();
      shell.remove();
    }
  };
}
