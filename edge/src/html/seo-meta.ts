/**
 * 搜索引擎优化 (SEO) 元数据与站点地图/爬虫协议生成器 (方案 A 落地)
 * 守持 P0 红线：零 emoji、零裸 hex、单文件 <= 300 行。
 * 遵循 SPEC-STATIC-PAGES v2 §S-4：门户页面零脚本、零外链样式。
 */

export const SEO_ORIGIN = 'https://play.prismos.org';

export const PORTAL_SEO = {
  title: '光影Play · 好剧随时开场 - 纯净短剧与影视聚合播放终端',
  description: '光影Play（Prism Play）是一款免注册、点开即播的纯净短剧与影视聚合播放终端。支持安卓手机原生硬件解码、全景手势操作、后台与息屏播放、大屏投屏、离线缓存与多端进度同步。好剧随时开场。',
  keywords: '光影Play,Prism Play,短剧,微短剧,短剧聚合,院线电影,热血动漫,影视播放器,安卓APP下载,免注册播放器'
};

export const DOWNLOAD_SEO = {
  title: '下载光影Play · 官方安卓 APK 极速下载 - 纯净短剧播放器',
  description: '光影Play 官方安卓 APK 下载页面。免注册零门槛，不索取通讯录或相册权限，支持当前集点开即播与离线缓存。',
  keywords: '光影Play下载,光影Play安卓版,短剧播放器下载,短剧APP下载,安卓APK下载'
};

export function portalSeoTags(): string[] {
  return [
    `<meta name="description" content="${PORTAL_SEO.description}" />`,
    `<meta name="keywords" content="${PORTAL_SEO.keywords}" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:title" content="${PORTAL_SEO.title}" />`,
    `<meta property="og:description" content="${PORTAL_SEO.description}" />`,
    '<meta property="og:site_name" content="光影Play" />',
    '<meta name="twitter:card" content="summary" />',
    `<meta name="twitter:title" content="${PORTAL_SEO.title}" />`,
    `<meta name="twitter:description" content="${PORTAL_SEO.description}" />`
  ];
}

export function downloadSeoTags(): string[] {
  return [
    `<meta name="description" content="${DOWNLOAD_SEO.description}" />`,
    `<meta name="keywords" content="${DOWNLOAD_SEO.keywords}" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:title" content="${DOWNLOAD_SEO.title}" />`,
    `<meta property="og:description" content="${DOWNLOAD_SEO.description}" />`,
    '<meta property="og:site_name" content="光影Play" />'
  ];
}

export function renderRobotsTxt(): string {
  return [
    'User-agent: *',
    'Allow: /',
    'Allow: /dl',
    'Allow: /s/',
    'Allow: /privacy',
    'Disallow: /api/',
    'Disallow: /admin',
    'Disallow: /proxy/',
    '',
    `Sitemap: ${SEO_ORIGIN}/sitemap.xml`,
    ''
  ].join('\n');
}

export function renderSitemapXml(): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <url>',
    `    <loc>${SEO_ORIGIN}/</loc>`,
    '    <changefreq>daily</changefreq>',
    '    <priority>1.0</priority>',
    '  </url>',
    '  <url>',
    `    <loc>${SEO_ORIGIN}/dl</loc>`,
    '    <changefreq>weekly</changefreq>',
    '    <priority>0.8</priority>',
    '  </url>',
    '  <url>',
    `    <loc>${SEO_ORIGIN}/privacy</loc>`,
    '    <changefreq>monthly</changefreq>',
    '    <priority>0.3</priority>',
    '  </url>',
    '</urlset>',
    ''
  ].join('\n');
}
