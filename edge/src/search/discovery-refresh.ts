import type { DiscoveryProvider } from './discovery-provider';
import type { DiscoveryContext } from './discovery-store';
import { publishDiscoveryFact } from './discovery-store';
import { acquireDiscoveryLease, discoveryQueryKey, releaseDiscoveryLease } from './discovery-query';
import { claimDiscoveryJob, initializeDiscoveryJobs, readDiscoveryCursor, readDiscoveryJobs, safeDiscoveryCandidate, saveDiscoveryJob } from './discovery-jobs';

interface RefreshRow { work_id: string; provider_id: string; source_id: string; card_json: string; updated_at: number; fact_hash: string }
const PUBLIC_CHANNELS = ['drama', 'movie', 'anime', 'documentary'];
export interface RefreshReport { examined: number; published: number; pending: number; failed: number }

export async function refreshDiscoveryWorks(context: DiscoveryContext, providers: readonly DiscoveryProvider[], limit = 2, workId?: string): Promise<RefreshReport> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error('Invalid refresh batch');
  const db = context.bindings.DB, now = context.nowSeconds();
  const rows = (await db.prepare(`SELECT work_id, provider_id, source_id, card_json, updated_at, fact_hash FROM discovery_works
    WHERE enabled = 1 AND (? IS NULL OR work_id = ?)
      AND updated_at <= ? - CASE WHEN json_extract(card_json, '$.releaseStatus') = 'ongoing' THEN 1800 ELSE 21600 END
      AND NOT EXISTS (SELECT 1 FROM discovery_jobs j WHERE j.work_id = discovery_works.work_id
        AND j.status = 'failed' AND j.updated_at > ?)
    ORDER BY COALESCE((SELECT MAX(j.updated_at) FROM discovery_jobs j
      WHERE j.work_id = discovery_works.work_id AND j.status = 'pending'), updated_at), work_id LIMIT ?`)
    .bind(workId ?? null, workId ?? null, now, now - 3600, limit).all<RefreshRow>()).results;
  const report: RefreshReport = { examined: 0, published: 0, pending: 0, failed: 0 };
  for (const row of rows) {
    const provider = providers.find((entry) => entry.id === row.provider_id);
    if (!provider) continue;
    const key = await discoveryQueryKey(row.work_id, 'public-refresh:v1');
    const lease = await acquireDiscoveryLease(db, `query:${key.qhash}`, context.nowSeconds(), 300);
    if (!lease) { report.pending++; continue; }
    report.examined++;
    try {
      const card = JSON.parse(row.card_json);
      if (card.isPrivate !== false || !PUBLIC_CHANNELS.includes(card.channelId)) throw new Error('Invalid public refresh card');
      const candidate = safeDiscoveryCandidate({ providerId: provider.id, sourceItemId: row.source_id,
        id: row.work_id, title: card.title, channelId: card.channelId, category: card.category, isAi: card.isAi });
      const authority = await context.authority({ workId: row.work_id, providerId: provider.id, sourceId: row.source_id });
      if (authority.authoritative && !authority.overlayEligible) continue;
      let job = (await readDiscoveryJobs(db, key.qhash))[0];
      if (!job || job.status !== 'pending') {
        if (!await initializeDiscoveryJobs(db, key, lease, [{ candidate, workId: row.work_id }], false, false, context.nowSeconds())) {
          report.pending++; continue;
        }
        job = (await readDiscoveryJobs(db, key.qhash))[0];
      }
      if (!job || !await claimDiscoveryJob(db, job, lease, context.nowSeconds())) { report.pending++; continue; }
      const resolved = await provider.resolve(candidate, await readDiscoveryCursor(context, job.cursor_key), { maxRequests: 8, timeoutMs: 15000 });
      if (resolved.status === 'progress') {
        await saveDiscoveryJob(context, job, lease, 'pending', resolved.cursor); report.pending++;
      } else if (resolved.status === 'blocked') {
        await saveDiscoveryJob(context, job, lease, 'failed'); report.failed++;
      } else {
        const fact = resolved.fact;
        if (fact.id !== candidate.id || fact.providerId !== provider.id || fact.sourceItemId !== candidate.sourceItemId || fact.channelId !== candidate.channelId || fact.title !== candidate.title || fact.isPrivate !== false ||
            (Number.isInteger(card.episodeCount) && fact.episodeCount < card.episodeCount)) {
          throw new Error('Refresh identity mismatch');
        }
        const published = await publishDiscoveryFact(context, provider.id, row.source_id,
          { ...fact, workId: row.work_id, generatedAt: context.nowSeconds(), lastSyncedEpisode: fact.episodes.length,
            lastSyncedAt: context.nowSeconds(), category: fact.category ?? '' },
          context.nowSeconds(), 86400, row.work_id, row.updated_at, row.fact_hash);
        const status = published.status === 'published' ? 'published' : published.status === 'busy' || published.status === 'superseded' ? 'pending' : 'failed';
        await saveDiscoveryJob(context, job, lease, status);
        if (status === 'published') report.published++; else if (status === 'pending') report.pending++; else report.failed++;
      }
    } catch {
      const failedJob = (await readDiscoveryJobs(db, key.qhash))[0];
      if (failedJob) await saveDiscoveryJob(context, failedJob, lease, 'failed');
      report.failed++;
    }
    finally { await releaseDiscoveryLease(db, lease); }
  }
  return report;
}
