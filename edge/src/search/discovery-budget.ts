import type { DiscoveryBudget } from './discovery-provider';

/** Provider request budgets, not promises of HTTP response or playback latency. */
export const DISCOVERY_FRONT_BUDGET: Readonly<DiscoveryBudget> = Object.freeze({ maxRequests: 2, timeoutMs: 3000 });
export const DISCOVERY_BACKGROUND_BUDGET: Readonly<DiscoveryBudget> = Object.freeze({ maxRequests: 24, timeoutMs: 25000 });
