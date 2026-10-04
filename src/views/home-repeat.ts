/** R26-07：无时间阈值的连续目标序列；同步与绘制单飞，导航代次隔离迟到结果。 */
export function createHomeRepeat(deps: {
  top(): void;
  sync?: () => Promise<void>;
  reload(): Promise<void>;
  invalidate(): void;
  failed(error: unknown): void;
}) {
  let previous: string | null = null, generation = 0, disposed = false;
  let pending: Promise<void> | null = null;
  const interrupt = (): void => { previous = null; generation++; deps.invalidate(); };
  function refresh(): Promise<void> {
    if (pending !== null) return pending;
    interrupt();
    const at = generation;
    // 将 pending 落位放在同步执行前：同步抛错也必须进入同一条 finally。
    pending = (async () => {
      try {
        await deps.sync?.();
        if (!disposed && at === generation) await deps.reload();
      } catch (error) {
        await Promise.resolve(); // sync 回调同步抛错时也先让 pending 完成落位。
        if (!disposed && at === generation) deps.failed(error);
      } finally { previous = null; pending = null; }
    })();
    return pending;
  }
  return {
    refresh,
    interrupt,
    busy: () => pending !== null,
    click(target: string): void {
      if (disposed || pending !== null) return;
      if (previous === target) { void refresh(); return; }
      previous = target; deps.top();
    },
    destroy(): void { disposed = true; interrupt(); }
  };
}
