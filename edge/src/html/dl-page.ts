/**
 * The `/dl` documents. Three UA branches, three pure renderers, no shared mutable state, so each
 * branch can be asserted independently in `tests/edge/81-download-landing.test.ts`.
 *
 * Contract drivers (SPEC 5 /dl, API-SPEC 五.2, openapi /dl):
 *   - `MicroMessenger`  -> the compliant guidance page. It states the ordinary manual step and makes
 *     NO claim about bypassing or surviving platform limits (SPEC: 不承诺防封);
 *   - Android           -> a download card pointing at `/dl/latest/android` (the only real funnel);
 *   - Windows / other   -> an honest "this release ships Android only" notice with no PC link, no
 *     fake package and no 404 bait, because SPEC 3 puts desktop hosts out of scope;
 *   - the download funnel lives here only; `/s` never performs exit guidance.
 *
 * `ref` is display-only attribution and is escaped everywhere it appears.
 */

import { escapeText, sanitizeDisplayToken } from './escape';
import { inlineDocumentHead, inlineThemeStyles, lucideIcon, type LucideIconName } from './theme';
import { APP_NAME } from './share-page';

export const ANDROID_PACKAGE_PATH = '/dl/latest/android';
export const DOWNLOAD_ENTRY_PATH = '/dl';

/** Which copy the visitor gets; decided by `routes/dl.ts` from the User-Agent only. */
export type DownloadAudience = 'wechat' | 'android' | 'windows' | 'other';

export interface DlPageInput {
  readonly ref?: string | null;
  /** Request origin, rendered as display text so a desktop visitor can type it on a phone. */
  readonly origin?: string | null;
}

const DL_STYLES = [
  '.lede { color: var(--fg-2); font-size: var(--text-base); }',
  '.panel > * + * { margin-top: var(--space-3); }',
  '.panel h2 { font-size: var(--text-lg); color: var(--accent); }',
  '.steps { list-style: none; }',
  '.steps li { display: flex; gap: var(--space-3); align-items: flex-start; padding: var(--space-2) 0; border-bottom: 1px solid var(--border); }',
  '.steps li:last-child { border-bottom: 0; }',
  '.steps .icon { color: var(--accent); margin-top: 2px; }',
  '.address { display: block; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--fg-2); font-size: var(--text-sm); }',
  '.cta-row { display: flex; flex-wrap: wrap; gap: var(--space-2); }'
].join('\n');

function shell(rawTitle: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    inlineDocumentHead(rawTitle, `${inlineThemeStyles()}\n${DL_STYLES}`),
    '</head>',
    '<body>',
    '<main class="shell stack">',
    `  <p class="brand">${escapeText(APP_NAME)}</p>`,
    body,
    '  <p class="fineprint">本页面仅提供下载指引，不索取任何个人信息，也不读取你的设备标识。</p>',
    '</main>',
    '</body>',
    '</html>'
  ].join('\n');
}

function attributionLine(ref: string | null): string {
  return ref === null
    ? '  <p class="meta">分享来源：直接访问</p>'
    : `  <p class="meta">分享来源标识 ${escapeText(ref)}（仅展示；跨安装无法凭链接归因，不结算邀请奖励）</p>`;
}

function steps(items: readonly { icon: LucideIconName; text: string }[]): string {
  return [
    '  <ol class="steps">',
    ...items.map((item) => `    <li>${lucideIcon(item.icon, 16)}<span>${escapeText(item.text)}</span></li>`),
    '  </ol>'
  ].join('\n');
}

/**
 * WeChat: the compliant guidance page. The wording deliberately stops at "open it in a browser" and
 * adds an explicit no-bypass / no-anti-block disclaimer, so nothing here promises a capability the
 * edge does not have.
 */
export function renderWeChatGuidePage(input: DlPageInput = {}): string {
  const ref = sanitizeDisplayToken(input.ref ?? null);
  const body = [
    '<section class="panel">',
    '  <h2>请在浏览器中打开继续下载</h2>',
    '  <p class="lede">微信内置浏览器不提供外部安装包的下载通道，因此本页无法在当前窗口完成下载。</p>',
    steps([
      { icon: 'chevron-up', text: '点击右上角的「…」或「···」菜单。' },
      { icon: 'external', text: '选择「在浏览器打开」（部分机型显示为「用系统浏览器打开」）。' },
      { icon: 'phone', text: `在系统浏览器中即可看到 ${APP_NAME} 的 Android 下载入口。` }
    ]),
    `  <p class="cta-row"><a class="ghost" href="${DOWNLOAD_ENTRY_PATH}">${lucideIcon('info', 16)}在当前窗口查看下载说明</a></p>`,
    `  <p class="notice">${lucideIcon('alert', 16)}这里只说明在浏览器中打开的常规操作步骤，不承诺绕过微信的限制，也不承诺链接的可达性不受平台策略影响。</p>`,
    attributionLine(ref),
    '</section>'
  ].join('\n');
  return shell(`下载指引 · ${APP_NAME}`, body);
}

/** Android: the one real download card. It points at the only entry the edge can honour. */
export function renderAndroidDownloadPage(input: DlPageInput = {}): string {
  const ref = sanitizeDisplayToken(input.ref ?? null);
  const body = [
    '<section class="panel">',
    `  <h2>${escapeText(APP_NAME)} Android 安装包</h2>`,
    '  <p class="lede">点击下方按钮获取当前已发布并通过校验的安装包；下载入口由本站固定路径提供，不存在其他镜像地址。</p>',
    `  <p class="cta-row"><a id="prism-apk" class="cta" href="${ANDROID_PACKAGE_PATH}">${lucideIcon('download', 20)}下载 Android 安装包</a></p>`,
    '  <p class="meta">若系统提示禁止安装未知来源应用，请在设置中允许当前浏览器安装后重试。</p>',
    `  <p class="notice">${lucideIcon('info', 16)}本期仅提供 Android 版本；Windows、macOS 与桌面客户端尚未发布，本站不提供对应安装包。</p>`,
    attributionLine(ref),
    '</section>'
  ].join('\n');
  return shell(`下载 ${APP_NAME} Android 版`, body);
}

/**
 * Windows / other: honest unavailability. No PC link, no placeholder package, and no route that could
 * resolve into a 404 bait, because SPEC 3 keeps the desktop host out of this release.
 */
export function renderUnsupportedNoticePage(input: DlPageInput & { audience?: DownloadAudience } = {}): string {
  const ref = sanitizeDisplayToken(input.ref ?? null);
  const audience = input.audience ?? 'other';
  const headline =
    audience === 'windows' ? '当前仅提供 Android 版本' : '当前设备不提供安装包下载';
  const deviceLabel = audience === 'windows' ? 'Windows 电脑' : '非 Android 设备';
  const address = sanitizeDisplayToken(input.origin ?? null, 200);
  const body = [
    '<section class="panel">',
    `  <h2>${escapeText(headline)}</h2>`,
    `  <p class="lede">${escapeText(deviceLabel)}没有可用的安装包，本页不展示也不跳转到任何并不存在的 PC 下载地址。</p>`,
    '  <p class="meta">本期发布范围只有 Android 安装包，桌面宿主与构建验证属于后续版本。</p>',
    steps([
      { icon: 'phone', text: '在 Android 手机或平板的浏览器中打开下方地址，即可看到下载按钮。' },
      { icon: 'info', text: '本页不提供 PC 安装包地址，也不承诺后续版本的时间表。' }
    ]),
    `  <span class="address">${escapeText(address === null ? DOWNLOAD_ENTRY_PATH : `${address}${DOWNLOAD_ENTRY_PATH}`)}</span>`,
    `  <p class="cta-row"><a class="ghost" href="${DOWNLOAD_ENTRY_PATH}">${lucideIcon('info', 16)}打开本页面的手机下载说明</a></p>`,
    attributionLine(ref),
    '</section>'
  ].join('\n');
  return shell(`${escapeText(headline)} · ${APP_NAME}`, body);
}

/** Single dispatch used by the route so the mapping UA -> document stays in one place. */
export function renderDownloadPage(audience: DownloadAudience, input: DlPageInput = {}): string {
  if (audience === 'wechat') return renderWeChatGuidePage(input);
  if (audience === 'android') return renderAndroidDownloadPage(input);
  return renderUnsupportedNoticePage({ ...input, audience });
}
