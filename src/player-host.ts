/**
 * 播放宿主：把 `createPlayer` 装进全屏浮层，并负责它自己够不着的四件事——
 * 退出控件、断点选择、进度落库路由（公开→历史域 / 个人探索→内存域）、通知栏动作回程。
 *
 * 播放器内部已有缺失卡与私密卡同构渲染（AC-02-6），所以本宿主不预判"能不能播"，只负责挂载与拆除；
 * FLAG_SECURE 的决策也不在这里下：宿主只回报"当前是否在播私密内容"，由组合根合并频道状态后一次设定。
 */
import { icon } from './components/icons';
import type { ContentItem, EpisodeItem, RelatedResponse, TitleDetail } from '../edge/src/types/api';
import type { PrismNativeBridge } from './core/native/bridge';
import type { WatchHistoryRow } from './core/storage/storage-domains';
import { registerBackHandler } from './core/native/back-button';
import { createOrientationPort, type OrientationPort } from './core/native/orientation';
import { exitReportOf, type ExitReport } from './core/user-sync';
import { createPlayer } from './player/prism-player';
import { buildDetailBody, type PlayerDetailStage } from './player/player-detail';
import type { PlayerApi, PlayerFailure, PrismPlayer } from './player/prism-player';
import type { EngineFactory } from './player/engine-seam';
import type { AspectOrientation } from './player/aspect';
import type { ProgressContext } from './player/episode-drawer';
import type { NotificationAction } from './core/native/capacitor-bridge';
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
  /**
   * §1.9.3 节点 ①（退出播放）的出口：载荷在销毁的那一刻定格，交由组合根注入的同步中枢处置。
   * 宿主不判定私密性——闸门自会拒绝私密断点落队列，这里再判一次只会长出两套口径。
   */
  onExit?(report: ExitReport): void;
  onClose?(): void;
  titleOf?(): string;
  /** 播放内核工厂是公开接缝（默认为 ArtPlayer+hls.js）：真机之外的装配与集成测试由此注入替身。 */
  engine?: EngineFactory;
  /**
   * 屏幕方向端口（AC-20）：默认走 `@capacitor/screen-orientation`，Web 端自动降级。
   * 注入而非直接调用，是因为锁方向在 jsdom 里无从验证——单测钉的是"何时该锁、何时必须解"的时序，
   * 真机才验证"屏幕真的转了"。
   */
  orientation?: OrientationPort;
}

export interface PlayerHost {
  open(contentId: string, resume?: WatchHistoryRow): Promise<boolean>;
  close(): void;
  isOpen(): boolean;
  playingPrivateContent(): boolean;
  onNotification(action: NotificationAction): void;
  state(): ReturnType<PrismPlayer['state']> | null;
}

/**
 * 断点优先回到历史那一集；历史缺失或该集已不在剧目内时，从第一集起播。
 * 端云合并来的行只有云端集数与本机旧集 ID（§1.9.2：云端不回填 `episode_id`），两者不符时按集数再认一次，
 * 否则会拿第 7 集的 ID 去续第 12 集的秒数——既不是最新断点，也不是本机事实。
 */
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
  const orientation = deps.orientation ?? createOrientationPort();

  /**
   * 全屏唯一权威（SPEC §1.2.0 / 铁律 7）：本布尔 + `.prism-player-host--fullscreen` 这一个类。
   * 播放器内核不再持有全屏通道，`.prism-player--fullscreen` 也已从样式里删除——
   * 三方权威互不相知正是旧缺陷"横竖屏都缩在中间小方块"的病理来源。
   */
  let isFullscreen = false;
  /** 元数据就绪后嗅到的真实画幅朝向；null 表示尚未知，未知时一律不做方向联动。 */
  let videoAspect: AspectOrientation | null = null;
  let orientationLocked = false;

  /**
   * 方向联动（AC-19 / AC-20）：只有**横屏影视**进全屏才锁横屏；竖屏短剧保持竖直自然握持，严禁强制旋转。
   * 退出全屏（或画幅尚未知的会话被拆除）一律解锁，把方向交还给系统传感器。
   */
  async function syncOrientation(): Promise<void> {
    const shouldLock = isFullscreen && videoAspect === 'landscape';
    if (shouldLock && !orientationLocked) orientationLocked = await orientation.lock('landscape');
    else if (!shouldLock && orientationLocked) {
      orientationLocked = false;
      await orientation.unlock();
    }
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

  function buildLayer(): { shell: HTMLElement; stage: HTMLElement } {
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
    shell.append(bar, stage);
    exit.addEventListener('click', () => close());
    return { shell, stage };
  }

  async function open(contentId: string, resume?: WatchHistoryRow): Promise<boolean> {
    close();
    // 先取详情：私密与不存在都靠 `api.title` 的 404 收敛，宿主不猜测、不预筛。
    let loaded: TitleDetail;
    try {
      loaded = await deps.api.title(contentId);
    } catch {
      return false;
    }
    if (player !== null) return false;   // 等待期间已被另一次 open 抢占
    detail = loaded;
    const { shell, stage } = buildLayer();
    layer = shell;
    deps.mount.appendChild(shell);
    const target = episodeFor(loaded, resume);
    if (target.episode === undefined) {
      close();
      return false;
    }
    player = createPlayer({
      root: stage,
      engine: deps.engine,
      bridge: deps.bridge,
      api: deps.api,
      titleId: loaded.item.id,
      detail: loaded,
      onProgress: deps.onProgress,
      onError: failure,
      // AC-02-6：私密与不可分享剧目一律不渲染分享入口，开关位由数据决定而非界面判断。
      allowShare: loaded.item.isPrivate === false && loaded.item.shareable !== false && deps.onShare !== undefined,
      onShare: deps.onShare === undefined ? undefined : (episode) => void deps.onShare?.(loaded.item, episode),
      allowBackgroundAudio: deps.allowBackgroundAudio(),
      // 画幅由播放器嗅探后**上报**，宿主据此决定是否联动方向；播放器自己不锁屏、不进全屏。
      onAspect: (aspect) => { videoAspect = aspect; void syncOrientation(); }
    });
    deps.onPrivacyChange(loaded.item.isPrivate === true || loaded.item.channelId === 'private');
    keyup = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (isFullscreen) toggleFullscreen(false); else close();
      }
    };
    document.addEventListener('keydown', keyup);
    unregisterBack = registerBackHandler(() => {
      if (isFullscreen) {
        toggleFullscreen(false);
        return true;
      }
      close();
      return true;
    });

    resizeHandler = () => {
      const isLandscape = window.innerWidth > window.innerHeight;
      if (isLandscape && !isFullscreen) toggleFullscreen(true);
    };
    window.addEventListener('resize', resizeHandler);

    const detailBody = buildDetailBody(
      loaded,
      target.episode.episodeId,
      (epId) => {
        void player?.load(epId);
        detailBody.markEpisode(epId);
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
      (contentId) => { void open(contentId); }
    );
    detailBodyRef = detailBody;
    shell.append(detailBody.body);

    await player.load(target.episode.episodeId, target.seconds > 0 ? target.seconds : undefined);
    return true;
  }

  function close(): void {
    if (keyup !== null) document.removeEventListener('keydown', keyup);
    keyup = null;
    if (unregisterBack !== null) unregisterBack();
    unregisterBack = null;
    if (resizeHandler !== null) window.removeEventListener('resize', resizeHandler);
    resizeHandler = null;
    isFullscreen = false;
    // 会话拆除必须把方向锁一并交还：留着锁横屏，用户退出播放器后手机会一直不肯回转。
    videoAspect = null;
    if (orientationLocked) { orientationLocked = false; void orientation.unlock(); }
    detailBodyRef = null;
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
      detailBodyRef?.markEpisode(next.episodeId);
      void player.load(next.episodeId);
    }
  }

  return {
    open,
    close,
    isOpen: () => player !== null,
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
