import { IncompleteDiscoverySearch, type DiscoveryCandidate, type DiscoveryProvider } from './discovery-provider';
import type { DiscoveryContext } from './discovery-store';
import { readDiscoveryCards } from './discovery-store';
import { readDiscoveryCard, saveDiscoveryCard } from './discovery-cards';
import { acquireDiscoveryLease, completeDiscoveryQuery, consumeDiscoveryRate, discoveryQueryKey,
  readDiscoveryQuery, releaseDiscoveryLease } from './discovery-query';
import type { DiscoveryQueryResult, DiscoveryServiceOptions } from './discovery-service';
import { searchInput } from './providers/transport';

export function createCardDiscoveryService(context: DiscoveryContext, providers: readonly DiscoveryProvider[], options: DiscoveryServiceOptions = {}) {
  const queryScope = (page: number) => JSON.stringify(['cards:v1', options.scope ?? '', providers.map((p) => p.id).sort(), page]);
  const itemsFor = async (ids: string[], q: string): Promise<DiscoveryQueryResult['items']> => {
    const items: DiscoveryQueryResult['items'] = [];
    for (const id of ids) {
      const stored = await readDiscoveryCard(context, id);
      const item = stored?.item ?? (await readDiscoveryCards(context, [id], context.nowSeconds()))[0];
      if (item) items.push({ item, matchType: item.title.normalize('NFKC').toLowerCase() === q ? 'exact' : 'related' });
    }
    return items;
  };
  return { queryScope, async query(input: string, page: number, request: Request): Promise<DiscoveryQueryResult> {
    const q = searchInput(input, page).normalize('NFKC').toLowerCase();
    const db = context.bindings.DB, now = context.nowSeconds();
    const key = await discoveryQueryKey(q, queryScope(page));
    const cached = await readDiscoveryQuery(db, key, now);
    if (cached) return { items: await itemsFor(cached.ids, q), pending: false, failed: false, hasMore: cached.ids.length > 0 && providers.some((p) => p.id === 'provider_m1') };
    const rate = await discoveryQueryKey(request.headers.get('CF-Connecting-IP') ?? 'unknown', 'cards-rate:v1');
    if (!(await consumeDiscoveryRate(db, rate.qhash, now, options.rateLimit ?? 20)).allowed) {
      return { items: [], pending: false, failed: true, hasMore: false };
    }
    const lease = await acquireDiscoveryLease(db, `query:${key.qhash}`, now, 30);
    if (!lease) return { items: [], pending: true, failed: false, hasMore: false, retryAfterSeconds: 1 };
    const ids: string[] = []; let failed = false, more = false;
    try {
      const raced = await readDiscoveryQuery(db, key, context.nowSeconds());
      if (raced) return { items: await itemsFor(raced.ids, q), pending: false, failed: false, hasMore: false };
      for (const provider of providers) {
        try {
          let candidates: DiscoveryCandidate[];
          try { candidates = await provider.search(q, page); }
          catch (error) {
            if (!(error instanceof IncompleteDiscoverySearch)) throw error;
            candidates = error.candidates; failed = true;
          }
          more ||= provider.id === 'provider_m1' && candidates.length > 0;
          for (const candidate of candidates) {
            if (candidate.providerId !== provider.id || ids.includes(candidate.id)) continue;
            if (await saveDiscoveryCard(context, candidate)) ids.push(candidate.id);
            else if ((await readDiscoveryCards(context, [candidate.id], context.nowSeconds())).length) ids.push(candidate.id);
          }
        } catch { failed = true; }
      }
      if (!failed) await completeDiscoveryQuery(db, key, lease, ids, context.nowSeconds());
      return { items: await itemsFor(ids, q), pending: false, failed, hasMore: more, providerHasMore: more };
    } finally { await releaseDiscoveryLease(db, lease); }
  } };
}
