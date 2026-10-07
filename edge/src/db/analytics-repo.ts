/**
 * 运营分析仓储（ADMIN-ANALYTICS-AND-COUPON-SPEC-AND-PLAN §2.1、§2.2）。
 *
 * 三条硬口径：
 *   1. 计数只走有限维度的原子 UPSERT，绝不读 JSON 再整列覆盖；
 *   2. 期间 UV 用 DISTINCT visitor_hash，页面/每日 UV 不可相加（跨日去重是核心不变量）；
 *   3. visitor_hash 是服务端 HMAC 摘要，本层不接触原始 Cookie、不做浏览器指纹补偿。
 *
 * 写入仅在成功响应后经 ctx.waitUntil 触发；本层保持纯 SQL，失败交由上层静默降级，
 * 不参与会员 / 私密授权判定路径。
 */

export type AnalyticsSurface = 'portal' | 'dl' | 'share';
export type AnalyticsTerminal = 'wechat' | 'android' | 'windows' | 'other';
export type AnalyticsKind = 'page' | 'download';

export interface AnalyticsEvent {
  readonly day: string;
  readonly surface: AnalyticsSurface;
  readonly channel: string;
  readonly terminal: AnalyticsTerminal;
  readonly kind: AnalyticsKind;
  readonly visitorHash: string | null;
}

export interface DailyRow {
  readonly day: string;
  readonly requests: number;
  readonly downloads: number;
}

function dailyUpsert(db: D1Database, event: AnalyticsEvent, nowSeconds: number): D1PreparedStatement {
  const increment = event.kind === 'page' ? { requests: 1, downloads: 0 } : { requests: 0, downloads: 1 };
  return db
    .prepare(
      'INSERT INTO analytics_daily (day, surface, channel, terminal, requests, downloads, updated_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(day, surface, channel, terminal) DO UPDATE SET ' +
        'requests = requests + excluded.requests, downloads = downloads + excluded.downloads, updated_at = excluded.updated_at'
    )
    .bind(event.day, event.surface, event.channel, event.terminal, increment.requests, increment.downloads, nowSeconds);
}

function visitorUpsert(db: D1Database, event: AnalyticsEvent, nowSeconds: number): D1PreparedStatement {
  // first_seen_day / first_channel 冻结后不覆盖，只推进 last_seen_at。
  return db
    .prepare(
      'INSERT INTO analytics_visitors (visitor_hash, first_seen_day, last_seen_at, first_channel) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(visitor_hash) DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)'
    )
    .bind(event.visitorHash, event.day, nowSeconds, event.channel);
}

function visitorDayUpsert(db: D1Database, event: AnalyticsEvent, nowSeconds: number): D1PreparedStatement {
  const pageSeen = event.kind === 'page' ? 1 : 0;
  const downloadSeen = event.kind === 'download' ? 1 : 0;
  // 同 (day,visitor,surface) 反复可见只把布尔位“或”上去，不重复计数。
  return db
    .prepare(
      'INSERT INTO analytics_visitor_days (day, visitor_hash, surface, page_seen, download_seen, last_seen_at) ' +
        'VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(day, visitor_hash, surface) DO UPDATE SET ' +
        'page_seen = page_seen | excluded.page_seen, download_seen = download_seen | excluded.download_seen, ' +
        'last_seen_at = MAX(last_seen_at, excluded.last_seen_at)'
    )
    .bind(event.day, event.visitorHash, event.surface, pageSeen, downloadSeen, nowSeconds);
}

/** 一条被计数的事件 = 聚合行 +（可选）标识建档 +（可选）去重事实，单原子批。 */
export async function recordAnalytics(db: D1Database, event: AnalyticsEvent, nowSeconds: number): Promise<void> {
  const statements: D1PreparedStatement[] = [dailyUpsert(db, event, nowSeconds)];
  if (event.visitorHash !== null) {
    statements.push(visitorUpsert(db, event, nowSeconds), visitorDayUpsert(db, event, nowSeconds));
  }
  await db.batch(statements);
}

export async function queryDailySeries(db: D1Database, fromDay: string, toDay: string): Promise<DailyRow[]> {
  const result = await db
    .prepare(
      'SELECT day, SUM(requests) AS requests, SUM(downloads) AS downloads FROM analytics_daily ' +
        'WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day'
    )
    .bind(fromDay, toDay)
    .all<{ day: string; requests: number; downloads: number }>();
  return result.results.map((row) => ({ day: row.day, requests: Number(row.requests), downloads: Number(row.downloads) }));
}

/** 期间 UV：跨日 DISTINCT，绝不把每日 UV 相加。surface 省略则合并所有 surface 去重。 */
export async function periodUv(
  db: D1Database,
  fromDay: string,
  toDay: string,
  surface?: AnalyticsSurface
): Promise<number> {
  const sql =
    surface === undefined
      ? 'SELECT COUNT(DISTINCT visitor_hash) AS n FROM analytics_visitor_days WHERE day BETWEEN ? AND ?'
      : 'SELECT COUNT(DISTINCT visitor_hash) AS n FROM analytics_visitor_days WHERE day BETWEEN ? AND ? AND surface = ?';
  const statement = surface === undefined ? db.prepare(sql).bind(fromDay, toDay) : db.prepare(sql).bind(fromDay, toDay, surface);
  const row = await statement.first<{ n: number }>();
  return Number(row?.n ?? 0);
}

export interface ConversionCounts {
  readonly pageVisitors: number;
  readonly downloadVisitors: number;
}

/** 转化是同期间“看过页面”与“触发过下载”两组 DISTINCT 标识的交集口径（分母另给）。 */
export async function conversionCounts(db: D1Database, fromDay: string, toDay: string): Promise<ConversionCounts> {
  const pageRow = await db
    .prepare('SELECT COUNT(DISTINCT visitor_hash) AS n FROM analytics_visitor_days WHERE day BETWEEN ? AND ? AND page_seen = 1')
    .bind(fromDay, toDay)
    .first<{ n: number }>();
  const downloadRow = await db
    .prepare(
      'SELECT COUNT(DISTINCT downloads.visitor_hash) AS n FROM analytics_visitor_days downloads ' +
        'WHERE downloads.day BETWEEN ? AND ? AND downloads.download_seen = 1 AND EXISTS (' +
        'SELECT 1 FROM analytics_visitor_days pages WHERE pages.visitor_hash = downloads.visitor_hash ' +
        'AND pages.day BETWEEN ? AND ? AND pages.page_seen = 1)'
    )
    .bind(fromDay, toDay, fromDay, toDay)
    .first<{ n: number }>();
  return { pageVisitors: Number(pageRow?.n ?? 0), downloadVisitors: Number(downloadRow?.n ?? 0) };
}

/** 新浏览器：首见日恰为该日（不是新增安装）。 */
export async function newBrowserCount(db: D1Database, day: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM analytics_visitors WHERE first_seen_day = ?').bind(day).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** 回访浏览器：当日可见且首见日早于当日（口径来自冻结的 first_seen_day，不读 Cookie）。 */
export async function returningBrowserCount(db: D1Database, day: string): Promise<number> {
  const row = await db
    .prepare(
      'SELECT COUNT(DISTINCT vd.visitor_hash) AS n FROM analytics_visitor_days vd ' +
        'JOIN analytics_visitors v ON v.visitor_hash = vd.visitor_hash WHERE vd.day = ? AND v.first_seen_day < ?'
    )
    .bind(day, day)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** 撤回同意：删除标识与去重记录；匿名每日聚合不追溯重写（计划 §2.1-7）。 */
export async function deleteVisitor(db: D1Database, visitorHash: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM analytics_visitor_days WHERE visitor_hash = ?').bind(visitorHash),
    db.prepare('DELETE FROM analytics_visitors WHERE visitor_hash = ?').bind(visitorHash)
  ]);
}
