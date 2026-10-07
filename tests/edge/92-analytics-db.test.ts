import { describe, expect, it } from 'vitest';
import { createTestEnv } from '../support/test-env';
import {
  recordAnalytics,
  periodUv,
  conversionCounts,
  newBrowserCount,
  returningBrowserCount,
  queryDailySeries,
  type AnalyticsEvent
} from '../../edge/src/db/analytics-repo';

const NOW = 1_767_225_600;
const DAY_SECONDS = 86400;
const D1 = '2026-01-01';
const D2 = '2026-01-02';

function pageEvent(visitorHash: string | null, day: string): AnalyticsEvent {
  return { day, surface: 'portal', channel: 'unknown', terminal: 'android', kind: 'page', visitorHash };
}

describe('analytics repo — anonymous aggregation without a visitor id', () => {
  it('counts requests even when the visitor id is absent', async () => {
    const env = await createTestEnv();
    await recordAnalytics(env.DB, pageEvent(null, D1), NOW);
    await recordAnalytics(env.DB, pageEvent(null, D1), NOW);
    const series = await queryDailySeries(env.DB, D1, D1);
    expect(series.reduce((sum, row) => sum + row.requests, 0)).toBe(2);
    expect(await periodUv(env.DB, D1, D1)).toBe(0);
  });
});

describe('analytics repo — UV is DISTINCT over the period, never summed per day', () => {
  it('one browser seen on two days counts once for the range', async () => {
    const env = await createTestEnv();
    await recordAnalytics(env.DB, pageEvent('hash-A', D1), NOW);
    await recordAnalytics(env.DB, pageEvent('hash-A', D2), NOW + DAY_SECONDS);
    await recordAnalytics(env.DB, pageEvent('hash-B', D2), NOW + DAY_SECONDS);

    expect(await periodUv(env.DB, D1, D1)).toBe(1);
    expect(await periodUv(env.DB, D2, D2)).toBe(2);
    // The whole point: 1 + 2 per-day would wrongly read 3; the true period UV is 2.
    expect(await periodUv(env.DB, D1, D2)).toBe(2);
  });
});

describe('analytics repo — conversion is an intersection of the same browsers', () => {
  it('counts a browser that both viewed and triggered download exactly once', async () => {
    const env = await createTestEnv();
    await recordAnalytics(env.DB, pageEvent('hash-A', D1), NOW);
    await recordAnalytics(
      env.DB,
      { day: D1, surface: 'dl', channel: 'unknown', terminal: 'android', kind: 'download', visitorHash: 'hash-A' },
      NOW
    );
    await recordAnalytics(env.DB, pageEvent('hash-B', D1), NOW);

    const counts = await conversionCounts(env.DB, D1, D1);
    expect(counts.pageVisitors).toBe(2);
    expect(counts.downloadVisitors).toBe(1);
  });

  it('excludes download-only visitors from the numerator', async () => {
    const env = await createTestEnv();
    await recordAnalytics(env.DB, pageEvent('hash-page', D1), NOW);
    await recordAnalytics(env.DB, { ...pageEvent('hash-download', D1), surface: 'dl', kind: 'download' }, NOW);

    expect(await conversionCounts(env.DB, D1, D1)).toEqual({ pageVisitors: 1, downloadVisitors: 0 });
  });

  it('includes the same-period intersection across days and surfaces only once', async () => {
    const env = await createTestEnv();
    await recordAnalytics(env.DB, pageEvent('hash-A', D1), NOW);
    await recordAnalytics(env.DB, { ...pageEvent('hash-A', D2), surface: 'dl', kind: 'download' }, NOW + DAY_SECONDS);
    await recordAnalytics(env.DB, { ...pageEvent('hash-A', D2), surface: 'share', kind: 'download' }, NOW + DAY_SECONDS);

    expect(await conversionCounts(env.DB, D1, D2)).toEqual({ pageVisitors: 1, downloadVisitors: 1 });
  });

  it.each([
    ['2025-12-31', NOW - DAY_SECONDS],
    [D2, NOW + DAY_SECONDS]
  ])('excludes a page seen outside the period on %s', async (day, timestamp) => {
    const env = await createTestEnv();
    await recordAnalytics(env.DB, pageEvent('hash-A', day), timestamp);
    await recordAnalytics(env.DB, { ...pageEvent('hash-A', D1), surface: 'dl', kind: 'download' }, NOW);

    expect(await conversionCounts(env.DB, D1, D1)).toEqual({ pageVisitors: 0, downloadVisitors: 0 });
  });
});

describe('analytics repo — last_seen_at is monotonic', () => {
  it('preserves both visitor timestamps when an older event arrives last', async () => {
    const env = await createTestEnv();
    await recordAnalytics(env.DB, pageEvent('hash-A', D1), NOW + 100);
    await recordAnalytics(env.DB, { ...pageEvent('hash-A', D1), kind: 'download', channel: 'late' }, NOW);

    const visitor = await env.DB.prepare(
      'SELECT last_seen_at, first_seen_day, first_channel FROM analytics_visitors WHERE visitor_hash = ?'
    ).bind('hash-A').first();
    const visitorDay = await env.DB.prepare(
      'SELECT last_seen_at, page_seen, download_seen FROM analytics_visitor_days WHERE visitor_hash = ? AND day = ? AND surface = ?'
    ).bind('hash-A', D1, 'portal').first();

    expect(visitor).toEqual({ last_seen_at: NOW + 100, first_seen_day: D1, first_channel: 'unknown' });
    expect(visitorDay).toEqual({ last_seen_at: NOW + 100, page_seen: 1, download_seen: 1 });
  });
});

describe('analytics repo — new vs returning browsers use the frozen first_seen_day', () => {
  it('classifies by first-seen day, not by cookie contents', async () => {
    const env = await createTestEnv();
    await recordAnalytics(env.DB, pageEvent('hash-A', D1), NOW);
    await recordAnalytics(env.DB, pageEvent('hash-A', D2), NOW + DAY_SECONDS);
    await recordAnalytics(env.DB, pageEvent('hash-C', D2), NOW + DAY_SECONDS);

    expect(await newBrowserCount(env.DB, D1)).toBe(1);
    expect(await newBrowserCount(env.DB, D2)).toBe(1);
    expect(await returningBrowserCount(env.DB, D2)).toBe(1);
  });
});

describe('analytics repo — consent withdrawal deletes the browser record', () => {
  it('removes visitor and its day rows, leaving anonymous aggregates intact', async () => {
    const env = await createTestEnv();
    await recordAnalytics(env.DB, pageEvent('hash-X', D1), NOW);
    expect(await periodUv(env.DB, D1, D1)).toBe(1);
    const { deleteVisitor } = await import('../../edge/src/db/analytics-repo');
    await deleteVisitor(env.DB, 'hash-X');
    expect(env.db.count('analytics_visitor_days')).toBe(0);
    expect(await periodUv(env.DB, D1, D1)).toBe(0);
    const series = await queryDailySeries(env.DB, D1, D1);
    expect(series.reduce((sum, row) => sum + row.requests, 0)).toBe(1);
  });
});
