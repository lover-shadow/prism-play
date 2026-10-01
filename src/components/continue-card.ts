/**
 * 首屏黄金续播卡（SPEC AC-03 / F-06，UIUX §5.3）。
 *
 * 数据来自注入的 `historyPreview()`（历史域归其它 Agent 持有，本组件只读不管写），
 * 展示剧名 / 第 N 集 / 秒级断点，进度条宽度即 `position_seconds / duration_seconds`。
 * 无历史时整卡不渲染——不留空壳占位，首屏第一视口还给片单。
 */

import type { WatchHistoryRow } from '../core/storage/storage-domains';
import { clearChildren, element, iconNode } from './state-views';

/** `m:ss`，满一小时走 `h:mm:ss`；非法值一律收敛到 `0:00`，绝不出现 NaN。 */
export function formatClock(value: number): string {
  const total = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (input: number): string => String(input).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** 断点比例（0–1）。时长为 0 或缺失时返回 0：不除零、不 NaN、不画满格。 */
export function progressRatio(positionSeconds: number, durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  if (!Number.isFinite(positionSeconds) || positionSeconds <= 0) return 0;
  return Math.min(1, Math.max(0, positionSeconds / durationSeconds));
}

export function progressPercent(positionSeconds: number, durationSeconds: number): number {
  return Math.round(progressRatio(positionSeconds, durationSeconds) * 100);
}

/** `updated_at` 降序取最近一部：历史域即便已排序，视图也不依赖对方的排序承诺。 */
export function latestRow(rows: readonly WatchHistoryRow[]): WatchHistoryRow | null {
  let best: WatchHistoryRow | null = null;
  for (const row of rows) {
    if (typeof row.updated_at !== 'number' || Number.isNaN(row.updated_at)) continue;
    if (best === null || row.updated_at > best.updated_at) best = row;
  }
  return best;
}

export interface ContinueCardDeps {
  root: HTMLElement;
  onResume: (row: WatchHistoryRow) => void;
}

export interface ContinueCard {
  /** 传入 `historyPreview()` 的原始结果；空数组等价于 `hide()`。 */
  show(rows: readonly WatchHistoryRow[]): void;
  hide(): void;
  destroy(): void;
}

export function createContinueCard(deps: ContinueCardDeps): ContinueCard {
  function thumb(row: WatchHistoryRow): HTMLElement {
    const box = element('span', 'continue-thumb');
    const url = typeof row.cover_url === 'string' ? row.cover_url.trim() : '';
    if (url === '') {
      box.appendChild(iconNode('play', { size: 20, className: 'continue-glyph' }));
    } else {
      const img = element('img', 'continue-cover');
      img.loading = 'lazy';
      img.alt = '';
      img.addEventListener('error', () => {
        img.remove();
        box.appendChild(iconNode('play', { size: 20, className: 'continue-glyph' }));
      });
      img.src = url;
      box.appendChild(img);
    }
    return box;
  }

  function build(row: WatchHistoryRow): HTMLElement {
    const percent = progressPercent(row.position_seconds, row.duration_seconds);
    const remaining = Math.max(0, row.duration_seconds - row.position_seconds);
    const episode = `第 ${row.last_episode_number} 集`;

    const card = element('button', 'continue-card');
    card.type = 'button';
    card.dataset.contentId = row.content_id;
    card.setAttribute(
      'aria-label',
      `继续观看《${row.title}》${episode}，已播 ${formatClock(row.position_seconds)}，剩 ${formatClock(remaining)}`
    );
    card.addEventListener('click', () => deps.onResume(row));

    card.appendChild(thumb(row));

    const info = element('span', 'continue-info');
    info.appendChild(element('span', 'continue-badge', '继续观看黄金断点'));
    info.appendChild(element('span', 'continue-title', row.title));
    info.appendChild(
      element('span', 'continue-meta', `${episode} · 已播 ${formatClock(row.position_seconds)} · 剩 ${formatClock(remaining)}`)
    );

    const track = element('span', 'continue-progress');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(percent));
    track.setAttribute('aria-label', '本集观看进度');
    const fill = element('span', 'continue-progress-fill');
    fill.style.width = `${percent}%`;
    track.appendChild(fill);
    info.appendChild(track);

    card.appendChild(info);

    const cta = element('span', 'continue-cta');
    cta.setAttribute('aria-hidden', 'true');
    cta.appendChild(iconNode('play', { size: 16 }));
    cta.appendChild(element('span', 'continue-cta-label', '续播'));
    card.appendChild(cta);
    return card;
  }

  return {
    show: (rows) => {
      const row = latestRow(rows);
      if (row === null) {
        clearChildren(deps.root);
        deps.root.hidden = true;
        return;
      }
      deps.root.hidden = false;
      clearChildren(deps.root);
      deps.root.appendChild(build(row));
    },
    hide: () => {
      clearChildren(deps.root);
      deps.root.hidden = true;
    },
    destroy: () => {
      clearChildren(deps.root);
      deps.root.hidden = true;
    }
  };
}
