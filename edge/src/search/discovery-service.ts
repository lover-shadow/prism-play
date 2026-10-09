import type { SearchResult } from '../types/api';
import { discoveryCanonicalId } from './discovery-facts';
import { IncompleteDiscoverySearch, type DiscoveryCandidate, type DiscoveryProvider } from './discovery-provider';
import { acquireDiscoveryLease, completeDiscoveryQuery, consumeDiscoveryRate, discoveryQueryKey,
  readDiscoveryQuery, releaseDiscoveryLease } from './discovery-query';
import { publishDiscoveryFact, readDiscoveryCards, readDiscoveryFact, type DiscoveryContext } from './discovery-store';
import { claimDiscoveryJob, finishDiscoveryJobs, initializeDiscoveryJobs, readDiscoveryCursor,
  readDiscoveryJobQuery, readDiscoveryJobs, safeDiscoveryCandidate, saveDiscoveryJob } from './discovery-jobs';
import { searchInput } from './providers/transport';

export interface DiscoveryQueryResult {
  items: SearchResult[]; pending: boolean; failed: boolean; hasMore: boolean;
  retryAfterSeconds?: number;
  /** Source pagination only; pending does not mean another source page. */
  providerHasMore?: boolean;
}
export interface DiscoveryServiceOptions {
  scope?: string;
  rateLimit?: number;
  pollRateLimit?: number;
}
export interface DiscoveryService {
  query(q: string, page: number, request: Request): Promise<DiscoveryQueryResult>;
  queryScope(page: number): string;
}
const normalize = (text: string) => text.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');

/** Every poll advances one durable job with an eight-request resolve budget, across isolates.
 * Query TTL and complete fact TTL are independent; eligible baselines refresh only stale full facts.
 */
export function createDiscoveryService(context: DiscoveryContext, providers: readonly DiscoveryProvider[],
  options: DiscoveryServiceOptions = {}): DiscoveryService {
  if (providers.length > 2 || new Set(providers.map((p) => p.id)).size !== providers.length) throw new Error('Invalid discovery providers');
  const queryScope = (page: number) => JSON.stringify(['public:v2', options.scope ?? '', providers.map((p) => p.id).sort(), page]);
  const result = async (ids: readonly string[], q: string, pending: boolean, failed: boolean,
    more = false): Promise<DiscoveryQueryResult> => {
    const cards = await readDiscoveryCards(context, ids, context.nowSeconds());
    return { items: cards.map((item) => ({ item, matchType: normalize(item.title) === normalize(q) ? 'exact' : 'related' })),
      pending, failed, hasMore: more, ...(more ? { providerHasMore: more } : {}), ...(pending ? { retryAfterSeconds: 1 } : {}) };
  };
  return { queryScope, async query(input, page, request) {
    let lease: Awaited<ReturnType<typeof acquireDiscoveryLease>> = null;
    let ids: string[] = [], q = '', more = false;
    try {
      q = normalize(searchInput(input, page));
      if (!providers.length) return await result([], q, false, false);
      const db = context.bindings.DB, key = await discoveryQueryKey(q, queryScope(page));
      let queue = await readDiscoveryJobQuery(db, key);
      more = queue?.provider_has_more === 1;
      const cached = await readDiscoveryQuery(db, key, context.nowSeconds());
      if (cached) {
        const hit = await result(cached.ids, q, false, false, more);
        if (hit.items.length === cached.ids.length) return hit;
      }
      const snapshot = async () => {
        const jobs = await readDiscoveryJobs(db, key.qhash);
        ids = jobs.filter((job) => job.status === 'published').map((job) => job.work_id);
        return jobs;
      };
      if (queue) await snapshot();
      const rate = await discoveryQueryKey(request.headers.get('CF-Connecting-IP') || 'unknown', 'discovery-rate:v1');
      // Platform IP only; polls do not spend the lower initialization budget.
      if (!(await consumeDiscoveryRate(db, `discovery-poll:${rate.qhash}`, context.nowSeconds(), options.pollRateLimit ?? 240)).allowed) {
        return await result(ids, q, queue?.status === 'pending', true, more);
      }
      lease = await acquireDiscoveryLease(db, `query:${key.qhash}`, context.nowSeconds(), 300);
      if (!lease) return await result(ids, q, true, false, more);
      queue = await readDiscoveryJobQuery(db, key);
      const raced = await readDiscoveryQuery(db, key, context.nowSeconds());
      if (raced) {
        const hit = await result(raced.ids, q, false, false, queue?.provider_has_more === 1);
        if (hit.items.length === raced.ids.length) return hit;
      }
      // Pending jobs survive query TTL; only terminal snapshots are refreshed by search.
      if (!queue || (queue.status !== 'pending' && queue.expires_at <= context.nowSeconds()) || queue.status === 'complete') {
        if (!(await consumeDiscoveryRate(db, `discovery:${rate.qhash}`, context.nowSeconds(), options.rateLimit ?? 20)).allowed) {
          return await result(ids, q, false, true, more);
        }
        const candidates: { candidate: ReturnType<typeof safeDiscoveryCandidate>; workId: string }[] = [];
        const seen = new Set<string>();
        let searchFailed = false;
        more = false;
        for (const provider of providers) {
          try {
            let found: DiscoveryCandidate[];
            try { found = await provider.search(q, page); }
            catch (error) {
              if (!(error instanceof IncompleteDiscoverySearch)) throw error;
              found = error.candidates; searchFailed = true;
            }
            if (found.length > 256) throw new Error('Too many discovery candidates');
            // m1 has no source pagination signal yet: conservatively offer another page.
            more ||= found.length > 0 && provider.id === 'provider_m1';
            for (const raw of found) {
              try {
                const candidate = safeDiscoveryCandidate(raw);
                if (candidate.providerId !== provider.id) throw new Error('Discovery provider mismatch');
                const workId = candidate.id;
                if (!discoveryCanonicalId(provider.id, candidate.sourceItemId, workId)) throw new Error('Invalid canonical discovery identity');
                if (seen.has(workId)) continue;
                if (candidates.length >= 256) throw new Error('Too many discovery candidates');
                seen.add(workId); candidates.push({ candidate, workId });
              } catch { searchFailed = true; }
            }
          } catch { searchFailed = true; }
        }
        if (!await initializeDiscoveryJobs(db, key, lease, candidates, searchFailed, more, context.nowSeconds())) {
          return await result(ids, q, true, false, more);
        }
        queue = await readDiscoveryJobQuery(db, key);
      }
      more = queue?.provider_has_more === 1;
      let jobs = await snapshot();
      if (queue?.status === 'failed') return await result(ids, q, false, true, more);
      const job = jobs.find((entry) => entry.status === 'pending');
      if (job) {
        if (!await claimDiscoveryJob(db, job, lease, context.nowSeconds())) return await result(ids, q, true, false, more);
        try {
          const candidate = safeDiscoveryCandidate(JSON.parse(job.candidate_json));
          const provider = providers.find((entry) => entry.id === job.provider_id);
          if (!provider) throw new Error('Missing discovery provider');
          const authority = await context.authority({ workId: job.work_id, providerId: provider.id, sourceId: candidate.sourceItemId });
          const existing = await readDiscoveryFact(context, job.work_id, context.nowSeconds());
          if (authority.authoritative && !authority.overlayEligible) {
            await saveDiscoveryJob(context, job, lease, authority.read.status === 'rejected' ? 'failed' : 'skipped');
          } else if (existing.status === 'ok' && (!authority.authoritative ||
            (authority.read.status === 'ok' && existing.fact.asset.generatedAt > authority.read.fact.asset.generatedAt))) {
            await saveDiscoveryJob(context, job, lease, 'published');
          } else {
            const resolved = await provider.resolve(candidate, await readDiscoveryCursor(context, job.cursor_key),
              { maxRequests: 8, timeoutMs: 15000 });
            if (resolved.status === 'progress') await saveDiscoveryJob(context, job, lease, 'pending', resolved.cursor);
            else if (resolved.status === 'blocked') await saveDiscoveryJob(context, job, lease, 'failed');
            else {
              const fact = resolved.fact;
              if (fact.providerId !== provider.id || fact.sourceItemId !== candidate.sourceItemId ||
                fact.id !== candidate.id || fact.channelId !== candidate.channelId) throw new Error('Discovery identity mismatch');
              const published = await publishDiscoveryFact(context, provider.id, candidate.sourceItemId,
                { ...fact, id: job.work_id, workId: job.work_id, generatedAt: context.nowSeconds(),
                  lastSyncedEpisode: fact.episodes.length, lastSyncedAt: context.nowSeconds(), category: fact.category ?? '' },
                context.nowSeconds(), 86400, candidate.id);
              await saveDiscoveryJob(context, job, lease, published.status === 'published' ? 'published' :
                published.status === 'baseline' ? 'skipped' : published.status === 'rejected' ? 'failed' : 'pending');
            }
          }
        } catch (err) {
          console.error('[discovery-service] Job failed:', job.job_id, err instanceof Error ? err.message : String(err), err instanceof Error ? err.stack : '');
          await saveDiscoveryJob(context, job, lease, 'failed');
        }
      }
      jobs = await snapshot();
      let pending = jobs.some((entry) => entry.status === 'pending');
      const failed = queue?.search_failed === 1 || jobs.some((entry) => entry.status === 'failed');
      if (!pending) {
        const now = context.nowSeconds();
        if (!await finishDiscoveryJobs(db, key, lease, failed, failed || !ids.length ? 30 : 300, now)) pending = true;
        else if (!failed && !await completeDiscoveryQuery(db, key, lease, ids, now)) pending = true;
      }
      return await result(ids, q, pending, failed, more);
    } catch { return await result(ids, q, false, true, more); }
    finally { if (lease) await releaseDiscoveryLease(context.bindings.DB, lease); }
  } };
}
