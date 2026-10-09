/**
 * 搜索引擎爬虫协议 (robots.txt) 与站点地图 (sitemap.xml) 路由处理器
 * 遵守 P0 红线：零 emoji、零裸 hex、单文件 <= 300 行。
 */
import type { Clock } from '../core/clock';
import type { Env } from '../types/env';
import { renderRobotsTxt, renderSitemapXml } from '../html/seo-meta';

const ROBOTS_CACHE_CONTROL = 'public, max-age=86400';
const SITEMAP_CACHE_CONTROL = 'public, max-age=86400';

export async function handleRobots(_request: Request, _env: Env, _clock: Clock): Promise<Response> {
  return new Response(renderRobotsTxt(), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': ROBOTS_CACHE_CONTROL,
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

export async function handleSitemap(_request: Request, _env: Env, _clock: Clock): Promise<Response> {
  return new Response(renderSitemapXml(), {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': SITEMAP_CACHE_CONTROL,
      'X-Content-Type-Options': 'nosniff'
    }
  });
}
