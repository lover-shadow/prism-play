// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeControls } from '../../src/player/native-controls';

beforeEach(() => { document.body.innerHTML = ''; });
describe('native playback controls', () => {
  const engine = () => ({ playing: vi.fn(() => false), play: vi.fn(), pause: vi.fn(),
    currentTime: vi.fn(() => 12), duration: vi.fn(() => 120), setCurrentTime: vi.fn() });
  it('plays, pauses and formats timeline from engine state', () => {
    const live = engine(), controls = createNativeControls(document.body, live);
    const button = document.querySelector('button')!;
    button.click(); expect(live.play).toHaveBeenCalledOnce();
    live.playing.mockReturnValue(true); controls.update();
    expect(button.getAttribute('aria-label')).toBe('暂停');
    button.click(); expect(live.pause).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain('0:12 / 2:00');
    controls.destroy(); expect(document.querySelector('button')).toBeNull();
  });
  it('keeps preview position during dragging and commits seek', () => {
    const live = engine(), controls = createNativeControls(document.body, live);
    const range = document.querySelector('input')!;
    range.value = '75'; range.dispatchEvent(new Event('input'));
    controls.update(); expect(range.value).toBe('75');
    expect(document.body.textContent).toContain('1:15');
    range.dispatchEvent(new Event('change'));
    expect(live.setCurrentTime).toHaveBeenCalledWith(75);
    controls.destroy();
  });
  it('blocks playback and seeking while locked, including a pending drag', () => {
    const live = engine(), controls = createNativeControls(document.body, live);
    const range = document.querySelector('input')!;
    range.value = '75'; range.dispatchEvent(new Event('input'));
    controls.setLocked(true);
    expect(document.querySelector('button')!.disabled).toBe(true);
    expect(range.disabled).toBe(true);
    range.dispatchEvent(new Event('change'));
    document.querySelector('button')!.click();
    expect(live.setCurrentTime).not.toHaveBeenCalled();
    expect(live.play).not.toHaveBeenCalled();
    controls.setLocked(false);
    expect(range.disabled).toBe(false);
    document.querySelector('button')!.click();
    expect(live.play).toHaveBeenCalledOnce();
    controls.destroy();
  });
  it('cancels an unfinished seek when controls are hidden', () => {
    const live = engine(), controls = createNativeControls(document.body, live);
    const range = document.querySelector('input')!;
    range.value = '75'; range.dispatchEvent(new Event('input'));
    controls.setVisible(false);
    range.dispatchEvent(new Event('change'));
    expect(live.setCurrentTime).not.toHaveBeenCalled();
    controls.setVisible(true); expect(range.value).toBe('12');
    controls.destroy();
  });
  it('ignores a cancelled drag change after the controls become visible again', () => {
    const live = engine(), controls = createNativeControls(document.body, live);
    const range = document.querySelector('input')!;
    range.value = '75'; range.dispatchEvent(new Event('input'));
    controls.setVisible(false); controls.setVisible(true);
    range.dispatchEvent(new Event('change'));
    expect(live.setCurrentTime).not.toHaveBeenCalled();
    range.value = '60'; range.dispatchEvent(new Event('input')); range.dispatchEvent(new Event('change'));
    expect(live.setCurrentTime).toHaveBeenCalledWith(60);
    controls.destroy();
  });
  it('disables seeking until duration exists and toggles visibility', () => {
    const live = engine(); live.duration.mockReturnValue(0);
    const controls = createNativeControls(document.body, live);
    expect(document.querySelector('input')!.disabled).toBe(true);
    controls.toggle(); expect(document.querySelector<HTMLElement>('.prism-native-controls')!.hidden).toBe(true);
    controls.toggle(); expect(document.querySelector<HTMLElement>('.prism-native-controls')!.hidden).toBe(false);
    controls.setVisible(false); expect(document.querySelector<HTMLElement>('.prism-native-controls')!.hidden).toBe(true);
    controls.setVisible(true); expect(document.querySelector<HTMLElement>('.prism-native-controls')!.hidden).toBe(false);
    controls.destroy();
  });
});
