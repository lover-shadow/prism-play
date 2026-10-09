// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ platform: 'android', saveQr: vi.fn(), openWechat: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: { getPlatform: () => native.platform, isPluginAvailable: () => true }, registerPlugin: () => native }));
import { authorSupportActions } from '../../src/core/native/author-support';
beforeEach(() => { vi.clearAllMocks(); native.platform = 'android'; native.saveQr.mockResolvedValue({ saved: true }); });
afterEach(() => vi.unstubAllGlobals());
describe('native author QR adapter', () => {
  it('passes bundled JPEG bytes and verified role to native saving', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['image'], { type: 'image/jpeg' }) })));
    expect(await authorSupportActions()!.save('/images/author-contact.jpg', 'contact')).toBe(true);
    expect(native.saveQr).toHaveBeenCalledWith({ data: btoa('image'), role: 'contact' });
    await authorSupportActions()!.openWechat(); expect(native.openWechat).toHaveBeenCalledTimes(1);
  });
  it('refuses cross-origin and unrelated image paths', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(authorSupportActions()!.save('https://outside.invalid/photo.jpg', 'contact')).rejects.toThrow();
    await expect(authorSupportActions()!.save('/other.jpg', 'contact')).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled(); expect(native.saveQr).not.toHaveBeenCalled();
  });
  it('rejects failed reads and reports user cancellation as false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    await expect(authorSupportActions()!.save('/images/author-contact.jpg', 'contact')).rejects.toThrow();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => new Blob(['image'], { type: 'image/jpeg' }) })));
    native.saveQr.mockResolvedValue({ saved: false });
    expect(await authorSupportActions()!.save('/images/author-reward.jpg', 'reward')).toBe(false);
  });
  it('keeps Web host on browser download rather than claiming native save', () => {
    native.platform = 'web'; expect(authorSupportActions()).toBeUndefined();
  });
});
