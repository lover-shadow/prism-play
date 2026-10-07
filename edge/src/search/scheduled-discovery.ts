import type { Env } from '../types/env';
import type { Clock } from '../core/clock';
import { readPublicManifest } from '../library/manifest';
import { readDiscoveryConfig, createDiscoveryProviders } from './discovery-config';
import type { DiscoveryService } from './discovery-service';
import { publicDiscoveryContext } from './public-facts';
import { refreshDiscoveryWorks, type RefreshReport } from './discovery-refresh';

export async function resumePendingDiscoveryQueries(db: D1Database, service: DiscoveryService,
  nowSeconds = () => Math.floor(Date.now() / 1000)): Promise<number> {
  const scopes = [...new Set(Array.from({ length: 100 }, (_, index) => service.queryScope(index + 1)))];
  const rows = (await db.prepare(`SELECT qhash, normalized_key FROM discovery_job_queries
    WHERE status = 'pending' AND json_valid(normalized_key)
      AND json_extract(normalized_key, '$[0]') IN (${scopes.map(() => '?').join(',')})
    ORDER BY updated_at, qhash LIMIT 32`).bind(...scopes).all<{ qhash: string; normalized_key: string }>()).results;
  let resumed = 0;
  for (const row of rows) {
    if (resumed >= 2) break;
    let input: unknown;
    try { input = JSON.parse(row.normalized_key); } catch { continue; }
    if (!Array.isArray(input) || input.length !== 2 || typeof input[0] !== 'string' || typeof input[1] !== 'string') continue;
    let scope: unknown;
    try { scope = JSON.parse(input[0]); } catch { continue; }
    if (!Array.isArray(scope) || !Number.isInteger(scope[3]) || scope[3] < 1 || scope[3] > 100 || service.queryScope(scope[3]) !== input[0]) continue;
    await service.query(input[1], scope[3], new Request('https://scheduled.invalid/search', { headers: { 'CF-Connecting-IP': 'scheduled-discovery' } }));
    await db.prepare(`UPDATE discovery_job_queries SET updated_at = ? WHERE qhash = ? AND status = 'pending'`)
      .bind(nowSeconds(), row.qhash).run();
    resumed++;
  }
  return resumed;
}

export async function refreshOpenedPublicWork(request: Request, response: Response, env: Env, clock: Clock): Promise<void> {
  if (env.SEARCH_DISCOVERY_ENABLED !== 'true' || !env.DISCOVERY_BUCKET || response.status !== 200 || request.method !== 'GET') return;
  const match = /^\/api\/titles\/([A-Za-z0-9_.:-]{1,128})$/.exec(new URL(request.url).pathname);
  if (!match) return;
  const body = await response.json() as { workId?: string; item?: { isPrivate?: boolean; channelId?: string; releaseStatus?: string; lastSyncedAt?: number } };
  const item = body.item;
  if (body.workId !== match[1] || item?.isPrivate !== false || item.channelId === 'private' || item.releaseStatus !== 'ongoing' ||
      !Number.isSafeInteger(item.lastSyncedAt) || clock.nowSeconds() - Number(item.lastSyncedAt) < 1800) return;
  const manifest = await readPublicManifest(env.KV);
  if (!manifest?.workFacts) return;
  const context = publicDiscoveryContext(env, manifest, () => clock.nowSeconds());
  await refreshDiscoveryWorks(context, createDiscoveryProviders(readDiscoveryConfig(env)), 1, body.workId);
}

export async function runScheduledDiscoveryRefresh(env: Env, clock: Clock): Promise<RefreshReport> {
  const idle = { examined: 0, published: 0, pending: 0, failed: 0 };
  if (env.SEARCH_DISCOVERY_ENABLED !== 'true' || !env.DISCOVERY_BUCKET) return idle;
  const manifest = await readPublicManifest(env.KV);
  if (!manifest?.workFacts) return idle;
  const providers = createDiscoveryProviders(readDiscoveryConfig(env));
  const context = publicDiscoveryContext(env, manifest, () => clock.nowSeconds());
  return refreshDiscoveryWorks(context, providers);
}
