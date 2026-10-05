/** 播放浮层宿主：退出、续集、存储与运行时接线、通知动作。FLAG_SECURE 仅上报，由组合根合并决策。 */
import { icon } from './components/icons';
import type { ContentItem, EpisodeItem, RelatedResponse, TitleDetail } from '../edge/src/types/api';
import type { PrismNativeBridge } from './core/native/bridge';
import type { WatchHistoryRow } from './core/storage/storage-domains';
import { registerBackHandler } from './core/native/back-button';
import { createFullscreenPolicy, createOrientationPort, type OrientationPort } from './core/native/orientation';
import { exitReportOf, type ExitReport } from './core/user-sync';
import { createPlayer } from './player/prism-player';
import { buildDetailBody, type PlayerDetailStage } from './player/player-detail';
import type { PlayerApi, PlayerFailure, PrismPlayer } from './player/prism-player';
import type { EngineFactory } from './player/engine-seam';
import type { AspectOrientation } from './player/aspect';
import type { ProgressContext } from './player/progress-reporter';
import { episodeSheetMode } from './player/episode-sheet';
import type { NotificationAction } from './core/native/capacitor-bridge';
import { bindWatchVideo, type RuntimeServices } from './core/runtime-services';
import { createSponsorNudge } from './views/sponsor-nudge';
import { isPrivateSubject } from './core/storage/storage-domains';
import './player/player-host.css';
export interface PlayerHostApi extends PlayerApi {
  related?(titleId: string): Promise<RelatedResponse>;
}
export interface PlayerHostDeps {
  /** 浮层挂到这里（通常是 `.app-shell`，让 safe-area 与 `--native-dim` 继续生效）。 */
  mount: HTMLElement;
  bridge: PrismNativeBridge;
  api: PlayerHostApi;
  /** 进度落库路由由组合根提供：私密内容必须进内存域，这条分支不许出现在宿主里重复实现。 */
  onProgress(row: WatchHistoryRow, context: ProgressContext): void;
  /** AC-10 权限位：未开启"后台/息屏播放"时播放器不得拉起前台服务。 */
  allowBackgroundAudio(): boolean;
  onShare?(item: ContentItem, episode: EpisodeItem): void;
  /** 私密断点路由失败之类的闸门拒绝原因（播放器已自行渲染其余错误态）。 */
  onBlocked?(message: string): void;
  /** 每次私密性落定后回调，由组合根合并频道状态再决定 FLAG_SECURE。 */
  onPrivacyChange(isPrivate: boolean): void;
  /** §1.9.3 退出载荷就地定格，交同步中枢判私密与落队列。 */
  onExit?(report: ExitReport): void;
  onClose?(): void;
  titleOf?(): string;
  /** 播放内核工厂是公开接缝（默认为 ArtPlayer+hls.js）：真机之外的装配与集成测试由此注入替身。 */
  engine?: EngineFactory;
  /** AC-20 方向端口：Web 自动降级，注入端口验证锁/解时序，真机验证旋转。 */
  orientation?: OrientationPort;
  playbackPreferences?: import('./player/playback-rate').PlaybackPreferences;
  following?: import('./core/storage/following-store').FollowingStore;
  runtime?: RuntimeServices;
  onRedeem?(): void;
}
export interface PlayerHost {
  open(contentId: string, resume?: WatchHistoryRow): Promise<boolean>;
  close(): void;
  isOpen(): boolean;
  playingPrivateContent(): boolean;
  onNotification(action: NotificationAction): void;
  suspend(): void;
  state(): ReturnType<PrismPlayer['state']> | null;
}
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
  let layer: HTMLElement | null = null;
  let player: PrismPlayer | null = null;
  let detail: TitleDetail | null = null;
  let keyup: ((event: KeyboardEvent) => void) | null = null;
  let unregisterBack: (() => void) | null = null;
  let detailBodyRef: PlayerDetailStage | null = null;
  let resizeHandler: (() => void) | null = null;
  let watchVideo: ReturnType<typeof bindWatchVideo> | null = null;
  let nudge: ReturnType<typeof createSponsorNudge> = null;
  let opening = 0;
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
    layer.classList.toggle('prism-player-host--fullscreen', isFullscreen);
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
  function buildLayer(): { shell: HTMLElement; stage: HTMLElement; sheet: HTMLElement } {
    const shell = document.createElement('div');
    shell.className = 'prism-player-host';
    shell.setAttribute('role', 'dialog');
    shell.setAttribute('aria-modal', 'true');
    shell.setAttribute('aria-label', '播放');
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
    const title = document.createElement('span');
    title.className = 'prism-player-host__title';
    title.textContent = deps.titleOf?.() ?? '';
    bar.append(exit, title);
    const stage = document.createElement('div');
    stage.className = 'prism-player-host__stage';
    // 选集面板的正文槽位排在舞台之后：非全屏即视频下方，不覆盖画面（R26-05）。
    const sheet = document.createElement('div');
    sheet.className = 'prism-player-host__sheet';
    shell.append(bar, stage, sheet);
    exit.addEventListener('click', () => close());
    return { shell, stage, sheet };
  }
  async function open(contentId: string, resume?: WatchHistoryRow): Promise<boolean> {
    close();
    const mine = opening;
    await deps.runtime?.refresh();
    // 先取详情：私密与不存在都靠 `api.title` 的 404 收敛，宿主不猜测、不预筛。
    let loaded: TitleDetail;
    try {
      loaded = await deps.api.title(contentId);
    } catch {
      return false;
    }
    if (player !== null || mine !== opening) return false; // 等待期间被关闭或另一次 open 抢占
    detail = loaded;
    const { shell, stage, sheet } = buildLayer();
    layer = shell;
    deps.mount.appendChild(shell);
    const target = episodeFor(loaded, resume);
    if (target.episode === undefined) {
      close();
      return false;
    }
    if (deps.runtime) {
      await deps.runtime.watch?.setScope(isPrivateSubject(loaded.item) ? 'private' : 'public');
      if (mine !== opening) return false;
      watchVideo = bindWatchVideo(stage, deps.runtime);
    }
    player = createPlayer({
      root: stage,
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
        if (nudge) shell.append(nudge.element);
      },
      onEpisodeChange: (ep) => detailBodyRef?.markEpisode(ep.episodeId),
      // AC-02-6：私密与不可分享剧目一律不渲染分享入口，开关位由数据决定而非界面判断。
      allowShare: loaded.item.isPrivate === false && loaded.item.shareable !== false && deps.onShare !== undefined,
      onShare: deps.onShare === undefined ? undefined : (episode) => void deps.onShare?.(loaded.item, episode),
      allowBackgroundAudio: deps.allowBackgroundAudio(),
      // 画幅由播放器嗅探后**上报**，宿主据此决定是否联动方向；播放器自己不锁屏、不进全屏。
      onAspect: (aspect) => { videoAspect = aspect; void syncOrientation(); },
      // 选集面板的三态与控件收起判据都从宿主的既有真相现读，播放器不持有第二份全屏/菜单状态（R26-05）。
      drawerMount: sheet, sheetMode: () => episodeSheetMode({ fullscreen: isFullscreen, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight }),
      fullscreen: () => isFullscreen, overlayOpen: () => detailBodyRef?.castOpen() ?? false,
      onOverlayOpen: () => { detailBodyRef?.closeCast(); }
    });
    deps.onPrivacyChange(loaded.item.isPrivate === true || loaded.item.channelId === 'private');
    keyup = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (detailBodyRef?.dismissOverlay() || player?.dismissOverlay()) return;
        if (isFullscreen) toggleFullscreen(false); else close();
      }
    };
    document.addEventListener('keydown', keyup);
    unregisterBack = registerBackHandler(() => {
      if (detailBodyRef?.dismissOverlay() || player?.dismissOverlay()) return true;
      if (isFullscreen) {
        toggleFullscreen(false);
        return true;
      }
      close();
      return true;
    });
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
    shell.append(detailBody.body);
    const cast = document.createElement('button'); cast.type = 'button'; cast.className = 'prism-player__button';
    cast.dataset.prismUi = 'cast'; cast.setAttribute('aria-label', '投屏'); cast.innerHTML = icon('cast', { size: 20 });
    cast.addEventListener('click', () => { player?.dismissOverlay(); detailBody.openCast(); });
    shell.querySelector('.prism-player__chrome')?.append(cast);
    await player.load(target.episode.episodeId, target.seconds > 0 ? target.seconds : undefined);
    return true;
  }
  function close(): void {
    opening++;
    watchVideo?.destroy(); watchVideo = null;
    void deps.runtime?.watch?.setScope('unknown');
    nudge?.close(); nudge = null;
    if (keyup !== null) document.removeEventListener('keydown', keyup);
    keyup = null;
    if (unregisterBack !== null) unregisterBack(); unregisterBack = null;
    if (resizeHandler !== null) window.removeEventListener('resize', resizeHandler); resizeHandler = null;
    isFullscreen = false;
    // 会话拆除必须把方向锁一并交还：留着锁横屏，用户退出播放器后手机会一直不肯回转。
    videoAspect = null;
    void fullscreenPolicy(false);
    detailBodyRef?.destroy(); detailBodyRef = null;
    const instance = player;
    const report = instance !== null && detail !== null ? exitReportOf(detail, instance.state()) : null; // §1.9.3 节点 ①：必须在 `detail`/内核归 null 之前定格
    player = null;
    detail = null;
    const host = layer;
    layer = null;
    if (instance !== null) {
      instance.destroy();
      deps.onPrivacyChange(false);
      if (report !== null) deps.onExit?.(report);
      deps.onClose?.();
    }
    host?.remove();
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
    isOpen: () => player !== null,
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
