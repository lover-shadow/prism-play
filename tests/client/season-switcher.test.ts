// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createSeasonSwitcher } from '../../src/player/season-switcher';
import { host } from './player-host-harness';
import { detailOf } from './player-harness';
import type { ContentItem } from '../../edge/src/types/api';
const item = (id: string, title: string, isPrivate = false): ContentItem => ({ id, title, isPrivate, channelId: 'drama', category: '故事' });
describe('player observed season switching', () => {
  it('switches to the chosen work without assuming season continuity', () => {
    const open = vi.fn(), current = item('s1', '示例故事');
    const root = createSeasonSwitcher(current, [current, item('s7', '示例故事第七季')], open)!;
    const select = root.querySelector('select')!;
    expect(select.options).toHaveLength(2); expect(select.value).toBe('s1');
    select.value = 's7'; select.dispatchEvent(new Event('change'));
    expect(open).toHaveBeenCalledWith('s7');
  });
  it('retains the same host stage and fullscreen while switching seasons', async () => {
    const first = item('s1', '故事第一季'), next = item('s2', '故事第二季');
    const h = host({ seriesItems: () => [first, next], respondTitle: async (id) => detailOf(id === 's1' ? first : next) });
    await h.player.open('s1');
    const shell = h.mount.querySelector('.prism-player-host')!;
    const stage = h.mount.querySelector('.prism-player-host__stage')!;
    shell.classList.add('prism-player-host--fullscreen');
    expect(h.mount.querySelector('.prism-drawer [data-prism-ui="season-switcher"]')).not.toBeNull();
    const select = h.mount.querySelector<HTMLSelectElement>('[data-prism-ui="season-switcher"] select')!;
    select.value = 's2'; select.dispatchEvent(new Event('change'));
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(h.mount.querySelector('.prism-player-host')).toBe(shell);
    expect(h.mount.querySelector('.prism-player-host__stage')).toBe(stage);
    expect(h.mount.textContent).toContain('故事第二季');
    expect(shell.classList.contains('prism-player-host--fullscreen')).toBe(true);
    h.player.close();
  });
  it('clears the previous season title while the retained stage is loading and allows exit', async () => {
    const first = item('s1', '故事第一季'), second = item('s2', '故事第二季');
    let resolve!: (detail: ReturnType<typeof detailOf>) => void;
    const h = host({ seriesItems: () => [first, second], respondTitle: async (id) => id === 's1' ? detailOf(first)
      : new Promise((done) => { resolve = done; }) });
    await h.player.open('s1');
    const select = h.mount.querySelector<HTMLSelectElement>('[data-prism-ui="season-switcher"] select')!;
    select.value = 's2'; select.dispatchEvent(new Event('change'));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(h.mount.querySelector('.prism-player-host__title')!.textContent).toBe('');
    expect(h.mount.textContent).not.toContain('故事第一季');
    h.player.close(); resolve(detailOf(second));
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(h.mount.querySelector('.prism-player-host')).toBeNull();
  });
  it('does not tear down a newer season when an older retained-stage request finishes', async () => {
    const works = [item('s1', '故事第一季'), item('s2', '故事第二季'), item('s3', '故事第三季')];
    const pending = new Map<string, (value: ReturnType<typeof detailOf>) => void>();
    const h = host({ seriesItems: () => works, respondTitle: async (id) => id === 's1' ? detailOf(works[0])
      : new Promise((resolve) => { pending.set(id, resolve); }) });
    await h.player.open('s1');
    const select = h.mount.querySelector<HTMLSelectElement>('[data-prism-ui="season-switcher"] select')!;
    select.value = 's2'; select.dispatchEvent(new Event('change'));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    select.value = 's3'; select.dispatchEvent(new Event('change'));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    pending.get('s3')!(detailOf(works[2]));
    for (let i = 0; i < 40; i++) await Promise.resolve();
    pending.get('s2')!(detailOf(works[1]));
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(h.mount.textContent).toContain('故事第三季'); expect(h.player.isOpen()).toBe(true);
    h.player.close();
  });
  it('ignores an older season rejection after a newer season becomes ready', async () => {
    const works = [item('s1', '故事第一季'), item('s2', '故事第二季'), item('s3', '故事第三季')];
    let rejectOld!: (error: Error) => void;
    const h = host({ seriesItems: () => works, respondTitle: async (id) => id === 's2'
      ? new Promise((_resolve, reject) => { rejectOld = reject; }) : detailOf(works.find((entry) => entry.id === id)) });
    await h.player.open('s1');
    const select = h.mount.querySelector<HTMLSelectElement>('[data-prism-ui="season-switcher"] select')!;
    select.value = 's2'; select.dispatchEvent(new Event('change'));
    for (let i = 0; i < 20; i++) await Promise.resolve();
    select.value = 's3'; select.dispatchEvent(new Event('change'));
    for (let i = 0; i < 50; i++) await Promise.resolve();
    rejectOld(new Error('network'));
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(h.mount.textContent).toContain('故事第三季'); expect(h.player.isOpen()).toBe(true);
    h.player.close();
  });
  it('does not expose private or unrelated works', () => {
    expect(createSeasonSwitcher(item('s1', '示例故事'), [item('secret', '示例故事第二季', true), item('other', '另一故事第三季')], vi.fn())).toBeNull();
    expect(createSeasonSwitcher(item('s1', '示例故事', true), [item('s2', '示例故事第二季')], vi.fn())).toBeNull();
  });
});
