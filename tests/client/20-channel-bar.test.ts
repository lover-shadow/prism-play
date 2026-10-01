// @vitest-environment jsdom
/**
 * 大视界第一/第二层导航契约测试（AC-01 默认高亮、AC-02-3 双层隐形、SPEC §10 可访问性下限）。
 * 夹具全部本地构造：`PrismApiClient` + 假 `fetchImpl` 返回罐头 `Response`。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelId, ChannelItem } from '../../edge/src/types/api';
import { PrismApiClient } from '../../src/core/api/client';
import {
  DEFAULT_CHANNEL_ID,
  createChannelBar,
  pickDefaultChannel,
  sortChannels
} from '../../src/components/channel-bar';
import {
  ALL_CATEGORIES_LABEL,
  buildCapsules,
  createCapsuleRail
} from '../../src/components/capsule-rail';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body)
  } as unknown as Response;
}

function channel(
  id: ChannelId,
  name: string,
  order: number,
  categories: string[] = []
): ChannelItem {
  return { id, name, order, requiresTier: [], categories };
}

const FOUR_PUBLIC: ChannelItem[] = [
  channel('movie', '院线电影', 2, ['科幻', '悬疑']),
  channel('anime', '热血动漫', 3, ['番剧']),
  channel('documentary', '人文纪录', 4, ['自然']),
  channel('drama', '短剧精选', 1, ['都市', '战神', '逆袭'])
];

const mounted: HTMLElement[] = [];

function host(): HTMLElement {
  const node = document.createElement('div');
  document.body.appendChild(node);
  mounted.push(node);
  return node;
}

function apiWithChannels(channels: ChannelItem[]): PrismApiClient {
  return new PrismApiClient({ baseUrl: '', fetchImpl: async () => jsonResponse({ version: 7, channels }) });
}

afterEach(() => {
  document.body.replaceChildren();
  mounted.length = 0;
});

describe('channel-bar：云端下发即渲染', () => {
  it('按 order 升序渲染，名称逐字采用云端下发', async () => {
    const node = host();
    const bar = createChannelBar({ root: node, onSelect: () => undefined });
    const response = await apiWithChannels(FOUR_PUBLIC).channels();
    bar.render(response.channels, null);

    const ids = Array.from(node.querySelectorAll<HTMLElement>('.channel-tab')).map((tab) => tab.dataset.channelId);
    const names = Array.from(node.querySelectorAll('.channel-tab')).map((tab) => tab.textContent);
    expect(ids).toEqual(['drama', 'movie', 'anime', 'documentary']);
    expect(names).toEqual(['短剧精选', '院线电影', '热血动漫', '人文纪录']);
    expect(sortChannels(FOUR_PUBLIC).map((entry) => entry.id)).toEqual(['drama', 'movie', 'anime', 'documentary']);
  });

  it('云端改名时客户端不夹带任何本地词表', () => {
    const node = host();
    const bar = createChannelBar({ root: node, onSelect: () => undefined });
    bar.render([channel('drama', '短剧热榜', 1), channel('movie', '大片现场', 9)], 'drama');
    expect(node.textContent).toBe('短剧热榜大片现场');
  });

  it('AC-01：默认高亮短剧精选，且 aria-current 只有一颗', async () => {
    const node = host();
    const bar = createChannelBar({ root: node, onSelect: () => undefined });
    const channels = await apiWithChannels(FOUR_PUBLIC).channels();
    const selected = pickDefaultChannel(channels.channels);
    expect(selected?.id).toBe(DEFAULT_CHANNEL_ID);

    bar.render(channels.channels, selected?.id ?? null);
    const active = node.querySelectorAll<HTMLElement>('.channel-tab[aria-current="true"]');
    expect(active.length).toBe(1);
    expect(active[0].dataset.channelId).toBe('drama');
    expect(active[0].classList.contains('is-active')).toBe(true);
  });

  it('云端没下发短剧精选时默认退化为 order 最小项，空响应则无默认项', () => {
    const withoutDrama = [channel('anime', '热血动漫', 3), channel('movie', '院线电影', 1)];
    expect(pickDefaultChannel(withoutDrama)?.id).toBe('movie');
    expect(pickDefaultChannel([])).toBeNull();
  });

  it('AC-02-3：响应不含 private 时，DOM 内 private/个人探索 零出现，且无锁定占位', async () => {
    const node = host();
    const bar = createChannelBar({ root: node, onSelect: () => undefined });
    const response = await apiWithChannels(FOUR_PUBLIC).channels();
    bar.render(response.channels, 'drama');

    expect(node.querySelectorAll('[data-channel-id="private"]').length).toBe(0);
    expect(node.querySelectorAll('.channel-tab').length).toBe(4);
    expect(node.querySelectorAll('[data-channel-id]').length).toBe(4);
    expect(node.textContent ?? '').not.toContain('个人探索');
    expect(node.innerHTML.toLowerCase()).not.toContain('private');
    expect(node.outerHTML.toLowerCase()).not.toContain('个人探索');
    expect(JSON.stringify(node.innerHTML)).not.toMatch(/lock|禁用|locked/i);
  });

  it('反向证明：云端真的下发 private 节点时客户端照渲染（隐形由服务端裁决，不是前端过滤）', () => {
    const node = host();
    const granted = [...FOUR_PUBLIC, channel('private', '个人探索', 9, ['今日更新'])];
    const bar = createChannelBar({ root: node, onSelect: () => undefined });
    bar.render(granted, 'drama');
    expect(node.querySelectorAll('[data-channel-id="private"]').length).toBe(1);
    expect(node.querySelectorAll('.channel-tab').length).toBe(5);
  });

  it('频道名里的 HTML 元字符只作为文本出现', () => {
    const node = host();
    const bar = createChannelBar({ root: node, onSelect: () => undefined });
    bar.render([channel('drama', '<img src=x onerror=alert(1)>', 1)], 'drama');
    expect(node.querySelectorAll('img').length).toBe(0);
    expect(node.querySelector('.channel-tab')?.textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('select 只切换选中态，不触发重绘', () => {
    const node = host();
    const bar = createChannelBar({ root: node, onSelect: () => undefined });
    bar.render(FOUR_PUBLIC, 'drama');
    const first = node.querySelector('.channel-tab') as HTMLElement;
    bar.select('anime');

    expect(node.querySelectorAll('.channel-tab').length).toBe(4);
    expect(node.querySelector('.channel-tab')).toBe(first);
    expect(first.hasAttribute('aria-current')).toBe(false);
    expect(node.querySelector('[data-channel-id="anime"]')?.getAttribute('aria-current')).toBe('true');
    expect(node.querySelectorAll('[aria-current="true"]').length).toBe(1);
  });

  it('点击频道把云端 id 交给回调', () => {
    const seen: ChannelId[] = [];
    const node = host();
    const bar = createChannelBar({ root: node, onSelect: (id) => seen.push(id) });
    bar.render(FOUR_PUBLIC, 'drama');
    (node.querySelector('[data-channel-id="movie"]') as HTMLButtonElement).click();
    (node.querySelector('[data-channel-id="drama"]') as HTMLButtonElement).click();
    expect(seen).toEqual(['movie', 'drama']);
  });

  it('键盘可达：每颗频道是 button，方向键在栏内移动焦点', () => {
    const node = host();
    const bar = createChannelBar({ root: node, onSelect: () => undefined });
    bar.render(FOUR_PUBLIC, 'drama');
    const tabs = Array.from(node.querySelectorAll<HTMLButtonElement>('.channel-tab'));
    expect(tabs.every((tab) => tab.type === 'button')).toBe(true);
    expect(tabs.every((tab) => tab.classList.contains('touch-target'))).toBe(true);

    tabs[0].focus();
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(tabs[1]);
    tabs[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(document.activeElement).toBe(tabs[0]);
    tabs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(document.activeElement).toBe(tabs[3]);
  });

  it('destroy 清空宿主，不留残骸', () => {
    const node = host();
    const bar = createChannelBar({ root: node, onSelect: () => undefined });
    bar.render(FOUR_PUBLIC, 'drama');
    bar.destroy();
    expect(node.childElementCount).toBe(0);
  });
});

describe('capsule-rail：二级分类完全由云端 categories 驱动', () => {
  it('云端缺「全部」时在首位补一颗，且不改动其余顺序', () => {
    expect(buildCapsules(['都市', '战神', '逆袭'])).toEqual([ALL_CATEGORIES_LABEL, '都市', '战神', '逆袭']);
  });

  it('云端已下发「全部」时绝不重复补', () => {
    expect(buildCapsules(['全部', '都市'])).toEqual(['全部', '都市']);
    expect(buildCapsules([])).toEqual([ALL_CATEGORIES_LABEL]);
  });

  it('非字符串与重复项按边缘降级口径丢弃', () => {
    expect(buildCapsules(['都市', 1, null, { nested: true }, '  战神  ', '都市', ''])).toEqual([
      ALL_CATEGORIES_LABEL,
      '都市',
      '战神'
    ]);
  });

  it('胶囊 ≥44px（touch-target + --subnav-height）且键盘可达', () => {
    const node = host();
    const rail = createCapsuleRail({ root: node, onSelect: () => undefined });
    rail.render(['都市', '战神'], ALL_CATEGORIES_LABEL);
    const pills = Array.from(node.querySelectorAll<HTMLButtonElement>('.capsule'));

    expect(pills.length).toBe(3);
    expect(pills.every((pill) => pill.classList.contains('touch-target'))).toBe(true);
    expect(pills.every((pill) => pill.type === 'button')).toBe(true);
    expect(node.querySelector('nav[aria-label="二级分类"] .capsule-rail')).not.toBeNull();
    expect(node.querySelector('.capsule[aria-current="true"]')?.textContent).toBe(ALL_CATEGORIES_LABEL);

    pills[0].focus();
    pills[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(pills[1]);
    pills[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(pills[2]);
  });

  it('点击胶囊回传分类名，select 迁移 aria-current', () => {
    const seen: string[] = [];
    const node = host();
    const rail = createCapsuleRail({ root: node, onSelect: (category) => seen.push(category) });
    rail.render(['都市', '战神']);
    (node.querySelectorAll<HTMLButtonElement>('.capsule')[1]).click();
    (node.querySelectorAll<HTMLButtonElement>('.capsule')[2]).click();
    expect(seen).toEqual(['都市', '战神']);

    rail.select('战神');
    expect(node.querySelectorAll('[aria-current="true"]').length).toBe(1);
    expect(node.querySelector('[aria-current="true"]')?.textContent).toBe('战神');
  });

  it('换频道即重绘分类集合，选中态回到「全部」', () => {
    const node = host();
    const rail = createCapsuleRail({ root: node, onSelect: () => undefined });
    rail.render(['都市', '战神'], '战神');
    rail.render(['科幻'], ALL_CATEGORIES_LABEL);
    const labels = Array.from(node.querySelectorAll('.capsule')).map((pill) => pill.textContent);
    expect(labels).toEqual([ALL_CATEGORIES_LABEL, '科幻']);
    expect(node.querySelector('.capsule.is-active')?.textContent).toBe(ALL_CATEGORIES_LABEL);
  });

  it('destroy 清空宿主', () => {
    const node = host();
    const rail = createCapsuleRail({ root: node, onSelect: () => undefined });
    rail.render(['都市']);
    rail.destroy();
    expect(node.childElementCount).toBe(0);
  });
});
