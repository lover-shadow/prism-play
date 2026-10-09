import { Capacitor, registerPlugin } from '@capacitor/core';

export interface SupportActions {
  save(url: string, role: 'contact' | 'reward'): Promise<boolean>;
  openWechat(): Promise<void>;
}
interface AuthorSupportPlugin {
  saveQr(args: { data: string; role: 'contact' | 'reward' }): Promise<{ saved: boolean }>;
  openWechat(): Promise<void>;
}
const plugin = registerPlugin<AuthorSupportPlugin>('PrismAuthorSupport');
export function authorSupportActions(): SupportActions | undefined {
  if (Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('PrismAuthorSupport')) return undefined;
  return {
    async save(url, role) {
      const allowed = new URL(url, window.location.href);
      if (allowed.origin !== window.location.origin || !/^\/images\/author-(contact|reward)\.jpg$/.test(allowed.pathname)) throw Error('二维码地址不可用');
      const response = await fetch(allowed.href, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error('二维码读取失败');
      const blob = await response.blob();
      if (blob.size < 1 || blob.size > 1048576 || blob.type !== 'image/jpeg') throw Error('二维码文件格式不可用');
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(Error('二维码读取失败'));
        reader.readAsDataURL(blob);
      });
      return (await plugin.saveQr({ data, role })).saved;
    },
    openWechat: () => plugin.openWechat()
  };
}
