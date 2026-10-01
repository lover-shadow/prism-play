/**
 * 一次性轻提示：组合根与播放宿主用它把"能力缺席 / 写入失败 / 操作已生效"说给用户听。
 * 只允许一条同屏提示（新的覆盖旧的并重置计时），因为堆叠的 toast 会让用户以为出了更多问题。
 */
export type Notice = (message: string) => void;

export function createNotice(app: HTMLElement, autoHideMs: number = 6_000): Notice {
  let node: HTMLElement | null = null;
  let timer: number | undefined;
  return (message: string): void => {
    if (node === null) {
      node = document.createElement('div');
      node.className = 'app-notice';
      node.setAttribute('role', 'status');
      node.setAttribute('aria-live', 'polite');
      app.appendChild(node);
    }
    node.textContent = message;
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      node?.remove();
      node = null;
    }, autoHideMs);
  };
}
