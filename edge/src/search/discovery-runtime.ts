import type { Env } from '../types/env';
import type { CatalogManifest } from '../library/manifest';
import { readWorkFact } from '../library/work-facts';
import type { DiscoveryContext, DiscoveryIdentity } from './discovery-store';
import { createDiscoveryProviders, discoveryConfigScope, readDiscoveryConfig } from './discovery-config';
import { createDiscoveryService, type DiscoveryService } from './discovery-service';

export interface DiscoveryBaselineContext {
  /** Main session owns current manifest lookup and provider/source-to-baseline identity mapping. */
  manifest(): Promise<CatalogManifest | null | undefined>;
  /** Must distinguish an existing disabled/private work from no mapping. Never implement via get(). */
  match(identity: DiscoveryIdentity, manifest: CatalogManifest): Promise<
    { hasMatch: true; workId: string } | { hasMatch: false }>;
  /** Main session supplies revision/mapping generation for query cache isolation when needed. */
  scope?: string;
}
/** Only manifest facts supply baseline reads; no legacy D1/get fallback is inferred here.
 * readWorkFact returns absent for disabled works, so hasMatch must come from the caller's
 * authoritative mapping rather than from readWorkFact's visibility-filtered result.
 */
export function createDiscoveryContext(env: Env, baseline: DiscoveryBaselineContext,
  nowSeconds = () => Math.floor(Date.now() / 1000)): DiscoveryContext {
  return { bindings: env, nowSeconds, authority: async (identity) => {
    try {
      const manifest = await baseline.manifest();
      if (!manifest?.workFacts) return { authoritative: true, read: { status: 'rejected' } };
      const match = await baseline.match(identity, manifest);
      if (!match.hasMatch) return { authoritative: false };
      return { authoritative: true, read: await readWorkFact(env, manifest, match.workId) };
    } catch { return { authoritative: true, read: { status: 'rejected' } }; }
  } };
}
/** Factory only: no routes, scheduled work, poll endpoints or deployment bindings are installed. */
export async function createDiscoveryRuntime(env: Env, baseline: DiscoveryBaselineContext): Promise<DiscoveryService> {
  const config = readDiscoveryConfig(env);
  const context = createDiscoveryContext(env, baseline);
  return createDiscoveryService(context, createDiscoveryProviders(config), {
    scope: `${await discoveryConfigScope(env)}:${baseline.scope ?? ''}`
  });
}
