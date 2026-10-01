/**
 * 分享出站（AC-02-6 的端侧半边）：只分享边缘 `/s/:drama_id?ep=N`，且失败必须被说出来。
 *
 * `ep` 是**集数**而非内部 id，且缺失即 404（`edge/src/routes/share.ts` 的线协议），所以海报卡上的分享
 * 没有播放上下文时固定第一集。私密内容永远走不到这里——播放器按数据摘掉了入口，本模块不再重复判定，
 * 以免两处各写一套私密规则、日后只改一处。
 */
import type { ContentItem, EpisodeItem } from '../../edge/src/types/api';
import type { PrismNativeBridge } from './native/bridge';
import type { Notice } from '../components/notice';

export interface ShareDeps {
  bridge: PrismNativeBridge;
  report: Notice;
  origin?: string;
}

export type ShareAction = (item: ContentItem, episode?: EpisodeItem) => Promise<void>;

export function createShareAction(deps: ShareDeps): ShareAction {
  return async (item: ContentItem, episode?: EpisodeItem): Promise<void> => {
    const origin = deps.origin ?? window.location.origin;
    const url = `${origin}/s/${encodeURIComponent(item.id)}?ep=${episode?.episodeNumber ?? 1}`;
    try {
      await navigator.clipboard.writeText(url);
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
