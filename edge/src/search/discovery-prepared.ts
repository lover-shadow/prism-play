import type { DiscoveryBudget, DiscoveryConfig, DiscoveryProviderId } from './discovery-provider';
import type { DiscoveryContext } from './discovery-store';
import { publishDiscoveryFact } from './discovery-store';
import { readDiscoveryCard } from './discovery-cards';
import { validateDiscoveryFact, type ValidatedDiscoveryFact } from './discovery-facts';
import { resolveS1Directory } from './providers/s1-directory';
import { createM1Provider } from './providers/m1';
import { DISCOVERY_FRONT_BUDGET } from './discovery-budget';
import type { DiscoveryLease } from './discovery-query';

/** A complete validated public fact in RAM, not a published pointer or a partial catalogue. */
export interface PreparedDiscovery {
  validated: ValidatedDiscoveryFact;
  candidateJson: string;
  publish(parentLease?: DiscoveryLease): Promise<void>;
}
export async function prepareCardDetail(context: DiscoveryContext, workId: string,
  configs: Partial<Record<DiscoveryProviderId, DiscoveryConfig>>,
  budget: Readonly<DiscoveryBudget> = DISCOVERY_FRONT_BUDGET): Promise<PreparedDiscovery | null> {
  const stored = await readDiscoveryCard(context, workId);
  if (!stored) return null;
  const candidate = stored.candidate, config = configs[candidate.providerId];
  if (!config) throw new Error('Discovery provider unavailable');
  const result = candidate.providerId === 'provider_s1'
    ? { status: 'complete' as const, fact: await resolveS1Directory(candidate, config, budget) }
    : await createM1Provider(config).resolve(candidate, undefined, budget);
  if (result.status !== 'complete') throw new Error('Discovery detail unavailable');
  const fact = result.fact;
  if (fact.id !== candidate.id || fact.providerId !== candidate.providerId || fact.sourceItemId !== candidate.sourceItemId ||
    fact.title !== candidate.title || fact.channelId !== candidate.channelId ||
    (candidate.episodeCount !== undefined && fact.episodeCount < candidate.episodeCount)) throw new Error('Discovery identity mismatch');
  const raw = { ...fact, workId, category: fact.category ?? '', generatedAt: context.nowSeconds(),
    lastSyncedAt: context.nowSeconds(), lastSyncedEpisode: fact.episodes.length };
  const validated = validateDiscoveryFact(raw, workId);
  if (!validated) throw new Error('Discovery fact rejected');
  // Re-read after upstream IO: removed/replaced cards or withdrawals cannot leak a late result.
  const current = await readDiscoveryCard(context, workId);
  if (!current || JSON.stringify(current.candidate) !== JSON.stringify(candidate)) return null;
  return { validated, candidateJson: JSON.stringify(candidate), async publish(parentLease) {
    const live = await readDiscoveryCard(context, workId);
    if (!live || JSON.stringify(live.candidate) !== JSON.stringify(candidate)) return;
    const status = await publishDiscoveryFact(context, candidate.providerId, candidate.sourceItemId,
      raw, context.nowSeconds(), 86400, workId, undefined, undefined, parentLease, JSON.stringify(candidate));
    if (!['published', 'superseded', 'baseline'].includes(status.status)) throw new Error('Discovery publication incomplete');
  } };
}
