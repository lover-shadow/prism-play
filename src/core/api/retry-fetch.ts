import type { FetchLike } from './client';

const RETRY_DELAYS = [250, 600];
const TIMEOUT_MS = 8000;
function cancelled(signal?: AbortSignal | null): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('请求已取消', 'AbortError');
}
function wait(ms: number, signal?: AbortSignal | null): Promise<void> {
  cancelled(signal);
  return new Promise((resolve, reject) => {
    const cleanup = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const abort = (): void => { cleanup(); reject(signal?.reason ?? new DOMException('请求已取消', 'AbortError')); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
export async function readWithRetry(fetcher: FetchLike, url: string, init: RequestInit): Promise<{ response: Response; text: string }> {
  const signal = init.signal;
  for (let attempt = 0; ; attempt++) {
    cancelled(signal);
    const controller = new AbortController();
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const stop = (reason: unknown): void => { controller.abort(reason); rejectAbort(reason); };
    const abort = (): void => stop(signal?.reason ?? new DOMException('请求已取消', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new DOMException('线路解析请求超时', 'TimeoutError')), TIMEOUT_MS);
    try {
      const request = (async () => {
        const response = await fetcher(url, { ...init, signal: controller.signal });
        return { response, text: await response.text() };
      })();
      return await Promise.race([request, aborted]);
    } catch (error) {
      cancelled(signal);
      if (attempt >= RETRY_DELAYS.length || !(error instanceof TypeError || error instanceof DOMException && error.name === 'TimeoutError')) throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    await wait(RETRY_DELAYS[attempt], signal);
  }
}

export function budgetForRequest(path: string, method = 'GET'): number {
  if (path.startsWith('/api/search/suggestions') || path.includes('/related')) return 12000;
  if (path.startsWith('/api/search/discoveries')) return 8000;
  if (path.startsWith('/api/search')) return 35000;
  if (path.startsWith('/assets/catalog-bundle')) return 60000;
  if (method !== 'GET') return 15000;
  return 8000;
}

export async function readWithBudget(fetcher: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<{ response: Response; text: string }> {
  const signal = init.signal;
  cancelled(signal);
  const controller = new AbortController();
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const stop = (reason: unknown): void => { controller.abort(reason); rejectAbort(reason); };
  const abort = (): void => stop(signal?.reason ?? new DOMException('请求已取消', 'AbortError'));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop(new DOMException('网络请求超时', 'TimeoutError')), timeoutMs);
  try {
    const request = (async () => {
      const response = await fetcher(url, { ...init, signal: controller.signal });
      return { response, text: await response.text() };
    })();
    return await Promise.race([request, aborted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
