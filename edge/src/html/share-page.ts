/**
 * The `/s/{drama_id}` document: an edge-direct, single-episode share player.
 *
 * Contract drivers (SPEC 5 /s/:drama_id, AC-12, AC-13, SPEC 10 分享页资源策略):
 *   - one episode only, no intro page, no site-level CSS/JS asset, no CDN, no font download;
 *   - autoplay is an ATTEMPT. The one-tap control is always in the DOM and only hides once a `play`
 *     event actually fires, so a rejected autoplay (SPEC 11 trap 5) degrades to a single click;
 *   - the 截流 card is revealed by the `ended` event and nothing else (AC-13);
 *   - the only media URL in the page is the same-origin sealed `/proxy/media/...?exp=&sig=` handle,
 *     so the upstream host never reaches the client (API-SPEC 〇 上游地址零暴露);
 *   - per API-SPEC 五.5 the WeChat exit guidance lives on `/dl` only: this page never sniffs UA and
 *     never instructs the visitor to leave the current container.
 *
 * Every interpolation below goes through `escape.ts`; `theme.ts` is the only colour source.
 */

import { embedJson, escapeText, sanitizeDisplayToken } from './escape';
import { inlineDocumentHead, inlineThemeStyles, lucideIcon } from './theme';

export const APP_NAME = '光影Play';

/** AC-13 verbatim copy; the test suite pins the exact string. */
export const SHARE_ENDED_HEADLINE = `本集已播放完毕，如果继续看，请下载【${APP_NAME}】`;

/** The manifest kind the controlled proxy serves for an episode. */
export const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl';

const DOWNLOAD_ENTRY_PATH = '/dl';
const ANDROID_PACKAGE_PATH = '/dl/latest/android';

export interface SharePageInput {
  readonly dramaId: string;
  /** RAW title; escaped here, never by the caller. */
  readonly title: string;
  readonly episodeNumber: number;
  readonly episodeTitle?: string | null;
  readonly durationSeconds?: number | null;
  /** Sealed same-origin proxy URL, or null when the edge found no healthy source for this episode. */
  readonly mediaUrl: string | null;
  readonly mimeType?: string;
  /** Display-only attribution (see `routes/share.ts`); never a settled invite. */
  readonly ref?: string | null;
}

/** Page-scoped rules only; every value is a token reference, so no colour appears in this file. */
const SHARE_STYLES = [
  '.head { padding-top: var(--space-2); }',
  '.head > * + * { margin-top: var(--space-2); }',
  '.stage > * + * { margin-top: var(--space-3); }',
  '.stage .video + .overlay { margin-top: 0; }',
  '.overlay { border-radius: 0; }',
  '.cta-row { display: flex; flex-wrap: wrap; gap: var(--space-2); }',
  '.cta-row > * + * { margin-left: var(--space-2); }',
  '.panel > * + * { margin-top: var(--space-3); }',
  '.panel h2 { font-size: var(--text-lg); color: var(--accent); }',
  '.notice { display: block; }',
  '.noscript {',
  '  display: block;',
  '  padding: var(--space-3) var(--space-4);',
  '  border: 1px solid var(--border);',
  '  border-radius: var(--radius-md);',
  '  color: var(--fg-2);',
  '  font-size: var(--text-sm);',
  '}'
].join('\n');

function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return null;
  const rounded = Math.round(seconds);
  if (rounded < 60) return `本集约 ${rounded} 秒`;
  const minutes = Math.round(rounded / 60);
  if (minutes < 120) return `本集约 ${minutes} 分钟`;
  return `本集约 ${(rounded / 3600).toFixed(1)} 小时`;
}

function metaLine(input: SharePageInput): string {
  const parts = [`第 ${input.episodeNumber} 集`];
  const episodeTitle = input.episodeTitle ?? null;
  if (episodeTitle !== null && episodeTitle !== '') parts.push(escapeText(episodeTitle));
  const duration = formatDuration(input.durationSeconds);
  if (duration !== null) parts.push(escapeText(duration));
  return parts.join(' · ');
}

function footerBlock(ref: string | null): string {
  const attribution =
    ref === null
      ? '来自好友的分享'
      : `来自好友的分享 · 标识 ${escapeText(ref)}`;
  return [
    '<footer class="panel">',
    `  <p class="meta">${attribution}</p>`,
    '  <p class="fineprint">链接上的分享标识只用于展示来源：跨安装无法凭 URL 自动归因，',
    '  因此本页不会据此结算任何邀请奖励，也不会改变你的授权状态。</p>',
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
    `    <a id="prism-download" class="cta" href="${ANDROID_PACKAGE_PATH}">${lucideIcon('download', 20)}一键下载安装</a>`,
    `    <a class="ghost" href="${DOWNLOAD_ENTRY_PATH}">${lucideIcon('info', 16)}查看下载说明</a>`,
    '  </p>',
    '</section>'
  ].join('\n');
}

function stageBlock(hasMedia: boolean): string {
  if (!hasMedia) {
    // No healthy candidate: render the honest state on the server, no dead play control.
    return [
      '  <section class="stage">',
      `    <div id="prism-empty" class="notice">${lucideIcon('alert', 16)}本集暂时找不到可用播放源，请稍后重新打开本链接。</div>`,
      '  </section>'
    ].join('\n');
  }
  return [
    '  <section class="stage">',
    '    <video id="prism-video" class="video" playsinline controls preload="none"></video>',
    '    <div id="prism-tap" class="overlay">',
    `      <button id="prism-play" class="cta" type="button">${lucideIcon('play', 20)}立即播放</button>`,
    '      <p class="fineprint">浏览器或系统内核可能拒绝带声音的自动播放，这里只作尝试；点一次即可开始。</p>',
    '    </div>',
    `    <div id="prism-hls" class="notice" hidden>${lucideIcon('alert', 16)}当前播放内核不支持 HLS 直接起播。`,
    `      请在【${APP_NAME}】App 内继续观看，或下载安装后再打开本链接。</div>`,
    '  </section>'
  ].join('\n');
}

/**
 * The single inline script of this document.
 *
 * `canPlayType('application/vnd.apple.mpegurl')` is the capability probe; hls.js is deliberately NOT
 * inlined, because SPEC 10 forbids site-level JS assets on this page. The consequence (Safari/WebView
 * can play HLS natively, Chromium desktop cannot) is surfaced honestly through `#prism-hls` plus the
 * download CTA instead of silently shipping a 400KB dependency. That tension is reported upstream.
 */
function playerScript(input: SharePageInput): string {
  const config = {
    url: input.mediaUrl,
    mimeType: input.mimeType ?? HLS_MIME_TYPE,
    probe: HLS_MIME_TYPE,
    episodeNumber: input.episodeNumber
  };
  return [
    '<script>',
    '(function () {',
    `  var config = ${embedJson(config)};`,
    "  var video = document.getElementById('prism-video');",
    "  var tap = document.getElementById('prism-tap');",
    "  var button = document.getElementById('prism-play');",
    "  var card = document.getElementById('prism-card');",
    "  var hlsBox = document.getElementById('prism-hls');",
    '  function show(node) { if (node) { node.hidden = false; } }',
    '  function hide(node) { if (node) { node.hidden = true; } }',
    '  function wire() {',
    "    video.addEventListener('play', function () { hide(tap); });",
    "    video.addEventListener('pause', function () { if (!video.ended) { show(tap); } });",
    "    video.addEventListener('ended', function () {",
    '      if (typeof video.pause === "function") { video.pause(); }',
    '      hide(tap);',
    '      show(card);',
    '      if (card && typeof card.scrollIntoView === "function") { card.scrollIntoView({ block: "end" }); }',
    '    });',
    '  }',
    '  function attemptPlayback() {',
    '    var pending = video.play();',
    '    if (pending && typeof pending.catch === "function") {',
    '      // Rejection is an expected outcome (autoplay policy), never a defect: leave the control up.',
    '      pending.catch(function () { show(tap); });',
    '    }',
    '  }',
    '  if (!video) { hide(tap); return; }',
    '  var capability = "";',
    '  try { capability = video.canPlayType(config.probe) || ""; } catch (error) { capability = ""; }',
    '  if (config.mimeType === config.probe && capability === "") {',
    '    show(hlsBox);',
    '    hide(tap);',
    '    return;',
    '  }',
    '  wire();',
    '  video.src = config.url;',
    '  video.load();',
    '  attemptPlayback();',
    '  if (button) {',
    "    button.addEventListener('click', attemptPlayback);",
    '  }',
    '})();',
    '</script>'
  ].join('\n');
}

export function renderSharePage(input: SharePageInput): string {
  const ref = sanitizeDisplayToken(input.ref ?? null);
  const head = inlineDocumentHead(
    `${input.title} 第 ${input.episodeNumber} 集 · ${APP_NAME}`,
    `${inlineThemeStyles()}\n${SHARE_STYLES}`
  );
  const hasMedia = input.mediaUrl !== null;
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    head,
    '</head>',
    '<body>',
    '<main class="shell stack">',
    '  <header class="head">',
    `    <p class="brand">${escapeText(APP_NAME)} 分享</p>`,
    `    <h1 class="title">${escapeText(input.title)}</h1>`,
    `    <p class="meta">${metaLine(input)}</p>`,
    '  </header>',
    stageBlock(hasMedia),
    endedCard(),
    footerBlock(ref),
    '  <noscript class="noscript">本页面需要启用 JavaScript 才能载入这一集的受控播放源；播放完成后的下载提示同样依赖脚本。</noscript>',
    '</main>',
    hasMedia ? playerScript(input) : '',
    '</body>',
    '</html>'
  ]
    .filter((line) => line !== '')
    .join('\n');
}
