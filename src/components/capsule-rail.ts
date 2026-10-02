/**
 * 第二层：吸顶联动横滑次级胶囊（SPEC §7、UIUX §5.2）。
 *
 * 分类集合 100% 来自 `/api/channels` 里所选频道的 `categories`：客户端不写死题材、不造假榜单
 * （`今日爆火` / `偏好推荐` 这类需要真实数据支撑的胶囊由云端决定是否下发）。
 * 「全部」只在云端分类里缺席时补一次，用来表达「不按分类过滤」，而不是把用户的选择藏起来。
 */

import { clearChildren, element } from './state-views';

export const ALL_CATEGORIES_LABEL = '全部';

export interface CapsuleRailDeps {
  root: HTMLElement;
  onSelect: (category: string) => void;
}

export interface CapsuleRail {
  /** 传入所选频道的 `categories` 原值（非字符串项会被丢弃，与边缘 `categories_json` 降级口径一致）。 */
  render(categories: readonly unknown[], selected?: string): void;
  select(category: string): void;
  destroy(): void;
}

export function buildCapsules(categories: readonly unknown[]): string[] {
  const kept: string[] = [];
  for (const raw of categories) {
    if (typeof raw !== 'string') continue;
    const label = raw.trim();
    if (label !== '' && !kept.includes(label)) kept.push(label);
  }
  return kept.includes(ALL_CATEGORIES_LABEL) ? kept : [ALL_CATEGORIES_LABEL, ...kept];
}

export function createCapsuleRail(deps: CapsuleRailDeps): CapsuleRail {
  let pills: HTMLButtonElement[] = [];

  function paintSelected(selected: string | undefined): void {
    for (const pill of pills) {
      const active = pill.dataset.category === selected;
      pill.classList.toggle('is-active', active);
      if (active) pill.setAttribute('aria-current', 'true');
      else pill.removeAttribute('aria-current');
    }
  }

  function scrollToActive(pill: HTMLButtonElement): void {
    // jsdom 与老 WebView 都可能没有滚动实现，缺能力即静默跳过，绝不让渲染中断。
    pill.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  function render(categories: readonly unknown[], selected?: string): void {
    clearChildren(deps.root);
    pills = [];
    const labels = buildCapsules(categories);

    const nav = element('nav', 'capsule-rail-wrap');
    nav.setAttribute('aria-label', '二级分类');
    const rail = element('div', 'capsule-rail');
    const signal = new AbortController();

    for (const label of labels) {
      // 按钮盒 = 命中区（`--capsule-hit` 44px），内层 span = 观感胶囊（`--capsule-height` 28px）。
      // 两层分开才能同时满足"视觉降维到 28px"与 SPEC §10 的"可点击 ≥44px"；
      // 只把 28px 写在按钮上、再靠外层 padding 撑行，命中区实测仍是 28px——那是无障碍破口而非双口径。
      const chip = element('button', 'capsule touch-target');
      chip.type = 'button';
      chip.dataset.category = label;
      chip.title = label;
      chip.appendChild(element('span', 'capsule-pill', label));
      chip.addEventListener('click', () => deps.onSelect(label), { signal: signal.signal });
      rail.appendChild(chip);
      pills.push(chip);
    }

    rail.addEventListener(
      'keydown',
      (event) => {
        const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, Home: -9999, End: 9999 };
        const delta = keys[event.key];
        if (delta === undefined || pills.length === 0) return;
        event.preventDefault();
        const at = pills.findIndex((pill) => pill === document.activeElement);
        const wanted = at + delta;
        const next = pills[Math.min(pills.length - 1, Math.max(0, wanted))] ?? pills[0];
        next.focus();
      },
      { signal: signal.signal }
    );

    nav.appendChild(rail);
    deps.root.appendChild(nav);
    const active = pills.find((pill) => pill.dataset.category === selected) ?? pills[0];
    if (active !== undefined) {
      paintSelected(active.dataset.category ?? ALL_CATEGORIES_LABEL);
      scrollToActive(active);
    }
  }

  return {
    render,
    select: (category: string) => paintSelected(category),
    destroy: () => {
      pills = [];
      clearChildren(deps.root);
    }
  };
}
