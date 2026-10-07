import type { ContentItem } from '../types/api';
import type { DiscoveryCandidate, DiscoveryConfig, DiscoveryProviderId } from './discovery-provider';
import type { DiscoveryContext } from './discovery-store';
import { publishDiscoveryFact, readDiscoveryFact } from './discovery-store';
import { safeDiscoveryCandidate } from './discovery-jobs';
import { discoveryCanonicalId } from './discovery-facts';
import { resolveS1Directory } from './providers/s1-directory';
import { createM1Provider } from './providers/m1';
import type { TitleAsset } from '../library/title-asset';

export interface DiscoveryCard { candidate: DiscoveryCandidate; item: ContentItem }
interface CardRow { candidate_json: string; card_json: string }

export async function saveDiscoveryCard(context: DiscoveryContext, input: DiscoveryCandidate): Promise<boolean> {
  const candidate = safeDiscoveryCandidate(input);
  if (!discoveryCanonicalId(candidate.providerId, candidate.sourceItemId, candidate.id)) return false;
  const authority = await context.authority({ workId: candidate.id, providerId: candidate.providerId, sourceId: candidate.sourceItemId });
  if (authority.authoritative) return false;
  const item: ContentItem = {
    id: candidate.id, title: candidate.title, channelId: candidate.channelId, category: candidate.category ?? '',
    isPrivate: false, enabled: true, shareable: true,
    ...(candidate.episodeCount === undefined ? {} : { episodeCount: candidate.episodeCount }),
    ...(candidate.synopsis === undefined ? {} : { synopsis: candidate.synopsis }),
    ...(candidate.isAi === undefined ? {} : { isAi: candidate.isAi }),
    ...(candidate.coverTargetUrl ? { coverUrl: `/proxy/img/${encodeURIComponent(candidate.id)}` } : {})
  };
  await context.bindings.DB.prepare(`INSERT INTO discovery_cards(work_id, provider_id, source_id, candidate_json, card_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(work_id) DO UPDATE SET
    candidate_json = excluded.candidate_json, card_json = excluded.card_json, updated_at = excluded.updated_at`)
    .bind(candidate.id, candidate.providerId, candidate.sourceItemId, JSON.stringify(candidate), JSON.stringify(item), context.nowSeconds()).run();
  return true;
}

export async function readDiscoveryCard(context: DiscoveryContext, workId: string): Promise<DiscoveryCard | null> {
  const row = await context.bindings.DB.prepare('SELECT candidate_json, card_json FROM discovery_cards WHERE work_id = ?')
    .bind(workId).first<CardRow>();
  if (!row) return null;
  const candidate = safeDiscoveryCandidate(JSON.parse(row.candidate_json));
  if (candidate.id !== workId || !discoveryCanonicalId(candidate.providerId, candidate.sourceItemId, workId)) return null;
  const authority = await context.authority({ workId, providerId: candidate.providerId, sourceId: candidate.sourceItemId });
  if (authority.authoritative) return null;
  const withdrawn = await context.bindings.DB.prepare('SELECT enabled FROM discovery_works WHERE work_id = ?')
    .bind(workId).first<{ enabled: number }>();
  if (withdrawn?.enabled === 0) return null;
  return { candidate, item: JSON.parse(row.card_json) as ContentItem };
}

export async function resolveCardDetail(
  context: DiscoveryContext,
  workId: string,
  configs: Partial<Record<DiscoveryProviderId, DiscoveryConfig>>
): Promise<TitleAsset | null> {
  const existing = await readDiscoveryFact(context, workId, context.nowSeconds());
  if (existing.status === 'ok') return existing.fact.asset;
  if (existing.status === 'rejected') return null;
  const stored = await readDiscoveryCard(context, workId);
  if (!stored) return null;
  const candidate = stored.candidate;
  if (candidate.providerId === 'provider_s1') {
    const config = configs.provider_s1;
    if (!config) return null;
    const fact = await resolveS1Directory(candidate, config);
    fact.lastSyncedEpisode = fact.episodes.length;
    fact.lastSyncedAt = context.nowSeconds();
    const pub = await publishDiscoveryFact(context, 'provider_s1', candidate.sourceItemId, fact, context.nowSeconds(), 86400, workId);
    if (pub.status === 'published' || pub.status === 'superseded') {
      const read = await readDiscoveryFact(context, workId, context.nowSeconds());
      if (read.status === 'ok') return read.fact.asset;
    }
    return null;
  }
  if (candidate.providerId === 'provider_m1') {
    const config = configs.provider_m1;
    if (!config) return null;
    const m1 = createM1Provider(config);
    const resolved = await m1.resolve(candidate, undefined, { maxRequests: 8, timeoutMs: 15000 });
    if (resolved.status === 'complete') {
      const pub = await publishDiscoveryFact(context, 'provider_m1', candidate.sourceItemId, resolved.fact, context.nowSeconds(), 86400, workId);
      if (pub.status === 'published' || pub.status === 'superseded') {
        const read = await readDiscoveryFact(context, workId, context.nowSeconds());
        if (read.status === 'ok') return read.fact.asset;
      }
    }
    return null;
  }
  return null;
}


