import { icon, type IconName, type IconSize } from './icons';

/** URL 准入由 API/展示读取边界负责；加载失败只替换图片，保留封面内的角标。 */
export function coverInto(node: HTMLElement, url: string | null | undefined, alt: string, fallback: IconName, size: IconSize): void {
  const placeholder = (): HTMLElement => {
    const span = document.createElement('span');
    span.innerHTML = icon(fallback, { size });
    return span;
  };
  const usable = typeof url === 'string' && (url.startsWith('/') || url.startsWith('https://')) ? url : null;
  if (usable === null) { node.append(placeholder()); return; }
  const img = document.createElement('img');
  img.addEventListener('error', () => img.replaceWith(placeholder()), { once: true });
  img.src = usable; img.alt = alt; img.loading = 'lazy';
  node.append(img);
}
