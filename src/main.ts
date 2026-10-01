/**
 * 组合根（SPEC §7 第一行）：平台能力装配、四大存储域接线、四个主视图的依赖注入与跨域决策。
 *
 * 三条纪律在本文件落地，而不是分散到视图里：
 * 1. **能力缺席就如实回报**——端侧 SQLite 不可用则【追剧】进入 disabled，未内置验签公钥则离线档位不显示，
 *    绝不返回空集合冒充"没有内容"（AC-15 / AC-18）；
 * 2. **进度落库的路由只写一次**——公开走历史域、个人探索走内存域，判定用 `isPrivateSubject` 唯一咽喉点；
 * 3. **FLAG_SECURE 只有一个决策点**——私密频道与私密播放任一成立即挂载，两者皆false即解除（AC-02-4）。
 */
import type { WatchHistoryRow, WatchProgressInput } from './core/storage';
import type { AppShell, ManagedView, ShellTab } from './app-shell';
import type { PosterMode } from './core/state/theme';
import type { PrismNativeBridge } from './core/native/bridge';
import type { FetchLike } from './core/api/client';
import type { ProgressContext } from './player/episode-drawer';
import type { RedeemOutcome } from './views/settings-view';
import { CATALOG_CACHE_LIMIT_BYTES, createStorageDomains, isPrivateSubject, MemoryCacheDisk, POSTER_CACHE_LIMIT_BYTES } from './core/storage';
import { PrismApiClient } from './core/api/client';
import { createCatalogCacheService } from './core/catalog-cache';
import { createGrantProbe, grantAdaptersFor } from './core/identity/offline-grant';
import { bindNotificationActions, installBridgeForPlatform } from './core/native/capacitor-bridge';
import { bridgeSource, getBridge } from './core/native/bridge';
import { createCacheDisk, createHistorySqlite, createPreferenceStore } from './core/native/platform-adapters';
import { applyTheme, readPosterMode, readThemePreference, writePosterMode } from './core/state/theme';
import { createAppShell } from './app-shell';
import { createNotice } from './components/notice';
import { createPlayerHost } from './player-host';
import { createShareAction } from './core/share';
import { createHomeView, type HomeApi, type HomeView } from './views/home-view';
import { createHistoryView } from './views/history-view';
import { createSearchView } from './views/search-view';
import { createSettingsView, SETTINGS_PREF_KEYS } from './views/settings-view';

/** 搜索热词的唯一来源：本机公开快照的剧名，绝不内置词表（SPEC §10 私密与公开同条约束）。 */
const HOT_WORD_LIMIT = 8;

export interface BootOptions {
  bridge?: PrismNativeBridge | null;
  apiBaseUrl?: string;
  fetchImpl?: FetchLike;
  nowSeconds?: () => number;
}

export interface PrismApp {
  shell: AppShell;
  openTitle(contentId: string, resume?: WatchHistoryRow): Promise<boolean>;
  destroy(): void;
}

function mountPoints(): [HTMLElement, HTMLElement, HTMLElement, HTMLElement] | null {
  const app = document.getElementById('app');
  const header = document.getElementById('app-header');
  const main = document.getElementById('app-main');
  const tabbar = document.getElementById('app-tabbar');
  return app !== null && header !== null && main !== null && tabbar !== null ? [app, header, main, tabbar] : null;
}

export async function boot(options: BootOptions = {}): Promise<PrismApp | null> {
  const mounts = mountPoints();
  if (mounts === null) return null;
  const [app, header, main, tabbar] = mounts;
  const now = options.nowSeconds ?? ((): number => Math.floor(Date.now() / 1000));

  installBridgeForPlatform(options.bridge ?? null);
  const bridge = getBridge();
  const prefs = createPreferenceStore();
  const storage = createStorageDomains({
    sqlite: await createHistorySqlite(),
    disk: (await createCacheDisk()) ?? new MemoryCacheDisk(),
    nowSeconds: now
  });
  // 冷启动即焚：上一次进程的私密痕迹不该存在于本进程（AC-02-2 每次进入默认关闭）。
  storage.privateVault.clear();

  const client = new PrismApiClient({ baseUrl: options.apiBaseUrl ?? '', fetchImpl: options.fetchImpl });
  client.bindSessionHolder(storage.privateVault.session);
  const grant = createGrantProbe({ credentials: storage.credentials, prefs, nowSeconds: now });
  const identity = grantAdaptersFor(grant, storage.credentials);

  applyTheme(await readThemePreference(prefs));
  let posterMode: PosterMode = await readPosterMode(prefs);
  let backgroundAudio = (await prefs.get(SETTINGS_PREF_KEYS.keepScreenOn)) === '1';

  // 在线请求一律带上已存 JWT（服务端私钥验签）；离线"显示档位"是另一条路，须本机验签通过（AC-15）。
  const stored = await storage.credentials.readAll();
  client.setAuthorization(stored.token);

  const catalog = createCatalogCacheService({ client, cache: storage.cache, nowSeconds: now });

  /**
   * AC-02-3 的端侧兜底：公开频道响应里若混进私密条目（服务端故障或响应被篡改），它既不进界面也不进缓存读取面。
   * 走【个人探索】时 `channel` 参数本身就是 private，那条链路按契约允许私密条目，因此不做剔除。
   */
  const homeApi: HomeApi = {
    channels: () => catalog.api.channels(),
    catalog: async (input) => {
      const page = await catalog.api.catalog(input);
      if (input.channel === 'private') return page;
      const items = page.items.filter((entry) => !isPrivateSubject(entry));
      return items.length === page.items.length ? page : { ...page, items };
    }
  };

  let privateChannel = false;
  let privatePlayback = false;
  const syncSecure = (): void => void bridge.setSecureScreen(privateChannel || privatePlayback);

  const report = createNotice(app);

  /** 私密内容永不进入历史域：这条分支是 M-8 第四域的落点，闸门在 `assertWritable` 里再兜一层。 */
  function progressSink(row: WatchHistoryRow, context: ProgressContext): void {
    if (isPrivateSubject(context)) {
      storage.privateVault.putBreakpoint(row);
      return;
    }
    const input: WatchProgressInput = {
      contentId: row.content_id, title: row.title, coverUrl: row.cover_url,
      lastEpisodeId: row.last_episode_id, lastEpisodeNumber: row.last_episode_number,
      positionSeconds: row.position_seconds, durationSeconds: row.duration_seconds,
      totalEpisodes: row.total_episodes, updatedAt: row.updated_at,
      isPrivate: context.isPrivate === true, channelId: context.channelId
    };
    void storage.history.upsertWatch(input).catch(() => report('断点未能写入本机历史：追剧进度需端侧 SQLite 就绪'));
  }

  const share = createShareAction({ bridge, report });

  const player = createPlayerHost({
    mount: app,
    bridge,
    api: client,
    onProgress: progressSink,
    allowBackgroundAudio: () => backgroundAudio,
    onShare: (item, episode) => void share(item, episode),
    onBlocked: (message) => report(message),
    onPrivacyChange: (isPrivate) => { privatePlayback = isPrivate; syncSecure(); },
    onClose: () => { privatePlayback = false; syncSecure(); }
  });

  let homeView: HomeView | null = null;

  async function historyAvailable(): Promise<boolean> {
    try {
      await storage.history.init();
      return true;
    } catch {
      return false;
    }
  }

  async function listHistory(): Promise<WatchHistoryRow[]> {
    return (await historyAvailable()) ? await storage.history.listRecent() : [];
  }

  function viewFor(tab: ShellTab, root: HTMLElement): ManagedView {
    if (tab === 'home') {
      const view = createHomeView({
        api: homeApi,
        root,
        posterMode: () => posterMode,
        onPosterModeChange: (mode) => { posterMode = mode; void writePosterMode(prefs, mode); },
        onOpenTitle: (contentId) => void player.open(contentId),
        onResume: (row) => void player.open(row.content_id, row),
        historyPreview: listHistory,
        onShare: (item) => void share(item),
        onChannelChange: (channel) => { privateChannel = channel?.id === 'private'; syncSecure(); }
      });
      homeView = view;
      return { mount: () => view.mount(), reload: () => view.refresh(), destroy: () => view.destroy() };
    }
    if (tab === 'history') {
      const view = createHistoryView({
        api: client,
        root,
        history: {
          available: historyAvailable,
          list: () => storage.history.listRecent(),
          clear: async () => void await storage.history.clearHistory()
        },
        cache: {
          measure: async () => {
            const used = storage.cache.bytesUsed();
            return { usedBytes: used.catalog + used.posters, limitBytes: CATALOG_CACHE_LIMIT_BYTES + POSTER_CACHE_LIMIT_BYTES };
          },
          clearPublicCache: async () => {
            const freed = await storage.cache.clearCache();
            return { clearedBytes: freed.freedBytes, domains: ['public-cache'] };
          }
        },
        credentials: identity.credentials,
        onOpenTitle: (contentId) => void player.open(contentId),
        onResume: (row) => void player.open(row.content_id, row),
        now
      });
      return { mount: () => view.mount(), reload: () => view.reload(), destroy: () => view.destroy() };
    }
    if (tab === 'search') {
      const view = createSearchView({
        api: client,
        root,
        onOpenTitle: (contentId) => void player.open(contentId),
        hotWords: storage.cache.list().slice(0, HOT_WORD_LIMIT).map((item) => item.title),
        onBrowse: () => void shell.activate('home')
      });
      return { mount: () => view.mount(), destroy: () => view.destroy() };
    }
    const view = createSettingsView({
      api: client,
      prefs,
      bridge,
      tokens: storage.privateVault.session,
      root,
      tierSource: identity.tierSource,
      deviceIdSource: identity.deviceIdSource,
      bridgeSourceOf: bridgeSource,
      now,
      onThemeChange: (mode) => applyTheme(mode),
      // 核销成功后凭证归位：视图自身不留 JWT 副本，写 Keystore 属凭证域。
      onOpenRedeem: (outcome: RedeemOutcome) => void handOffCredential(outcome),
      onPrivateSessionChange: (active) => {
        if (!active) {
          storage.privateVault.clear();
          privateChannel = false;
        }
        syncSecure();
        void homeView?.refresh();
      }
    });
    return { mount: () => view.mount(), reload: () => view.reload(), destroy: () => view.destroy() };
  }

  async function handOffCredential(outcome: RedeemOutcome): Promise<void> {
    try {
      await storage.credentials.write('token', outcome.token);
      client.setAuthorization(outcome.token);
      await grant.recordOnlineCheck(now());
      void homeView?.refresh();
    } catch (error) {
      report(error instanceof Error ? error.message : '授权凭证写入失败');
    }
  }

  const shell: AppShell = createAppShell({
    header,
    main,
    tabbar,
    viewFor,
    onTabChange: async () => {
      backgroundAudio = (await prefs.get(SETTINGS_PREF_KEYS.keepScreenOn)) === '1';
    }
  });

  // 快照优先（AC-01）：bootstrap 内部会先 hydrate 再后台同步；同步成功即刷新离线校验时点（AC-15）。
  const started = await catalog.bootstrap();
  if (started.outcome !== null && started.outcome.offline === false) await grant.recordOnlineCheck(now());
  catalog.onSynced(() => { if (homeView !== null) void homeView.refresh(); });
  const releaseNotifications = bindNotificationActions((action) => player.onNotification(action));

  await shell.activate('home');
  if (started.hadSnapshot === false && storage.cache.snapshotRevision() === 0) {
    report('离线或目录拉取失败：本机尚无公开快照，点播需联网。');
  }

  return {
    shell,
    openTitle: (contentId, resume) => player.open(contentId, resume),
    destroy() {
      releaseNotifications();
      shell.destroy();
      player.close();
      client.forgetPrivateSessionLocally();
      storage.privateVault.clear();
    }
  };
}

/** 自动启动只在真实页面里发生：单测直接调用 `boot()`，不依赖导入副作用。 */
if (typeof document !== 'undefined' && import.meta.env?.MODE !== 'test') {
  // 组合根失败必须可见：此时没有任何已装配的 UI 可承载提示，退回控制台。
  boot().catch((error: unknown) => console.error('光影Play 启动失败', error));
}
