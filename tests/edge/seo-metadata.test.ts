import { describe, expect, it } from 'vitest';
import worker from '../../edge/src/index';
import { renderLandingPage } from '../../edge/src/html/landing-page';
import { renderAndroidDownloadPage } from '../../edge/src/html/dl-page';
import { createTestEnv, type PrismTestEnv } from '../support/test-env';

const ORIGIN = 'https://play.prismos.org';
const ctx = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined
};

async function req(env: PrismTestEnv, path: string, method = 'GET'): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method }), env, ctx);
}

describe('官网 SEO 基础设施 (方案 A 落地)', () => {
  it('GET /robots.txt 规范开放公开页面并屏蔽敏感目录', async () => {
    const env = await createTestEnv();
    const res = await req(env, '/robots.txt');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/plain');
    const text = await res.text();
    expect(text).toContain('User-agent: *');
    expect(text).toContain('Allow: /');
    expect(text).toContain('Allow: /dl');
    expect(text).toContain('Allow: /s/');
    expect(text).toContain('Disallow: /api/');
    expect(text).toContain('Disallow: /admin');
    expect(text).toContain('Disallow: /proxy/');
    expect(text).toContain('Sitemap: https://play.prismos.org/sitemap.xml');
  });

  it('非 GET 请求 /robots.txt 与 /sitemap.xml 严格返回 405', async () => {
    const env = await createTestEnv();
    const res1 = await req(env, '/robots.txt', 'POST');
    expect(res1.status).toBe(405);
    expect(res1.headers.get('Allow')).toBe('GET');

    const res2 = await req(env, '/sitemap.xml', 'POST');
    expect(res2.status).toBe(405);
    expect(res2.headers.get('Allow')).toBe('GET');
  });

  it('GET /sitemap.xml 返回标准 XML 站点地图包含主页与下载页', async () => {
    const env = await createTestEnv();
    const res = await req(env, '/sitemap.xml');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('xml');
    const xml = await res.text();
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('<loc>https://play.prismos.org/</loc>');
    expect(xml).toContain('<loc>https://play.prismos.org/dl</loc>');
    expect(xml).toContain('<loc>https://play.prismos.org/privacy</loc>');
  });

  it('官网首页包含结构化 TDK 与 OpenGraph，同时遵守零脚本规范', () => {
    const html = renderLandingPage({ release: { versionName: '2.6.7', versionCode: 21607 }, apkSizeBytes: 36000000 });
    expect(html).toContain('<meta name="description"');
    expect(html).toContain('短剧');
    expect(html).toContain('影视');
    expect(html).toContain('<meta name="keywords"');
    expect(html).toContain('光影Play');
    expect(html).toContain('<meta property="og:title"');
    expect(html).toContain('<meta property="og:type" content="website" />');
    expect(html).not.toContain('<script');
  });

  it('下载落地页包含对应 SEO 描述与 OpenGraph', () => {
    const html = renderAndroidDownloadPage({});
    expect(html).toContain('<meta name="description"');
    expect(html).toContain('<meta property="og:title"');
  });
});
