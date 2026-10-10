/** 组合根：能力缺席如实回报；断点路由统一由 user-sync 决策；FLAG_SECURE 合并频道与播放状态。 */
import type { WatchHistoryRow } from './core/storage';
import type { AppShell, ManagedView, ShellTab } from './app-shell';
import type { PosterMode } from './core/state/theme';
import type { PrismNativeBridge } from './core/native/bridge';
import type { FetchLike } from './core/api/client';
import type { UserSyncService } from './core/user-sync';
import type { RedeemOutcome } from './views/settings-view';
import { CATALOG_CACHE_LIMIT_BYTES, createLocalSearchApi, createSearchIndex, createStorageDomains, isPrivateSubject, MemoryCacheDisk, POSTER_CACHE_LIMIT_BYTES } from './core/storage';
import { PrismApiClient } from './core/api/client';
import { createCatalogCacheService } from './core/catalog-cache';
import { createDiscoveryIndexPatcher, createDiscoverySync } from './core/discovery-sync';
import { deferDiscoverySync } from './core/discovery-start';
import { createPosterUrls } from './core/poster-urls';
import { createUserSync } from './core/user-sync';
import { createGrantProbe, grantAdaptersFor } from './core/identity/offline-grant';
import { bindNotificationActions, installBridgeForPlatform } from './core/native/capacitor-bridge';
import { bridgeSource, getBridge } from './core/native/bridge';
import { createCacheDisk, createHistorySqlite, createPreferenceStore, isNativeHost } from './core/native/platform-adapters';
import { applyTheme, readPosterMode, readThemePreference, writePosterMode } from './core/state/theme';
import { createAppShell } from './app-shell';
import { createNotice } from './components/notice';
import { createPlayerHost } from './player-host';
import type { OpenCandidate } from './player-host';
import type { ContentItem } from '../edge/src/types/api';
import { publicOpenCandidate } from './player/open-candidate';
import { createFollowingStore } from './core/storage/following-store';
import { createRuntimeServices } from './core/runtime-services';
import { createShareAction } from './core/share';
import { createHomeView, type HomeApi, type HomeView } from './views/home-view';
import { createHistoryView } from './views/history-view';
import { createSearchOverlay } from './views/search-overlay';
import { createSettingsView, SETTINGS_PREF_KEYS } from './views/settings-view';
import { scheduleBulletinsCheck } from './views/client-bulletins';
import { createSeriesDiscovery } from './core/series-discovery';

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
  const app = document.getElementById('app'), header = document.getElementById('app-header');
  const main = document.getElementById('app-main'), tabbar = document.getElementById('app-tabbar');
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
  const sqlite = await createHistorySqlite();
  const following = createFollowingStore({ sqlite, nowSeconds: now });
  const searchIndex = createSearchIndex({ sqlite, nowSeconds: now });
  const storage = createStorageDomains({ sqlite, disk: (await createCacheDisk()) ?? new MemoryCacheDisk(), nowSeconds: now });
  // 冷启动即焚：上一次进程的私密痕迹不该存在于本进程（AC-02-2 每次进入默认关闭）。
  storage.privateVault.clear();
  const defaultApiBaseUrl = options.apiBaseUrl ?? (isNativeHost() ? 'https://play.prismos.org' : '');
  const posters = createPosterUrls(defaultApiBaseUrl);
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

  // §A-6.2 数据流：快照/增量批次落地即喂端侧 FTS5 索引；索引自己吞异常并记进 status()，不改落盘结论。
  const catalog = createCatalogCacheService({ client, baseUrl: defaultApiBaseUrl, cache: storage.cache, nowSeconds: now,
    onSnapshotEntries: (feed) => void searchIndex.sync(feed.changes === undefined ? { ...feed, items: storage.cache.list() } : feed)
  });
  const backgroundAbort = new AbortController();
  const discoverySync = createDiscoverySync({ cache: storage.cache, client,
    busy: () => player.isOpen(), signal: backgroundAbort.signal, onEntries: createDiscoveryIndexPatcher(storage.cache, searchIndex)
  });

  const homeApi: HomeApi = {
    channels: () => catalog.api.channels(),
    catalog: async (input) => {
      const page = await catalog.api.catalog(input);
      const items = input.channel === 'private' ? page.items : page.items.filter((entry) => !isPrivateSubject(entry));
      return { ...page, items: posters.items(items) };
    },
    cachedSnapshot: () => ({
      // `state` 是候选覆盖度与修订的唯一事实来源：综合首页据此如实记 full/partial，不夸口成全库（HP-05）。
      channels: storage.cache.getChannels(), state: () => catalog.snapshotState(),
      items: (channel: string) => posters.items(storage.cache.list(channel).filter((entry) => !isPrivateSubject(entry)))
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

  /** 双击退出 Toast 的停留时长（A-1 定案 6.5s）：比系统提示长一点，用户才来得及读完"再按一次"。 */
  const report = createNotice(app, 6_500);
  const sync = createUserSync({
    token: stored.token, history: storage.history, privateVault: storage.privateVault, prefs,
    baseUrl: defaultApiBaseUrl, fetchImpl: options.fetchImpl, nowSeconds: now, onNotice: report,
    categoryOf: (contentId) => storage.cache.getItem(contentId)?.category ?? null,
    provenanceOf: (contentId) => ({ contentId, isPrivate: storage.cache.getItem(contentId)?.isPrivate, channelId: storage.cache.getItem(contentId)?.channelId })
  });

  const share = createShareAction({ bridge, report });
  const runtime = await createRuntimeServices({ prefs, grant, monetization: () => client.monetization(), report });
  const ingestDiscoveries = async (items: Parameters<typeof storage.cache.mergeDiscoveries>[0]) => {
    const discoveries = await storage.cache.mergeDiscoveries(items);
    await searchIndex.sync({ items: [], discoveries, revision: storage.cache.snapshotRevision() });
    return discoveries;
  };
  const seriesDiscovery = createSeriesDiscovery({
    search: (input) => client.search(input),
    onDiscovered: async (items) => { await ingestDiscoveries(items); }
  });
  const player = createPlayerHost({
    mount: app, bridge, api: client, following, runtime, seriesItems: () => storage.cache.list().filter((entry) => !isPrivateSubject(entry)),
    supplementSeries: (target, onUpdated) => {
      void seriesDiscovery.discover(target).then((items) => { if (items.length > 0) onUpdated(); });
    },
    onRedeem: () => void shell.activate('settings'),
    onProgress: sync.onProgress,
    // §1.9.3 节点 ①：退出播放/关闭播放器/系统 Back 销毁的那一刻就地断点上报（`keepalive` + 待发队列）。
    onExit: (breakpoint) => void sync.reportExit(breakpoint),
    allowBackgroundAudio: () => backgroundAudio, onShare: (item, episode) => void share(item, episode),
    onBlocked: (message) => report(message),
    onPrivacyChange: (isPrivate) => { privatePlayback = isPrivate; syncSecure(); },
    onClose: () => { privatePlayback = false; syncSecure(); }
  });

  let homeView: HomeView | null = null;
  const publicLocalItems = () => posters.items(storage.cache.list().filter((entry) => !isPrivateSubject(entry)));
  /** 点击对象优先于目录查询：已渲染在线卡片不必等完整快照落盘；私密仍不预填。 */
  const candidateFor = (contentId: string, clicked?: ContentItem): OpenCandidate | undefined => {
    const item = clicked?.id === contentId ? clicked : storage.cache.getItem(contentId);
    const candidate = publicOpenCandidate(item);
    return candidate ? { ...candidate, coverUrl: posters.resolve(candidate.coverUrl) ?? undefined } : undefined;
  };
  const candidateFromResume = (row: WatchHistoryRow): OpenCandidate => ({
    title: row.title, coverUrl: posters.resolve(row.cover_url) ?? undefined
  });
  const searchApi = createLocalSearchApi({ index: searchIndex, localItems: publicLocalItems, remote: client, onOnlineItems: async (items) => {
    await ingestDiscoveries(items);
    void discoverySync.sync(); // Search's successful online supplement can resume the independent log.
  } });
  const overlay = createSearchOverlay({
    appRoot: app, api: searchApi,
    localItems: publicLocalItems,
    hotWords: () => publicLocalItems().slice(0, HOT_WORD_LIMIT).map((entry) => entry.title),
    onOpenTitle: (contentId, item) => void player.open(contentId, undefined, { candidate: candidateFor(contentId, item) }),
    onBrowse: () => void shell.activate('home')
  });

  /** 端侧 SQLite 未就绪时如实返回 false：【追剧】整视图据此进入 disabled，而不是渲染空历史冒充"你没看过"。 */
  async function historyAvailable(): Promise<boolean> {
    try { await storage.history.init(); return true; } catch { return false; }
  }
  const listHistory = async (): Promise<WatchHistoryRow[]> => (await historyAvailable()) ? await storage.history.listRecent() : [];

  function viewFor(tab: ShellTab, root: HTMLElement): ManagedView {
    if (tab === 'home') {
      const view = createHomeView({
        api: homeApi, nowSeconds: now,
        syncCatalog: async () => { const result = await catalog.syncIncremental(); if (result.reason) throw new Error(result.reason); },
        root, headerAccessory: shell.headerAccessory(), posterMode: () => posterMode,
        onPosterModeChange: (mode) => { posterMode = mode; void writePosterMode(prefs, mode); },
        onOpenTitle: (contentId, item) => void player.open(contentId, undefined, { candidate: candidateFor(contentId, item) }),
        onResume: (row) => void player.open(row.content_id, row, { candidate: candidateFromResume(row) }),
        historyPreview: listHistory, onSearch: () => overlay.open(),
        onChannelChange: (channel) => { privateChannel = channel?.id === 'private'; syncSecure(); }
      });
      homeView = view;
      return { mount: () => view.mount(), reload: () => view.refresh(), destroy: () => view.destroy() };
    }
    if (tab === 'history') {
      const view = createHistoryView({
        api: client, root, following,
        history: { available: historyAvailable, list: () => storage.history.listRecent(), clear: async () => void await storage.history.clearHistory() },
        credentials: identity.credentials, onOpenTitle: (contentId, item) => void player.open(contentId, undefined, { candidate: candidateFor(contentId, item) }),
        onResume: (row) => void player.open(row.content_id, row, { candidate: candidateFromResume(row) }), pullRemote: () => sync.pull(), now
      });
      return { mount: () => view.mount(), reload: () => view.reload(), destroy: () => view.destroy() };
    }
    const view = createSettingsView({
      api: client, apiBaseUrl: defaultApiBaseUrl,
      runtimeVersions: { app: async () => (await import('@capacitor/app')).App.getInfo(), cloud: () => client.version() },
      catalogStatus: () => catalog.snapshotState(), checkCatalogUpdate: () => catalog.syncIncremental(),
      prefs, bridge,
      supportAssets: { contact: { url: './images/author-contact.jpg' }, reward: { url: './images/author-reward.jpg' } },
      cache: {
        measure: async () => {
          const used = storage.cache.bytesUsed();
          return { usedBytes: used.catalog + used.posters, limitBytes: CATALOG_CACHE_LIMIT_BYTES + POSTER_CACHE_LIMIT_BYTES };
        },
        clearPublicCache: async () => {
          const freed = await storage.cache.clearCache(); await searchIndex.clear();
          return { clearedBytes: freed.freedBytes, domains: ['public-cache'] };
        }
      },
      tokens: storage.privateVault.session, root,
      tierSource: identity.tierSource, deviceIdSource: identity.deviceIdSource,
      bridgeSourceOf: bridgeSource, now,
      onThemeChange: (mode) => applyTheme(mode),
      onOpenRedeem: (outcome: RedeemOutcome) => void handOffCredential(outcome),
      onPrivateSessionChange: (active) => {
        if (!active) { storage.privateVault.clear(); privateChannel = false; }
        syncSecure(); void homeView?.refresh();
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
    // A-1 双击退出提示复用全局唯一那条轻提示；退行动交回总线（原生宿主才真退，Web 宿主如实 no-op）。
    notice: report,
    onTabChange: async () => { backgroundAudio = (await prefs.get(SETTINGS_PREF_KEYS.keepScreenOn)) === '1'; }
  });

  const started = await catalog.bootstrap();
  const cancelDiscoveryStart = deferDiscoverySync(() => discoverySync.sync(), () => player.isOpen());
  if (started.outcome !== null && started.outcome.offline === false) await grant.recordOnlineCheck(now());
  catalog.onSynced((outcome) => { if (homeView !== null && outcome.appliedEntries > 0) void homeView.syncRecommendation(); }); // HP-06b：后台推进只走背景同步入口，新的发现轮次只由用户显式刷新开启
  const releaseNotifications = bindNotificationActions((action) => player.onNotification(action));
  const releaseAppState = await sync.observeBackground(() => { player.suspend(); void sync.reportExit(sync.lastBreakpoint()); });
  await shell.activate('home');
  const releaseBulletins = scheduleBulletinsCheck({ api: client, prefs, root: app, bridge, isPlayerOpen: () => player.isOpen(), nowSeconds: now });
  if (started.hadSnapshot === false && storage.cache.snapshotRevision() === 0) {
    report('离线或目录拉取失败：本机尚无公开快照，点播需联网。');
  }

  return {
    shell, sync,
    openTitle: (contentId, resume) => player.open(contentId, resume, { candidate: candidateFor(contentId) }),
    destroy() {
      backgroundAbort.abort(); releaseBulletins(); cancelDiscoveryStart(); releaseNotifications(); releaseAppState();
      // Overlay 排在播放器之前拆：它的 Layer handler 必须先于播放器离场摘掉，返回栈才不会串层。
      overlay.destroy();
      // 节点 ① 的上报必须排在同步中枢解散之前，否则"完全退出"这一次永远发不出去。
      player.close();
      void runtime.destroy();
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
