import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWithRetry } from '../../src/core/api/retry-fetch';
import { PrismApiClient } from '../../src/core/api/client';

afterEach(() => vi.useRealTimers());
describe('bounded playback transport', () => {
  it('recovers one transport failure without retrying a business response', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(new Response('{}'));
    const result = readWithRetry(fetcher, '/title', {});
    await vi.advanceTimersByTimeAsync(250);
    expect((await result).text).toBe('{}');
    expect(fetcher).toHaveBeenCalledTimes(2);
    const missing = vi.fn().mockResolvedValue(new Response('{}', { status: 404 }));
    expect((await readWithRetry(missing, '/title', {})).response.status).toBe(404);
    expect(missing).toHaveBeenCalledTimes(1);
  });
  it('ends after three failed attempts and cleans timers', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const result = expect(readWithRetry(fetcher, '/title', {})).rejects.toThrow('Failed to fetch');
    await vi.advanceTimersByTimeAsync(850);
    await result;
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('times out response-body consumption and aborts each attempt', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      signals.push(init.signal);
      return { text: () => new Promise(() => {}) } as Response;
    });
    const result = expect(readWithRetry(fetcher, '/title', {})).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(24850);
    await result;
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('caller cancellation stops the backoff without another request', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const result = expect(readWithRetry(fetcher, '/title', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await result;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not retry redemption POST or impose playback timeout on search', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const client = new PrismApiClient({ fetchImpl: fetcher });
    await expect(client.redeem({} as never)).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(client.search({ q: '标题' })).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
