// @vitest-environment jsdom
/**
 * 真机缺陷组 3、4、5 的回归：集号按钮栅格与分段（R26-05）、全屏控件自动隐藏（AC-19）、
 * 详情状态文案只说数据能证明的事（R26-05）。断言口径见 `player-sheet-harness.ts`。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EpisodeItem, TitleDetail } from '../../edge/src/types/api';
import { detailOf, settle, setup } from './player-harness';
import {
  EPISODE_SEGMENT_SIZE, episodeAriaLabel, episodeBadge, segmentLabel, segmentPage, segmentRange
} from '../../src/player/episode-sheet';
import { CONTROLS_IDLE_MS } from '../../src/player/controls-idle';
import { hostCss, openHost, playerCss, rule } from './player-sheet-harness';

const withTitles = (count = 3): TitleDetail => ({
  item: { id: 'c1', channelId: 'drama', title: '测试剧', category: '都市', isPrivate: false, shareable: true },
  episodes: Array.from({ length: count }, (_, i) => ({
    episodeId: 100 + i, episodeNumber: i + 1, title: `第${i + 1}集的名字长得足够可以撑破一个按钮`, durationSeconds: 5400
  }))
});

describe('缺陷组 3：集按钮只显示集号，真实集名进 aria-label（R26-05）', () => {
  it('数字徽章与朗读文案分离：徽章 2 位、破百 3 位', () => {
    expect(episodeBadge(1, 3)).toBe('01');
    expect(episodeBadge(30, 90)).toBe('30');
    expect(episodeBadge(7, 120)).toBe('007');
    expect(episodeBadge(100, 120)).toBe('100');
    expect(episodeAriaLabel({ episodeNumber: 12, title: '雨夜告别' } as EpisodeItem)).toBe('播放第 12 集 雨夜告别');
    expect(episodeAriaLabel({ episodeNumber: 12 } as EpisodeItem)).toBe('播放第 12 集');
  });

  it('抽屉按钮文本只有集号，不再拼标题与分钟数，当前集有 aria-current', async () => {
    const h = setup({ detail: withTitles() });
    await h.player.load(101); await settle();
    h.player.openDrawer();
    const items = [...h.root.querySelectorAll<HTMLElement>('.prism-drawer__item')];
    expect(items.map((item) => item.textContent)).toEqual(['01', '02', '03']);
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual([
      '播放第 1 集 第1集的名字长得足够可以撑破一个按钮', '播放第 2 集 第2集的名字长得足够可以撑破一个按钮', '播放第 3 集 第3集的名字长得足够可以撑破一个按钮'
    ]);
    expect(h.root.textContent).not.toMatch(/分钟|第 \d+ 集/);
    expect(items[1].getAttribute('aria-current')).toBe('true');
    expect(items[0].hasAttribute('aria-current')).toBe(false);
    expect(items[1].classList.contains('is-current')).toBe(true);
    expect(items[0].querySelector('[class*=title], [class*=meta]')).toBeNull();
    h.player.destroy();
  });

  it('按钮溢出收口：单行省略号，宽度受网格约束', () => {
    const item = rule(playerCss, '.prism-drawer__item');
    expect(item).toMatch(/white-space:\s*nowrap/);
    expect(item).toMatch(/overflow:\s*hidden/);
    expect(item).toMatch(/text-overflow:\s*ellipsis/);
    expect(item).toMatch(/min-width:\s*0/);
  });

  it(`超过 ${EPISODE_SEGMENT_SIZE} 集分段：30 一段、自动落在当前段、点段落换窗口`, async () => {
    expect(segmentPage(45, 0)).toBe(0);
    expect(segmentPage(45, EPISODE_SEGMENT_SIZE)).toBe(1);
    expect(segmentRange(45, 1)).toEqual({ from: 31, to: 45 });
    expect(segmentLabel(31, 45)).toBe('31–45');
    const h = setup({ detail: withTitles(45) });
    await h.player.load(100 + 33); await settle();
    h.player.openDrawer();
    const tabs = [...h.root.querySelectorAll<HTMLElement>('.prism-drawer__segment')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(['1–30', '31–45']);
    expect(tabs[1].getAttribute('aria-current')).toBe('true');
    const shown = [...h.root.querySelectorAll<HTMLElement>('.prism-drawer__item')];
    expect(shown).toHaveLength(15);
    expect(shown[0].textContent).toBe('31');
    tabs[0].click();
    expect([...h.root.querySelectorAll<HTMLElement>('.prism-drawer__item')].at(-1)?.textContent).toBe('30');
    h.player.destroy();
  });

  it('分段标签使用真实集号，不把缺号目录的数组位置冒充集号', async () => {
    const detail = withTitles(31);
    detail.episodes.forEach((episode, index) => { episode.episodeNumber = index < 30 ? index + 2 : 40; });
    const h = setup({ detail });
    await h.player.load(100); await settle();
    h.player.openDrawer();
    const tabs = [...h.root.querySelectorAll<HTMLElement>('.prism-drawer__segment')];
    expect(tabs.map(tab => tab.textContent)).toEqual(['2–31', '40']);
    tabs[1].click();
    expect(h.root.querySelector('.prism-drawer__item')?.textContent).toBe('40');
    h.player.destroy();
  });

  it('切集后面板仍跟到当前集：分段与高亮一起更新', async () => {
    const h = setup({ detail: withTitles(45) });
    await h.player.load(100); await settle();
    h.player.openDrawer();
    expect([...h.root.querySelectorAll<HTMLElement>('.prism-drawer__segment')][0].getAttribute('aria-current')).toBe('true');
    h.player.closeDrawer();
    await h.player.load(140); await settle();
    h.player.openDrawer();
    const tabs = [...h.root.querySelectorAll<HTMLElement>('.prism-drawer__segment')];
    expect(tabs[1].getAttribute('aria-current')).toBe('true');
    expect(h.root.querySelector<HTMLElement>('.prism-drawer__item.is-current')?.textContent).toBe('41');
    h.player.destroy();
  });

  it('详情选集轨同样只显示集号并带 aria 语义，箭头取 Lucide', async () => {
    const h = openHost();
    await h.host.open('c1'); await settle();
    const rail = [...h.mount.querySelectorAll<HTMLButtonElement>('.ep-rail-btn')];
    expect(rail.map((b) => b.textContent?.trim())).toEqual(['01', '02', '03']);
    expect(rail[0].getAttribute('aria-current')).toBe('true');
    expect(rail[1].getAttribute('aria-label')).toBe('播放第 2 集');
    const viewAll = h.mount.querySelector<HTMLElement>('.view-all-link')!;
    expect(viewAll.querySelector('svg')).not.toBeNull();
    expect(viewAll.textContent).not.toMatch(/[›▼▲<]/);
    viewAll.click();
    expect(h.mount.querySelector<HTMLElement>('.prism-drawer')!.hidden).toBe(false);
    h.host.close();
  });
});

describe('缺陷组 4：全屏控件自动隐藏，暂停/缓冲/拖动/浮层保持（AC-19 / AC-24）', () => {
  const chromeOf = (root: HTMLElement) => root.querySelector<HTMLElement>('.prism-player__chrome')!;

  it('正在播才计时收起；暂停、缓冲、拖动、开浮层一律保持可见', async () => {
    const h = setup({ fullscreen: () => true });
    await h.player.load(11); await settle();
    const chrome = chromeOf(h.root);
    // 起播走真实入口：`play()` 同时翻转内核态并派发 `play` 事件，只 fire 不改态会绕开判据。
    h.player.play();
    expect(chrome.classList.contains('is-visible')).toBe(true);
    h.clock.advance(CONTROLS_IDLE_MS - 1);
    expect(chrome.classList.contains('is-visible')).toBe(true);
    h.clock.advance(1);
    expect(chrome.classList.contains('is-visible')).toBe(false);
    for (const keep of ['pause', 'waiting', 'seeking'] as const) {
      h.fire(keep);
      expect(chrome.classList.contains('is-visible'), keep).toBe(true);
      h.clock.advance(CONTROLS_IDLE_MS * 3);
      expect(chrome.classList.contains('is-visible'), keep).toBe(true);
    }
    h.player.play(); h.player.openDrawer();
    h.clock.advance(CONTROLS_IDLE_MS * 3);
    expect(chrome.classList.contains('is-visible')).toBe(true);
    h.player.closeDrawer();
    h.clock.advance(CONTROLS_IDLE_MS);
    expect(chrome.classList.contains('is-visible')).toBe(false);
    h.player.destroy();
  });

  it('非全屏详情台不自动收起控件（工具栏是详情态唯一控制面）', async () => {
    const h = setup();
    await h.player.load(11); await settle();
    h.player.play(); h.clock.advance(CONTROLS_IDLE_MS * 3);
    expect(chromeOf(h.root).classList.contains('is-visible')).toBe(true);
    h.player.destroy();
  });

  it('缓冲与拖动绝不落到连播分支：换集只由 ended 触发', async () => {
    const h = setup({ fullscreen: () => true });
    await h.player.load(11); await settle();
    for (const event of ['waiting', 'seeking'] as const) h.fire(event);
    await settle();
    expect(h.api.playback).toHaveBeenCalledTimes(1);
    expect(h.player.state().episodeId).toBe(11);
    h.player.destroy();
  });

  it('浮动态的可达性：安全区留白与 44px 触点都写进样式正本', () => {
    for (const selector of ['.prism-drawer--sheet', '.prism-drawer--side', '.prism-rate-sheet']) {
      expect(rule(playerCss, selector), selector).toMatch(/env\(safe-area-inset-/);
    }
    expect(rule(playerCss, '.prism-drawer__item')).toMatch(/min-height:\s*44px/);
    expect(rule(playerCss, '.prism-drawer__segment')).toMatch(/min-height:\s*44px/);
    expect(rule(playerCss, '.prism-drawer__close')).toMatch(/width:\s*44px;\s*height:\s*44px/);
    expect(rule(playerCss, '.prism-drawer__action')).toMatch(/min-height:\s*44px/);
    expect(playerCss).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
  });

  /**
   * HP-08a（HOME-PLAYER-REPAIR §3 HP-08 / §5.1 HP-08a）：非全屏**画面内**不存在悬浮工具条。
   *
   * 上面那条"非全屏详情台不自动收起控件"钉的是收起判据（chrome 的可见类不被计时收掉），它今天仍然成立；
   * 但真机缺陷是那条带子本身压在画面上。因此这一组钉的是另一件事：宿主样式把画面内 chrome
   * **物理摘出非全屏**，同时详情侧的操作区（选集轨 + 全部剧集 + 投屏 + 沉浸全屏）一颗不少。
   * 摘除走宿主 CSS 而不是删组件：全屏还要复用同一个 chrome，`data-action` 出口也必须留在树里。
   */
  it('HP-08a 非全屏由宿主把画面内 chrome 物理摘除，详情操作区仍完整', async () => {
    const h = openHost();
    await h.host.open('c1'); await settle();
    const scoped = hostCss.match(
      /\.prism-player-host:not\(\.prism-player-host--fullscreen\)[^{]*\.prism-player__chrome\s*\{[^}]*display:\s*none/
    );
    expect(scoped, '宿主缺"非全屏画面内 chrome 物理缺席"规则').not.toBeNull();
    // chrome 节点仍在树里（全屏复用），但详情侧四个入口必须独立可达，不靠这条带子。
    expect(h.q('.prism-player__chrome')).not.toBeNull();
    for (const label of ['选集播放', '全部 3 集', '投屏', '沉浸全屏']) {
      expect(h.mount.textContent, `详情侧缺少入口：${label}`).toContain(label);
    }
    h.mount.querySelector<HTMLElement>('.view-all-link')!.click();
    expect(h.q<HTMLElement>('.prism-drawer')?.hidden).toBe(false);
    h.host.close();
  });
});

describe('缺陷组 5：详情状态文案只说数据能证明的事（R26-05）', () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it('episodeCount 与可播集数分开：源说 90 集而只上线 1 集时不宣称全集', async () => {
    const detail: TitleDetail = {
      item: { id: 'c1', channelId: 'drama', title: '测试剧', category: '都市', isPrivate: false, episodeCount: 90 },
      episodes: [{ episodeId: 11, episodeNumber: 1, durationSeconds: 5400 }]
    };
    const h = openHost({ detail });
    await h.host.open('c1'); await settle();
    const pills = [...h.mount.querySelectorAll<HTMLElement>('.detail-meta-pill-row .meta-pill')].map((p) => p.textContent);
    expect(pills).toContain('目录 1 集 / 源 90 集');
    expect(pills.some((p) => /全集已上线|连载中/.test(p ?? ''))).toBe(false);
    expect(h.mount.textContent).not.toMatch(/全 90 集/);
    h.host.close();
  });

  it('分类缺席就不贴分类胶囊，也不写死"精选"', async () => {
    const h = openHost({ detail: detailOf({ category: '' }) });
    await h.host.open('c1'); await settle();
    expect([...h.mount.querySelectorAll<HTMLElement>('.detail-meta-pill-row .meta-pill')].map((p) => p.textContent)).toEqual(['共 3 集']);
    expect(h.mount.querySelector<HTMLElement>('.meta-pill.accent')?.textContent).toBe('第 1 集');
    h.host.close();
  });

  it('只有数据显式声明合集才标"合集"，单集长片不推断', async () => {
    const single: TitleDetail = {
      item: { id: 'c1', channelId: 'movie', title: '测试片', category: '电影', isPrivate: false },
      episodes: [{ episodeId: 11, episodeNumber: 1, durationSeconds: 5400 }]
    };
    const plain = openHost({ detail: single });
    await plain.host.open('c1'); await settle();
    expect(plain.mount.textContent).not.toMatch(/合集/);
    plain.host.close();
    const marked = openHost({ detail: { ...detailOf(), item: { ...detailOf().item, isCollection: true } } as unknown as TitleDetail });
    await marked.host.open('c1'); await settle();
    expect([...marked.mount.querySelectorAll<HTMLElement>('.detail-meta-pill-row .meta-pill')].map((p) => p.textContent)).toContain('合集');
    marked.host.close();
  });

  it('无简介：整块不渲染，既没有兜底文案也没有展开控件', async () => {
    const h = openHost({ detail: detailOf({ synopsis: undefined }) });
    await h.host.open('c1'); await settle();
    expect(h.mount.querySelector('.detail-synopsis-box')).toBeNull();
    expect(h.mount.querySelector('.synopsis-toggle')).toBeNull();
    expect(h.mount.textContent).not.toMatch(/暂无详细剧目简介|敬请沉浸观赏/);
    h.host.close();
  });

  it('短简介不出现展开控件，长简介才有，且展开态可收起', async () => {
    const short = openHost({ detail: detailOf({ synopsis: '一句话简介。' }) });
    await short.host.open('c1'); await settle();
    expect(short.mount.querySelector('.synopsis-toggle')).toBeNull();
    expect(short.mount.querySelector('.detail-synopsis-text')?.textContent).toBe('一句话简介。');
    short.host.close();
    const long = openHost({ detail: detailOf({ synopsis: '剧'.repeat(120) }) });
    await long.host.open('c1'); await settle();
    const toggle = long.mount.querySelector<HTMLButtonElement>('.synopsis-toggle')!;
    const text = long.mount.querySelector<HTMLElement>('.detail-synopsis-text')!;
    expect(text.classList.contains('is-collapsed')).toBe(true);
    expect(toggle.querySelector('svg')).not.toBeNull();
    expect(toggle.textContent).toBe('展开完整简介');
    toggle.click();
    expect(text.classList.contains('is-collapsed')).toBe(false);
    expect(toggle.textContent).toBe('收起完整简介');
    toggle.click();
    expect(text.classList.contains('is-collapsed')).toBe(true);
    long.host.close();
  });

  it('详情卡样式归宿主正本，且零裸色值', async () => {
    for (const selector of ['.detail-header-card', '.detail-title-row', '.detail-main-title', '.detail-meta-pill-row',
      '.meta-pill', '.detail-synopsis-box', '.detail-synopsis-text', '.synopsis-toggle', '.prism-player-host__sheet']) {
      expect(rule(hostCss, selector), selector).toBeTruthy();
    }
    expect(hostCss).not.toMatch(/#[0-9A-Fa-f]{3,8}\b/);
    const h = openHost();
    await h.host.open('c1'); await settle();
    expect(h.mount.textContent).not.toMatch(/[›▼▲]/);
    h.host.close();
  });
});
