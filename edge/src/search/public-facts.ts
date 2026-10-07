import type { Env } from '../types/env';
import type { CatalogManifest } from '../library/manifest';
import { readWorkFact, type FactRead } from '../library/work-facts';
import { readDiscoveryFact, type DiscoveryContext, type DiscoveryIdentity } from './discovery-store';
import { readDiscoveryConfig } from './discovery-config';
import { discoveryCanonicalId } from './discovery-facts';

async function baselineIdentity(env: Env, manifest: CatalogManifest, identity: DiscoveryIdentity): Promise<FactRead> {
  const ids = [identity.workId];
  if (identity.providerId === 'provider_s1' && identity.sourceId && /^\d{1,32}$/.test(identity.sourceId)) ids.push(`drama_s_${identity.sourceId}`);
  if (identity.providerId === 'provider_m1' && identity.sourceId && /^\d{1,32}$/.test(identity.sourceId)) {
    for (const channel of ['drama', 'movie', 'anime', 'documentary']) ids.push(`${channel}_m_${identity.sourceId}`);
  }
  for (const id of new Set(ids)) {
    const read = await readWorkFact(env, manifest, id, true);
    if (read.status !== 'absent') return read;
  }
  return { status: 'absent' };
}
export function publicDiscoveryContext(env: Env, manifest: CatalogManifest,
  nowSeconds = () => Math.floor(Date.now() / 1000)): DiscoveryContext {
  return { bindings: env, nowSeconds, authority: async (identity) => {
    if (!manifest.workFacts) return { authoritative: true, read: { status: 'rejected' } };
    const read = await baselineIdentity(env, manifest, identity);
    if (read.status === 'absent') return { authoritative: false };
    if (read.status !== 'ok') return { authoritative: true, read };
    if (read.fact.row.enabled !== 1 || read.fact.row.is_private !== 0) return { authoritative: true, read: { status: 'absent' } };
    const canonicalId = read.fact.asset.workId;
    if ((identity.providerId || identity.sourceId) && (!identity.providerId || !identity.sourceId ||
      !discoveryCanonicalId(identity.providerId, identity.sourceId, canonicalId) || identity.workId !== canonicalId)) {
      return { authoritative: true, read: { status: 'rejected' } };
    }
    return { authoritative: true, read, overlayEligible: true, canonicalId };
  } };
}
export async function readPublicFact(env: Env, manifest: CatalogManifest, id: string, now: number): Promise<FactRead> {
  if (env.DISCOVERY_BUCKET) {
    const read = await readDiscoveryFact(publicDiscoveryContext(env, manifest, () => now), id, now);
    // The proxy consumes this server-side manifest allowlist; never derive origins from a fact URL.
    if (read.status === 'ok' && read.fact.asset.generatedAt > 0) {
      manifest.coverOrigins = [...new Set([...(manifest.coverOrigins ?? []), ...discoveryCoverOrigins(env)])];
    }
    return read;
  }
  const base = await readWorkFact(env, manifest, id, true);
  return base.status === 'ok' && base.fact.row.enabled !== 1 ? { status: 'absent' } : base;
}
export function discoveryCoverOrigins(env: Env): readonly string[] {
  const config = readDiscoveryConfig(env);
  return [...new Set(Object.values(config.providers).flatMap((provider) => [...provider!.coverAllowlist]))];
}
