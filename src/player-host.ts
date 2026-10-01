/**
 * 播放宿主：把 `createPlayer` 装进全屏浮层，并负责它自己够不着的四件事——
 * 退出控件、断点选择、进度落库路由（公开→历史域 / 个人探索→内存域）、通知栏动作回程。
 *
 * 播放器内部已有缺失卡与私密卡同构渲染（AC-02-6），所以本宿主不预判"能不能播"，只负责挂载与拆除；
 * FLAG_SECURE 的决策也不在这里下：宿主只回报"当前是否在播私密内容"，由组合根合并频道状态后一次设定。
 */
import { icon } from './components/icons';
import type { ContentItem, EpisodeItem, TitleDetail } from '../edge/src/types/api';
import type { PrismNativeBridge } from './core/native/bridge';
import type { WatchHistoryRow } from './core/storage/storage-domains';
import { createPlayer } from './player/prism-player';
import type { EngineFactory, PlayerApi, PlayerFailure, PrismPlayer } from './player/prism-player';
import type { ProgressContext } from './player/episode-drawer';
import type { NotificationAction } from './core/native/capacitor-bridge';

export interface PlayerHostDeps {
  /** 浮层挂到这里（通常是 `.app-shell`，让 safe-area 与 `--native-dim` 继续生效）。 */
  mount: HTMLElement;
  bridge: PrismNativeBridge;
  api: PlayerApi;
  /** 进度落库路由由组合根提供：私密内容必须进内存域，这条分支不许出现在宿主里重复实现。 */
  onProgress(row: WatchHistoryRow, context: ProgressContext): void;
  /** AC-10 权限位：未开启"后台/息屏播放"时播放器不得拉起前台服务。 */
  allowBackgroundAudio(): boolean;
  onShare?(item: ContentItem, episode: EpisodeItem): void;
  /** 私密断点路由失败之类的闸门拒绝原因（播放器已自行渲染其余错误态）。 */
  onBlocked?(message: string): void;
  /** 每次私密性落定后回调，由组合根合并频道状态再决定 FLAG_SECURE。 */
  onPrivacyChange(isPrivate: boolean): void;
  onClose?(): void;
  titleOf?(): string;
  /** 播放内核工厂是公开接缝（默认为 ArtPlayer+hls.js）：真机之外的装配与集成测试由此注入替身。 */
  engine?: EngineFactory;
}

export interface PlayerHost {
  open(contentId: string, resume?: WatchHistoryRow): Promise<boolean>;
  close(): void;
  isOpen(): boolean;
  playingPrivateContent(): boolean;
  onNotification(action: NotificationAction): void;
  state(): ReturnType<PrismPlayer['state']> | null;
}

/** 断点优先回到历史那一集；历史缺失或该集已不在剧目内时，从第一集起播。 */
function episodeFor(detail: TitleDetail, resume?: WatchHistoryRow): { episode: EpisodeItem; seconds: number } {
  const ordered = [...detail.episodes].sort((a, b) => a.episodeNumber - b.episodeNumber);
  const wanted = resume !== undefined && resume.content_id === detail.item.id ? resume.last_episode_id : null;
  const episode = ordered.find((item) => item.episodeId === wanted) ?? ordered[0];
  const seconds = wanted !== null && episode !== undefined && resume?.last_episode_id === episode.episodeId
    ? resume.position_seconds : 0;
  return { episode, seconds };
}

export function createPlayerHost(deps: PlayerHostDeps): PlayerHost {
  let layer: HTMLElement | null = null;
  let player: PrismPlayer | null = null;
  let detail: TitleDetail | null = null;
  let keyup: ((event: KeyboardEvent) => void) | null = null;

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
      allowBackgroundAudio: deps.allowBackgroundAudio()
    });
    deps.onPrivacyChange(loaded.item.isPrivate === true || loaded.item.channelId === 'private');
    keyup = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    document.addEventListener('keydown', keyup);
    await player.load(target.episode.episodeId, target.seconds > 0 ? target.seconds : undefined);
    return true;
  }

  function close(): void {
    if (keyup !== null) document.removeEventListener('keydown', keyup);
    keyup = null;
    const instance = player;
    player = null;
    detail = null;
    const host = layer;
    layer = null;
    if (instance !== null) {
      instance.destroy();
      deps.onPrivacyChange(false);
      deps.onClose?.();
    }
    host?.remove();
  }

  function step(offset: number): void {
    if (detail === null || player === null) return;
    const ordered = [...detail.episodes].sort((a, b) => a.episodeNumber - b.episodeNumber);
    const at = ordered.findIndex((item) => item.episodeId === player?.state().episodeId);
    const next = ordered[Math.min(ordered.length - 1, Math.max(0, at + offset))];
    if (next !== undefined) void player.load(next.episodeId);
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
