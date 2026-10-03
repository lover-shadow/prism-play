/**
 * 全屏搜索 Overlay（SPEC-APP-REFACTOR A-3）与它在返回栈里的 Layer 注册（A-1）。
 *
 * 为什么不是 Tab：底栏 3 键里"搜索"与首页搜索入口职责重叠，产品定案把它降为一层**覆盖层**。
 * 因此它的生命周期由本模块管：开＝建节点 + push 一条历史 + 注册 Layer handler + 聚焦输入框；
 * 关＝摘 handler + 销毁视图 + 弹掉自己那条历史。四个入口（关闭键 / 侧滑 / 浏览器后退 / 点结果起播）
 * 走同一条 `close()`，不存在"某条路径关不掉"的第二套语义。
 *
 * 历史条目的处理必须分清来源：浏览器物理后退已经消耗了一条，此时再 `history.back()` 会多退一层，
 * 所以只有非 popstate 路径才由我们自己弹（`getBackDispatchSource()`）。
 */
import type { ContentItem } from '../../edge/src/types/api';
import { getBackDispatchSource, registerBackHandler, unwindHistory } from '../core/native/back-button';
import { createSearchView, type BrowseTarget, type SearchApi, type SearchView } from './search-view';

export interface SearchOverlayDeps {
  /** 覆盖层挂载点：真实页面是 `#app`，测试传一个普通容器即可。 */
  appRoot: HTMLElement;
  api: SearchApi;
  /** 端侧榜单与热词的数据源（本机公开快照读面）：Overlay 自己不碰存储域。 */
  localItems: () => readonly ContentItem[];
  hotWords: () => string[];
  onOpenTitle(contentId: string): void;
  /** 「回【精选】浏览」的去处：由宿主切 Tab，本模块只负责先把这层关掉。 */
  onBrowse?(target: BrowseTarget): void;
}

export interface SearchOverlay {
  open(): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

export function createSearchOverlay(deps: SearchOverlayDeps): SearchOverlay {
  let panel: HTMLElement | null = null;
  let view: SearchView | null = null;
  let releaseBack: (() => void) | null = null;
  let pushedEntry = false;

  function body(): HTMLElement {
    const node = document.createElement('div');
    node.className = 'app-overlay-body';
    node.dataset.el = 'search-overlay';
    return node;
  }

  /** 只拆这层自己的东西：handler 与视图实例都跟着面板走，不留悬空监听。 */
  function teardown(): void {
    releaseBack?.();
    releaseBack = null;
    view?.destroy();
    view = null;
    panel?.remove();
    panel = null;
  }

  function close(): void {
    if (panel === null) return;
    const owned = pushedEntry;
    teardown();
    // 浏览器后退已经把条目弹掉了；其余路径（关闭键 / 原生返回键 / 点结果）由我们补这一次弹栈。
    if (owned && getBackDispatchSource() !== 'popstate') unwindHistory();
    pushedEntry = false;
  }

  function open(): void {
    if (panel !== null) {
      view?.focus();
      return;
    }
    const node = document.createElement('div');
    node.className = 'app-overlay';
    node.setAttribute('role', 'dialog');
    node.setAttribute('aria-modal', 'true');
    node.setAttribute('aria-label', '搜索与榜单');
    const host = body();
    node.appendChild(host);
    deps.appRoot.appendChild(node);
    panel = node;

    view = createSearchView({
      api: deps.api,
      root: host,
      localItems: deps.localItems,
      hotWords: deps.hotWords(),
      onOpenTitle: (contentId) => {
        // 起播前必须先关掉这层：播放器的 Layer handler 才能在返回栈里干净地接手。
        close();
        deps.onOpenTitle(contentId);
      },
      onClose: close,
      onBrowse: (target) => {
        close();
        deps.onBrowse?.(target);
      }
    });
    void view.mount();
    releaseBack = registerBackHandler(() => {
      if (panel === null) return false;
      close();
      return true;
    }, 'layer');

    // 浏览器物理后退要先关这层，所以自己压一条条目；宿主没有 History API 时如实跳过。
    try {
      window.history.pushState({ prismLayer: 'search-overlay' }, '');
      pushedEntry = true;
    } catch {
      pushedEntry = false;
    }
    view.focus();
  }

  return {
    open,
    close,
    isOpen: () => panel !== null,
    destroy() {
      if (panel !== null && pushedEntry && getBackDispatchSource() !== 'popstate') unwindHistory();
      teardown();
      pushedEntry = false;
    }
  };
}
