/**
 * 应用外壳：底部三主 Tab（【精选】/【追剧】/【我的】）与视图宿主（SPEC §7、AC-01；SPEC-APP-REFACTOR A-1 / A-3）。
 *
 * 三条不可让的纪律都落在这里：
 * 1. **每个 Tab 的视图实例每 App 生命周期只构造一次**——【我的】视图"构造即关"（AC-02-2 冷启动默认关闭），
 *    若随 Tab 切换反复重建，用户切走再切回就等于被强制结束当次私密会话，那是行为缺陷而非保守设计；
 * 2. 私密频道节点在拓扑里不存在时，外壳也不制造任何"私密"字样（AC-02-3 双层隐形）；
 * 3. **Page 级返回由外壳统一裁决**（A-1）：Tab 切换 push 一条历史，返回键按「上一个 Tab → 首页深滚回顶 →
 *    2 秒双击退出」的顺序消费。搜索不再是 Tab（A-3），它由首页搜索条拉起为全屏 Overlay 并注册为 Layer。
 */
import { icon, type IconName } from './components/icons';
import { exitApplication, registerBackHandler, unwindHistory } from './core/native/back-button';

export type ShellTab = 'home' | 'history' | 'settings';

export interface ShellTabDefinition {
  id: ShellTab;
  label: string;
  glyph: IconName;
}

/**
 * Tab 闭集（A-3 定案【精选/追剧/我的】），新增必须走契约变更。图标只能取自 `components/icons.ts` 的锁定表
 * （P0-1）：SPEC 点名的 sparkles / clock / user 不在表内，就近取义为网格 / 回拨时钟 / 齿轮。
 */
export const SHELL_TABS: readonly ShellTabDefinition[] = [
  { id: 'home', label: '精选', glyph: 'grid' },
  { id: 'history', label: '追剧', glyph: 'history' },
  { id: 'settings', label: '我的', glyph: 'settings' }
];

export interface ManagedView {
  mount(): void | Promise<void>;
  /** 再次进入已构造的视图时刷新数据，而不是重建实例。 */
  reload?(): void | Promise<void>;
  destroy?(): void;
}

/** A-1 深滚回顶的滚动接缝：判定与回顶只走这一条路，不留第二套滚动真相。 */
export interface HomeScrollProbe {
  position(): number;
  toTop(): void;
}

export interface AppShellDeps {
  header: HTMLElement;
  main: HTMLElement;
  tabbar: HTMLElement;
  /** 宿主工厂：外壳保证同一 Tab 只调用一次，并把该 Tab 专属的 root 容器交给它。 */
  viewFor(tab: ShellTab, root: HTMLElement): ManagedView;
  onTabChange?(tab: ShellTab): void;
  initialTab?: ShellTab;
  homeScroll?: HomeScrollProbe;
  /** 一次性轻提示（A-1 双击退出 Toast）：由组合根注入 `createNotice`。 */
  notice?: (message: string) => void;
  /** 退出应用（缺省交还原生总线）与时计时钟：后者供单测推进 2 秒窗口。 */
  exitApp?: () => void;
  now?: () => number;
}

export interface AppShell {
  activate(tab: ShellTab): Promise<void>;
  current(): ShellTab;
  /** Page 级返回栈深度（测试与遥测用；不参与任何渲染决策）。 */
  backDepth(): number;
  /** 供视图回调里拿到自己那一份宿主（例如搜索视图的键盘聚焦）。 */
  rootOf(tab: ShellTab): HTMLElement | null;
  /**
   * 顶栏右侧「工具槽」：本波次承载首页的四模排版切换器（视觉精致化 §1.7.3）。槽位在 shell 构造时就存在且
   * **永不被 replaceChildren 清空**——槽里控件由视图构造一次后常驻，切 Tab 只切可见性；若像旧实现那样每次
   * paint 重建 header 子节点，切换器会随 Tab 反复重建并丢失 `aria-pressed` 与偏好态。
   */
  headerAccessory(): HTMLElement;
  destroy(): void;
}

const isShellTab = (value: string): value is ShellTab =>
  SHELL_TABS.some((tab) => tab.id === value);

/** 深滚回顶阈值（A-1 定案 300px）：低于它返回键就当作"没什么可回顶"，交还下一级。 */
export const DEEP_SCROLL_THRESHOLD = 300;
/** 双击退出的窗口期（A-1 定案 2 秒）：窗口内第二下才真退，超时自动重置。 */
export const DOUBLE_EXIT_WINDOW_MS = 2_000;
/** Page 级栈的内存上限：超过即丢最旧的记录，返回最终必然落回【精选】而不是无限后退。 */
const TAB_STACK_MAX = 8;

export function createAppShell(deps: AppShellDeps): AppShell {
  const views = new Map<ShellTab, ManagedView>();
  const hosts = new Map<ShellTab, HTMLElement>();
  const buttons = new Map<ShellTab, HTMLButtonElement>();
  let active: ShellTab = deps.initialTab ?? 'home';
  let destroyed = false;
  /** 串行化切换：并发 activate() 交错会让两个 Tab 同时可见。 */
  let queue: Promise<void> = Promise.resolve();
  /** Page 级返回栈：只记"从哪个 Tab 过来"，同 Tab 重复点击不入栈。 */
  const tabStack: ShellTab[] = [];
  let booted = false;
  let lastExitAt = Number.NEGATIVE_INFINITY;

  /** 缺省滚动接缝：`main` 在 Capacitor 宿主里就是滚动容器，读不到才退到 `window`。 */
  const scrollProbe: HomeScrollProbe = deps.homeScroll ?? {
    position: () => (deps.main.scrollTop > 0 ? deps.main.scrollTop : typeof window === 'undefined' ? 0 : window.scrollY),
    toTop: () => {
      if (deps.main.scrollTop > 0) deps.main.scrollTop = 0;
      if (typeof window !== 'undefined' && window.scrollY > 0) window.scroll(0, 0);
    }
  };

  /**
   * A-1 的 Page 级裁决（Layer / Dialog 已被总线排在前面，走到这里说明浮层都没人消费）：
   * ①【精选】且已深滚 → 平滑回顶；② 有上一个 Tab → 回退过去；③ 不在【精选】→ 回【精选】；
   * ④ 已在【精选】顶部且无上级 → 2 秒双击退出。每一步都消费事件，兜底的"直接退 App"因此不再被触发。
   */
  function onPageBack(): boolean {
    if (destroyed) return false;
    if (active === 'home' && scrollProbe.position() > DEEP_SCROLL_THRESHOLD) {
      scrollProbe.toTop();
      return true;
    }
    const previous = tabStack.pop();
    if (previous !== undefined) {
      void navigate(previous, false);
      unwindHistory();
      return true;
    }
    if (active !== 'home') {
      void navigate('home', true);
      return true;
    }
    const at = (deps.now ?? ((): number => Date.now()))();
    if (at - lastExitAt <= DOUBLE_EXIT_WINDOW_MS) {
      lastExitAt = Number.NEGATIVE_INFINITY;
      (deps.exitApp ?? exitApplication)();
      return true;
    }
    lastExitAt = at;
    deps.notice?.('再按一次退出光影Play');
    return true;
  }
  const releasePageBack = registerBackHandler(onPageBack, 'page');

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
    const wrap = element('div', 'app-brand');
    const name = element('span', 'app-brand-name');
    name.textContent = '光影Play';
    const current = element('span', 'app-brand-tab');
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
    // Tab 挤在 `.app-tabbar-inner` 而不是 `.app-tabbar` 上：限宽 360px 只能收内容，
    // 挂在栏本体会把底色与分隔线一起缩掉（AC-27）。
    const inner = element('div', 'app-tabbar-inner');
    deps.tabbar.replaceChildren(inner);
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
      inner.appendChild(button);
      buttons.set(tab.id, button);
    }
  }

  /**
   * 真正的切屏。`record` 决定要不要在 Page 级栈与浏览器历史里留一格"能回去的位置"：用户点 Tab / 宿主
   * activate 留（返回键才有上一格可退）；返回键自己退栈时不留，否则退一次记两次、永远退不完。
   */
  async function run(tab: ShellTab, record: boolean): Promise<void> {
    if (destroyed || !isShellTab(tab)) return;
    const view = viewFor(tab);
    const host = hostFor(tab);
    const changed = tab !== active;
    if (record && changed && booted) {
      tabStack.push(active);
      if (tabStack.length > TAB_STACK_MAX) tabStack.splice(0, tabStack.length - TAB_STACK_MAX);
      // History 是"物理后退也要落到同一格"的手段，不是必需品：宿主不可用时端内栈照样成立。
      try {
        window.history.pushState({ prismTab: tab }, '');
      } catch {
        /* 无 History API 的宿主：只保留内存栈，退栈时不弹历史条目 */
      }
    }
    booted = true;
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

  function navigate(tab: ShellTab, record: boolean): Promise<void> {
    const next = queue.then(() => run(tab, record));
    // A failing view must not wedge the shell: swallow the rejection for the queue, rethrow to the caller.
    queue = next.catch(() => undefined);
    return next;
  }

  function activate(tab: ShellTab): Promise<void> {
    return navigate(tab, true);
  }

  buildTabs();

  return {
    activate,
    current: () => active,
    /** Page 级返回栈的当前深度（测试与遥测用；不参与任何渲染决策）。 */
    backDepth: () => tabStack.length,
    rootOf: (tab) => hosts.get(tab) ?? null,
    headerAccessory: () => accessoryHost,
    destroy() {
      destroyed = true;
      releasePageBack();
      tabStack.length = 0;
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
