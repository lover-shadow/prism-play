/**
 * The inline player script of `/s` (SPEC-STATIC-PAGES v2 S-1).
 *
 * What it replaces: the old `canPlayType(...) === '' -> return` block, which black-screened the page
 * on every Chromium host (WeChat X5, Android Chrome, desktop Chrome/Edge) because none of them
 * answers that probe. The probe is now a *router* between two channels, not a gate:
 *
 *   channel A (native HLS)  the host answers the probe -> assign `video.src` directly (iOS Safari);
 *   channel B (MSE)         otherwise -> fetch the self-hosted engine once, then drive it over the
 *                           same element. The engine is only ever pulled from the same-origin path in
 *                           `config.library`, never from a third-party CDN (S-1.7).
 *
 * The media address is not in the document: the script asks the episode manifest for it at run time
 * (`config.manifest`, SPEC 2.1), so the page source carries no upstream host, and `lines[0]` failing
 * falls through to `lines[1..]` up to `maxSwitches` times before the honest state card appears.
 *
 * Autoplay stays an ATTEMPT (SPEC 11 trap 5): `video.play()` rejection only re-arms the tap control.
 * The 截流 card is still revealed by `ended` and by nothing else (AC-13).
 *
 * Every string the visitor reads is injected by the server through `config.copy`, so this file holds
 * no user-facing copy and no colour, and nothing here interpolates markup.
 */

import { embedJson } from './escape';

/** Element ids shared with the markup; the script reaches the DOM only through this map. */
export interface ShareElementIds {
  readonly video: string;
  readonly tap: string;
  readonly play: string;
  readonly card: string;
  readonly state: string;
  readonly stateText: string;
  readonly rail: string;
  readonly railTrack: string;
  readonly railHint: string;
  readonly mask: string;
  readonly maskClose: string;
  readonly barDownload: string;
  readonly dock: string;
  readonly download: string;
}

export interface SharePlayerCopy {
  readonly unavailable: string;
  readonly exhausted: string;
  readonly noLibrary: string;
  readonly noEngine: string;
  /** `第 ` + number + ` 集`, i.e. the rail chip label. */
  readonly episode: string;
  readonly episodeUnit: string;
}

export interface SharePlayerConfig {
  readonly episode: number;
  readonly manifest: string;
  readonly library: string;
  readonly probe: string;
  readonly maxSwitches: number;
  readonly bufferSeconds: number;
  readonly railLimit: number;
  readonly urlLimit: number;
  readonly ids: ShareElementIds;
  readonly copy: SharePlayerCopy;
}

const BODY: readonly string[] = [
  '(function () {',
  "  'use strict';",
  '  var config = CONFIG_JSON;',
  '  var ABSOLUTE = /^https?:\\/\\//i;',
  "  function byId(id) { return document.getElementById(id); }",
  '  var ids = config.ids;',
  '  var video = byId(ids.video);',
  '  var tap = byId(ids.tap);',
  '  var card = byId(ids.card);',
  '  var stateBox = byId(ids.state);',
  '  var stateText = byId(ids.stateText);',
  '  var rail = byId(ids.rail);',
  '  var railTrack = byId(ids.railTrack);',
  '  var railHint = byId(ids.railHint);',
  '  var mask = byId(ids.mask);',
  '  var engine = null;',
  '  var lines = [];',
  '  var cursor = 0;',
  '  var switches = 0;',
  '  // Channel selection happens once: the probe routes, it never blocks (S-1.2).',
  '  var native = (function () {',
  '    var probed = "";',
  '    try { probed = video && video.canPlayType ? video.canPlayType(config.probe) : ""; } catch (error) { probed = ""; }',
  '    return (probed || "") !== "";',
  '  })();',
  '  if (video === null) { return; }',
  '  function show(node) { if (node) { node.hidden = false; } }',
  '  function hide(node) { if (node) { node.hidden = true; } }',
  '  function reveal(message) { hide(tap); if (stateText) { stateText.textContent = message; } show(stateBox); }',
  '  function attemptPlayback() {',
  '    var pending = video.play();',
  '    if (pending && typeof pending.catch === "function") {',
  '      // Rejection is an expected outcome of the autoplay policy, never a defect: leave the control up.',
  '      pending.catch(function () { show(tap); });',
  '    }',
  '  }',
  '  function detachEngine() {',
  '    if (engine !== null) { try { engine.destroy(); } catch (error) {} engine = null; }',
  '  }',
  '  function playLine(url) {',
  '    hide(stateBox);',
  '    if (native) { video.src = url; video.load(); attemptPlayback(); return; }',
  '    startEngine(url);',
  '  }',
  '  function startEngine(url) {',
  '    var Ctor = window.Hls;',
  '    if (!Ctor || typeof Ctor.isSupported !== "function" || Ctor.isSupported() === false) {',
  '      reveal(config.copy.noEngine);',
  '      return;',
  '    }',
  '    detachEngine();',
  '    engine = new Ctor({ maxBufferLength: config.bufferSeconds });',
  '    engine.on(Ctor.Events.ERROR, function (event, data) { if (data && data.fatal) { advance(); } });',
  '    engine.loadSource(url);',
  '    engine.attachMedia(video);',
  '    engine.on(Ctor.Events.MANIFEST_PARSED, attemptPlayback);',
  '  }',
  '  function advance() {',
  '    if (switches >= config.maxSwitches || cursor + 1 >= lines.length) { reveal(config.copy.exhausted); return; }',
  '    switches += 1;',
  '    cursor += 1;',
  '    playLine(lines[cursor]);',
  '  }',
  '  function loadEngine(then, miss) {',
  '    if (window.Hls) { then(); return; }',
  '    var node = document.createElement("script");',
  '    node.src = config.library;',
  '    node.async = true;',
  '    node.onload = then;',
  '    node.onerror = miss;',
  '    (document.head || document.getElementsByTagName("head")[0]).appendChild(node);',
  '  }',
  '  function begin() {',
  '    if (native || window.Hls) { playLine(lines[cursor]); return; }',
  '    loadEngine(function () { playLine(lines[cursor]); }, function () { reveal(config.copy.noLibrary); });',
  '  }',
  '  function lineUrls(payload) {',
  '    var episodes = payload && payload.episodes;',
  '    if (!Array.isArray(episodes)) { return []; }',
  '    var wanted = null;',
  '    for (var i = 0; i < episodes.length; i += 1) {',
  '      if (Number(episodes[i] && episodes[i].episodeNumber) === config.episode) { wanted = episodes[i]; break; }',
  '    }',
  '    var rows = wanted && Array.isArray(wanted.lines) ? wanted.lines : [];',
  '    var urls = [];',
  '    for (var j = 0; j < rows.length; j += 1) {',
  '      var candidate = rows[j] && rows[j].mediaUrl;',
  '      if (typeof candidate === "string" && candidate.length <= config.urlLimit && ABSOLUTE.test(candidate)) { urls.push(candidate); }',
  '    }',
  '    return urls;',
  '  }',
  '  function railChip(number, current) {',
  '    var chip = document.createElement("button");',
  '    chip.type = "button";',
  '    chip.className = current ? "chip is-current" : "chip";',
  '    chip.textContent = config.copy.episode + number + config.copy.episodeUnit;',
  '    if (current) { chip.setAttribute("aria-current", "true"); }',
  '    // S-2.3: a non-current episode is a preview, not a jump. Nothing loads and nothing navigates.',
  '    else { chip.addEventListener("click", function () { show(railHint); }); }',
  '    return chip;',
  '  }',
  '  function renderRail(episodes) {',
  '    if (rail === null || railTrack === null || !Array.isArray(episodes) || episodes.length === 0) { return; }',
  '    var fragment = document.createDocumentFragment();',
  '    for (var i = 0; i < episodes.length && i < config.railLimit; i += 1) {',
  '      var number = Number(episodes[i] && episodes[i].episodeNumber);',
  '      if (isFinite(number) && number >= 1) { fragment.appendChild(railChip(number, number === config.episode)); }',
  '    }',
  '    if (fragment.childNodes.length === 0) { return; }',
  '    railTrack.textContent = "";',
  '    railTrack.appendChild(fragment);',
  '    show(rail);',
  '  }',
  '  function fetchManifest() {',
  '    if (typeof fetch !== "function" || !config.manifest) { reveal(config.copy.unavailable); return; }',
  '    // credentials omitted: a share visitor is anonymous, and no device credential belongs on this call.',
  "    fetch(config.manifest, { credentials: 'omit', cache: 'default' })",
  '      .then(function (response) {',
  '        if (!response || response.ok !== true) { reveal(config.copy.unavailable); return null; }',
  '        return response.json();',
  '      })',
  '      .then(function (payload) {',
  '        if (!payload) { return; }',
  '        renderRail(payload.episodes);',
  '        lines = lineUrls(payload);',
  '        if (lines.length === 0) { reveal(config.copy.unavailable); return; }',
  '        begin();',
  '      })',
  '      .catch(function () { reveal(config.copy.unavailable); });',
  '  }',
  '  function inContainerWeChat() {',
  '    var agent = typeof navigator === "undefined" ? "" : String(navigator.userAgent || "");',
  '    // Lower-cased on purpose: the container name never appears in the document, only its fingerprint.',
  '    return /micromessenger/i.test(agent);',
  '  }',
  '  function wireFunnel() {',
  '    if (mask === null) { return; }',
  '    var triggers = [ids.barDownload, ids.dock, ids.download];',
  '    for (var i = 0; i < triggers.length; i += 1) {',
  '      var node = byId(triggers[i]);',
  '      if (node === null) { continue; }',
  '      node.addEventListener("click", function (event) {',
  '        if (inContainerWeChat() === false) { return; }',
  '        event.preventDefault();',
  '        show(mask);',
  '      });',
  '    }',
  '    var close = byId(ids.maskClose);',
  '    if (close !== null) { close.addEventListener("click", function () { hide(mask); }); }',
  '    mask.addEventListener("click", function (event) { if (event.target === mask) { hide(mask); } });',
  '  }',
  '  function wirePlayer() {',
  '    video.addEventListener("play", function () { hide(tap); hide(stateBox); });',
  '    video.addEventListener("pause", function () { if (video.ended === false) { show(tap); } });',
  '    video.addEventListener("error", function () { if (video.ended === false) { advance(); } });',
  "    video.addEventListener('ended', function () {",
  '      if (typeof video.pause === "function") { video.pause(); }',
  '      hide(tap);',
  '      show(card);',
  '      if (card && typeof card.scrollIntoView === "function") { card.scrollIntoView({ block: "end" }); }',
  '    });',
  '    var button = byId(ids.play);',
  '    if (button !== null) { button.addEventListener("click", attemptPlayback); }',
  '  }',
  '  wirePlayer();',
  '  wireFunnel();',
  '  fetchManifest();',
  '})();'
];

/**
 * The one `<script>` block of the document. `CONFIG_JSON` is its only interpolation, and `embedJson`
 * is what makes that safe: it neutralises `</script`, `<!--` and the two line separators inside a
 * script element. Split/join rather than `replace`, because a `$&` inside injected copy would
 * otherwise be read back as a replacement pattern.
 */
export function renderPlayerScript(config: SharePlayerConfig): string {
  const body = BODY.join('\n').split('CONFIG_JSON').join(embedJson(config));
  return ['<script>', body, '</script>'].join('\n');
}
