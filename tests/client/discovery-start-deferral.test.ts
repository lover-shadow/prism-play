import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferDiscoverySync } from '../../src/core/discovery-start';

afterEach(() => vi.useRealTimers());
describe('deferred discovery startup', () => {
  it('lets foreground playback finish before starting background discovery', async () => {
    vi.useFakeTimers();
    const sync = vi.fn(async () => {});
    let busy = true;
    const cancel = deferDiscoverySync(sync, () => busy);
    await vi.advanceTimersByTimeAsync(4000);
    expect(sync).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(sync).toHaveBeenCalledTimes(1);
    cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('destroy cancels a not-yet-started background request', async () => {
    vi.useFakeTimers();
    const sync = vi.fn(async () => {});
    const cancel = deferDiscoverySync(sync, () => false);
    cancel();
    await vi.advanceTimersByTimeAsync(4000);
    expect(sync).not.toHaveBeenCalled();
  });
});
