// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createPlaybackPreferencesBand, readPlaybackRates, PLAYBACK_PREF_KEYS, PLAYBACK_RATES } from '../../src/views/settings-playback';
import { createSettingsCacheBand } from '../../src/views/settings-cache';
import { createSupportBand } from '../../src/views/settings-support';
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const pick = (root: HTMLElement, el: string) => root.querySelector<HTMLElement>(`[data-el="${el}"]`)!;

describe('R26-10 settings modules', () => {
  it('validates persisted rates and defaults hold to 2, normal to 1', async () => {
    for (const value of [null, '', '0', 'NaN', 'Infinity', '2.1', ' 2 ', '02']) {
      expect(await readPlaybackRates({ get: async () => value, set: async () => {} })).toEqual({ holdRate: 2, normalRate: 1 });
    }
    for (const rate of PLAYBACK_RATES) {
      expect(await readPlaybackRates({ get: async () => String(rate), set: async () => {} })).toEqual({ holdRate: rate, normalRate: rate });
    }
  });
  it('persists selected rate and retains previous choice on failed save', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const band = createPlaybackPreferencesBand({ get: async () => null, set });
    await band.reload();
    const select = pick(band.wrap, 'hold-rate') as HTMLSelectElement;
    select.value = '3'; select.dispatchEvent(new Event('change')); await tick();
    expect(set).toHaveBeenCalledWith(PLAYBACK_PREF_KEYS.holdRate, '3');
    set.mockRejectedValue(new Error('storage'));
    select.value = '4'; select.dispatchEvent(new Event('change')); await tick();
    expect(select.value).toBe('3'); expect(band.wrap.dataset.state).toBe('error');
    expect(band.wrap.textContent).not.toContain('已保存');
  });
  it('reports unreadable preferences without fake success', async () => {
    const band = createPlaybackPreferencesBand({ get: async () => { throw Error(); }, set: async () => {} });
    await band.reload(); expect(band.wrap.dataset.state).toBe('error');
  });
  it('retains cache measurement and controls after failed clear', async () => {
    const clear = vi.fn().mockRejectedValue(Error('disk'));
    const band = createSettingsCacheBand({ measure: async () => ({ usedBytes: 2048, limitBytes: 4096 }), clearPublicCache: clear });
    await band.reload(); pick(band.wrap, 'clear-cache').click(); await tick();
    expect(band.wrap.dataset.state).toBe('error'); expect(band.wrap.textContent).toContain('2 KiB');
    clear.mockResolvedValue({ clearedBytes: 2048, domains: ['public-cache'] });
    pick(band.wrap, 'clear-cache').click(); await tick(); expect(clear).toHaveBeenCalledTimes(2);
  });
  it('rejects clear reports outside public cache', async () => {
    const band = createSettingsCacheBand({ measure: async () => ({ usedBytes: 100, limitBytes: 200 }), clearPublicCache: async () => ({ clearedBytes: 100, domains: ['credentials'] as never }) });
    await band.reload(); pick(band.wrap, 'clear-cache').click(); await tick(); expect(band.wrap.dataset.state).toBe('error');
  });
  it('omits unconfigured and unsafe support images', () => {
    expect(createSupportBand(document.createElement('div'))).toBeNull();
    expect(createSupportBand(document.createElement('div'), { contact: { url: 'javascript:bad' } })).toBeNull();
  });
  it('opens image, provides browser file download, closes with Escape and restores focus', () => {
    const root = document.createElement('div'); document.body.replaceChildren(root);
    const band = createSupportBand(root, { contact: { url: '/images/author-contact.jpg' }, reward: { url: '/images/author-reward.jpg' } })!;
    root.append(band.wrap); const trigger = pick(root, 'support-contact'); trigger.focus(); trigger.click();
    expect(root.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe('/images/author-contact.jpg');
    const link = root.querySelector<HTMLAnchorElement>('[download]')!;
    expect(link.download).toBe('author-contact.jpg'); expect(link.getAttribute('href')).toBe('/images/author-contact.jpg');
    expect(root.textContent).not.toContain('保存图库');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(root.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(trigger);
    trigger.click(); pick(root, 'support-close').click(); expect(root.querySelector('[role="dialog"]')).toBeNull();
    trigger.click(); band.destroy(); expect(root.querySelector('[role="dialog"]')).toBeNull();
  });
});
