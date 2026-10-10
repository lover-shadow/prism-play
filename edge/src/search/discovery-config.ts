import { isRecord } from '../library/contract';
import { factsHash } from '../library/work-facts';
import type { DiscoveryConfig, DiscoveryProvider, DiscoveryProviderId } from './discovery-provider';
import { createM1Provider } from './providers/m1';
import { createS1Provider } from './providers/s1';
import { resolveS1Directory } from './providers/s1-directory';
import { safeUrl } from './providers/transport';

export interface DiscoveryServerConfig {
  enabled: boolean;
  providers: Partial<Record<DiscoveryProviderId, DiscoveryConfig>>;
}
export interface DiscoveryConfigEnv {
  SEARCH_DISCOVERY_ENABLED?: string;
  SEARCH_DISCOVERY_CONFIG?: string;
}
function allowlist(raw: unknown): ReadonlySet<string> {
  if (!Array.isArray(raw) || !raw.length || raw.length > 32) throw new Error('Invalid discovery allowlist');
  const origins = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') throw new Error('Invalid discovery origin');
    const url = new URL(value);
    if (value !== url.origin) throw new Error('Discovery allowlists require exact origins');
    safeUrl(value, new Set([value]));
    origins.add(value);
  }
  return origins;
}
/** JSON shape: { providers: { provider_m1?: { origin, originAllowlist, mediaAllowlist,
 * coverAllowlist }, provider_s1?: { ... } } }. Only server env can configure targets.
 * Disabled defaults do not parse dormant configuration. Invalid enabled config throws closed.
 */
export function readDiscoveryConfig(env: DiscoveryConfigEnv): DiscoveryServerConfig {
  if (env.SEARCH_DISCOVERY_ENABLED !== 'true') return { enabled: false, providers: {} };
  if (!env.SEARCH_DISCOVERY_CONFIG || env.SEARCH_DISCOVERY_CONFIG.length > 32768) throw new Error('Discovery configuration required');
  const raw: unknown = JSON.parse(env.SEARCH_DISCOVERY_CONFIG);
  if (!isRecord(raw) || !isRecord(raw.providers) || Object.keys(raw).some((key) => key !== 'providers')) {
    throw new Error('Invalid discovery configuration');
  }
  const providers: DiscoveryServerConfig['providers'] = {};
  for (const [id, value] of Object.entries(raw.providers)) {
    if ((id !== 'provider_m1' && id !== 'provider_s1') || !isRecord(value) || typeof value.origin !== 'string' ||
      Object.keys(value).some((key) => !['origin', 'originAllowlist', 'mediaAllowlist', 'coverAllowlist'].includes(key))) {
      throw new Error('Invalid discovery provider configuration');
    }
    const originAllowlist = allowlist(value.originAllowlist);
    providers[id] = { origin: safeUrl(value.origin, originAllowlist), originAllowlist,
      mediaAllowlist: allowlist(value.mediaAllowlist), coverAllowlist: allowlist(value.coverAllowlist),
      searchBudget: { maxRequests: 8, timeoutMs: 15000 } };
  }
  if (!Object.keys(providers).length) throw new Error('Discovery providers required');
  return { enabled: true, providers };
}
export function createDiscoveryProviders(config: DiscoveryServerConfig): DiscoveryProvider[] {
  if (!config.enabled) return [];
  const providers: DiscoveryProvider[] = [];
  if (config.providers.provider_m1) providers.push(createM1Provider(config.providers.provider_m1));
  const s1 = config.providers.provider_s1;
  if (s1) providers.push({ ...createS1Provider(s1), resolve: async (candidate, _cursor, budget) => {
    try { return { status: 'complete', fact: await resolveS1Directory(candidate, s1, budget) }; }
    catch { return { status: 'blocked', providerId: 'provider_s1', reason: 'unavailable' }; }
  } });
  return providers;
}
/** Private fingerprint isolates shared queries after a server target/allowlist change. */
export async function discoveryConfigScope(env: DiscoveryConfigEnv): Promise<string> {
  return factsHash(new TextEncoder().encode(env.SEARCH_DISCOVERY_CONFIG ?? 'disabled'));
}
