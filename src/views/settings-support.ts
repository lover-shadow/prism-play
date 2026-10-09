import { band, button, make } from './history-view';
import './settings.css';
import { authorSupportActions, type SupportActions } from '../core/native/author-support';
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
export function createSupportBand(root: HTMLElement, assets?: SupportAssets, actions: SupportActions | undefined = authorSupportActions()) {
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
  target.body.append(
    make('p', 'pv-note', '本程序的内容来自网络搜索聚合。部分来源的视频可能带有广告，我们正在逐步完善识别与剔除；目前无法保证所有内容均无广告。'),
    make('p', 'pv-note', '程序目前仍处于完善阶段。如遇到 BUG 或有改进建议，欢迎通过【联系作者】反馈，帮助我们持续完善。反馈时可附上剧名、操作步骤、截图或运行诊断报告；请勿提供卡密、授权令牌等敏感信息。'),
    make('p', 'pv-note', '赞赏自愿，不构成购买授权或价格承诺；图中旧项目文字不代表当前权益，请以当前授权契约为准。')
  );
  function open(role: 'contact' | 'reward', asset: SupportAsset, trigger: HTMLElement): void {
    close(); opener = trigger;
    overlay = make('div', 'pv-overlay set-support-overlay');
    const card = make('div', 'pv-dialog set-support-dialog'); card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', role === 'contact' ? '作者联系二维码' : '作者赞赏二维码');
    const img = make('img', 'set-support-image'); img.src = asset.url; img.alt = role === 'contact' ? '作者联系二维码' : '作者赞赏二维码';
    const status = make('p', 'pv-note'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const download = make('a', 'pv-btn'); download.href = asset.url; download.download = `author-${role}.jpg`; download.textContent = '下载二维码文件';
    download.addEventListener('click', () => { status.textContent = '已请求浏览器下载，请查看下载列表；未确认保存到图库。'; });
    const save = button('保存二维码文件', () => { void saveFile(); }, { el: 'support-save' });
    async function saveFile(): Promise<void> {
      if (!actions || save.disabled) return;
      save.disabled = true; status.textContent = '正在保存二维码；若出现系统保存窗口，请选择位置并确认。';
      try { status.textContent = await actions.save(asset.url, role) ? '二维码文件已保存，请在图库或所选文件位置查看，再用微信扫一扫识别。' : '已取消保存，二维码仍可查看。'; }
      catch { status.textContent = '保存失败，请重试或使用其他设备扫描二维码。'; }
      finally { save.disabled = false; }
    }
    const wechat = button('打开微信', () => { void openWechat(); }, { el: 'support-wechat' });
    async function openWechat(): Promise<void> {
      wechat.disabled = true; status.textContent = '正在尝试打开微信，请手动使用扫一扫识别二维码。';
      try { await actions?.openWechat(); }
      catch { status.textContent = '无法打开微信，请确认已安装，或手动打开微信识别二维码。'; }
      finally { wechat.disabled = false; }
    }
    const closeButton = button('关闭', close, { el: 'support-close' });
    card.append(img, make('p', 'pv-note', '请先保存二维码，再打开微信扫一扫识别。Android 10及以上保存到图库，旧版使用系统文件保存；浏览器下载不代表图库保存。也可使用其他设备扫描此图。'), ...(actions ? [save, wechat] : [download]), status, closeButton);
    overlay.append(card); overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    root.append(overlay); document.addEventListener('keydown', onKey); closeButton.focus();
  }
  return { wrap: target.wrap, destroy: close };
}
