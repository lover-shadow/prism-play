/**
 * 竖屏非全屏剧集详情生态台 (Portrait Media Stage)
 * 包含：剧名标题与分类胶囊、折叠简介、核心操作工具岛（追剧/缓存/分享/全屏）、常驻选集横滑轨、同类好剧推荐流。
 */

import type { ContentItem, EpisodeItem, TitleDetail } from '../../edge/src/types/api';
import { icon } from '../components/icons';

export interface PlayerDetailStage {
  body: HTMLElement;
  markEpisode(id: number): void;
}

export function buildDetailBody(
  info: TitleDetail,
  currentEpisodeId: number,
  onSelectEpisode: (id: number) => void,
  onOpenDrawer: () => void,
  onShare?: (ep: EpisodeItem) => void,
  onFullscreen?: () => void,
  loadRelated?: () => Promise<ContentItem[]>,
  onOpenRelated?: (contentId: string) => void
): PlayerDetailStage {
  const body = document.createElement('div');
  body.className = 'prism-player-host__body';

  // 1. 剧目名片区
  const infoCard = document.createElement('div');
  infoCard.className = 'detail-header-card';

  const titleRow = document.createElement('div');
  titleRow.className = 'detail-title-row';
  const titleEl = document.createElement('h2');
  titleEl.className = 'detail-main-title';
  titleEl.textContent = info.item.title;

  const currentEp = info.episodes.find((e) => e.episodeId === currentEpisodeId) ?? info.episodes[0];
  const epTag = document.createElement('span');
  epTag.className = 'meta-pill accent';
  epTag.textContent = `第 ${currentEp?.episodeNumber ?? 1} 集`;
  titleRow.append(titleEl, epTag);

  const metaRow = document.createElement('div');
  metaRow.className = 'detail-meta-pill-row';
  const epCount = info.episodes.length || info.item.episodeCount || 0;
  const countPill = document.createElement('span');
  countPill.className = 'meta-pill';
  countPill.textContent = `全 ${epCount} 集`;

  const catPill = document.createElement('span');
  catPill.className = 'meta-pill';
  catPill.textContent = info.item.category || '精选';

  const statusPill = document.createElement('span');
  statusPill.className = 'meta-pill';
  statusPill.textContent = epCount > 0 ? '全集已上线' : '连载中';
  metaRow.append(countPill, catPill, statusPill);

  // 2. 折叠简介
  const synopsisBox = document.createElement('div');
  synopsisBox.className = 'detail-synopsis-box';
  const synopsisText = document.createElement('p');
  synopsisText.className = 'detail-synopsis-text';
  synopsisText.textContent = info.item.synopsis || '暂无详细剧目简介，敬请沉浸观赏精彩剧情。';

  const toggleHint = document.createElement('div');
  toggleHint.className = 'synopsis-toggle-hint';
  toggleHint.innerHTML = '<span>展开完整简介</span><span style="font-size:10px; margin-left:2px;">▼</span>';

  synopsisBox.append(synopsisText, toggleHint);
  synopsisBox.addEventListener('click', () => {
    const isExpanded = synopsisBox.classList.toggle('is-expanded');
    const span = toggleHint.querySelector('span');
    if (span) span.textContent = isExpanded ? '收起完整简介' : '展开完整简介';
    const arrow = toggleHint.querySelectorAll('span')[1];
    if (arrow) arrow.textContent = isExpanded ? '▲' : '▼';
  });

  infoCard.append(titleRow, metaRow, synopsisBox);

  // 3. 核心操作工具岛 (Action Island - 4 键网格)
  const actionIsland = document.createElement('div');
  actionIsland.className = 'detail-action-island';

  const favBtn = document.createElement('button');
  favBtn.type = 'button';
  favBtn.className = 'action-island-item';
  favBtn.innerHTML = `${icon('bookmark', { size: 20 })}<span>追剧</span>`;
  favBtn.addEventListener('click', () => {
    favBtn.classList.toggle('active');
    const active = favBtn.classList.contains('active');
    const label = favBtn.querySelector('span');
    if (label) label.textContent = active ? '已追剧' : '追剧';
  });

  const cacheBtn = document.createElement('button');
  cacheBtn.type = 'button';
  cacheBtn.className = 'action-island-item';
  cacheBtn.innerHTML = `${icon('download', { size: 20 })}<span>缓存本集</span>`;
  cacheBtn.addEventListener('click', () => {
    const label = cacheBtn.querySelector('span');
    if (label) label.textContent = '已在队列';
    cacheBtn.classList.add('active');
  });

  const shareBtn = document.createElement('button');
  shareBtn.type = 'button';
  shareBtn.className = 'action-island-item';
  shareBtn.innerHTML = `${icon('share', { size: 20 })}<span>分享</span>`;
  shareBtn.addEventListener('click', () => {
    const cur = info.episodes.find((e) => e.episodeId === currentEpisodeId) ?? info.episodes[0];
    if (onShare && cur) onShare(cur);
  });

  const cinemaBtn = document.createElement('button');
  cinemaBtn.type = 'button';
  cinemaBtn.className = 'action-island-item';
  cinemaBtn.innerHTML = `${icon('fullscreen', { size: 20 })}<span>沉浸全屏</span>`;
  cinemaBtn.addEventListener('click', () => onFullscreen?.());

  actionIsland.append(favBtn, cacheBtn, shareBtn, cinemaBtn);

  // 4. 常驻选集播放轨
  const epSection = document.createElement('div');
  epSection.className = 'episodes-section';

  const titleBar = document.createElement('div');
  titleBar.className = 'section-title-bar';
  const h3 = document.createElement('div');
  h3.className = 'section-h3';
  h3.innerHTML = `<span>选集播放</span><span class="section-sub-info">(共 ${epCount} 集)</span>`;

  const viewAll = document.createElement('div');
  viewAll.className = 'view-all-link';
  viewAll.innerHTML = `<span>全部 ${epCount} 集</span><span style="font-size:12px; margin-left:2px;">›</span>`;
  viewAll.addEventListener('click', onOpenDrawer);
  titleBar.append(h3, viewAll);

  const rail = document.createElement('div');
  rail.className = 'episodes-rail';
  const pills: Map<number, HTMLElement> = new Map();

  for (const ep of info.episodes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ep-rail-btn';
    const numStr = ep.episodeNumber < 10 ? `0${ep.episodeNumber}` : `${ep.episodeNumber}`;
    if (ep.episodeId === currentEpisodeId) {
      btn.classList.add('active');
      btn.innerHTML = `<span>${numStr}</span><div class="ep-wave"></div>`;
    } else {
      btn.innerHTML = `<span>${numStr}</span>`;
    }
    btn.addEventListener('click', () => onSelectEpisode(ep.episodeId));
    pills.set(ep.episodeId, btn);
    rail.append(btn);
  }
  epSection.append(titleBar, rail);

  // 5. 类似剧集流转区 (Related Flow)
  const relatedSection = document.createElement('div');
  relatedSection.className = 'related-section';
  const relatedH3 = document.createElement('div');
  relatedH3.className = 'section-h3';
  relatedH3.textContent = '同类好剧推荐';
  const relatedGrid = document.createElement('div');
  relatedGrid.className = 'related-grid';
  relatedSection.append(relatedH3, relatedGrid);

  if (loadRelated) {
    loadRelated().then((items) => {
      if (!items || items.length === 0) {
        relatedSection.remove();
        return;
      }
      for (const item of items.slice(0, 6)) {
        const card = document.createElement('div');
        card.className = 'related-card';
        const cover = document.createElement('div');
        cover.className = 'related-cover';
        if (item.coverUrl) {
          cover.innerHTML = `<img src="${item.coverUrl}" alt="" loading="lazy" /><span class="related-tag">全${item.episodeCount || 1}集</span>`;
        } else {
          cover.innerHTML = `<span class="related-tag">全${item.episodeCount || 1}集</span>`;
        }
        const descBox = document.createElement('div');
        descBox.className = 'related-body';
        const title = document.createElement('span');
        title.className = 'related-title';
        title.textContent = item.title;
        const desc = document.createElement('span');
        desc.className = 'related-desc';
        desc.textContent = item.synopsis || item.category || '精选热播剧集';
        descBox.append(title, desc);
        card.append(cover, descBox);
        card.addEventListener('click', () => onOpenRelated?.(item.id));
        relatedGrid.append(card);
      }
    }).catch(() => {
      relatedSection.remove();
    });
  } else {
    relatedSection.remove();
  }

  body.append(infoCard, actionIsland, epSection, relatedSection);

  const markEpisode = (id: number): void => {
    currentEpisodeId = id;
    const ep = info.episodes.find((e) => e.episodeId === id);
    epTag.textContent = `第 ${ep?.episodeNumber ?? 1} 集`;
    for (const [epId, btn] of pills.entries()) {
      const isCur = epId === id;
      btn.classList.toggle('active', isCur);
      const targetEp = info.episodes.find((e) => e.episodeId === epId);
      const numStr = (targetEp?.episodeNumber ?? 1) < 10 ? `0${targetEp?.episodeNumber ?? 1}` : `${targetEp?.episodeNumber ?? 1}`;
      btn.innerHTML = isCur ? `<span>${numStr}</span><div class="ep-wave"></div>` : `<span>${numStr}</span>`;
    }
  };

  return { body, markEpisode };
}
