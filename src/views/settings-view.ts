/**
 * 独立设置中心（SPEC §7 / AC-02 全六条 / AC-05 / AC-10 / AC-11 / AC-14 / AC-15 / M-2 / M-3 / A-3）。
 *
 * 分区：外观（日夜双模）→ 播放与后台 → 卡密核销 → 版本检测（OTA）→ 个人探索（条件显现）。
 * 【个人探索】是合规生死面，逐条对齐 AC-02：① 只有本机档位命中 `monetization().privateAccessTiers` 才渲染
 * 开关，该集合只取公开商业化端点（A-3），绝不从 `/api/channels` 推断、绝不写死档位数组——`SettingsApi` 里
 * 根本没有 `channels()`，越界在类型层就编译不过；② 视图构造即渲染为「关」并清掉 holder 里的遗留 token
 * （冷启动默认关闭，界面绝不从存量状态自动点亮）；③ 点击先弹阻断式免责对话框（可拒绝、可关闭），确认后才
 * 申请当次会话；④ 进入挂载 FLAG_SECURE，关闭与 `destroy()` 一律解除；⑤ 对话框如实写明「服务端只能证明收到
 * 显式开启请求」的已知局限；⑥ 本视图无任何分享 / 导出入口。DOM 与五态基元复用 `history-view` 的共享节。
 */
import type { CouponTier, DeviceTier, ErrorCode, MonetizationConfig, RedeemRequest, RedeemSuccessResponse, VersionResponse } from '../../edge/src/types/api';
import { PERMANENT_EXPIRES_AT } from '../../edge/src/types/api';
import type { BridgeSource, PrismNativeBridge } from '../core/native/bridge';
import { bridgeSource } from '../core/native/bridge';
import { ApiError } from '../core/api/client';
import { applyTheme, readThemePreference, writeThemePreference, type PreferenceStore, type ThemeMode } from '../core/state/theme';
import { attempt, band, button, errorCopy, glyphInto, make, readyBand, rowLine, stateBand, type Band, type ViewState } from './history-view';
import { createDiagnosticsBand } from './diagnostics-band';
import './views.css';

/** 注入的短时凭据持有者：必须与 `PrismApiClient.bindSessionHolder` 绑的是同一个 RAM holder。 */
export interface VolatileTokens { read(): string | null; write(token: string | null): void; }
/** 本机当前档位来源（由安全凭证域离线验签得到）；不注入 = 无法证明资格 = 开关不出现。 */
export interface TierReader { currentTier(): Promise<DeviceTier | null>; }
/** 设备标识来源；不注入 = 核销分区进入 disabled，绝不伪造 deviceId。 */
export interface DeviceIdReader { currentDeviceId(): Promise<string | null>; }
/** 故意不含 `channels()`：个人探索资格只能来自公开商业化配置（A-3 裁决）。 */
export interface SettingsApi {
  monetization(): Promise<MonetizationConfig>;
  version(): Promise<VersionResponse>;
  redeem(body: RedeemRequest): Promise<RedeemSuccessResponse>;
  openPrivateSession(): Promise<number>;
  closePrivateSession(): Promise<void>;
}
export interface RedeemOutcome { tier: CouponTier; tierName: string; expiresAt: number; token: string; }
export interface SettingsViewDeps {
  api: SettingsApi; prefs: PreferenceStore; bridge: PrismNativeBridge; tokens: VolatileTokens; root: HTMLElement;
  onThemeChange?: (mode: ThemeMode) => void;
  /** 核销成功后把契约结果交给宿主：写 Keystore 属凭证域工作包，本视图不留 JWT 副本。 */
  onOpenRedeem?: (outcome: RedeemOutcome) => void;
  /** 开关翻转后通知宿主重绘频道拓扑（【个人探索】节点显现 / 消失）。 */
  onPrivateSessionChange?: (active: boolean) => void;
  tierSource?: TierReader;
  deviceIdSource?: DeviceIdReader;
  apiBaseUrl?: string;
  /** 可注入便于测试；默认 `bridgeSource()`，避免把 Web 宿主说成原生能力已生效。 */
  bridgeSourceOf?: () => BridgeSource;
  now?(): number;
}
export interface SettingsView { mount(): Promise<void>; reload(): Promise<void>; destroy(): void; }

export const SETTINGS_PREF_KEYS = { keepScreenOn: 'prism.keepScreenOn', callAutoPause: 'prism.callAutoPause' } as const;
const PLATFORM: RedeemRequest['platform'] = 'android';
const NETWORK_COPY = '网络不可用：版本检测与卡密核销都需联网，离线期只可验证已存授权。';
const NO_DEVICE_ID_COPY = '本机暂无可用设备标识（需安全凭证域初始化完成），未提交任何核销请求。';
/** 闭集错误码逐条自有文案（导出以便测试证明「每条各有文案且互不重复」）；一律不回显服务端 message，
 *  卡密设备计数因此没有第二条通路能被带到界面上。 */
export const ERROR_COPY: Readonly<Record<ErrorCode | 'NETWORK_ERROR' | 'UNEXPECTED_RESPONSE', string>> = {
  COUPON_NOT_FOUND: '卡密不存在，请核对后重试。', COUPON_REVOKED: '该卡密已被作废，无法核销。',
  COUPON_DEVICE_LIMIT_EXCEEDED: '该卡密可绑定的设备数已达上限，请在已绑定设备上观看或联系发卡方。',
  COUPON_INVALID_FORMAT: '卡密格式不正确，应按 GY- 开头分段填写。', DEVICE_ID_INVALID: '本机设备标识不合法，请重新安装或稍后重试。',
  RATE_LIMITED: '核销尝试过于频繁，请稍后再试。', PRIVATE_SESSION_REQUIRED: '当次私密探索授权未被确认，请重新勾选并确认免责声明。',
  TIER_INSUFFICIENT: '当前档位不在云端开放的准入档位内，无法开启个人探索。', NOT_FOUND: '请求的内容不存在或已下架。',
  SERVICE_UNAVAILABLE: '服务端暂时不可用，请稍后重试。', PLATFORM_UNSUPPORTED: '本期仅支持 Android 端核销。',
  CREDENTIAL_EXPIRED: '授权已过期，请重新核销卡密。', VALIDATION_ERROR: '提交内容未通过校验，请检查卡密格式。',
  PROXY_SIGNATURE_INVALID: '取流地址已过期或被篡改，请重新选集后再试。', CATALOG_REVISION_CONFLICT: '公开目录刚刚发生变化，请重新拉取后再试。',
  CATALOG_CURSOR_EXPIRED: '本机目录游标已过期，将改拉完整快照。', NETWORK_ERROR: NETWORK_COPY, UNEXPECTED_RESPONSE: '服务端返回了无法识别的响应，请稍后重试。'
};
function copyFor(error: unknown): string {
  return error instanceof ApiError ? ERROR_COPY[error.code] : errorCopy(error, NETWORK_COPY);
}
export function formatExpiry(expiresAt: number, nowSeconds: number): string {
  if (expiresAt === PERMANENT_EXPIRES_AT) return '永久有效';
  if (expiresAt <= nowSeconds) return '已到期，需重新核销';
  return `${new Date(expiresAt * 1000).toLocaleDateString('zh-CN')} 到期（剩余 ${Math.ceil((expiresAt - nowSeconds) / 86400)} 天）`;
}
function switchControl(dataEl: string, label: string, onChange: (next: boolean) => void): HTMLButtonElement {
  const node = make('button', 'pv-switch');
  node.type = 'button';
  node.dataset.el = dataEl;
  node.setAttribute('role', 'switch');
  node.setAttribute('aria-checked', 'false');
  node.setAttribute('aria-label', label);
  node.addEventListener('click', () => onChange(node.getAttribute('aria-checked') !== 'true'));
  return node;
}
function setSwitch(node: HTMLElement, checked: boolean): void { node.setAttribute('aria-checked', String(checked)); }

export function createSettingsView(deps: SettingsViewDeps): SettingsView {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const nativeOnly = deps.bridgeSourceOf ?? bridgeSource;
  let disposed = false;
  let dialog: HTMLElement | null = null;
  const onDialogKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') closeDialog(); };
  function closeDialog(): void { if (dialog === null) return; document.removeEventListener('keydown', onDialogKey); dialog.remove(); dialog = null; }
  const appearance = band('外观', 'set-appearance');
  const playback = band('播放与后台', 'set-playback');
  const redeem = band('卡密核销', 'set-redeem', '仅 Android 端提交');
  const ota = band('版本检测', 'set-ota');
  const privateBand = band('个人探索', 'set-private');
  const themeSwitch = switchControl('theme-toggle', '日夜双模主题', (next) => void applyThemeMode(next ? 'light' : 'dark'));
  const keepScreenSwitch = switchControl('keep-screen-on', '后台 / 息屏播放', (next) => void toggleKeepScreenOn(next));
  const callPauseSwitch = switchControl('call-auto-pause', '来电自动暂停', (next) => void toggleCallPause(next));
  const privateSwitch = switchControl('private-switch', '个人探索', (next) => flipPrivateSession(next));
  const codeInput = make('input', 'pv-input');
  codeInput.type = 'text'; codeInput.dataset.el = 'redeem-code'; codeInput.placeholder = '输入卡密'; codeInput.setAttribute('aria-label', '卡密');
  const hostHonesty = (): string => (nativeOnly() === 'web-fallback' ? '当前为 Web 宿主，此项须 Android 真机才会真实生效。' : '已交由 Android 原生能力处理，效果仍需真机复核。');
  const themeRow = rowLine('row-theme', '日夜双模主题', '黑曜石夜空 / 象牙纯白即时切换，偏好只写入可备份的偏好域。', [themeSwitch]);
  const keepRow = rowLine('row-keep-screen', '后台 / 息屏播放', `锁屏或切回桌面时是否保持音频，${hostHonesty()}`, [keepScreenSwitch]);
  const pauseRow = rowLine('row-call-pause', '来电自动暂停', '响铃即暂停并记录断点；恢复播放须满足前置条件，否则保持暂停。', [callPauseSwitch]);
  const redeemRow = rowLine('row-redeem', '卡密核销', '核销成功后由宿主写入安全凭证域，本视图不留 JWT 副本。', [codeInput, button('核销', () => void submitRedeem(), { icon: 'check', cls: 'pv-btn-primary', el: 'redeem-submit' })]);
  const privateRow = rowLine('row-private', '个人探索（当次手动开启）', '冷启动默认关闭；开启态只存内存，不写历史、不可分享。', [privateSwitch]);
  ota.head.append(button('检查更新', () => void checkVersion(), { icon: 'refresh', cls: 'pv-btn-ghost', el: 'ota-check' }));
  const diagController = createDiagnosticsBand({
    apiBaseUrl: deps.apiBaseUrl ?? '',
    nativeSource: nativeOnly,
    paintRows
  });
  deps.root.classList.add('pv-view', 'set-view');
  deps.root.append(make('h2', 'pv-head-title', '系统设置中枢'), appearance.wrap, playback.wrap, redeem.wrap, ota.wrap, diagController.wrap);
  // AC-02-2：构造即「关」，并丢弃任何遗留的当次凭据，绝不允许「界面已关但凭据仍在飞」。
  deps.tokens.write(null);

  /** 带内既有常驻控件又有状态文案：状态写在外层 wrap 的 data-state 上，控件行不会被抹掉。 */
  function paintRows(target: Band, state: ViewState, text: string, rows: Node[]): void {
    const note = make('p', `pv-state pv-state-${state}`, text);
    note.dataset.state = state;
    target.wrap.dataset.state = state;
    target.body.replaceChildren(...rows, note);
  }
  async function applyThemeMode(mode: ThemeMode): Promise<void> {
    applyTheme(mode);
    setSwitch(themeSwitch, mode === 'light');
    try {
      await writeThemePreference(deps.prefs, mode);
      deps.onThemeChange?.(mode);
      paintRows(appearance, 'ready', `已切换至${mode === 'light' ? '象牙纯白' : '黑曜石夜空'}，偏好已写入。`, [themeRow]);
    } catch (error) {
      paintRows(appearance, 'error', `主题已即时生效，但偏好写入失败：${error instanceof Error ? error.message : '未知原因'}。`, [themeRow]);
    }
  }
  async function toggleKeepScreenOn(next: boolean): Promise<void> {
    if (disposed) return;
    setSwitch(keepScreenSwitch, next);
    await attempt(() => deps.bridge.setKeepScreenOn(next));
    await attempt(() => deps.prefs.set(SETTINGS_PREF_KEYS.keepScreenOn, next ? '1' : '0'));
    paintRows(playback, 'ready', `${next ? '已允许' : '已禁止'}后台 / 息屏播放。${hostHonesty()}`, [keepRow, pauseRow]);
  }
  async function toggleCallPause(next: boolean): Promise<void> {
    if (disposed) return;
    setSwitch(callPauseSwitch, next);
    await attempt(() => deps.prefs.set(SETTINGS_PREF_KEYS.callAutoPause, next ? '1' : '0'));
    paintRows(playback, 'ready', `来电自动暂停已${next ? '开启' : '关闭'}：恢复播放须同时满足「通话前在播放、期间未被手动暂停、音频焦点已恢复」，否则保持暂停。`, [keepRow, pauseRow]);
  }
  function flipPrivateSession(next: boolean): void {
    if (next) openDisclaimer();
    else void disablePrivateSession();
  }
  async function enablePrivateSession(): Promise<void> {
    if (disposed) return;
    paintRows(privateBand, 'loading', '正在申请当次私密探索授权…', [privateRow]);
    const result = await attempt(() => deps.api.openPrivateSession());
    if (!result.ok) {
      setSwitch(privateSwitch, false);
      return paintRows(privateBand, 'error', `${copyFor(result.error)}本次未开启个人探索。`, [privateRow]);
    }
    setSwitch(privateSwitch, true);
    const secured = await attempt(() => deps.bridge.setSecureScreen(true));
    paintRows(privateBand, 'ready', `已开启，短时凭据仅存内存（约 ${Math.max(1, Math.round(result.value / 60))} 分钟后需重新确认）。${secured.ok && secured.value === true ? '已请求挂载 FLAG_SECURE' : 'FLAG_SECURE 未能挂载'}：${hostHonesty()}`, [privateRow]);
    deps.onPrivateSessionChange?.(true);
  }
  async function disablePrivateSession(): Promise<void> {
    const result = await attempt(() => deps.api.closePrivateSession());
    deps.tokens.write(null);
    setSwitch(privateSwitch, false);
    await attempt(() => deps.bridge.setSecureScreen(false));
    paintRows(privateBand, 'ready', result.ok
      ? '已关闭：内存凭据即刻销毁、服务端同步作废，本机从未写入该频道任何数据。'
      : '关闭请求未送达服务端，但本机凭据已立即清除；服务端凭短时有效期自动作废。', [privateRow]);
    deps.onPrivateSessionChange?.(false);
  }
  function openDisclaimer(): void {
    if (dialog !== null) return;
    const overlay = make('div', 'pv-overlay');
    const card = make('div', 'pv-dialog');
    const title = make('h3', 'pv-dialog-title', '个人探索适龄与免责声明');
    title.id = 'private-disclaimer-title';
    glyphInto(title, 'alert', 20);
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', title.id);
    card.dataset.el = 'private-disclaimer';
    const actions = make('div', 'pv-dialog-actions');
    actions.append(
      button('拒绝并放弃', () => { closeDialog(); paintRows(privateBand, 'ready', '未开启个人探索：拒绝免责声明后开关保持关闭。', [privateRow]); }, { cls: 'pv-btn-ghost', el: 'disclaimer-decline' }),
      button('我已满 18 岁，确认开启', () => { closeDialog(); void enablePrivateSession(); }, { icon: 'check', cls: 'pv-btn-primary', el: 'disclaimer-accept' })
    );
    card.append(
      title,
      make('p', 'pv-dialog-body', '本频道可能包含成人内容，仅面向已满 18 岁的成年人，观看后果与责任由使用者本人承担。开启后内容只驻留内存：不写历史、不写断点、不可分享；冷启动或完全退出即自动关闭。'),
      make('p', 'pv-dialog-body', '诚实边界：服务端只能证明收到过一次显式的开启请求，无法验证设备上是否由本人完成点击；Android 防截屏也无法防御外部摄像头拍摄，因此不宣称绝对不可绕过。'),
      actions
    );
    overlay.append(card);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) closeDialog(); });
    document.addEventListener('keydown', onDialogKey);
    dialog = overlay;
    deps.root.append(overlay);
  }
  async function readDeviceId(): Promise<string | null> {
    if (deps.deviceIdSource === undefined) return null;
    const result = await attempt(() => deps.deviceIdSource?.currentDeviceId() ?? Promise.resolve(null));
    return result.ok && typeof result.value === 'string' && result.value !== '' ? result.value : null;
  }
  async function submitRedeem(): Promise<void> {
    if (disposed) return;
    const code = codeInput.value.trim();
    if (code === '') return paintRows(redeem, 'disabled', '请先输入卡密。', [redeemRow]);
    const deviceId = await readDeviceId();
    if (deviceId === null) return paintRows(redeem, 'disabled', NO_DEVICE_ID_COPY, [redeemRow]);
    paintRows(redeem, 'loading', '正在核销…', [redeemRow]);
    const result = await attempt(() => deps.api.redeem({ code, deviceId, platform: PLATFORM }));
    if (!result.ok) return paintRows(redeem, 'error', copyFor(result.error), [redeemRow]);
    const granted = result.value;
    deps.onOpenRedeem?.({ tier: granted.tier, tierName: granted.tierName, expiresAt: granted.expiresAt, token: granted.token });
    codeInput.value = '';
    paintRows(redeem, 'ready', `核销成功：档位 ${granted.tierName} · ${formatExpiry(granted.expiresAt, now())}；凭证由安全凭证域接管。`, [redeemRow]);
  }
  async function checkVersion(): Promise<void> {
    if (disposed) return;
    stateBand(ota, 'loading', '正在检测云端版本…');
    const result = await attempt(() => deps.api.version());
    if (!result.ok) return stateBand(ota, 'error', copyFor(result.error));
    const release = result.value.android;
    const line = rowLine('ota-result', 'Android 最新版本', `版本 ${release.versionName}（${release.versionCode}）${release.force === true ? ' · 本次为强制更新' : ''}`, [
      button('下载 Android 安装包', () => void attempt(() => deps.bridge.openExternalUrl(release.downloadUrl)), { icon: 'download', cls: 'pv-btn-ghost', el: 'ota-download' })
    ]);
    line.dataset.downloadUrl = release.downloadUrl;
    const nodes: Node[] = [line];
    if (release.changelog !== undefined && release.changelog.trim() !== '') nodes.push(make('p', 'pv-state pv-state-ready', `更新日志：${release.changelog}`));
    nodes.push(make('p', 'pv-note', '本期只发布 Android 安装包；桌面 / PC 客户端尚未构建，不提供任何下载入口。'));
    readyBand(ota, nodes);
  }
  /** 资格判定：云端下发的档位集合 ∩ 本机档位，任一未知即「开关不存在」而不是 disabled。 */
  async function paintPrivateSection(): Promise<void> {
    const [config, tierResult] = await Promise.all([
      attempt(() => deps.api.monetization()),
      deps.tierSource === undefined ? Promise.resolve(null) : attempt(() => deps.tierSource?.currentTier() ?? Promise.resolve(null))
    ]);
    const tiers = config.ok && Array.isArray(config.value.privateAccessTiers) ? config.value.privateAccessTiers : [];
    const deviceTier = tierResult !== null && tierResult.ok ? tierResult.value : null;
    privateBand.wrap.remove();
    if (deviceTier === null || tiers.length === 0) return;
    if (!(tiers as readonly string[]).includes(deviceTier)) return;
    ota.wrap.before(privateBand.wrap);
    // 开关只跟随内存 holder 的真实状态；构造期已清空 holder，所以冷启动必然渲染为「关」。
    setSwitch(privateSwitch, deps.tokens.read() !== null);
    paintRows(privateBand, 'ready', '冷启动默认关闭；开启状态不落盘，退出即失效。', [privateRow]);
  }
  async function reload(): Promise<void> {
    if (disposed) return;
    deps.root.dataset.state = 'loading';
    stateBand(ota, 'empty', '尚未检测：点击分区内按钮获取云端版本公告。');
    const [theme, keep, callPause] = await Promise.all([
      attempt(() => readThemePreference(deps.prefs)),
      attempt(() => deps.prefs.get(SETTINGS_PREF_KEYS.keepScreenOn)),
      attempt(() => deps.prefs.get(SETTINGS_PREF_KEYS.callAutoPause))
    ]);
    if (theme.ok) setSwitch(themeSwitch, theme.value === 'light');
    paintRows(appearance, theme.ok ? 'ready' : 'error', theme.ok ? '主题即时生效，偏好写入可备份的偏好域。' : copyFor(theme.error), [themeRow]);
    if (keep.ok) setSwitch(keepScreenSwitch, keep.value === '1');
    if (callPause.ok) setSwitch(callPauseSwitch, callPause.value === '1');
    paintRows(playback, 'ready', `后台 / 息屏播放当前：${keep.ok && keep.value === '1' ? '允许' : '禁止'}。`, [keepRow, pauseRow]);
    if (deps.deviceIdSource === undefined) paintRows(redeem, 'disabled', NO_DEVICE_ID_COPY, [redeemRow]);
    else paintRows(redeem, 'ready', '核销请求只提交 Android 端；离线可验证授权，但点播仍需联网。', [redeemRow]);
    await paintPrivateSection();
    await diagController.paint();
    // 视图级五态：loading → ready；偏好域不可读则整视图 error（其余态在各分区上如实呈现）。
    deps.root.dataset.state = theme.ok ? 'ready' : 'error';
  }
  return {
    async mount(): Promise<void> { await reload(); },
    reload,
    destroy(): void {
      disposed = true;
      const hadSession = deps.tokens.read() !== null;
      closeDialog();
      // AC-02-4：离开视图必解除 FLAG_SECURE；顺手丢弃内存凭据，绝不留「界面已关但会话仍活」。
      deps.tokens.write(null);
      void deps.bridge.setSecureScreen(false);
      if (hadSession) {
        void attempt(() => deps.api.closePrivateSession());
        deps.onPrivateSessionChange?.(false);
      }
      deps.root.replaceChildren();
      deps.root.classList.remove('pv-view', 'set-view');
    }
  };
}
