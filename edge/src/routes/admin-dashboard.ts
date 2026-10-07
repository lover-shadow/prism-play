import type { Clock } from '../core/clock';
import type { AdminEnv } from '../auth/admin-session';
import { conversionCounts, periodUv, queryDailySeries } from '../db/analytics-repo';
import { adminJson } from './admin-auth';

function dayAt(seconds: number): string {
  return new Date((seconds + 28800) * 1000).toISOString().slice(0, 10);
}

export async function handleAdminDashboard(request: Request, env: AdminEnv, clock: Clock): Promise<Response> {
  const daysRaw = new URL(request.url).searchParams.get('days') ?? '7';
  if (!['7', '30'].includes(daysRaw)) return adminJson({ code: 'VALIDATION_ERROR' }, 400);
  const toDay = dayAt(clock.nowSeconds());
  const fromDay = dayAt(clock.nowSeconds() - (Number(daysRaw) - 1) * 86400);
  const series = await queryDailySeries(env.DB, fromDay, toDay);
  const conversion = await conversionCounts(env.DB, fromDay, toDay);
  const metadata = await env.DB.prepare('SELECT MIN(day) AS start_day,MAX(updated_at) AS updated_at FROM analytics_daily')
    .first<{ start_day: string | null; updated_at: number | null }>();
  const dimensions = await env.DB.prepare('SELECT channel,terminal,SUM(requests) AS requests,SUM(downloads) AS downloads FROM analytics_daily ' +
    'WHERE day BETWEEN ? AND ? GROUP BY channel,terminal ORDER BY requests DESC LIMIT 100').bind(fromDay, toDay).all();
  const identified = await env.DB.prepare('SELECT COUNT(*) AS events FROM analytics_visitor_days WHERE day BETWEEN ? AND ? AND page_seen=1')
    .bind(fromDay, toDay).first<{ events: number }>();
  return adminJson({ fromDay, toDay, series, dimensions: dimensions.results,
    identifiedBrowserDays: identified?.events ?? 0,
    coverageNotice: '标识记录按浏览器、日期与页面类型去重，不等于访问请求覆盖百分比',
    uv: await periodUv(env.DB, fromDay, toDay), ...conversion,
    conversionRate: conversion.pageVisitors === 0 ? null : conversion.downloadVisitors / conversion.pageVisitors,
    startedAt: metadata?.start_day ?? null, updatedAt: metadata?.updated_at ?? null,
    dataNotice: metadata?.updated_at ? '统计为尽力采集，Cookie拒绝和异步写入失败可能少计' : '尚无统计数据',
    metrics: { requests: '页面访问请求', downloads: '下载触发', uv: '可识别浏览器数' } });
}
