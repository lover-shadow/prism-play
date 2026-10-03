/**
 * 会话内检索记录（SPEC-APP-REFACTOR A-3：搜索 Overlay 自上而下第二段）。
 *
 * 一条硬约束：**只住内存，一个字节都不写存储**。
 * - AC-18 的"私密零留痕"因此无从被违反（不落盘就没有需要剔除的东西）；
 * - AC-02-2 的"开启状态严禁持久化"同一条纪律也不被这里的记录抢先把搜索词带上磁盘；
 * - 冷启动或完全退出即自然清空，用户不需要任何"清除隐私"的额外入口。
 *
 * 因此界面上的口径也必须如实：文案写的是"本次会话"，不写成"历史搜索记录"暗示的永久账本。
 * ≤20 条、去重、最新在前；「清除」就地清内存数组并重绘。
 */
import { band, button, make, readyBand, stateBand, type Band } from './history-view';

export const SEARCH_HISTORY_LIMIT = 20;

export interface SearchHistoryLedger {
  /** 记录一次真正发出的检索词：空白词与超长词（本地拒绝、未发送）不该进记录。 */
  note(word: string): void;
  list(): string[];
  clear(): void;
  size(): number;
}

export function createSearchHistoryLedger(limit: number = SEARCH_HISTORY_LIMIT): SearchHistoryLedger {
  const words: string[] = [];
  return {
    note(raw: string): void {
      const word = raw.trim();
      if (word === '') return;
      const at = words.indexOf(word);
      if (at >= 0) words.splice(at, 1);
      words.unshift(word);
      if (words.length > limit) words.length = limit;
    },
    list: () => [...words],
    clear(): void {
      words.length = 0;
    },
    size: () => words.length
  };
}

export interface SearchHistoryBand {
  wrap: HTMLElement;
  band: Band;
  /** 每次真实检索后与「清除」后各调一次，保持可见状态与内存一致。 */
  paint(): void;
  destroy(): void;
}

/**
 * 搜索历史的展示带：点词条即回灌输入框并立刻发起同一条检索（与热词同一个交互口径）。
 * @param onPick 用户点中的词——由搜索视图负责真正跑一次检索，本模块不碰网络。
 */
export function createSearchHistoryBand(
  ledger: SearchHistoryLedger,
  onPick: (word: string) => void,
  onClear: () => void = () => undefined
): SearchHistoryBand {
  const target = band('本次会话检索记录', 'search-history', '仅存内存，退出应用即清空');
  // 清除键在构造时挂一次，之后只切可见性：每次重绘都 append 会把同一颗按钮越叠越多。
  const clearButton = button('清除', () => {
    ledger.clear();
    onClear();
    paint();
  }, { icon: 'trash', cls: 'pv-btn-ghost', el: 'history-clear' });
  clearButton.hidden = true;
  target.head.append(clearButton);

  function paint(): void {
    const words = ledger.list();
    clearButton.hidden = words.length === 0;
    if (words.length === 0) return stateBand(target, 'empty', '本次会话还没有检索记录：搜索结果会列在这里，只存内存。');
    const chips = make('div', 'pv-chip-row');
    chips.append(...words.map((word) => button(word, () => onPick(word), { cls: 'pv-chip', el: 'history-word' })));
    readyBand(target, [chips]);
  }

  return {
    wrap: target.wrap,
    band: target,
    paint,
    destroy(): void {
      target.wrap.remove();
    }
  };
}
