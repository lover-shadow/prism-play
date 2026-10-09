// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../src/core/api/client';
import { createHostLayer, hostErrorFor } from '../../src/player/host-layer';

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });
describe('playback connection states', () => {
  it('does not claim offline when a connected device has a failed request', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    expect(hostErrorFor(new ApiError('NETWORK_ERROR', 0, 'failed'))).toBe('connection');
    const host = createHostLayer({ mount: document.body, onClose: vi.fn() });
    host.showState('connection');
    expect(host.shell.textContent).toContain('连接暂不可用');
    expect(host.shell.textContent).not.toContain('需要网络');
    host.destroy();
  });
  it('keeps actual offline and privacy denials separate', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(hostErrorFor(new ApiError('NETWORK_ERROR', 0, 'failed'))).toBe('offline');
    for (const code of ['NOT_FOUND', 'PRIVATE_SESSION_REQUIRED', 'TIER_INSUFFICIENT'] as const) {
      expect(hostErrorFor(new ApiError(code, 404, 'denied'))).toBe('missing');
    }
    expect(hostErrorFor(new Error('unknown'))).toBe('missing');
  });
  it('does not describe a known service failure as missing content', () => {
    expect(hostErrorFor(new ApiError('SERVICE_UNAVAILABLE', 503, 'failed'))).toBe('connection');
  });
});
