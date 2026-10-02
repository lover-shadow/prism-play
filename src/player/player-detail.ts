/**
 * 竖屏非全屏剧集详情生态台 (Portrait Media Stage)
 * 包含：剧名标题与分类胶囊、折叠简介、操作工具岛（追剧/缓存/分享）、常驻选集横滑轨。
 */

import type { EpisodeItem, TitleDetail } from '../../edge/src/types/api';
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
  onShare?: (ep: EpisodeItem) => void
): PlayerDetailStage {
  const body = document.createElement('div');
  body.className = 'prism-player-host__body';

  const infoCard = document.createElement('div');
  infoCard.className = 'prism-player-info';

  const header = document.createElement('div');
  header.className = 'prism-player-info__header';

  const titleEl = document.createElement('h1');
  titleEl.className = 'prism-player-info__title';
  titleEl.textContent = info.item.title;

  const meta = document.createElement('div');
  meta.className = 'prism-player-info__meta';
  const epCount = info.episodes.length || info.item.episodeCount || 0;
  const countTag = document.createElement('span');
  countTag.className = 'prism-player-info__tag is-accent';
  countTag.textContent = `全 ${epCount} 集`;

  const catTag = document.createElement('span');
  catTag.className = 'prism-player-info__tag';
  catTag.textContent = info.item.category || '精选';

  meta.append(countTag, catTag);
  header.append(titleEl, meta);

  const synopsisWrap = document.createElement('div');
  synopsisWrap.className = 'prism-player-info__synopsis-wrap';
  const synopsis = document.createElement('p');
  synopsis.className = 'prism-player-info__synopsis is-collapsed';
  synopsis.textContent = info.item.synopsis || '暂无详细剧目简介，敬请沉浸观赏精彩剧情。';

  const expandBtn = document.createElement('button');
  expandBtn.type = 'button';
  expandBtn.className = 'prism-player-info__expand-btn';
  expandBtn.textContent = '展开简介 ›';
  expandBtn.addEventListener('click', () => {
    const isCollapsed = synopsis.classList.toggle('is-collapsed');
    expandBtn.textContent = isCollapsed ? '展开简介 ›' : '收起简介 ‹';
  });

  synopsisWrap.append(synopsis, expandBtn);
  infoCard.append(header, synopsisWrap);

  const actionBar = document.createElement('div');
  actionBar.className = 'prism-player-actions';

  const favBtn = document.createElement('button');
  favBtn.type = 'button';
  favBtn.className = 'prism-player-action-btn';
  favBtn.innerHTML = `${icon('bookmark', { size: 16 })}<span>追剧</span>`;
  favBtn.addEventListener('click', () => {
    favBtn.classList.toggle('is-active');
    const active = favBtn.classList.contains('is-active');
    const textSpan = favBtn.querySelector('span');
    if (textSpan) textSpan.textContent = active ? '已追剧' : '追剧';
  });

  const cacheBtn = document.createElement('button');
  cacheBtn.type = 'button';
  cacheBtn.className = 'prism-player-action-btn';
  cacheBtn.innerHTML = `${icon('download', { size: 16 })}<span>缓存</span>`;

  actionBar.append(favBtn, cacheBtn);

  if (onShare && info.item.shareable !== false && !info.item.isPrivate) {
    const shareBtn = document.createElement('button');
    shareBtn.type = 'button';
    shareBtn.className = 'prism-player-action-btn';
    shareBtn.innerHTML = `${icon('share', { size: 16 })}<span>分享</span>`;
    shareBtn.addEventListener('click', () => {
      const cur = info.episodes.find((e) => e.episodeId === currentEpisodeId) ?? info.episodes[0];
      if (cur) onShare(cur);
    });
    actionBar.append(shareBtn);
  }

  const railSection = document.createElement('div');
  railSection.className = 'prism-player-rail';

  const railHead = document.createElement('div');
  railHead.className = 'prism-player-rail__head';
  const railTitle = document.createElement('span');
  railTitle.className = 'prism-player-rail__title';
  railTitle.textContent = `选集 · 共 ${epCount} 集`;

  const allEpisodesBtn = document.createElement('button');
  allEpisodesBtn.type = 'button';
  allEpisodesBtn.className = 'prism-player-rail__all-btn';
  allEpisodesBtn.textContent = '全部选集 ›';
  allEpisodesBtn.addEventListener('click', onOpenDrawer);

  railHead.append(railTitle, allEpisodesBtn);

  const railList = document.createElement('div');
  railList.className = 'prism-player-rail__list';

  const pills: Map<number, HTMLElement> = new Map();
  for (const ep of info.episodes) {
    const epPill = document.createElement('button');
    epPill.type = 'button';
    epPill.className = 'prism-player-rail__pill';
    if (ep.episodeId === currentEpisodeId) {
      epPill.classList.add('is-current');
    }
    epPill.textContent = `${ep.episodeNumber}`;
    epPill.addEventListener('click', () => {
      onSelectEpisode(ep.episodeId);
    });
    pills.set(ep.episodeId, epPill);
    railList.append(epPill);
  }

  railSection.append(railHead, railList);
  body.append(infoCard, actionBar, railSection);

  const markEpisode = (id: number): void => {
    currentEpisodeId = id;
    for (const [epId, pill] of pills.entries()) {
      pill.classList.toggle('is-current', epId === id);
    }
  };

  return { body, markEpisode };
}
