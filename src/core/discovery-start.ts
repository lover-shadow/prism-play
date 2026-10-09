export function deferDiscoverySync(sync: () => Promise<unknown>, busy: () => boolean): () => void {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout>;
  const run = (): void => {
    if (disposed) return;
    if (busy()) { timer = setTimeout(run, 2000); return; }
    void sync();
  };
  timer = setTimeout(run, 2000);
  return () => { disposed = true; clearTimeout(timer); };
}
