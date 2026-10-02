/**
 * 分享出站（AC-02-6 的端侧半边）：只分享边缘 `/s/:drama_id?ep=N`，且失败必须被说出来。
 *
 * `ep` 是**集数**而非内部 id，且缺失即 404（`edge/src/routes/share.ts` 的线协议），所以海报卡上的分享
 * 没有播放上下文时固定第一集。私密内容永远走不到这里——播放器按数据摘掉了入口，本模块不再重复判定，
 * 以免两处各写一套私密规则、日后只改一处。
 *
 * **主域为什么是常量而不是运行时读取**：Android Capacitor 里 `window.location.origin` 是
 * `https://localhost`，用它拼出来的分享链接在别人手机上是必然打不开的死链（v2.4 之前的真实缺陷）。
 * 主域是产品事实而非运行时事实，故锁成常量，并把 `origin` 依赖项从类型上彻底删除——留着它，下一次
 * 就还会有人传错、或者干脆不传而悄悄回落到 localhost。
 */
import type { ContentItem, EpisodeItem } from '../../edge/src/types/api';
import type { PrismNativeBridge } from './native/bridge';
import type { Notice } from '../components/notice';

/** 统一服务主域：分享链接的根，唯一真相源（严禁改为运行时读取）。 */
export const SHARE_ORIGIN = 'https://play.prismos.org';

export interface ShareDeps {
  bridge: PrismNativeBridge;
  report: Notice;
}

export type ShareAction = (item: ContentItem, episode?: EpisodeItem) => Promise<void>;

/** 分享文案带上剧名与集数：只发一个裸链接对接收方是无效信息。 */
export function shareTextFor(item: ContentItem, url: string, episodeNumber: number): string {
  return `【光影Play】邀请你看《${item.title}》第${episodeNumber}集，点开即播免下载：\n${url}`;
}

export function createShareAction(deps: ShareDeps): ShareAction {
  return async (item: ContentItem, episode?: EpisodeItem): Promise<void> => {
    const episodeNumber = episode?.episodeNumber ?? 1;
    const url = `${SHARE_ORIGIN}/s/${encodeURIComponent(item.id)}?ep=${episodeNumber}`;
    const text = shareTextFor(item, url, episodeNumber);
    try {
      await navigator.clipboard.writeText(text);
      deps.report('分享链接已复制，可直接粘贴给好友');
      return;
    } catch {
      // 剪贴板被浏览器策略拒绝时退回系统分享通道；两条路都不通才报错，绝不静默失败。
    }
    try {
      await deps.bridge.openExternalUrl(url);
    } catch {
      deps.report('分享失败：本机无可用分享通道');
    }
  };
}
