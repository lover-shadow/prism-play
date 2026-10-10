/** Native TextureView sits below the WHOLE WebView: isolate the host, not only its background. */
const owners = new WeakMap<HTMLElement, Map<string, { count: number; original: boolean }>>();
function acquire(element: HTMLElement, name: string): () => void {
  const classes = owners.get(element) ?? new Map();
  owners.set(element, classes);
  const state = classes.get(name) ?? { count: 0, original: element.classList.contains(name) };
  state.count += 1; classes.set(name, state); element.classList.add(name);
  return () => {
    state.count -= 1;
    if (state.count > 0) return;
    if (!state.original) element.classList.remove(name);
    classes.delete(name);
  };
}

export function acquireNativeComposition(container: HTMLElement): () => void {
  const release: (() => void)[] = [];
  for (let element: HTMLElement | null = container; element; element = element.parentElement) {
    release.push(acquire(element, 'prism-native-transparent'));
  }
  release.push(acquire(document.documentElement, 'prism-native-active'));
  const hidden = new Set<HTMLElement>();
  const branches: Array<{ parent: HTMLElement; keep: HTMLElement }> = [];
  const host = container.closest<HTMLElement>('.prism-player-host');
  // Preserve every control INSIDE the host. Only background branches outside it are occluded.
  for (let keep = host; keep?.parentElement; keep = keep.parentElement) {
    if (keep.parentElement === document.documentElement) break;
    branches.push({ parent: keep.parentElement, keep });
  }
  const isolate = (): void => {
    for (const { parent, keep } of branches) {
      for (const child of Array.from(parent.children)) {
        if (!(child instanceof HTMLElement) || child === keep || hidden.has(child) ||
            child.matches('.prism-player-host, script, style, link')) continue;
        hidden.add(child); release.push(acquire(child, 'prism-native-occluded'));
      }
    }
  };
  isolate();
  const observer = new MutationObserver(isolate);
  for (const { parent } of branches) observer.observe(parent, { childList: true });
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true; observer.disconnect();
    for (const off of release.reverse()) off();
  };
}
