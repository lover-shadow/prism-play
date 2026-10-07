/**
 * The `/` document: the official 光影Play portal (SPEC-STATIC-PAGES v2 S-4).
 *
 * 视觉对齐 prismos.org「流光·逸影 | AIOS·Prism」黑曜石沉浸质感。
 * 核心卖点如实展示：免注册、纯净零广告、当前集点开即播、数据留在本地、预制卡密多端。
 * 设备矩阵严禁出现 iOS（只有 Android 手机现役，PC 与 TV 规划中）。
 *
 * 版式按宿主宽度分三档：手机单列居中；≥960px 起 hero 左文案右真机渲染图、设备三列、能力四列。
 * 渲染图是 `/assets/hero-showcase-*.webp`（同源 R2），因为一个只有线框、没有真实海报的
 * CSS 假界面在宽屏上等于把「我们长什么样」这件事留白。
 */

import { escapeText } from './escape';
import { ANDROID_PACKAGE_PATH, DOWNLOAD_ENTRY_PATH, heroShotMarkup } from './dl-page';
import { inlineDocumentHead, inlineDayPaletteStyles, inlineThemeStyles, lucideIcon, type LucideIconName } from './theme';
import { APP_NAME } from './share-page';

export interface LandingRelease {
  readonly versionName: string;
  readonly versionCode: number;
}

export interface LandingPageInput {
  readonly release: LandingRelease | null;
  readonly apkSizeBytes: number | null;
}

const LANDING_STYLES = [
  'body { padding: 0; }',
  '.page { display: flex; flex-direction: column; gap: var(--space-10); padding: 0 var(--space-4) var(--space-8); }',
  '.wrap { width: 100%; max-width: var(--container-desktop); margin: 0 auto; }',
  // --- 顶栏：品牌 + 锚点导航 + 常驻下载键
  '.top { border-bottom: 1px solid var(--border); }',
  '.top-inner { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); min-height: var(--touch-target); padding: var(--safe-top) 0 var(--space-3); }',
  '.brand { display: inline-flex; align-items: center; gap: var(--space-2); color: var(--accent); font-size: var(--text-base); font-weight: 700; letter-spacing: var(--tracking-caps); text-decoration: none; }',
  '.brand-tag { display: none; font-size: var(--text-xs); padding: 2px var(--space-2); border-radius: var(--radius-xs); background: var(--surface-raised); border: 1px solid var(--border); color: var(--muted); }',
  '.top-actions { display: flex; align-items: center; gap: var(--space-2); }',
  '.nav { display: none; gap: var(--space-6); margin-right: auto; }',
  '.nav a { color: var(--fg-2); font-size: var(--text-sm); text-decoration: none; }',
  '.nav a:hover { color: var(--accent); }',
  '.cta-compact { min-height: 38px; padding: var(--space-2) var(--space-4); font-size: var(--text-sm); }',
  // --- hero
  '.hero { padding: var(--space-8) 0 0; text-align: center; }',
  '.hero-inner { display: flex; flex-direction: column; gap: var(--space-6); }',
  '.hero-copy > * + * { margin-top: var(--space-4); }',
  '.hero-badge { display: inline-flex; align-items: center; gap: var(--space-2); padding: var(--space-1) var(--space-3); border-radius: var(--radius-pill); background: var(--accent-subtle); border: 1px solid var(--border); font-size: var(--text-xs); color: var(--accent); letter-spacing: var(--tracking-caps); }',
  '.hero-title { font-family: var(--font-display); font-size: var(--text-xl); line-height: var(--leading-tight); letter-spacing: var(--tracking-tight); color: var(--fg); }',
  '.hero-lede { max-width: 46ch; margin-inline: auto; color: var(--fg-2); font-size: var(--text-md); line-height: var(--leading-normal); }',
  '.hero-highlights { display: flex; justify-content: center; flex-wrap: wrap; gap: var(--space-2); }',
  '.highlight-pill { display: inline-flex; align-items: center; gap: var(--space-1); font-size: var(--text-xs); color: var(--accent); padding: 3px 10px; border-radius: var(--radius-pill); background: var(--surface); border: 1px solid var(--border); font-weight: 600; }',
  '.cta-row { display: flex; justify-content: center; flex-wrap: wrap; gap: var(--space-3); }',
  '.trust { display: flex; align-items: flex-start; gap: var(--space-2); max-width: 52ch; margin-inline: auto; color: var(--muted); font-size: var(--text-xs); text-align: left; }',
  '.trust .icon { color: var(--accent); margin-top: 2px; }',
  '.hero-meta { color: var(--muted); font-size: var(--text-xs); letter-spacing: var(--tracking-caps); }',
  '.hero-visual { margin-top: var(--space-2); }',
  '.hero-shot { display: block; width: 100%; height: auto; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--player-bg); }',
  // --- 区块标题
  '.section-head { text-align: center; margin-bottom: var(--space-6); }',
  '.section-title { font-size: var(--text-lg); color: var(--fg); }',
  '.section-lede { color: var(--muted); font-size: var(--text-sm); margin-top: var(--space-2); }',
  // --- 栅格：手机单列，宽屏按区块分列，永不横向溢出 (AC-S4-3)
  '.grid { display: grid; grid-template-columns: 1fr; gap: var(--space-4); }',
  '@media (min-width: 600px) { .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .hero-title { font-size: var(--text-display); } .brand-tag { display: inline-block; } }',
  '@media (min-width: 960px) { .nav { display: flex; } .hero { padding: var(--space-10) 0 0; text-align: left; } .hero-inner { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr); gap: var(--space-10); align-items: center; } .hero-lede, .trust { margin-inline: 0; } .hero-highlights, .cta-row { justify-content: flex-start; } .hero-visual { margin-top: 0; } .grid.is-devices, .grid.is-features { grid-template-columns: repeat(3, minmax(0, 1fr)); } }',
  '.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--space-5); display: flex; flex-direction: column; gap: var(--space-2); }',
  '.card-head { display: flex; align-items: center; gap: var(--space-2); color: var(--fg); font-size: var(--text-base); font-weight: 700; }',
  '.card-head .icon { color: var(--accent); }',
  '.pills { display: flex; flex-wrap: wrap; gap: var(--space-2); }',
  '.pill { display: inline-flex; align-items: center; min-height: var(--space-6); padding: 0 var(--space-3); border: 1px solid var(--accent); border-radius: var(--radius-pill); color: var(--accent); font-size: var(--text-xs); letter-spacing: var(--tracking-caps); }',
  '.pill-plain { border-color: var(--border); color: var(--fg-2); }',
  '.card.is-off { background: var(--surface-raised); border-style: dashed; }',
  '.card.is-off .card-head, .card.is-off .card-head .icon { color: var(--muted); }',
  '.feature { font-size: var(--text-sm); color: var(--fg-2); line-height: var(--leading-normal); }',
  '.feature-sub { font-size: var(--text-xs); color: var(--accent); font-weight: 600; }',
  '.note { font-size: var(--text-xs); color: var(--muted); line-height: var(--leading-normal); }',
  '.foot { border-top: 1px solid var(--border); padding: var(--space-6) 0 calc(var(--space-4) + var(--safe-bottom)); }',
  '.foot-inner { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: baseline; justify-content: space-between; font-size: var(--text-xs); color: var(--muted); }'
].join('\n');

function formatSize(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes <= 0) return null;
  const megabytes = bytes / (1024 * 1024);
  if (megabytes < 1) return `约 ${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `约 ${megabytes.toFixed(1)} MB`;
}

/** 发布通道可能下发带渠道前缀的 name（`dev_v2.1.1.1`）：只在纯数字开头时补 `v`，否则原样展示。 */
function versionLabel(name: string): string {
  return /^[0-9]/.test(name) ? `v${name}` : name;
}

function topBar(): string {
  return [
    '<header class="top">',
    '  <div class="wrap top-inner">',
    '    <div style="display:flex;align-items:center;gap:var(--space-3)">',
    `      <a class="brand" href="/">${lucideIcon('film', 16)}<span>流光·逸影 · ${escapeText(APP_NAME)}</span></a>`,
    '      <span class="brand-tag">PrismOS 家族</span>',
    '    </div>',
    '    <nav class="nav">',
    '      <a href="#features">核心能力</a>',
    '      <a href="#devices">支持设备</a>',
    `      <a href="${DOWNLOAD_ENTRY_PATH}">下载说明</a>`,
    '    </nav>',
    '    <div class="top-actions">',
    `      <a class="cta cta-compact" href="${ANDROID_PACKAGE_PATH}">${lucideIcon('download', 16)}下载 APK</a>`,
    '    </div>',
    '  </div>',
    '</header>'
  ].join('\n');
}

function heroBlock(release: LandingRelease | null, apkSize: string | null): string {
  const version = release === null ? '版本号尚未由发布通道配置' : escapeText(versionLabel(release.versionName));
  const sizePill = apkSize === null ? '' : ` · ${escapeText(apkSize)}`;
  return [
    '<section class="hero">',
    '  <div class="wrap hero-inner">',
    '    <div class="hero-copy">',
    '      <p><span class="hero-badge">' + lucideIcon('play', 16) + 'PRISM PLAY</span></p>',
    '      <h1 class="hero-title">好剧随时开场</h1>',
    '      <p class="hero-lede">免注册、零广告、点开即播的短剧与影视聚合终端。数据留在本地，分享出去的那一集，朋友看到的也是那一集。</p>',
    '      <div class="hero-highlights">',
    '        <span class="highlight-pill">免注册 · 零门槛</span>',
    '        <span class="highlight-pill">全链路纯净零广告</span>',
    '        <span class="highlight-pill">当前集点开即播</span>',
    '        <span class="highlight-pill">数据留在本地</span>',
    '        <span class="highlight-pill">预制卡密 · 多端接力</span>',
    '      </div>',
    `      <p class="cta-row"><a class="cta" href="${ANDROID_PACKAGE_PATH}">${lucideIcon('download', 20)}立即下载 APK</a>`,
    `        <a class="ghost" href="${DOWNLOAD_ENTRY_PATH}">${lucideIcon('info', 16)}下载说明</a></p>`,
    `      <p class="trust">${lucideIcon('shield', 16)}<span>不索取手机号、通讯录、位置或相册权限；授权码与观看进度只存在你这台设备的本地库里，本站不做任何账号绑定。</span></p>`,
    `      <p class="hero-meta">ANDROID · ${version}${sizePill}</p>`,
    '    </div>',
    `    <div class="hero-visual">${heroShotMarkup('hero-shot')}</div>`,
    '  </div>',
    '</section>'
  ].join('\n');
}

function androidCard(release: LandingRelease | null, size: string | null): string {
  const pills = ['<span class="pill">APK</span>'];
  if (release !== null) pills.push(`<span class="pill pill-plain">${escapeText(versionLabel(release.versionName))}</span>`);
  if (size !== null) pills.push(`<span class="pill pill-plain">${escapeText(size)}</span>`);
  const note =
    release === null
      ? '安装包已就绪，版本号尚未由发布通道配置，安装完成后以 App 内「关于」页为准。'
      : 'Android 8.0 及以上原生适配；支持双滑调控、后台播放与本地 FTS 极速检索。';
  return [
    '  <article class="card">',
    `    <h3 class="card-head">${lucideIcon('smartphone', 20)}Android 手机版</h3>`,
    `    <div class="pills">${pills.join('')}</div>`,
    `    <p class="note">${escapeText(note)}</p>`,
    `    <p class="cta-row" style="margin-top:auto;justify-content:flex-start"><a class="cta cta-compact" href="${ANDROID_PACKAGE_PATH}">${lucideIcon('download', 16)}立即下载 APK</a></p>`,
    '  </article>'
  ].join('\n');
}

/** 未出厂的宿主只是一句说明，不是一个链接：`href` 在结构上就不存在。 */
function upcomingCard(icon: LucideIconName, label: string, detail: string): string {
  return [
    '  <article class="card is-off">',
    `    <h3 class="card-head">${lucideIcon(icon, 20)}${escapeText(label)}</h3>`,
    '    <div class="pills"><span class="pill pill-plain">即将推出</span></div>',
    `    <p class="note">${escapeText(detail)}</p>`,
    '  </article>'
  ].join('\n');
}

function matrixBlock(release: LandingRelease | null, apkSizeBytes: number | null): string {
  return [
    '<section id="devices">',
    '  <div class="wrap">',
    '    <div class="section-head">',
    '      <h2 class="section-title">支持设备与宿主</h2>',
    '      <p class="section-lede">当前只发布 Android 手机版；电视大屏与 PC 桌面端已立项，出厂前本页不放任何假链接。</p>',
    '    </div>',
    '    <div class="grid is-devices">',
    androidCard(release, formatSize(apkSizeBytes)),
    upcomingCard('tv', 'Android TV / 电视大屏', '手机端已全量支持 DLNA 局域网投屏，把当前线路直接交给电视播放；原生大屏遥控端上线后与本页同步更新。'),
    upcomingCard('monitor-smartphone', 'Windows / PC 桌面版', '面向大视界宽屏的桌面观影终端，多列画卷与全局快捷键调度；构建验证完成前不提供下载地址。'),
    '    </div>',
    '  </div>',
    '</section>'
  ].join('\n');
}

const FEATURE_CARDS: readonly { readonly icon: LucideIconName; readonly title: string; readonly sub: string; readonly detail: string }[] = [
  {
    icon: 'film',
    title: '精选短剧一键播放',
    sub: '免注册 · 纯净零广告',
    detail: '拒绝手机号与隐私搜集，全链路零开屏、零插播、零贴片弹窗，进入即播。'
  },
  {
    icon: 'play-circle',
    title: '当前集点开即播',
    sub: '点开即播 · 播完截流',
    detail: '微信与浏览器单集秒播。朋友分享第 24 集直接载入第 24 集，绝不倒退第 1 集。'
  },
  {
    icon: 'wifi-off',
    title: '可缓存 可离线观看',
    sub: '零流量畅看 · 随时随地',
    detail: '剧集支持离线缓存到设备本地，断网或飞行模式下也能流畅播放，通勤出行告别流量焦虑。'
  },
  {
    icon: 'layers',
    title: '多源聚合去重',
    sub: '云端归一 · 线路可切',
    detail: '同一剧目在云端按标准化片名合并，一条条目只出现一次，播放线路可随时切换。'
  },
  {
    icon: 'monitor-smartphone',
    title: '多端断点接力',
    sub: '匿名同步观看进度 · 预制卡密',
    detail: '凭授权码在换设备时无缝续播，观看进度与收藏走匿名云端同步通道，不索取手机号，不绑定个人身份。'
  },
  {
    icon: 'tv',
    title: '客厅大屏一键投屏',
    sub: 'DLNA · 直连线路',
    detail: '把当前播放线路直接交给局域网里的电视或盒子，不必把视频再下载一遍，手机可以继续做别的。'
  }
];

function featuresBlock(): string {
  const cards = FEATURE_CARDS.map((card) =>
    [
      '    <article class="card">',
      `      <h3 class="card-head">${lucideIcon(card.icon, 20)}${escapeText(card.title)}</h3>`,
      `      <p class="feature-sub">${escapeText(card.sub)}</p>`,
      `      <p class="feature">${escapeText(card.detail)}</p>`,
      '    </article>'
    ].join('\n')
  );
  return [
    '<section id="features">',
    '  <div class="wrap">',
    '    <div class="section-head">',
    '      <h2 class="section-title">它会怎么陪你追剧</h2>',
    '      <p class="section-lede">避开劣质套壳与弹窗乱象，把交互和质感对齐一线流媒体。</p>',
    '    </div>',
    '    <div class="grid is-features">',
    ...cards,
    '    </div>',
    '  </div>',
    '</section>'
  ].join('\n');
}

function footBlock(release: LandingRelease | null): string {
  const version = release === null ? '版本信息由发布通道实时下发' : `Android ${escapeText(versionLabel(release.versionName))}`;
  return [
    '<footer class="foot">',
    '  <div class="wrap foot-inner">',
    `    <p class="meta">${escapeText(APP_NAME)} · ${version} · © 2026 AIOS Foundation</p>`,
    `    <p class="meta"><a class="ghost" href="${DOWNLOAD_ENTRY_PATH}">下载与安装说明</a></p>`,
    '  </div>',
    '</footer>'
  ].join('\n');
}

export function renderLandingPage(input: LandingPageInput): string {
  const release = input.release;
  const head = inlineDocumentHead(
    `${APP_NAME} · 好剧随时开场`,
    `${inlineThemeStyles()}\n${inlineDayPaletteStyles()}\n${LANDING_STYLES}`,
    { dualMode: true }
  );
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    head,
    '</head>',
    '<body>',
    '<div class="page">',
    topBar(),
    heroBlock(release, formatSize(input.apkSizeBytes)),
    matrixBlock(release, input.apkSizeBytes),
    featuresBlock(),
    footBlock(release),
    '</div>',
    '<p><a href="/privacy">隐私与统计设置</a></p>',
    '</body>',
    '</html>'
  ].join('\n');
}
