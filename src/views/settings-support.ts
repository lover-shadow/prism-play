import { band, button, make } from './history-view';
import './settings.css';
/** Optional host-provided assets. No assumed cloud fields or default QR code. */
export interface SupportAsset { url: string; }
export interface SupportAssets { contact?: SupportAsset; reward?: SupportAsset; }
function safeUrl(value: string): string | null {
  try {
    const url = new URL(value, window.location.href);
    // Same-origin images make browser download honest; remote/configured assets need a host proxy.
    return url.origin === window.location.origin && ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}
export function createSupportBand(root: HTMLElement, assets?: SupportAssets) {
  const configured = (['contact', 'reward'] as const).flatMap(role => {
    const asset = assets?.[role]; return asset && safeUrl(asset.url) ? [{ role, asset }] : [];
  });
  if (!configured.length) return null;
  const target = band('作者支持', 'set-support');
  let overlay: HTMLElement | null = null, opener: HTMLElement | null = null;
  function close(): void {
    document.removeEventListener('keydown', onKey); overlay?.remove(); overlay = null;
    opener?.focus(); opener = null;
  }
  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') close();
    if (event.key === 'Tab' && overlay) {
      const nodes = Array.from(overlay.querySelectorAll<HTMLElement>('button, a[href]'));
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }
  for (const { role, asset } of configured) {
    const label = role === 'contact' ? '联系作者' : '自愿支持作者';
    const trigger = button(label, () => open(role, asset, trigger), { icon: 'image', el: `support-${role}` });
    target.body.append(trigger);
  }
  target.body.append(make('p', 'pv-note', '赞赏自愿，不构成购买授权或价格承诺；图中旧项目文字不代表当前权益，请以当前授权契约为准。'));
  function open(role: 'contact' | 'reward', asset: SupportAsset, trigger: HTMLElement): void {
    close(); opener = trigger;
    overlay = make('div', 'pv-overlay set-support-overlay');
    const card = make('div', 'pv-dialog set-support-dialog'); card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', role === 'contact' ? '作者联系二维码' : '作者赞赏二维码');
    const img = make('img', 'set-support-image'); img.src = asset.url; img.alt = role === 'contact' ? '作者联系二维码' : '作者赞赏二维码';
    const download = make('a', 'pv-btn'); download.href = asset.url; download.download = `author-${role}.jpg`; download.textContent = '下载二维码文件';
    const closeButton = button('关闭', close, { el: 'support-close' });
    card.append(img, make('p', 'pv-note', '微信内可长按识别；也可下载文件后自行打开微信识别。浏览器下载不等于保存到手机图库。'), download, closeButton);
    overlay.append(card); overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    root.append(overlay); document.addEventListener('keydown', onKey); closeButton.focus();
  }
  return { wrap: target.wrap, destroy: close };
}
