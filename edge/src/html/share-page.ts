/**
 * The `/s/{drama_id}` document: an edge-direct, single-episode share player.
 *
 * Contract drivers (SPEC-STATIC-PAGES v2 S-1/S-2, SPEC 5 /s/:drama_id, AC-12, AC-13):
 *   - one episode only, no intro page, no stylesheet/font/CDN reference: the token block is inlined
 *     by `theme.ts`, and the ONLY script this document pulls is the self-hosted HLS engine served by
 *     `routes/assets.ts` from the same origin (v2 §1.2-4 overrides the old "no site-level JS asset"
 *     reading of SPEC 10, because that rule is what black-screened every Chromium host);
 *   - the media address is NOT in this document. The inline script asks `/api/titles/{workId}` for
 *     the episode manifest at run time (v2 §2.1), so the page source carries no upstream host at all
 *     and the CDN is reached directly by the player;
 *   - autoplay is an ATTEMPT: the tap control is in the DOM from the first byte and only hides once a
 *     `play` event actually fires (SPEC 11 trap 5);
 *   - the 截流 card is revealed by the `ended` event and nothing else (AC-13);
 *   - the download funnel is three taps deep at most (brand bar / dock / 截流 card). Inside the
 *     WeChat container a tap reveals the manual "open in a browser" guidance instead of a jump-out,
 *     and the guidance states plainly that nothing here promises a bypass (S-2.4).
 *
 * Every interpolation goes through `escape.ts`; this file contains no colour (P0-3) and no pictograph
 * (P0-1), and it stays under the 300-line ceiling because its CSS lives in `share-page-styles.ts` and
 * its script in `share-player-script.ts`.
 */

import { escapeText, sanitizeDisplayToken } from './escape';
import { inlineDocumentHead, inlineThemeStyles, lucideIcon } from './theme';
import { SHARE_STYLES } from './share-page-styles';
import { renderPlayerScript, type SharePlayerConfig, type SharePlayerCopy } from './share-player-script';

export const APP_NAME = '光影Play';

/** AC-13 verbatim copy; the test suite pins the exact string. */
export const SHARE_ENDED_HEADLINE = `本集已播放完毕，如果继续看，请下载【${APP_NAME}】`;

/** The manifest kind the player is pointed at: an HLS playlist, native or through MSE. */
export const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl';

export const DOWNLOAD_ENTRY_PATH = '/dl';
export const ANDROID_PACKAGE_PATH = '/dl/latest/android';
/** Episode manifest of the requested work (v2 §2.1); same origin, cacheable for public works. */
export const TITLES_PATH_PREFIX = '/api/titles/';
/**
 * The self-hosted playback engine (v2 §1.2-4). The path is declared here, next to the other two
 * same-origin paths this document references, and `routes/assets.ts` derives its R2 key from it, so
 * the URL can only ever be defined once. `edge/src/html/**` imports nothing from `routes/**`.
 */
export const HLS_SCRIPT_PATH = '/assets/hls.min.js';

/** Bound the inline label work: a 10k-episode manifest would otherwise build 10k chips. */
const RAIL_LIMIT = 300;
/** Anything longer than this is not a playlist address this page will hand to the player. */
const MEDIA_URL_LIMIT = 2048;
/** S-1.6: at most two switches away from `lines[0]`. */
const MAX_LINE_SWITCHES = 2;
const BUFFER_SECONDS = 30;

/**
 * Content ids are opaque `d…`/`drama_m_…` strings. The route already resolved this id out of D1, so a
 * value that fails the pattern can only come from a caller that skipped that step: the page then
 * degrades to the honest state card instead of emitting a manifest URL nobody can answer.
 */
const WORK_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The ids are the whole contract between the markup below and the script in `share-player-script.ts`. */
const SHARE_ELEMENT_IDS = {
  video: 'prism-video',
  tap: 'prism-tap',
  play: 'prism-play',
  card: 'prism-card',
  state: 'prism-state',
  stateText: 'prism-state-text',
  rail: 'prism-rail',
  railTrack: 'prism-episodes',
  railHint: 'prism-rail-hint',
  mask: 'prism-mask',
  maskClose: 'prism-mask-close',
  barDownload: 'prism-bar-download',
  dock: 'prism-dock',
  download: 'prism-download'
} as const;

/** Copy is server-owned so the player script stays a mechanism with no strings in it. */
const PLAYER_COPY: SharePlayerCopy = {
  unavailable: `这一集暂时没有可用播放源，请稍后重新打开本链接，或在【${APP_NAME}】App 内继续观看。`,
  exhausted: `当前线路暂不可用：本次候选线路尝试已结束，仍未起播，请稍后重新打开本链接，或在【${APP_NAME}】App 内继续观看。`,
  interrupted: `播放中断：本次候选线路尝试已结束，请稍后重新打开本链接，或在【${APP_NAME}】App 内继续观看。`,
  noLibrary: `播放组件未能载入，请检查网络后重新打开本链接，或在【${APP_NAME}】App 内继续观看。`,
  noEngine: `当前浏览器内核既不接受该播放格式，也无法以硬件解码承载它，请在【${APP_NAME}】App 内继续观看。`,
  episode: '第 ',
  episodeUnit: ' 集'
};

export interface SharePageInput {
  /** The work id as it appears in the share URL; also the manifest key (v2 §2.1). */
  readonly dramaId: string;
  /** RAW title; escaped here, never by the caller. */
  readonly title: string;
  readonly episodeNumber: number;
  readonly episodeTitle?: string | null;
  readonly durationSeconds?: number | null;
  /** Display-only attribution (see `routes/share.ts`); never a settled invite. */
  readonly ref?: string | null;
}

function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return null;
  const rounded = Math.round(seconds);
  if (rounded < 60) return `本集约 ${rounded} 秒`;
  const minutes = Math.round(rounded / 60);
  if (minutes < 120) return `本集约 ${minutes} 分钟`;
  return `本集约 ${(rounded / 3600).toFixed(1)} 小时`;
}

function metaLine(input: SharePageInput): string {
  const parts = [`${PLAYER_COPY.episode}${input.episodeNumber}${PLAYER_COPY.episodeUnit}`.trim()];
  const episodeTitle = input.episodeTitle ?? null;
  if (episodeTitle !== null && episodeTitle !== '') parts.push(escapeText(episodeTitle));
  const duration = formatDuration(input.durationSeconds);
  if (duration !== null) parts.push(escapeText(duration));
  return parts.join(' · ');
}

function footerBlock(ref: string | null): string {
  const attribution = ref === null ? '来自好友的分享' : `来自好友的分享 · 标识 ${escapeText(ref)}`;
  return [
    '<footer class="panel">',
    `  <p class="meta">${attribution}</p>`,
    '  <p class="fineprint">链接上的分享标识只用于展示来源：跨安装无法凭 URL 自动归因，',
    '  因此本页不会据此结算任何邀请奖励，也不会改变你的授权状态。</p>',
    '  <p class="fineprint" style="margin-top:8px"><a class="ghost" href="/privacy">隐私与统计设置</a></p>',
    '</footer>'
  ].join('\n');
}

/** The 截流 card: static markup, hidden by the `hidden` attribute, revealed only by the `ended` event. */
function endedCard(): string {
  return [
    '<section id="prism-card" class="panel" hidden aria-live="polite">',
    `  <h2>${escapeText(SHARE_ENDED_HEADLINE)}</h2>`,
    `  <p class="meta">${escapeText(APP_NAME)} 内可继续看下一集、断点续播与全片单，无需再找链接。</p>`,
    '  <p class="cta-row">',
    `    <a id="${SHARE_ELEMENT_IDS.download}" class="cta" href="${ANDROID_PACKAGE_PATH}">${lucideIcon('download', 20)}一键下载安装</a>`,
    `    <a class="ghost" href="${DOWNLOAD_ENTRY_PATH}">${lucideIcon('info', 16)}查看下载说明</a>`,
    '  </p>',
    '</section>'
  ].join('\n');
}

/** S-2.1: the brand bar is sticky and 44px tall, so 【下载 APP】 is reachable from any scroll offset. */
function brandBar(): string {
  return [
    '<header class="bar">',
    `  <span class="bar-brand">${lucideIcon('film', 16)}${escapeText(APP_NAME)} 分享</span>`,
    `  <a id="${SHARE_ELEMENT_IDS.barDownload}" class="bar-cta" href="${DOWNLOAD_ENTRY_PATH}">下载 APP</a>`,
    '</header>'
  ].join('\n');
}

/**
 * S-1.3: the X5/`playsinline` attributes are what keep the stream inside the page instead of handing
 * the whole WebView over to a fullscreen shell. Autoplay is deliberately absent (AC-12 is an attempt).
 */
function stageBlock(): string {
  return [
    '  <section class="stage">',
    `    <video id="${SHARE_ELEMENT_IDS.video}" class="video" playsinline webkit-playsinline` +
      ` x5-video-player-type="h5-page" x5-video-player-fullscreen="true" controls preload="none"></video>`,
    `    <div id="${SHARE_ELEMENT_IDS.tap}" class="overlay">`,
    `      <button id="${SHARE_ELEMENT_IDS.play}" class="tap" type="button">${lucideIcon('play-circle', 24)}立即播放</button>`,
    '      <p class="fineprint">浏览器或系统内核可能拒绝带声音的自动播放，这里只作尝试；点一次即可开始。</p>',
    '    </div>',
    `    <div id="${SHARE_ELEMENT_IDS.state}" class="state notice" hidden aria-live="polite">`,
    `      ${lucideIcon('alert', 16)}<span id="${SHARE_ELEMENT_IDS.stateText}"></span>`,
    '    </div>',
    '  </section>'
  ].join('\n');
}

/** S-2.3: the chips are filled in by the script from the same manifest that yields the media address. */
function railBlock(): string {
  return [
    `  <section id="${SHARE_ELEMENT_IDS.rail}" class="rail" hidden>`,
    '    <h2 class="rail-title">选集预览</h2>',
    `    <div id="${SHARE_ELEMENT_IDS.railTrack}" class="rail-track"></div>`,
    `    <p id="${SHARE_ELEMENT_IDS.railHint}" class="rail-hint" hidden>下载【${escapeText(APP_NAME)}】App 后可继续看更多集数。</p>`,
    '  </section>'
  ].join('\n');
}

/** S-2.2: the CTA stays on screen for the whole play session, lifted clear of the home indicator. */
function dockBlock(): string {
  return [
    '  <div class="dock">',
    `    <a id="${SHARE_ELEMENT_IDS.dock}" class="cta" href="${DOWNLOAD_ENTRY_PATH}">${lucideIcon('download', 20)}下载 APP 免费看全集</a>`,
    '  </div>'
  ].join('\n');
}

/**
 * S-2.4: the WeChat guidance. It is inert outside that container and it never jumps out on its own;
 * the `href` behind each trigger stays a real link, so a visitor without script still lands on `/dl`.
 */
function guidanceMask(): string {
  return [
    `  <div id="${SHARE_ELEMENT_IDS.mask}" class="mask" hidden role="dialog" aria-modal="true" aria-label="下载提示">`,
    '    <div class="mask-card">',
    `      <strong>${lucideIcon('arrow-up-right', 24)}请点右上角「···」，选择在系统浏览器中打开</strong>`,
    '      <p class="meta">当前窗口不提供安装包通道，在系统浏览器中打开本页即可下载。</p>',
    '      <p class="fineprint">这里只说明在系统浏览器中打开的常规步骤，不承诺绕过任何平台限制。</p>',
    `      <button id="${SHARE_ELEMENT_IDS.maskClose}" class="mask-close" type="button" aria-label="关闭提示">${lucideIcon('x', 16)}</button>`,
    '    </div>',
    '  </div>'
  ].join('\n');
}

function playerConfig(input: SharePageInput): SharePlayerConfig {
  const workId = WORK_ID_PATTERN.test(input.dramaId) ? input.dramaId : '';
  return {
    episode: input.episodeNumber,
    manifest: workId === '' ? '' : `${TITLES_PATH_PREFIX}${encodeURIComponent(workId)}`,
    library: HLS_SCRIPT_PATH,
    probe: HLS_MIME_TYPE,
    maxSwitches: MAX_LINE_SWITCHES,
    bufferSeconds: BUFFER_SECONDS,
    railLimit: RAIL_LIMIT,
    urlLimit: MEDIA_URL_LIMIT,
    ids: SHARE_ELEMENT_IDS,
    copy: PLAYER_COPY
  };
}

export function renderSharePage(input: SharePageInput): string {
  const ref = sanitizeDisplayToken(input.ref ?? null);
  const rawTitle = `${input.title} 第 ${input.episodeNumber} 集 · ${APP_NAME}`;
  const head = inlineDocumentHead(rawTitle, `${inlineThemeStyles()}\n${SHARE_STYLES}`);
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    head,
    '</head>',
    '<body>',
    '<div class="frame">',
    brandBar(),
    '<main class="shell stack">',
    '  <section class="head">',
    `    <h1 class="title">${escapeText(input.title)}</h1>`,
    `    <p class="meta">${metaLine(input)}</p>`,
    '  </section>',
    stageBlock(),
    railBlock(),
    endedCard(),
    footerBlock(ref),
    '</main>',
    dockBlock(),
    guidanceMask(),
    '  <noscript class="noscript">本页面需要启用 JavaScript 才能向剧集清单取得这一集的播放源；没有脚本时播放与下载提示仍然保留入口，但不会自动载入影音。</noscript>',
    '</div>',
    renderPlayerScript(playerConfig(input)),
    '</body>',
    '</html>'
  ].join('\n');
}
