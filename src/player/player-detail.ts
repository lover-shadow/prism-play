/**
 * 竖屏非全屏剧集详情生态台 (Portrait Media Stage)：剧名与状态胶囊、可折叠简介、核心操作工具岛
 * （追剧/投屏/分享/沉浸全屏）、常驻选集横滑轨、同类好剧推荐流。
 *
 * 文案判据全部外置到 `detail-facts.ts`（集数/分类/合集/简介各归各的字段），本文件只管渲染与交互；
 * 没有简介就整块不渲染——兜底空话与一个点了没内容的展开控件都是假 UI。
 */

import type { ContentItem, EpisodeItem, TitleDetail } from '../../edge/src/types/api';
import { icon } from '../components/icons';
import { isPrivateSubject } from '../core/storage/storage-domains';
import { coverInto } from '../components/poster-cover';
import { createCastPanel } from './cast-panel';
import { createLineAwareCastStreamSource } from './cast-ports';
import { episodeAriaLabel, episodeBadge } from './episode-sheet';
import { SYNOPSIS_CLAMP_CHARS, episodeCountLabel, episodeTagOf, statusPillLabels, synopsisOf } from './detail-facts';

export interface PlayerDetailStage {
  body: HTMLElement;
  attachSeasonSwitcher(element: HTMLElement): void;
  markEpisode(id: number): void;
  openCast(): void; closeCast(): void; castOpen(): boolean;
  dismissOverlay(): boolean; destroy(): void;
}

function pill(text: string, accent = false): HTMLElement {
  const node = document.createElement('span');
  node.className = accent ? 'meta-pill accent' : 'meta-pill';
  node.textContent = text;
  return node;
}

/**
 * 图标直接作为 `<svg>` 落进宿主元素，不套 `<span>`：`.action-island-item` 的标签 span 与
 * 追剧态回写（`querySelector('span')`）都按"按钮里唯一的 span 就是文案"来判定，多包一层
 * 就会让文案写进图标壳里，观感是图标旁边再冒出一个词。
 */
function withIcon<T extends HTMLElement>(host: T, name: Parameters<typeof icon>[0], size: 16 | 20 | 24): T {
  const scratch = document.createElement('div');
  scratch.innerHTML = icon(name, { size });
  host.append(...Array.from(scratch.childNodes));
  return host;
}

function islandButton(name: Parameters<typeof icon>[0], label: string): HTMLButtonElement {
  const button = withIcon(document.createElement('button'), name, 20);
  button.type = 'button';
  button.className = 'action-island-item';
  const text = document.createElement('span');
  text.textContent = label;
  button.append(text);
  return button;
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
  following?: { store: import('../core/storage/following-store').FollowingStore; report?(message: string): void },
  /** 菜单互斥的宿主接缝：详情台的投屏一开，选集/倍速由宿主收掉（R26-05）。 */
  menus?: { beforeMenuOpen?(): void }
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
  const epTag = pill(episodeTagOf(info, currentEpisodeId), true);
  titleRow.append(titleEl, epTag);

  const metaRow = document.createElement('div');
  metaRow.className = 'detail-meta-pill-row';
  const count = episodeCountLabel(info);
  for (const label of statusPillLabels(info)) metaRow.append(pill(label));

  // 2. 简介：有就显示，长才折叠，没有就整块缺席（不渲染展开控件，也不编一句兜底文案）。
  infoCard.append(titleRow, metaRow);
  const synopsis = synopsisOf(info);
  if (synopsis !== null) {
    const synopsisBox = document.createElement('div');
    synopsisBox.className = 'detail-synopsis-box';
    const synopsisText = document.createElement('p');
    synopsisText.className = 'detail-synopsis-text';
    synopsisText.textContent = synopsis;
    synopsisBox.append(synopsisText);
    if (synopsis.length > SYNOPSIS_CLAMP_CHARS) {
      synopsisText.classList.add('is-collapsed');
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'synopsis-toggle';
      const toggleLabel = document.createElement('span');
      toggleLabel.textContent = '展开完整简介';
      toggle.append(toggleLabel);
      withIcon(toggle, 'chevronRight', 16);
      toggle.addEventListener('click', () => {
        const expanded = synopsisText.classList.contains('is-collapsed');
        synopsisText.classList.toggle('is-collapsed', !expanded);
        toggle.classList.toggle('is-expanded', expanded);
        toggleLabel.textContent = expanded ? '收起完整简介' : '展开完整简介';
      });
      synopsisBox.append(toggle);
    }
    infoCard.append(synopsisBox);
  }

  // 3. 核心操作工具岛 (Action Island - 4 键网格：追剧 / 投屏 / 分享 / 沉浸全屏，SPEC §1.5.1)
  const actionIsland = document.createElement('div');
  actionIsland.className = 'detail-action-island';

  const favBtn = islandButton('bookmark', '追剧');
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
   * 属于 AGENTS.md「任何前端开关必有真实机制对应」明令禁止的那类假 UI，因此换成有真实原生机制的投屏。
   */
  const castBtn = islandButton('cast', '投屏');

  const shareBtn = islandButton('share', '分享');
  shareBtn.addEventListener('click', () => {
    const cur = info.episodes.find((e) => e.episodeId === currentEpisodeId) ?? info.episodes[0];
    if (onShare && cur) onShare(cur);
  });

  const cinemaBtn = islandButton('fullscreen', '沉浸全屏');
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
  castBtn.addEventListener('click', () => { menus?.beforeMenuOpen?.(); castPanel.toggle(); });

  // 4. 常驻选集播放轨：按钮只放集号，真实集名进 aria-label，当前集用 aria-current 说话。
  const epSection = document.createElement('div');
  epSection.className = 'episodes-section';
  const titleBar = document.createElement('div');
  titleBar.className = 'section-title-bar';
  const h3 = document.createElement('div');
  h3.className = 'section-h3';
  const h3Label = document.createElement('span');
  h3Label.textContent = '选集播放';
  const h3Sub = document.createElement('span');
  h3Sub.className = 'section-sub-info';
  h3Sub.textContent = count === '' ? '' : `(${count})`;
  h3.append(h3Label, h3Sub);

  const viewAll = document.createElement('button');
  viewAll.type = 'button';
  viewAll.className = 'view-all-link';
  const viewLabel = document.createElement('span');
  viewLabel.textContent = info.episodes.length > 0 ? `全部 ${info.episodes.length} 集` : '全部剧集';
  viewAll.append(viewLabel);
  withIcon(viewAll, 'chevronRight', 16);
  viewAll.addEventListener('click', onOpenDrawer);
  titleBar.append(h3, viewAll);

  const rail = document.createElement('div');
  rail.className = 'episodes-rail';
  const pills: Map<number, HTMLButtonElement> = new Map();

  for (const ep of info.episodes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ep-rail-btn';
    btn.dataset['episodeId'] = String(ep.episodeId);
    btn.setAttribute('aria-label', episodeAriaLabel(ep));
    if (ep.episodeId === currentEpisodeId) { btn.classList.add('active'); btn.setAttribute('aria-current', 'true'); }
    const number = document.createElement('span');
    number.textContent = episodeBadge(ep.episodeNumber, info.episodes.length);
    const wave = document.createElement('span');
    wave.className = 'ep-wave';
    btn.append(number, wave);
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
      if (!items || items.length === 0) { relatedSection.remove(); return; }
      for (const item of items.slice(0, 6)) {
        const card = document.createElement('div');
        card.className = 'related-card';
        const cover = document.createElement('div');
        cover.className = 'related-cover';
        coverInto(cover, item.coverUrl, item.title, 'image', 20);
        const tag = document.createElement('span');
        tag.className = 'related-tag';
        tag.textContent = `全${item.episodeCount || 1}集`;
        cover.append(tag);
        const descBox = document.createElement('div');
        descBox.className = 'related-body';
        const title = document.createElement('span');
        title.className = 'related-title';
        title.textContent = item.title;
        const desc = document.createElement('span');
        desc.className = 'related-desc';
        desc.textContent = item.synopsis || item.category || '暂无简介';
        descBox.append(title, desc);
        card.append(cover, descBox);
        card.addEventListener('click', () => onOpenRelated?.(item.id));
        relatedGrid.append(card);
      }
    }).catch(() => { relatedSection.remove(); });
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
    epTag.textContent = episodeTagOf(info, id);
    for (const [epId, btn] of pills.entries()) {
      const isCur = epId === id;
      btn.classList.toggle('active', isCur);
      if (isCur) btn.setAttribute('aria-current', 'true'); else btn.removeAttribute('aria-current');
    }
  };

  return {
    body,
    attachSeasonSwitcher: (el: HTMLElement) => { epSection.before(el); },
    markEpisode,
    openCast: () => { menus?.beforeMenuOpen?.(); castPanel.open(); },
    closeCast: () => castPanel.close(),
    castOpen: () => castPanel.isOpen(),
    dismissOverlay: () => castPanel.isOpen() ? (castPanel.close(), true) : false,
    destroy: () => { disposed = true; castPanel.destroy(); }
  };
}
