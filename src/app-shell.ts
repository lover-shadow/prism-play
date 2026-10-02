/**
 * 应用外壳：底部四主 Tab（大视界 / 追剧 / 搜索 / 设置）与视图宿主（SPEC §7、AC-01）。
 *
 * 两条不可让的纪律都落在这里：
 * 1. **每个 Tab 的视图实例每 App 生命周期只构造一次**——【设置】视图"构造即关"（AC-02-2 冷启动默认关闭），
 *    若随 Tab 切换反复重建，用户切走再切回就等于被强制结束当次私密会话，那是行为缺陷而非保守设计；
 * 2. 私密频道节点在拓扑里不存在时，外壳也不制造任何"私密"字样（AC-02-3 双层隐形）。
 */
import { icon, type IconName } from './components/icons';

export type ShellTab = 'home' | 'history' | 'search' | 'settings';

export interface ShellTabDefinition {
  id: ShellTab;
  label: string;
  glyph: IconName;
}

/** Tab 闭集：本期 MVP 只有这四个主界面（SPEC §2），新增必须走契约变更。 */
export const SHELL_TABS: readonly ShellTabDefinition[] = [
  { id: 'home', label: '大视界', glyph: 'grid' },
  { id: 'history', label: '追剧', glyph: 'history' },
  { id: 'search', label: '搜索', glyph: 'search' },
  { id: 'settings', label: '设置', glyph: 'settings' }
];

export interface ManagedView {
  mount(): void | Promise<void>;
  /** 再次进入已构造的视图时刷新数据，而不是重建实例。 */
  reload?(): void | Promise<void>;
  destroy?(): void;
}

export interface AppShellDeps {
  header: HTMLElement;
  main: HTMLElement;
  tabbar: HTMLElement;
  /** 宿主工厂：外壳保证同一 Tab 只调用一次，并把该 Tab 专属的 root 容器交给它。 */
  viewFor(tab: ShellTab, root: HTMLElement): ManagedView;
  onTabChange?(tab: ShellTab): void;
  initialTab?: ShellTab;
}

export interface AppShell {
  activate(tab: ShellTab): Promise<void>;
  current(): ShellTab;
  /** 供视图回调里拿到自己那一份宿主（例如搜索视图的键盘聚焦）。 */
  rootOf(tab: ShellTab): HTMLElement | null;
  /**
   * 顶栏右侧「工具槽」：本波次用于承载首页的四模排版切换器（视觉精致化 §1.7.3）。
   *
   * 槽位在 shell 构造时就存在且**永不被 replaceChildren 清空**——槽里的控件由视图构造一次后常驻，
   * 切 Tab 只切换槽的可见性。若像旧实现那样每次 paint 重建 header 子节点，排版切换器会随 Tab 切换
   * 反复重建并丢失 `aria-pressed` 与偏好态。
   */
  headerAccessory(): HTMLElement;
  destroy(): void;
}

const isShellTab = (value: string): value is ShellTab =>
  SHELL_TABS.some((tab) => tab.id === value);

export function createAppShell(deps: AppShellDeps): AppShell {
  const views = new Map<ShellTab, ManagedView>();
  const hosts = new Map<ShellTab, HTMLElement>();
  const buttons = new Map<ShellTab, HTMLButtonElement>();
  let active: ShellTab = deps.initialTab ?? 'home';
  let destroyed = false;
  /** 串行化切换：并发 activate() 交错会让两个 Tab 同时可见。 */
  let queue: Promise<void> = Promise.resolve();

  function hostFor(tab: ShellTab): HTMLElement {
    const existing = hosts.get(tab);
    if (existing !== undefined) return existing;
    const host = document.createElement('section');
    host.className = 'app-view';
    host.dataset.tab = tab;
    host.setAttribute('role', 'tabpanel');
    host.hidden = true;
    deps.main.appendChild(host);
    hosts.set(tab, host);
    return host;
  }

  function viewFor(tab: ShellTab): ManagedView {
    const existing = views.get(tab);
    if (existing !== undefined) return existing;
    const built = deps.viewFor(tab, hostFor(tab));
    views.set(tab, built);
    return built;
  }

  function paint(): void {
    for (const { id, label } of SHELL_TABS) {
      const host = hosts.get(id);
      if (host !== undefined) host.hidden = id !== active;
      const button = buttons.get(id);
      if (button !== undefined) {
        button.setAttribute('aria-current', id === active ? 'true' : 'false');
        button.classList.toggle('is-active', id === active);
      }
      // 只换品牌文案，绝不重建顶栏结构：槽内控件（首页排版切换器）必须常驻复用。
      if (id === active) brandHost.replaceChildren(brand(label));
    }
    // 工具槽只属于承载它的那个 Tab；其余 Tab 隐藏，控件实例本身不被销毁。
    accessoryHost.hidden = active !== accessoryTab;
    deps.main.scrollTop = 0;
  }

  function brand(label: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'app-brand';
    const name = document.createElement('span');
    name.className = 'app-brand-name';
    name.textContent = '光影Play';
    const current = document.createElement('span');
    current.className = 'app-brand-tab';
    current.textContent = label;
    wrap.append(name, current);
    return wrap;
  }

  /**
   * 顶栏一次成型：左品牌 + 右工具槽。
   *
   * 旧实现每次 paint 都 `header.replaceChildren(brand(...))`，顶栏因此永远只有一个品牌区、右侧一大片
   * 留白，且任何挂上去的控件都会被下一次切 Tab 抹掉。这里改成固定骨架 + 局部更新。
   */
  const headerRow = element('div', 'app-header-row');
  const brandHost = element('div', 'app-header-brand');
  const accessoryHost = element('div', 'app-header-accessory');
  const accessoryTab: ShellTab = 'home';
  accessoryHost.hidden = (deps.initialTab ?? 'home') !== accessoryTab;
  headerRow.append(brandHost, accessoryHost);
  deps.header.replaceChildren(headerRow);

  function element(tag: string, className: string): HTMLElement {
    const node = document.createElement(tag);
    node.className = className;
    return node;
  }

  function buildTabs(): void {
    deps.tabbar.replaceChildren();
    for (const tab of SHELL_TABS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'touch-target app-tab';
      button.dataset.tab = tab.id;
      button.setAttribute('aria-label', tab.label);
      button.innerHTML = icon(tab.glyph, { size: 24 });
      const caption = document.createElement('span');
      caption.className = 'app-tab-label';
      caption.textContent = tab.label;
      button.appendChild(caption);
      button.addEventListener('click', () => void activate(tab.id));
      deps.tabbar.appendChild(button);
      buttons.set(tab.id, button);
    }
  }

  async function run(tab: ShellTab): Promise<void> {
    if (destroyed || !isShellTab(tab)) return;
    const view = viewFor(tab);
    const host = hostFor(tab);
    active = tab;
    // 0ms 乐观响应：先刷新界面高亮与容器可见性，杜绝网络与 I/O 阻塞切屏手感
    paint();
    deps.onTabChange?.(tab);

    if (!host.dataset.mounted) {
      host.dataset.mounted = '1';
      await view.mount();
    } else {
      await view.reload?.();
    }
  }

  function activate(tab: ShellTab): Promise<void> {
    const next = queue.then(() => run(tab));
    // A failing view must not wedge the shell: swallow the rejection for the queue, rethrow to the caller.
    queue = next.catch(() => undefined);
    return next;
  }

  buildTabs();

  return {
    activate,
    current: () => active,
    rootOf: (tab) => hosts.get(tab) ?? null,
    headerAccessory: () => accessoryHost,
    destroy() {
      destroyed = true;
      for (const view of views.values()) view.destroy?.();
      views.clear();
      for (const host of hosts.values()) host.remove();
      hosts.clear();
      buttons.clear();
      deps.tabbar.replaceChildren();
      deps.header.replaceChildren();
    }
  };
}
