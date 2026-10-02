/**
 * 组合根（SPEC §7 第一行）：平台能力装配、四大存储域接线、四个主视图的依赖注入与跨域决策。
 *
 * 三条纪律在本文件落地，而不是分散到视图里：
 * 1. **能力缺席就如实回报**——端侧 SQLite 不可用则【追剧】进入 disabled，未内置验签公钥则离线档位不显示，
 *    绝不返回空集合冒充"没有内容"（AC-15 / AC-18）；
 * 2. **进度落库的路由只写一次**——公开走历史域、个人探索走内存域，判定用 `isPrivateSubject` 唯一咽喉点；
 *    该路由与端云同步同源，已收进 `core/user-sync.ts`（AC-30），本文件只接线、不复制判定；
 * 3. **FLAG_SECURE 只有一个决策点**——私密频道与私密播放任一成立即挂载，两者皆false即解除（AC-02-4）。
 */
import type { WatchHistoryRow } from './core/storage';
import type { AppShell, ManagedView, ShellTab } from './app-shell';
import type { PosterMode } from './core/state/theme';
import type { PrismNativeBridge } from './core/native/bridge';
import type { FetchLike } from './core/api/client';
import type { UserSyncService } from './core/user-sync';
import type { RedeemOutcome } from './views/settings-view';
import { CATALOG_CACHE_LIMIT_BYTES, createStorageDomains, isPrivateSubject, MemoryCacheDisk, POSTER_CACHE_LIMIT_BYTES } from './core/storage';
import { PrismApiClient } from './core/api/client';
import { createCatalogCacheService } from './core/catalog-cache';
import { createUserSync } from './core/user-sync';
import { createGrantProbe, grantAdaptersFor } from './core/identity/offline-grant';
import { bindNotificationActions, installBridgeForPlatform } from './core/native/capacitor-bridge';
import { bridgeSource, getBridge } from './core/native/bridge';
import { createCacheDisk, createHistorySqlite, createPreferenceStore, isNativeHost } from './core/native/platform-adapters';
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
  /** 端云同步中枢（AC-30）：推荐引擎经 `sync.preferences()` 继承跨端画像，视图不另开第二条网络路径。 */
  sync: UserSyncService;
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

  const defaultApiBaseUrl = options.apiBaseUrl ?? (isNativeHost() ? 'https://play.prismos.org' : '');
  const client = new PrismApiClient({ baseUrl: defaultApiBaseUrl, fetchImpl: options.fetchImpl });
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
    },
    cachedSnapshot: () => ({
      channels: storage.cache.getChannels(),
      items: (channel: string) => storage.cache.list(channel).filter((entry) => !isPrivateSubject(entry))
    })
  };

  let privateChannel = false;
  let privatePlayback = false;
  let lastSecure: boolean | null = null;
  const syncSecure = (): void => {
    const next = privateChannel || privatePlayback;
    if (next !== lastSecure) {
      lastSecure = next;
      void bridge.setSecureScreen(next);
    }
  };

  const report = createNotice(app);

  /**
   * 端云状态同步中枢（SPEC §1.9 / AC-30）：构造即补发待发队列（§3.1 要求补传先于任何拉取），并交出
   * "断点落库路由"这唯一咽喉点——私密内容永不进历史域、也永不进待发队列（§1.9.4）。分类与私密出处
   * 都取自公开快照：本文件不另判私密，视图也不自建第二条网络路径。
   */
  const sync = createUserSync({
    token: stored.token, history: storage.history, privateVault: storage.privateVault, prefs,
    baseUrl: defaultApiBaseUrl, fetchImpl: options.fetchImpl, nowSeconds: now, onNotice: report,
    categoryOf: (contentId) => storage.cache.getItem(contentId)?.category ?? null,
    provenanceOf: (contentId) => ({ contentId, isPrivate: storage.cache.getItem(contentId)?.isPrivate, channelId: storage.cache.getItem(contentId)?.channelId })
  });

  const share = createShareAction({ bridge, report });

  const player = createPlayerHost({
    mount: app, bridge, api: client,
    onProgress: sync.onProgress,
    // §1.9.3 节点 ①：退出播放/关闭播放器/系统 Back 销毁的那一刻就地断点上报（`keepalive` + 待发队列）。
    onExit: (breakpoint) => void sync.reportExit(breakpoint),
    allowBackgroundAudio: () => backgroundAudio, onShare: (item, episode) => void share(item, episode),
    onBlocked: (message) => report(message),
    onPrivacyChange: (isPrivate) => { privatePlayback = isPrivate; syncSecure(); },
    onClose: () => { privatePlayback = false; syncSecure(); }
  });

  let homeView: HomeView | null = null;

  /** 端侧 SQLite 未就绪时如实返回 false：【追剧】整视图据此进入 disabled，而不是渲染空历史冒充"你没看过"。 */
  async function historyAvailable(): Promise<boolean> {
    try { await storage.history.init(); return true; } catch { return false; }
  }

  async function listHistory(): Promise<WatchHistoryRow[]> {
    return (await historyAvailable()) ? await storage.history.listRecent() : [];
  }

  function viewFor(tab: ShellTab, root: HTMLElement): ManagedView {
    if (tab === 'home') {
      const view = createHomeView({
        api: homeApi,
        root,
        headerAccessory: shell.headerAccessory(),
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
        // §1.9.4 接口 B 的端侧触发点：进入【追剧】即静默拉取并按 `updatedAt` 取较新者合并。
        pullRemote: () => sync.pull(),
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
      apiBaseUrl: defaultApiBaseUrl,
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
      // 凭证换发即同步中枢的身份换轨：更新 JWT 并按 §1.9.4 的"核销成功"触发点静默拉取一次云端断点。
      client.setAuthorization(outcome.token); sync.setToken(outcome.token); void sync.pull();
      await grant.recordOnlineCheck(now());
      void homeView?.refresh();
    } catch (error) {
      report(error instanceof Error ? error.message : '授权凭证写入失败');
    }
  }
  const shell: AppShell = createAppShell({
    header, main, tabbar, viewFor,
    onTabChange: async () => { backgroundAudio = (await prefs.get(SETTINGS_PREF_KEYS.keepScreenOn)) === '1'; }
  });

  // 快照优先（AC-01）：bootstrap 内部会先 hydrate 再后台同步；同步成功即刷新离线校验时点（AC-15）。
  const started = await catalog.bootstrap();
  if (started.outcome !== null && started.outcome.offline === false) await grant.recordOnlineCheck(now());
  catalog.onSynced(() => { if (homeView !== null) void homeView.refresh(); });
  const releaseNotifications = bindNotificationActions((action) => player.onNotification(action));
  // §1.9.3 节点 ②：切到后台（`isActive === false`）即静默上报当前断点。监听口与 `back-button.ts` 同款
  // 守卫——非原生宿主根本不注册，Web 构建退化为 no-op，绝不因为缺 `@capacitor/app` 而抛错。
  const releaseAppState = await sync.observeBackground(() => void sync.reportExit(sync.lastBreakpoint()));
  await shell.activate('home');
  if (started.hadSnapshot === false && storage.cache.snapshotRevision() === 0) {
    report('离线或目录拉取失败：本机尚无公开快照，点播需联网。');
  }

  return {
    shell, sync,
    openTitle: (contentId, resume) => player.open(contentId, resume),
    destroy() {
      releaseNotifications();
      releaseAppState();
      // 节点 ① 的上报必须排在同步中枢解散之前，否则"完全退出"这一次永远发不出去。
      player.close();
      sync.dispose();
      shell.destroy();
      client.forgetPrivateSessionLocally();
      storage.privateVault.clear();
    }
  };
}

/** 自动启动只在真实页面里发生：单测直接调用 `boot()`，不依赖导入副作用。 */
if (typeof document !== 'undefined' && import.meta.env?.MODE !== 'test') {
  boot().catch((error: unknown) => {
    console.error('光影Play 启动失败', error);
    const appEl = document.getElementById('app');
    if (appEl) {
      const errMsg = error instanceof Error ? error.stack || error.message : String(error);
      appEl.innerHTML = `<div style="padding:48px 24px;color:var(--fg);text-align:center;"><h2 style="color:var(--accent);font-size:20px;">光影Play 初始化未完成</h2><pre style="text-align:left;background:rgba(255,255,255,0.06);padding:14px;border-radius:8px;font-size:12px;color:var(--accent);">${errMsg}</pre><button onclick="window.location.reload()" style="background:var(--accent);color:var(--accent-on);border:none;padding:12px 24px;border-radius:8px;cursor:pointer;">重新加载</button></div>`;
    }
  });
}
