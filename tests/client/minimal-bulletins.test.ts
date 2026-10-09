// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openBulletinDialog, scheduleBulletinsCheck } from '../../src/views/client-bulletins';
import { createPreferenceStore } from '../../src/core/native/platform-adapters';
import { checkClientBulletins } from '../../src/core/client-bulletins';
import type { PrismApiClient } from '../../src/core/api/client';
import type { PrismNativeBridge } from '../../src/core/native/bridge';
const release = { versionCode: 21607, versionName: '2.6.7', downloadUrl: 'https://play.prismos.org/dl/latest/android', changelog: '稳定性优化', force: true };
const item = { id: 'message_0001', revision: 1, title: '升级说明', body: '可选更新，不打断播放', startsAt: 1, endsAt: 1000 };
const prefs = () => createPreferenceStore({ platform: () => false, storage: { getItem: () => null, setItem() {} } });
afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });
describe('MIN-04/05 optional update and foreground messages', () => {
  it('does not make a Web host pretend to have an Android version', async () => {
    vi.useFakeTimers(); const version = vi.fn(async () => ({ android: release }));
    const cancel = scheduleBulletinsCheck({ api: { version } as unknown as PrismApiClient, prefs: prefs(), root: document.body,
      bridge: {} as PrismNativeBridge, isPlayerOpen: () => false });
    await vi.advanceTimersByTimeAsync(2000); cancel(); expect(version).not.toHaveBeenCalled();
  });
  it('shows a snoozable update, then a valid message; never downloads automatically', async () => {
    vi.useFakeTimers(); const download = vi.fn(async () => {});
    const cancel = scheduleBulletinsCheck({ versionCode: 21606, nowSeconds: () => 100,
      api: { version: async () => ({ android: release }), announcements: async () => ({ revision: 1, items: [item] }) } as unknown as PrismApiClient,
      prefs: prefs(), root: document.body, bridge: { openExternalUrl: download } as unknown as PrismNativeBridge, isPlayerOpen: () => false });
    await vi.advanceTimersByTimeAsync(1500);
    expect(document.querySelector('[data-el="bulletin-snooze"]')).not.toBeNull(); expect(download).not.toHaveBeenCalled();
    document.querySelector<HTMLButtonElement>('[data-el="bulletin-snooze"]')!.click();
    await vi.advanceTimersByTimeAsync(1); expect(document.body.textContent).toContain(item.title);
    cancel(); expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it('drops messages that expired while waiting for playback to close', async () => {
    vi.useFakeTimers(); let now = 100, busy = true;
    const cancel = scheduleBulletinsCheck({ versionCode: 21606, nowSeconds: () => now,
      api: { version: async () => ({ android: { ...release, versionCode: 21606 } }), announcements: async () => ({ revision: 1, items: [item] }) } as unknown as PrismApiClient,
      prefs: prefs(), root: document.body, bridge: {} as PrismNativeBridge, isPlayerOpen: () => busy });
    await vi.advanceTimersByTimeAsync(1500); now = 2000; busy = false;
    await vi.advanceTimersByTimeAsync(2000); expect(document.querySelector('[role="dialog"]')).toBeNull(); cancel();
  });
  it('keeps all updates optional even if a future config carries force', async () => {
    const result = await checkClientBulletins({ api: { version: async () => ({ android: release }), announcements: async () => ({ revision: 1, items: [] }) },
      prefs: prefs(), currentVersionCode: 21606, nowSeconds: () => 100 });
    expect(result.update?.kind).toBe('optional');
  });
  it('renders multi-paragraph notice without replacing title or dropping paragraphs (AC-R01)', () => {
    const dialog = openBulletinDialog({
      root: document.body,
      announcement: {
        id: 'content-feedback-notice',
        revision: 1,
        title: '内容来源与反馈说明',
        body: '本程序的内容来自网络搜索聚合。部分来源的视频可能带有广告，我们正在逐步完善识别与剔除；目前无法保证所有内容均无广告。\n\n程序目前仍处于完善阶段。如遇到 BUG 或有改进建议，欢迎通过【我的 → 作者支持 → 联系作者】反馈，帮助我们持续完善。',
        startsAt: 1,
        endsAt: 1000
      }
    });
    expect(document.querySelector('.pv-dialog-title')?.textContent).toContain('内容来源与反馈说明');
    const paras = Array.from(document.querySelectorAll('.pv-dialog-body'));
    expect(paras).toHaveLength(2);
    expect(paras[0].textContent).toContain('网络搜索聚合');
    expect(paras[1].textContent).toContain('完善阶段');
    dialog.close();
  });
});
