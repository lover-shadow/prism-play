// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSupportBand } from '../../src/views/settings-support';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function setup(save: () => Promise<boolean>, openWechat = vi.fn(async () => {})) {
  const root = document.createElement('div'); document.body.append(root);
  const band = createSupportBand(root, { contact: { url: '/images/author-contact.jpg' } }, { save, openWechat })!;
  root.append(band.wrap);
  root.querySelector<HTMLButtonElement>('[data-el="support-contact"]')!.click();
  return { root, openWechat, band };
}
describe('author support action feedback', () => {
  it('confirms native save only after completion and prevents repeated pending saves', async () => {
    let complete!: (value: boolean) => void;
    const save = vi.fn(() => new Promise<boolean>((resolve) => { complete = resolve; }));
    const h = setup(save);
    const button = h.root.querySelector<HTMLButtonElement>('[data-el="support-save"]')!;
    button.click(); button.click();
    expect(save).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    expect(h.root.textContent).not.toContain('二维码文件已保存');
    complete(true); await flush();
    expect(h.root.textContent).toContain('二维码文件已保存');
    expect(button.disabled).toBe(false);
    h.band.destroy();
  });
  it('handles cancellation and failed WeChat launch without losing the QR', async () => {
    const h = setup(async () => false, vi.fn(async () => { throw Error('not installed'); }));
    h.root.querySelector<HTMLButtonElement>('[data-el="support-save"]')!.click(); await flush();
    expect(h.root.textContent).toContain('已取消保存');
    h.root.querySelector<HTMLButtonElement>('[data-el="support-wechat"]')!.click(); await flush();
    expect(h.root.textContent).toContain('无法打开微信');
    expect(h.root.querySelector('img')).not.toBeNull();
    h.band.destroy();
  });
  it('shows a save failure and permits another attempt', async () => {
    const h = setup(async () => { throw Error('disk'); });
    const button = h.root.querySelector<HTMLButtonElement>('[data-el="support-save"]')!;
    button.click(); await flush();
    expect(h.root.textContent).toContain('保存失败'); expect(button.disabled).toBe(false);
    h.band.destroy();
  });
  it('displays the permanent content origin disclaimer and feedback guidance (AC-R02)', () => {
    const root = document.createElement('div'); document.body.append(root);
    const band = createSupportBand(root, { contact: { url: '/images/author-contact.jpg' } })!;
    expect(band.wrap.textContent).toContain('本程序的内容来自网络搜索聚合');
    expect(band.wrap.textContent).toContain('部分来源的视频可能带有广告');
    expect(band.wrap.textContent).toContain('程序目前仍处于完善阶段');
    expect(band.wrap.textContent).toContain('欢迎通过【联系作者】反馈');
    band.destroy();
  });
});
