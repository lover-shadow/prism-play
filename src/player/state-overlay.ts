import { icon } from '../components/icons';

export type OverlayState = 'loading' | 'retryable' | 'offline' | 'connection' | 'missing';
export type PlayerErrorKind = Exclude<OverlayState, 'loading'>;

/** AC-15 / AC-02-6: 私密与未知共用同一句话，浮层不泄露任何剧目元信息。 */
const STATE_COPY: Readonly<Record<OverlayState, { title: string; copy: string; retry: boolean }>> = {
  loading: { title: '正在解析可播地址', copy: '请稍候。', retry: false },
  retryable: { title: '暂无可用播放源', copy: '上游源巡检中，请稍后重试。', retry: true },
  offline: { title: '需要网络', copy: '点播必须联网解析可播地址，离线仅可浏览已缓存的公开目录。', retry: true },
  connection: { title: '连接暂不可用', copy: '请求超时或服务暂不可达，请重试。', retry: true },
  missing: { title: '内容不存在或已下架', copy: '该剧目当前不可用。', retry: false }
};

export interface StateOverlay {
  el: HTMLElement;
  /** The host registers and unbinds the retry action itself, so teardown bookkeeping stays in one place. */
  retryButton: HTMLButtonElement;
  show(kind: OverlayState): void;
  hide(): void;
  destroy(): void;
}

export function createStateOverlay(root: HTMLElement): StateOverlay {
  const el = document.createElement('div');
  el.className = 'prism-player__state';
  el.dataset['prismUi'] = 'state';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.hidden = true;
  const iconBox = document.createElement('span');
  iconBox.className = 'prism-player__state-icon';
  const title = document.createElement('p');
  title.className = 'prism-player__state-title';
  const copy = document.createElement('p');
  copy.className = 'prism-player__state-copy';
  const retryButton = document.createElement('button');
  retryButton.type = 'button';
  retryButton.className = 'prism-player__retry';
  retryButton.innerHTML = icon('refresh', { size: 16 });
  retryButton.append(document.createTextNode('重试'));
  el.append(iconBox, title, copy, retryButton);
  root.append(el);

  return {
    el,
    retryButton,
    show: (kind) => {
      const text = STATE_COPY[kind];
      el.classList.toggle('prism-player__state--offline', kind === 'offline');
      el.classList.toggle('prism-player__state--missing', kind === 'missing');
      iconBox.innerHTML = icon(kind === 'loading' ? 'refresh' : 'alert', { size: 24 });
      title.textContent = text.title;
      copy.textContent = text.copy;
      retryButton.hidden = !text.retry;
      el.hidden = false;
    },
    hide: () => void (el.hidden = true),
    destroy: () => el.remove()
  };
}
