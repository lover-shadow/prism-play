import type { SnapshotState, SyncOutcome } from '../../core/catalog-cache';
import { band, button, make, type ViewState } from '../history-view';

export interface CatalogStatusDeps {
  catalogStatus?: () => SnapshotState | null;
  checkCatalogUpdate?: () => Promise<SyncOutcome>;
  now?: () => number;
}

/** 只展示真实快照；检查由用户触发，结果与时间仅存当前视图内存。 */
export function createCatalogStatusBand(deps: CatalogStatusDeps) {
  const read = deps.catalogStatus, check = deps.checkCatalogUpdate;
  if (read === undefined || check === undefined) return null;
  const section = band('内容库更新', 'set-catalog');
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  let disposed = false, pending = false;
  let checkedAt: number | null = null;
  let state: ViewState | 'offline' = 'empty';
  let result = '尚未检查内容更新。此处检查内容库，不检查 APP 软件版本。';
  const action = button('检查内容更新', () => void run(), { icon: 'refresh', cls: 'pv-btn-ghost', el: 'catalog-check' });
  section.head.append(action);
  section.body.setAttribute('role', 'status');
  section.body.setAttribute('aria-live', 'polite');

  function paint(): void {
    if (disposed) return;
    const snapshot = read!();
    const local = make('p', 'pv-note', snapshot === null
      ? '本地暂无内容库快照：修订未知 · 0 条。'
      : `本地修订 ${snapshot.revision} · ${snapshot.items} 条${snapshot.partial ? '（部分快照）' : ''}`);
    local.dataset.el = 'catalog-local';
    const note = make('p', `pv-state pv-state-${state === 'offline' ? 'error' : state}`, result);
    note.dataset.el = 'catalog-result';
    const time = make('p', 'pv-note', checkedAt === null ? '检查时间：尚未检查' : `检查时间：${new Date(checkedAt * 1000).toLocaleString('zh-CN')}`);
    time.dataset.el = 'catalog-checked-at';
    if (checkedAt !== null) time.dataset.timestamp = String(checkedAt);
    section.wrap.dataset.state = state;
    section.wrap.setAttribute('aria-busy', String(pending));
    action.disabled = pending;
    section.body.replaceChildren(local, note, time);
  }

  async function run(): Promise<void> {
    if (disposed || pending) return;
    pending = true;
    state = 'loading';
    result = '正在检查内容更新…';
    paint();
    try {
      const outcome = await check!();
      if (disposed) return;
      if (outcome.offline) {
        state = 'offline';
        result = read!() === null ? '离线：本地暂无可用快照。' : '离线：沿用本地旧快照，未确认云端是否最新。';
      } else if (outcome.reason !== undefined) {
        state = 'error';
        result = '内容更新失败，未确认云端是否最新。';
      } else {
        state = 'ready';
        result = outcome.appliedEntries === 0 ? '内容库已最新：本次无变更。' : `内容库更新成功：本次应用 ${outcome.appliedEntries} 条变更。`;
      }
      if (outcome.reason !== undefined) result += ` 原因：${outcome.reason}`;
    } catch (error) {
      if (disposed) return;
      state = 'error';
      result = `内容更新失败：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      pending = false;
      if (!disposed) { checkedAt = now(); paint(); }
    }
  }
  paint();
  return { wrap: section.wrap, paint, destroy(): void { disposed = true; } };
}
