// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { createSponsorNudge } from '../../src/views/sponsor-nudge';
import type { MonetizationConfig } from '../../edge/src/types/api';
const config: MonetizationConfig = { activeTiers: [{ tier: 'A', name: '<云档位>', priceYuan: 17.5, durationDays: 32, desc: '云描述' }], nudgePolicy: { freeTrialSeconds: 1, stage1UntilSeconds: 2, stage2UntilSeconds: 3, stage1IntervalSeconds: 1, stage2IntervalSeconds: 1, stage3IntervalSeconds: 1, dialogTitle: '<img src=x onerror=alert(1)>', dialogBody: '云正文' } };
describe('R26-11 nonblocking sponsor nudge', () => {
  it('renders cloud text safely and tier prices; close/action are injected and once only', () => {
    const onClose = vi.fn(), onAction = vi.fn();
    const view = createSponsorNudge({ config, onClose, onAction }); expect(view).not.toBeNull();
    document.body.append(view!.element);
    expect(view!.element.textContent).toContain(config.nudgePolicy.dialogTitle);
    expect(view!.element.textContent).toContain('<云档位>'); expect(view!.element.textContent).toContain('17.5');
    expect(view!.element.querySelector('img')).toBeNull(); expect(view!.element.querySelector('svg')).not.toBeNull();
    expect(view!.element.getAttribute('aria-modal')).not.toBe('true'); expect(document.activeElement).toBe(document.body);
    (view!.element.querySelector('[data-action="redeem"]') as HTMLButtonElement).click();
    view!.close(); expect(onClose).toHaveBeenCalledOnce(); expect(onAction).toHaveBeenCalledOnce(); expect(view!.element.isConnected).toBe(false);
  });
  it('Escape and close button dismiss without blocking other keyboard events', () => {
    const onClose = vi.fn(); const view = createSponsorNudge({ config, onClose, onAction: vi.fn() })!;
    document.body.append(view.element);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    view.element.dispatchEvent(escape); expect(onClose).toHaveBeenCalledOnce(); expect(escape.defaultPrevented).toBe(false);
    const second = createSponsorNudge({ config, onClose, onAction: vi.fn() })!;
    (second.element.querySelector('[aria-label="关闭提醒"]') as HTMLButtonElement).click(); expect(onClose).toHaveBeenCalledTimes(2);
  });
  it('missing/invalid configuration creates no DOM or fallback price', () => {
    for (const c of [null, {}, { ...config, activeTiers: [] }, { ...config, activeTiers: [{ ...config.activeTiers[0], priceYuan: NaN }] }]) {
      expect(createSponsorNudge({ config: c, onClose: vi.fn(), onAction: vi.fn() })).toBeNull();
    }
  });
});
