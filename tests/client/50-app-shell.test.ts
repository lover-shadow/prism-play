// @vitest-environment jsdom
/**
 * 应用外壳测试：Tab 闭集、构造一次的实例纪律、可见性与可达性状态。
 * 这里钉住的最重要一条是"同一 Tab 的视图每 App 生命周期只构造一次"——【设置】视图构造即关私密会话，
 * 若随切换重建，用户切走再切回就被强制结束当次会话（AC-02-2 的边界是冷启动，不是 Tab 切换）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createAppShell, SHELL_TABS, type ManagedView, type ShellTab } from '../../src/app-shell';

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

  it('主 Tab 是四枚闭集，中文口径逐字固定，且不存在任何私密入口', () => {
    const h = harness();
    expect(SHELL_TABS.map((tab) => tab.id)).toEqual(['home', 'history', 'search', 'settings']);
    expect(SHELL_TABS.map((tab) => tab.label)).toEqual(['大视界', '追剧', '搜索', '设置']);
    expect(h.tabbar.querySelectorAll('.app-tab')).toHaveLength(4);
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
    await h.shell.activate('search');
    expect(h.shell.rootOf('home')?.hidden).toBe(true);
    expect(h.shell.rootOf('search')?.hidden).toBe(false);
    expect(tabButton(h.tabbar, 'search').getAttribute('aria-current')).toBe('true');
    expect(tabButton(h.tabbar, 'home').getAttribute('aria-current')).toBe('false');
    expect(tabButton(h.tabbar, 'search').classList.contains('is-active')).toBe(true);
  });

  it('头部呈现品牌与当前 Tab 名，未登录/未初始化时也不留空', async () => {
    const h = harness({ initialTab: 'settings' });
    await h.shell.activate('settings');
    expect(h.header.textContent).toContain('光影Play');
    expect(h.header.textContent).toContain('设置');
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
    await Promise.all([h.shell.activate('home'), h.shell.activate('search')]);
    expect(h.shell.rootOf('home')?.hidden).toBe(true);
    expect(h.shell.rootOf('search')?.hidden).toBe(false);
    expect(h.tabs).toEqual(['home', 'search']);
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
    await h.shell.activate('search');
    expect(h.tabs).toEqual(['home', 'history']);
  });

  it('未知 Tab 名不产生任何宿主（Tab 闭集在运行期同样成立）', async () => {
    const h = harness();
    await h.shell.activate('private' as ShellTab);
    expect(h.main.querySelectorAll('.app-view')).toHaveLength(0);
    expect(h.tabs).toEqual([]);
  });
});
