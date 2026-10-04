import { element, iconNode } from '../components/state-views';
import { validMonetization } from '../core/watch-time';

/** Inline, modeless card: no backdrop, focus steal, playback calls, payments or QR assumptions. */
export function createSponsorNudge(options: { config: unknown; onClose: () => void; onAction: () => void }) {
  if (!validMonetization(options.config)) return null;
  const config = options.config;
  const wrap = element('section', 'sponsor-nudge');
  wrap.setAttribute('role', 'region');
  wrap.setAttribute('aria-label', config.nudgePolicy.dialogTitle);
  const style = element('style');
  // Component-local token styles; shared CSS remains owned by its existing maintainer.
  style.textContent = `
.sponsor-nudge { padding: var(--space-4); border-radius: var(--radius-lg); background: var(--surface-raised); color: var(--fg); box-shadow: var(--elev-card); }
.sponsor-nudge .sponsor-nudge-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.sponsor-nudge p, .sponsor-nudge ul { margin-block: var(--space-3); overflow-wrap: anywhere; }
.sponsor-nudge button { padding: var(--space-3); border: none; border-radius: var(--radius-md); cursor: pointer; background: var(--accent); color: var(--accent-on); font: inherit; }
.sponsor-nudge button:focus-visible { outline: solid var(--accent); outline-offset: var(--space-1); }
.sponsor-nudge .sponsor-nudge-close { background: var(--surface); color: var(--fg); }
`;
  const head = element('div', 'sponsor-nudge-head');
  head.append(element('strong', undefined, config.nudgePolicy.dialogTitle));
  const closeButton = element('button', 'sponsor-nudge-close');
  closeButton.type = 'button'; closeButton.setAttribute('aria-label', '关闭提醒');
  closeButton.append(iconNode('close', { size: 20 }));
  head.append(closeButton);
  const tiers = element('ul');
  for (const tier of config.activeTiers) {
    tiers.append(element('li', undefined, `${tier.name} · ¥${tier.priceYuan}${tier.desc ? ` · ${tier.desc}` : ''}`));
  }
  const action = element('button', undefined, '去我的核销');
  action.type = 'button'; action.dataset.action = 'redeem';
  wrap.append(style, head, element('p', undefined, config.nudgePolicy.dialogBody), tiers, action);
  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true; wrap.remove(); options.onClose();
  }
  closeButton.addEventListener('click', close);
  action.addEventListener('click', () => { if (closed) return; close(); options.onAction(); });
  wrap.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  return { element: wrap, close };
}
