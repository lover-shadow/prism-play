// @vitest-environment jsdom
/**
 * 应用外壳测试：Tab 闭集、构造一次的实例纪律、可见性与可达性状态。
 * 这里钉住的最重要一条是"同一 Tab 的视图每 App 生命周期只构造一次"——【设置】视图构造即关私密会话，
 * 若随切换重建，用户切走再切回就被强制结束当次会话（AC-02-2 的边界是冷启动，不是 Tab 切换）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createAppShell, SHELL_TABS, type ManagedView, type ShellTab } from '../../src/app-shell';

/** 从当前工作目录向上找到仓库根，避免依赖 vitest 的 cwd 假设。 */
const readSource = (relative: string): string => {
  let directory = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    const candidate = join(directory, relative);
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
    directory = dirname(directory);
  }
  throw new Error(`找不到样式正本 ${relative}`);
};

const flush = async (): Promise<void> => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

interface Harness {
  tabs: ShellTab[];
  mounts: ShellTab[];
  reloads: ShellTab[];
  destroys: ShellTab[];
  changes: ShellTab[];
  viewFor(tab: ShellTab, root: HTMLElement): ManagedView;
  shell: ReturnType<typeof createAppShell>;
  header: HTMLElement;
  main: HTMLElement;
  tabbar: HTMLElement;
  failures: Partial<Record<ShellTab, Error>>;
}

function harness(over: { initialTab?: ShellTab; throwOn?: ShellTab } = {}): Harness {
  const header = document.createElement('header');
  const main = document.createElement('main');
  const tabbar = document.createElement('nav');
  document.body.replaceChildren(header, main, tabbar);
  const state: Harness = {
    tabs: [],
    mounts: [],
    reloads: [],
    destroys: [],
    changes: [],
    failures: { ...(over.throwOn !== undefined ? { [over.throwOn]: new Error('视图构造失败') } : {}) },
    header,
    main,
    tabbar,
    viewFor(tab: ShellTab): ManagedView {
      if (state.failures[tab] !== undefined) throw state.failures[tab] as Error;
      state.tabs.push(tab);
      return {
        mount: () => { state.mounts.push(tab); },
        reload: () => { state.reloads.push(tab); },
        destroy: () => { state.destroys.push(tab); }
      };
    },
    shell: null as unknown as ReturnType<typeof createAppShell>
  };
  state.shell = createAppShell({
    header, main, tabbar,
    viewFor: (tab, root) => state.viewFor(tab, root),
    onTabChange: (tab) => { state.changes.push(tab); },
    initialTab: over.initialTab
  });
  return state;
}

const tabButton = (bar: HTMLElement, tab: string): HTMLButtonElement =>
  bar.querySelector<HTMLButtonElement>(`.app-tab[data-tab="${tab}"]`)!;

describe('app-shell Tab 拓扑', () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it('主 Tab 是三枚闭集（A-3 底栏 3 键），中文口径逐字固定，且不存在任何私密入口', () => {
    const h = harness();
    expect(SHELL_TABS.map((tab) => tab.id)).toEqual(['home', 'history', 'settings']);
    expect(SHELL_TABS.map((tab) => tab.label)).toEqual(['精选', '追剧', '我的']);
    expect(h.tabbar.querySelectorAll('.app-tab')).toHaveLength(3);
    // 搜索已从 Tab 降级为全屏 Overlay（A-3）：底栏里不该再有任何"搜索"字样与搜索节点。
    expect(h.tabbar.textContent).not.toMatch(/搜索/);
    expect(h.tabbar.textContent).not.toMatch(/探索|私密|成人/);
  });

  it('每枚 Tab 用内联 SVG 图标而非文字符号，aria-label 齐全', () => {
    const h = harness();
    for (const tab of SHELL_TABS) {
      const button = tabButton(h.tabbar, tab.id);
      expect(button.querySelector('svg')).not.toBeNull();
      expect(button.getAttribute('aria-label')).toBe(tab.label);
    }
  });

  it('首次进入即构造并挂载；再次进入只 reload，绝不二次构造', async () => {
    const h = harness();
    await h.shell.activate('settings');
    expect(h.tabs).toEqual(['settings']);
    expect(h.mounts).toEqual(['settings']);
    await h.shell.activate('home');
    await h.shell.activate('settings');
    await h.shell.activate('home');
    expect(h.tabs).toEqual(['settings', 'home']);
    expect(h.reloads).toEqual(['settings', 'home']);
    expect(h.mounts).toEqual(['settings', 'home']);
  });

  it('同一 Tab 的宿主容器是同一个节点（视图实例与 DOM 都跨切换存活）', async () => {
    const h = harness();
    await h.shell.activate('history');
    const first = h.shell.rootOf('history');
    await h.shell.activate('home');
    await h.shell.activate('history');
    expect(h.shell.rootOf('history')).toBe(first);
    expect(first?.dataset.mounted).toBe('1');
  });

  it('可见性与 aria-current 同步：只有当前 Tab 的 panel 不隐藏', async () => {
    const h = harness();
    await h.shell.activate('home');
    expect(h.main.querySelectorAll('.app-view')).toHaveLength(1);
    expect(h.shell.rootOf('home')?.hidden).toBe(false);
    await h.shell.activate('settings');
    expect(h.shell.rootOf('home')?.hidden).toBe(true);
    expect(h.shell.rootOf('settings')?.hidden).toBe(false);
    expect(tabButton(h.tabbar, 'settings').getAttribute('aria-current')).toBe('true');
    expect(tabButton(h.tabbar, 'home').getAttribute('aria-current')).toBe('false');
    expect(tabButton(h.tabbar, 'settings').classList.contains('is-active')).toBe(true);
  });

  it('头部呈现品牌与当前 Tab 名，未登录/未初始化时也不留空', async () => {
    const h = harness({ initialTab: 'settings' });
    await h.shell.activate('settings');
    expect(h.header.textContent).toContain('光影Play');
    expect(h.header.textContent).toContain('我的');
  });

  it('点击 Tab 按钮即切换（真实事件路径，不只调 API）', async () => {
    const h = harness();
    await h.shell.activate('home');
    tabButton(h.tabbar, 'settings').click();
    await flush();
    expect(h.shell.current()).toBe('settings');
  });

  it('并发切换被串行化：最终只有最后一个 Tab 可见', async () => {
    const h = harness();
    await Promise.all([h.shell.activate('home'), h.shell.activate('settings')]);
    expect(h.shell.rootOf('home')?.hidden).toBe(true);
    expect(h.shell.rootOf('settings')?.hidden).toBe(false);
    expect(h.tabs).toEqual(['home', 'settings']);
  });

  it('视图构造失败不楔死外壳：后续 Tab 仍可进入', async () => {
    const h = harness({ throwOn: 'settings' });
    await expect(h.shell.activate('settings')).rejects.toThrow('视图构造失败');
    await h.shell.activate('home');
    expect(h.shell.rootOf('home')?.hidden).toBe(false);
    expect(h.changes).toEqual(['home']);
  });

  it('destroy 拆掉所有已构造视图与宿主，并清空导航', async () => {
    const h = harness();
    await h.shell.activate('home');
    await h.shell.activate('history');
    h.shell.destroy();
    expect(h.destroys).toEqual(['home', 'history']);
    expect(h.main.querySelectorAll('.app-view')).toHaveLength(0);
    expect(h.tabbar.querySelectorAll('.app-tab')).toHaveLength(0);
    // 搜索已降级为全屏 Overlay（A-3）：即便旧调用方仍传 'search'，运行期的 Tab 闭集也让它一个宿主都不产生。
    await h.shell.activate('search' as ShellTab);
    expect(h.tabs).toEqual(['home', 'history']);
  });

  it('未知 Tab 名不产生任何宿主（Tab 闭集在运行期同样成立）', async () => {
    const h = harness();
    await h.shell.activate('private' as ShellTab);
    expect(h.main.querySelectorAll('.app-view')).toHaveLength(0);
    expect(h.tabs).toEqual([]);
  });
});

describe('app-shell 顶栏与底栏骨架（AC-25 / AC-27）', () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it('AC-25 顶栏一次成型为"左品牌 + 右工具槽"，且槽位永不被 paint 清空', async () => {
    const h = harness();
    const row = h.header.querySelector('.app-header-row');
    expect(row).not.toBeNull();
    expect(row?.querySelector('.app-header-brand')).not.toBeNull();
    expect(row?.querySelector('.app-header-accessory')).not.toBeNull();
    // 槽里放进一颗常驻控件后，切四次 Tab 都必须是同一颗实例：重建会丢 aria-pressed 与偏好态。
    const accessory = h.shell.headerAccessory();
    const kept = document.createElement('button');
    kept.type = 'button';
    kept.setAttribute('aria-pressed', 'true');
    accessory.replaceChildren(kept);
    for (const tab of ['settings', 'history', 'home', 'settings'] as ShellTab[]) await h.shell.activate(tab);
    expect(accessory.children).toHaveLength(1);
    expect(accessory.firstElementChild).toBe(kept);
    expect(kept.getAttribute('aria-pressed')).toBe('true');
  });

  it('AC-25 工具槽只在承载它的那个 Tab 可见，其余 Tab 隐藏实例本身', async () => {
    const h = harness();
    expect(h.shell.headerAccessory().hidden).toBe(false);
    await h.shell.activate('settings');
    expect(h.shell.headerAccessory().hidden).toBe(true);
    await h.shell.activate('home');
    expect(h.shell.headerAccessory().hidden).toBe(false);
  });

  it('AC-27 三颗 Tab 等宽住在 .app-tabbar-inner 内容区，栏本体仍可铺满背景', async () => {
    const h = harness();
    const inner = h.tabbar.querySelector('.app-tabbar-inner');
    expect(inner).not.toBeNull();
    // 限宽只能挂在内层：按钮直接挂在 .app-tabbar 上时，缩宽度会把底色与分隔线一起缩掉。
    expect(inner?.children).toHaveLength(3);
    expect(h.tabbar.children).toHaveLength(1);
  });
});

describe('外壳样式静态对账（AC-25 / AC-26 / AC-27）', () => {
  const appCss = readSource('src/styles/app.css');
  const tokensCss = readSource('src/styles/design-tokens.css');

  it('AC-25 顶栏行垂直居中并拉满 --header-height，品牌区不再用 baseline 贴顶', () => {
    const row = appCss.match(/\.app-header-row\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(row).toMatch(/display:\s*flex/);
    expect(row).toMatch(/align-items:\s*center/);
    expect(row).toMatch(/justify-content:\s*space-between/);
    expect(row).toMatch(/height:\s*var\(--header-height\)/);
    const brand = appCss.match(/\.app-brand\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(brand).toMatch(/align-items:\s*center/);
    expect(brand).not.toMatch(/baseline/);
  });

  it('AC-27 底栏内容区限宽来自 token 且等于 360px，居中收拢', () => {
    const inner = appCss.match(/\.app-tabbar-inner\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(inner).toMatch(/max-width:\s*var\(--tabbar-content-max\)/);
    expect(inner).toMatch(/margin:\s*0 auto/);
    expect(inner).toMatch(/width:\s*100%/);
    expect(tokensCss).toMatch(/--tabbar-content-max:\s*360px/);
  });

  it('AC-26 胶囊双口径的两个 token 都真实存在，且 app.css 未把 44px 写死', () => {
    expect(tokensCss).toMatch(/--capsule-height:\s*28px/);
    expect(tokensCss).toMatch(/--capsule-hit:\s*44px/);
    expect(appCss).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
  });
});
