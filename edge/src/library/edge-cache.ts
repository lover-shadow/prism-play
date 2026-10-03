/**
 * Workers Cache API for the first screen (§C-3-1: 首屏额外写 Cache API, TTL 300s).
 *
 * Only the credential-independent public first page is ever written: a shared cache must not merge the
 * outcomes of the private double admission (AC-02-3), and `channel=private` answers stay `no-store`
 * upstream. Everything here is best-effort — a runtime without `caches` (the vitest harness, a local
 * `wrangler dev` cold worker) or a refused `put` must degrade to "hit R2 again", never to an error page,
 * because the cache is a latency optimisation and not part of the contract.
 */

/** §C-3-1 pins the first-screen edge TTL at 300 seconds. */
export const FIRST_SCREEN_CACHE_SECONDS = 300;

interface CacheNamespace {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

function defaultCache(): CacheNamespace | null {
  if (typeof caches === 'undefined') return null;
  try {
    return caches.default as unknown as CacheNamespace;
  } catch {
    return null;
  }
}

export async function readFromEdgeCache(request: Request): Promise<Response | null> {
  const store = defaultCache();
  if (store === null) return null;
  try {
    return (await store.match(request)) ?? null;
  } catch {
    return null;
  }
}

/**
 * `put` consumes the response body, so the caller hands over a clone and keeps its own readable copy.
 * A failure here is silent by design: the answer was already computed, and a cache write must never be
 * able to turn a good page into a 500.
 */
export async function writeToEdgeCache(request: Request, response: Response): Promise<void> {
  const store = defaultCache();
  if (store === null) return;
  try {
    await store.put(request, response.clone());
  } catch {
    // Optimistic only.
  }
}

/** Cache-Control for a page that the edge may hold for `seconds`, with the credential Vary kept. */
export function publicMaxAgeHeaders(seconds: number, vary: string): Record<string, string> {
  return { 'Cache-Control': `public, max-age=${seconds}`, Vary: vary };
}
