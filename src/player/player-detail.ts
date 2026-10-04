/**
 * 竖屏非全屏剧集详情生态台 (Portrait Media Stage)
 * 包含：剧名标题与分类胶囊、折叠简介、核心操作工具岛（追剧/投屏/分享/全屏）、常驻选集横滑轨、同类好剧推荐流。
 */

import type { ContentItem, EpisodeItem, TitleDetail } from '../../edge/src/types/api';
import { icon } from '../components/icons';
import { isPrivateSubject } from '../core/storage/storage-domains';
import { createCastPanel } from './cast-panel';
import { createLineAwareCastStreamSource } from './cast-ports';

export interface PlayerDetailStage {
  body: HTMLElement;
  markEpisode(id: number): void;
  openCast(): void; dismissOverlay(): boolean; destroy(): void;
}

export function buildDetailBody(
  info: TitleDetail,
  currentEpisodeId: number,
  onSelectEpisode: (id: number) => void,
  onOpenDrawer: () => void,
  onShare?: (ep: EpisodeItem) => void,
  onFullscreen?: () => void,
  loadRelated?: () => Promise<ContentItem[]>,
  onOpenRelated?: (contentId: string) => void,
  following?: { store: import('../core/storage/following-store').FollowingStore; report?(message: string): void }
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

  // 3. 核心操作工具岛 (Action Island - 4 键网格：追剧 / 投屏 / 分享 / 沉浸全屏，SPEC §1.5.1)
  const actionIsland = document.createElement('div');
  actionIsland.className = 'detail-action-island';

  const favBtn = document.createElement('button');
  favBtn.type = 'button';
  favBtn.className = 'action-island-item';
  favBtn.innerHTML = `${icon('bookmark', { size: 20 })}<span>追剧</span>`;
  let disposed = false;
  favBtn.dataset.action = 'following';
  favBtn.disabled = true;
  const publicFollowing = following !== undefined && !isPrivateSubject(info.item);
  const paintFollowing = (active: boolean) => {
    favBtn.classList.toggle('active', active);
    favBtn.setAttribute('aria-pressed', String(active));
    favBtn.querySelector('span')!.textContent = active ? '已追剧' : '追剧';
  };
  if (publicFollowing) void following.store.list().then(rows => {
    if (disposed) return;
    paintFollowing(rows.some(row => row.content_id === info.item.id)); favBtn.disabled = false;
  }).catch(() => { if (!disposed) following.report?.('本机追剧存储不可用，无法读取追剧状态'); });
  favBtn.addEventListener('click', async () => {
    if (!publicFollowing || disposed || favBtn.disabled) return;
    favBtn.disabled = true;
    try {
      const committed = await following.store.toggle({ contentId: info.item.id, title: info.item.title,
        coverUrl: info.item.coverUrl, isPrivate: info.item.isPrivate, channelId: info.item.channelId });
      if (!disposed) paintFollowing(committed);
    } catch { if (!disposed) following.report?.('追剧保存失败，保留原状态，请重试'); }
    finally { if (!disposed) favBtn.disabled = false; }
  });

  /**
   * 【投屏】取代原来的第二键。原第二键「缓存本集」是**没有任何机制的死键**：点击只把自身文字改成
   * "已在队列"、给自己加一个 active 类，既不入队、不落盘、不查 `public-cache`，也没有任何消费方读它——
   * 属于 AGENTS.md「任何前端开关必有真实机制对应」明令禁止的那类假 UI，因此换成有真实原生机制的投屏，
   * 不是砍掉一个活功能。（真正的离线缓存若要回来，应作为独立工作包接 `cache` 域，而不是挂回这里。）
   */
  const castBtn = document.createElement('button');
  castBtn.type = 'button';
  castBtn.className = 'action-island-item';
  castBtn.innerHTML = `${icon('cast', { size: 20 })}<span>投屏</span>`;

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

  actionIsland.append(favBtn, castBtn, shareBtn, cinemaBtn);

  /**
   * 投屏状态机挂在这里：详情台是唯一同时知道"当前是哪一集""这部剧私不私密""选集清单顺序"的地方，
   * 连播与拒播都必须以它为准，而不是让宿主再广播一份平行状态。
   * `currentEpisodeId()` 读的是 `markEpisode` 会改写的那个形参闭包，所以切集后推的就是新的一集。
   */
  const castPanel = createCastPanel({
    root: body,
    episodes: info.episodes,
    // A-7.5：电视推的是当前这一集的直连上游地址（清单在场时），清单缺席才退回云端代理句柄。
    stream: createLineAwareCastStreamSource({ workId: () => info.item.id, episodes: info.episodes }),
    titleOf: () => info.item.title,
    currentEpisodeId: () => currentEpisodeId,
    isPrivate: () => isPrivateSubject(info.item),
    onPhase: (state, device) => {
      castBtn.classList.toggle('active', device !== null && (state === 'casting' || state === 'paused'));
    }
  });
  castBtn.addEventListener('click', () => castPanel.toggle());

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
  // attach 必须在 body.append 之后：`anchor.after()` 在没有父节点时是静默 no-op，
  // 放在 append 之前会让呼吸状态条永远挂不上树——面板照常工作、状态条却不出现，正是最难查的那类错位。
  castPanel.attach(actionIsland);

  const markEpisode = (id: number): void => {
    currentEpisodeId = id;
    // 手机上切集，大屏必须跟到同一集；未在投屏时 syncNow() 自己就是空操作。
    if (castPanel.activeDevice() !== null) void castPanel.syncNow();
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

  return { body, markEpisode, openCast: () => castPanel.open(),
    dismissOverlay: () => castPanel.isOpen() ? (castPanel.close(), true) : false,
    destroy: () => { disposed = true; castPanel.destroy(); } };
}
