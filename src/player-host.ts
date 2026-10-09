/** 播放浮层宿主：即时 loading、打开代次守卫、退出、续集、存储与运行时接线、通知动作。FLAG_SECURE 仅上报，由组合根合并决策。 */
import { icon } from './components/icons';
import type { ContentItem, EpisodeItem, TitleDetail } from '../edge/src/types/api';
import type { WatchHistoryRow } from './core/storage/storage-domains';
import { registerBackHandler } from './core/native/back-button';
import { createFullscreenPolicy, createOrientationPort } from './core/native/orientation';
import { exitReportOf } from './core/user-sync';
import { createPlayer } from './player/prism-player';
import { buildDetailBody, type PlayerDetailStage } from './player/player-detail';
import type { PlayerFailure, PrismPlayer } from './player/prism-player';
import type { AspectOrientation } from './player/aspect';
import { episodeSheetMode } from './player/episode-sheet';
import { bindWatchVideo } from './core/runtime-services';
import { createSponsorNudge } from './views/sponsor-nudge';
import { isPrivateSubject } from './core/storage/storage-domains';
import { createHostLayer, hostErrorFor, type HostLayer } from './player/host-layer';
import type { OverlayState } from './player/hud';
import type { PlayerHost, PlayerHostDeps } from './player/host-contract';
import './player/player-host.css';
import { createSeasonSwitcher } from './player/season-switcher';

export type { PlayerHost, PlayerHostApi, PlayerHostDeps } from './player/host-contract';

/** 历史优先，缺集回第一集；端云合并后 ID/集数冲突时优先按集数匹配，避免旧 ID 续错集。 */
function episodeFor(detail: TitleDetail, resume?: WatchHistoryRow): { episode: EpisodeItem; seconds: number } {
  const ordered = [...detail.episodes].sort((a, b) => a.episodeNumber - b.episodeNumber);
  const mine = resume !== undefined && resume.content_id === detail.item.id ? resume : null;
  const byId = ordered.find((item) => item.episodeId === mine?.last_episode_id);
  const byNumber = ordered.find((item) => item.episodeNumber === mine?.last_episode_number);
  const episode = byId !== undefined && byId.episodeNumber === mine?.last_episode_number ? byId : byNumber ?? byId ?? ordered[0];
  const seconds = mine !== null && (episode?.episodeId === mine.last_episode_id || episode?.episodeNumber === mine.last_episode_number) ? mine.position_seconds : 0;
  return { episode, seconds };
}

export function createPlayerHost(deps: PlayerHostDeps): PlayerHost {
  /** 当前这一层（loading / error / ready 三态同一条记录）：`layer !== null` 就是"界面被挡住"的真相。 */
  let layer: HostLayer | null = null;
  let player: PrismPlayer | null = null;
  let detail: TitleDetail | null = null;
  let keyup: ((event: KeyboardEvent) => void) | null = null;
  let unregisterBack: (() => void) | null = null;
  let detailBodyRef: PlayerDetailStage | null = null;
  let resizeHandler: (() => void) | null = null;
  let watchVideo: ReturnType<typeof bindWatchVideo> | null = null;
  let nudge: ReturnType<typeof createSponsorNudge> = null;
  /** 打开代次：`close()` 递增它，用来作废在途的 refresh / 详情 / setScope / load 结果。 */
  let opening = 0;
  let openingRequest: AbortController | null = null;
  const orientation = deps.orientation ?? createOrientationPort();
  /** 全屏唯一权威：本布尔与宿主类；内核不另持全屏通道。 */
  let isFullscreen = false;
  /** 元数据就绪后嗅到的真实画幅朝向；null 表示尚未知，未知时一律不做方向联动。 */
  let videoAspect: AspectOrientation | null = null;
  const fullscreenPolicy = createFullscreenPolicy(orientation, deps.bridge);
  /** AC-19/20：仅横屏影视全屏锁横屏；竖屏不强转，退出解锁。 */
  async function syncOrientation(): Promise<void> {
    await fullscreenPolicy(isFullscreen && videoAspect === 'landscape');
  }
  function toggleFullscreen(on?: boolean): void {
    if (layer === null) return;
    isFullscreen = on !== undefined ? on : !isFullscreen;
    layer.shell.classList.toggle('prism-player-host--fullscreen', isFullscreen);
    // 几何变了就让内核重算尺寸（`autoSize`），它不触碰任何原生全屏容器。
    player?.relayout();
    void syncOrientation();
  }
  /** 播放器是异步构造的（ArtPlayer/hls.js 动态导入），动作必须始终打在"当前那一个"实例上。 */
  const act = (action: (current: PrismPlayer) => void): void => { if (player !== null) action(player); };
  /** 进度写入被闸门拒绝时播放器不再叠加界面提示，由宿主如实回报给组合根。 */
  const failure = (event: PlayerFailure): void => {
    if (event.kind === 'progress-blocked') deps.onBlocked?.(event.message);
  };
  /** 返回键与 Escape 共用一条级联：内核还没装起来时，这层唯一的去处就是关掉自己。 */
  function consumeBack(): boolean {
    const current = player;
    if (current === null) { close(); return true; }
    if (detailBodyRef?.dismissOverlay() || current.dismissOverlay()) return true;
    if (isFullscreen) {
      toggleFullscreen(false);
      return true;
    }
    close();
    return true;
  }
  /** 失败必须停在层内给出出口；但代次已被抢走时旧结果一个节点都不许留下（不得复活画面）。 */
  function refuse(host: HostLayer, mine: number, retry: () => void, kind: OverlayState): false {
    if (mine !== opening || layer !== host) { if (layer !== host) host.destroy(); return false; }
    host.showState(kind);
    host.onRetry(retry);
    return false;
  }
  /** 旧代次拿到了结果：只拆自己那块（可能早已脱离文档的）节点，绝不改当前层的共享状态。 */
  function discard(host: HostLayer): false {
    if (layer !== host) host.destroy();
    return false;
  }
  async function open(contentId: string, resume?: WatchHistoryRow, retainStage = false): Promise<boolean> {
    const retained = retainStage ? layer : null;
    close(retained !== null);
    const mine = opening, request = new AbortController();
    openingRequest = request;
    // §3.1：创建与挂载都发生在第一个 await 之前——"点了没反应"就是旧实现的用户面缺陷本体。
    const host = retained ?? createHostLayer({ mount: deps.mount, onClose: () => close() });
    layer = host;
    host.showState('loading');
    keyup = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (detailBodyRef?.dismissOverlay() || player?.dismissOverlay()) return;
        if (isFullscreen) toggleFullscreen(false); else close();
      }
    };
    document.addEventListener('keydown', keyup);
    unregisterBack = registerBackHandler(consumeBack);
    const retry = (): void => { void open(contentId, resume); };
    // 先取详情：私密与不存在都靠 `api.title` 的 404 收敛，宿主不猜测、不预筛。
    let loaded: TitleDetail;
    try {
      await deps.runtime?.refresh();
      // 每一个 await 之后都先核代次：偏好读取一慢就被取消的话，不该再把那次详情请求发出去。
      if (mine !== opening || layer !== host) return discard(host);
      loaded = await deps.api.title(contentId, request.signal);
    } catch (error) {
      return refuse(host, mine, retry, hostErrorFor(error));
    }
    if (mine !== opening || layer !== host) return discard(host);
    const target = episodeFor(loaded, resume);
    // 核验过身份的公开剧目返回空清单：这是"暂无可用播放源"，不是"内容不存在"，两者不得互相冒充。
    if (target.episode === undefined) return refuse(host, mine, retry, 'retryable');
    detail = loaded;
    // 走到这一行才有资格升级：详情身份已核验、且确实有可播集，标题槽此刻才被写入。
    host.promote(loaded.item.title);
    if (deps.runtime) {
      await deps.runtime.watch?.setScope(isPrivateSubject(loaded.item) ? 'private' : 'public');
      if (mine !== opening || layer !== host) return discard(host);
      watchVideo = bindWatchVideo(host.stage, deps.runtime);
    }
    player = createPlayer({
      root: host.stage,
      engine: deps.engine,
      bridge: deps.bridge,
      api: deps.api,
      titleId: loaded.item.id,
      detail: loaded,
      onProgress: deps.onProgress,
      onError: (event) => { if (event.kind === 'media') watchVideo?.reset('error'); failure(event); },
      playbackPreferences: deps.runtime?.playbackPreferences ?? deps.playbackPreferences,
      onSourceChange: () => watchVideo?.reset('switch'),
      onNaturalBoundary: async () => {
        const policy = await watchVideo?.naturalBoundary();
        if (!policy || mine !== opening || nudge) return;
        nudge = createSponsorNudge({ config: policy,
          onClose: () => { nudge = null; void deps.runtime?.watch?.dismissNudge(); },
          onAction: () => { close(); deps.onRedeem?.(); } });
        if (nudge) layer?.shell.append(nudge.element);
      },
      onEpisodeChange: (ep) => detailBodyRef?.markEpisode(ep.episodeId),
      // AC-02-6：私密与不可分享剧目一律不渲染分享入口，开关位由数据决定而非界面判断。
      allowShare: loaded.item.isPrivate === false && loaded.item.shareable !== false && deps.onShare !== undefined,
      onShare: deps.onShare === undefined ? undefined : (episode) => void deps.onShare?.(loaded.item, episode),
      allowBackgroundAudio: deps.allowBackgroundAudio(),
      // 画幅由播放器嗅探后**上报**，宿主据此决定是否联动方向；播放器自己不锁屏、不进全屏。
      onAspect: (aspect) => { videoAspect = aspect; void syncOrientation(); },
      // 选集面板的三态与控件收起判据都从宿主的既有真相现读，播放器不持有第二份全屏/菜单状态（R26-05）。
      drawerMount: host.sheet, sheetMode: () => episodeSheetMode({ fullscreen: isFullscreen, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }),
      fullscreen: () => isFullscreen, overlayOpen: () => detailBodyRef?.castOpen() ?? false,
      onOverlayOpen: () => { detailBodyRef?.closeCast(); }
    });
    deps.onPrivacyChange(loaded.item.isPrivate === true || loaded.item.channelId === 'private');
    resizeHandler = () => {
      const isLandscape = window.innerWidth > window.innerHeight;
      // 转屏时全屏态不自动进出（那是用户的手），但画面矩形与面板模式必须跟着视口重量一次。
      if (isLandscape && !isFullscreen) toggleFullscreen(true); else player?.relayout();
    };
    window.addEventListener('resize', resizeHandler);
    const detailBody = buildDetailBody(
      loaded,
      target.episode.episodeId,
      (epId) => {
        void player?.load(epId);
      },
      () => player?.openDrawer(),
      deps.onShare === undefined ? undefined : (episode) => void deps.onShare?.(loaded.item, episode),
      () => toggleFullscreen(),
      async () => {
        if (loaded.item.isPrivate || loaded.item.channelId === 'private' || !deps.api.related) return [];
        try {
          const res = await deps.api.related(loaded.item.id);
          return res.items.filter((entry: ContentItem) => entry.id !== loaded.item.id && !entry.isPrivate);
        } catch {
          return [];
        }
      },
      (contentId) => { void open(contentId); },
      deps.following ? { store: deps.following, report: deps.onBlocked } : undefined,
      // 菜单互斥：详情台的投屏一开，选集与倍速必须先收——同一时刻只允许一个菜单（R26-05）。
      { beforeMenuOpen: () => void player?.dismissOverlay() }
    );
    detailBodyRef = detailBody;
    const bindSeasons = (): void => {
      const items = deps.seriesItems?.() ?? [];
      const s = createSeasonSwitcher(loaded.item, items, (id) => { void open(id, undefined, true); });
      if (s) {
        detailBody.attachSeasonSwitcher(s);
        const ds = createSeasonSwitcher(loaded.item, items, (id) => { void open(id, undefined, true); });
        if (ds) {
          host.sheet.querySelector('.prism-drawer [data-prism-ui="season-switcher"]')?.remove();
          host.sheet.querySelector('.prism-drawer')?.prepend(ds);
        }
      }
    };
    bindSeasons();
    deps.supplementSeries?.(loaded.item, () => {
      if (mine === opening && layer === host && detail?.item.id === loaded.item.id) bindSeasons();
    });
    host.shell.append(detailBody.body);
    const cast = document.createElement('button'); cast.type = 'button'; cast.className = 'prism-player__button';
    cast.dataset.prismUi = 'cast'; cast.setAttribute('aria-label', '投屏'); cast.innerHTML = icon('cast', { size: 20 });
    cast.addEventListener('click', () => { player?.dismissOverlay(); detailBody.openCast(); });
    host.shell.querySelector('.prism-player__chrome')?.append(cast);
    await player.load(target.episode.episodeId, target.seconds > 0 ? target.seconds : undefined);
    // load 在途期间被关掉/被抢占时如实报 false：调用方不该拿到一个"成功但已经没有层"的结果。
    return mine === opening && layer === host;
  }
  function close(retainStage = false): void {
    opening++;
    openingRequest?.abort(); openingRequest = null;
    watchVideo?.destroy(); watchVideo = null;
    void deps.runtime?.watch?.setScope('unknown');
    nudge?.close(); nudge = null;
    if (keyup !== null) document.removeEventListener('keydown', keyup);
    keyup = null;
    if (unregisterBack !== null) unregisterBack(); unregisterBack = null;
    if (resizeHandler !== null) window.removeEventListener('resize', resizeHandler); resizeHandler = null;
    if (!retainStage) { isFullscreen = false; videoAspect = null; void fullscreenPolicy(false); }
    detailBodyRef?.body.remove(); detailBodyRef?.destroy(); detailBodyRef = null;
    const instance = player;
    const report = instance !== null && detail !== null ? exitReportOf(detail, instance.state()) : null; // §1.9.3 节点 ①：必须在 `detail`/内核归 null 之前定格
    player = null;
    detail = null;
    const host = layer;
    layer = null;
    // 从未装配过内核的层（loading / error）不是一次"播放退出"：不报断点、也不谎报 onClose。
    if (instance !== null) {
      instance.destroy();
      deps.onPrivacyChange(false);
      if (report !== null) deps.onExit?.(report);
      if (!retainStage) deps.onClose?.();
    }
    if (retainStage && host) { host.stage.replaceChildren(); host.sheet.replaceChildren(); }
    else host?.destroy();
  }
  function step(offset: number): void {
    if (detail === null || player === null) return;
    const ordered = [...detail.episodes].sort((a, b) => a.episodeNumber - b.episodeNumber);
    const at = ordered.findIndex((item) => item.episodeId === player?.state().episodeId);
    const next = ordered[Math.min(ordered.length - 1, Math.max(0, at + offset))];
    if (next !== undefined) {
      void player.load(next.episodeId);
    }
  }
  return {
    open,
    close,
    isOpen: () => layer !== null,
    suspend: () => watchVideo?.reset('blur'),
    playingPrivateContent: () => player !== null && player.state().isPrivate,
    state: () => player?.state() ?? null,
    onNotification(action) {
      if (action === 'toggle') act((current) => (current.state().playing ? current.pause() : current.play()));
      if (action === 'next') step(1);
      if (action === 'previous') step(-1);
      if (action === 'focus-lost' || action === 'focus-regained') {
        act((current) => current.notifyAudioFocus(action === 'focus-lost' ? 'lost' : 'restored'));
      }
    }
  };
}
