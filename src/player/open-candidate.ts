import type { ContentItem } from '../../edge/src/types/api';
import { isPrivateSubject } from '../core/storage/storage-domains';
import type { OpenCandidate } from './host-contract';

/** 只复制公开卡片已经展示的字段；不把候选当作分集或准入依据。 */
export function publicOpenCandidate(item: ContentItem | null | undefined): OpenCandidate | undefined {
  if (!item || item.isPrivate !== false || isPrivateSubject(item)) return undefined;
  return { title: item.title, coverUrl: item.coverUrl, category: item.category,
    synopsis: item.synopsis, episodeCount: item.episodeCount };
}

/** 加载期已有内容沿用详情名片样式；不构造虚假选集、分享、追剧或投屏按钮。 */
export function candidateDetail(candidate: OpenCandidate): HTMLElement {
  const body = document.createElement('div'); body.className = 'prism-player-host__body';
  body.dataset.el = 'host-preview';
  const card = document.createElement('div'); card.className = 'detail-header-card';
  const title = document.createElement('h2'); title.className = 'detail-main-title';
  title.textContent = candidate.title ?? ''; card.append(title);
  const meta = document.createElement('div'); meta.className = 'detail-meta-pill-row';
  const labels = [candidate.category];
  if (Number.isSafeInteger(candidate.episodeCount) && candidate.episodeCount! > 0) labels.push(`共 ${candidate.episodeCount} 集`);
  for (const text of labels) {
    if (!text?.trim()) continue;
    const pill = document.createElement('span'); pill.className = 'meta-pill'; pill.textContent = text; meta.append(pill);
  }
  card.append(meta);
  if (candidate.synopsis?.trim()) {
    const box = document.createElement('div'); box.className = 'detail-synopsis-box';
    const synopsis = document.createElement('p'); synopsis.className = 'detail-synopsis-text';
    synopsis.textContent = candidate.synopsis; box.append(synopsis); card.append(box);
  }
  body.append(card); return body;
}
