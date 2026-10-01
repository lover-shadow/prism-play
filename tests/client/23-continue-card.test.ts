// @vitest-environment jsdom
/**
 * 首屏黄金续播卡（AC-03 / F-06）：秒级断点格式化、进度比例、点击回传与空态缺席。
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { WatchHistoryRow } from '../../src/core/storage/storage-domains';
import {
  createContinueCard,
  formatClock,
  latestRow,
  progressPercent,
  progressRatio
} from '../../src/components/continue-card';

function row(overrides: Partial<WatchHistoryRow> = {}): WatchHistoryRow {
  return {
    content_id: 'c-1',
    title: '战神之龙王归来',
    cover_url: 'https://cdn.example/cover-1.jpg',
    last_episode_id: 180,
    last_episode_number: 18,
    position_seconds: 102,
    duration_seconds: 135,
    total_episodes: 80,
    updated_at: 1_700_000_000,
    ...overrides
  };
}

const mounted: HTMLElement[] = [];

function hostCard(onResume?: (row: WatchHistoryRow) => void): {
  node: HTMLElement;
  card: ReturnType<typeof createContinueCard>;
} {
  const node = document.createElement('div');
  document.body.appendChild(node);
  mounted.push(node);
  return { node, card: createContinueCard({ root: node, onResume: onResume ?? (() => undefined) }) };
}

afterEach(() => {
  document.body.replaceChildren();
  mounted.length = 0;
});

describe('formatClock：秒数一律 m:ss / h:mm:ss', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [59, '0:59'],
    [60, '1:00'],
    [102, '1:42'],
    [599, '9:59'],
    [600, '10:00'],
    [3_599, '59:59'],
    [3_600, '1:00:00'],
    [3_661, '1:01:01'],
    [7_325, '2:02:05'],
    [86_400, '24:00:00']
  ])('%i 秒 → %s', (input, expected) => {
    expect(formatClock(input)).toBe(expected);
  });

  it('非法输入收敛到 0:00，不出现 NaN 与负号', () => {
    expect(formatClock(-30)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('0:00');
    expect(formatClock(90.9)).toBe('1:30');
    expect(formatClock(0)).not.toContain('NaN');
  });
});

describe('progressRatio / progressPercent：不除零、不 NaN、不出界', () => {
  it('时长为 0 或缺失时比例为 0', () => {
    expect(progressRatio(50, 0)).toBe(0);
    expect(progressRatio(50, Number.NaN)).toBe(0);
    expect(progressPercent(50, 0)).toBe(0);
    expect(progressPercent(50, Number.NaN)).toBe(0);
    expect(String(progressPercent(50, 0))).not.toContain('NaN');
  });

  it('断点为 0 或超过时长时钳制在 0–100', () => {
    expect(progressRatio(0, 100)).toBe(0);
    expect(progressRatio(-20, 100)).toBe(0);
    expect(progressRatio(100, 100)).toBe(1);
    expect(progressPercent(240, 100)).toBe(100);
    expect(progressPercent(102, 135)).toBe(76);
    expect(progressPercent(3_600, 7_200)).toBe(50);
  });
});

describe('latestRow：只认最近一部', () => {
  it('取 updated_at 最大者，空数组返回 null', () => {
    expect(latestRow([])).toBeNull();
    const older = row({ content_id: 'a', updated_at: 10 });
    const newer = row({ content_id: 'b', updated_at: 20 });
    expect(latestRow([older, newer])?.content_id).toBe('b');
    expect(latestRow([newer, older])?.content_id).toBe('b');
    expect(latestRow([row({ content_id: 'z' })])?.content_id).toBe('z');
  });
});

describe('continue-card：AC-03 常驻与秒级断点', () => {
  it('有历史即渲染剧名、集数与秒级断点，进度条宽度等于断点比例', () => {
    const { node, card } = hostCard();
    card.show([row()]);

    const cardElement = node.querySelector('.continue-card') as HTMLButtonElement;
    expect(cardElement).not.toBeNull();
    expect(cardElement.type).toBe('button');
    expect(cardElement.dataset.contentId).toBe('c-1');
    expect(node.querySelectorAll('.continue-card').length).toBe(1);
    expect(node.querySelector('.continue-title')?.textContent).toBe('战神之龙王归来');
    const meta = node.querySelector('.continue-meta')?.textContent ?? '';
    expect(meta).toContain('第 18 集');
    expect(meta).toContain('1:42');
    expect(meta).toContain('0:33');
    expect(meta).not.toMatch(/\d+s|NaN|undefined/);

    expect(node.querySelector('.continue-progress')?.getAttribute('role')).toBe('progressbar');
    expect(node.querySelector('.continue-progress')?.getAttribute('aria-valuenow')).toBe('76');
    expect(node.querySelector('.continue-progress-fill')?.getAttribute('style')).toBe('width: 76%;');
  });

  it('可访问名称带全剧名、集数与断点；整卡只有一颗按钮（焦点不重复）', () => {
    const { node, card } = hostCard();
    card.show([row()]);
    const cardElement = node.querySelector('.continue-card') as HTMLButtonElement;
    const label = cardElement.getAttribute('aria-label') ?? '';

    expect(label).toContain('继续观看');
    expect(label).toContain('战神之龙王归来');
    expect(label).toContain('第 18 集');
    expect(label).toContain('1:42');
    expect(cardElement.querySelectorAll('button').length).toBe(0);
    expect(node.querySelector('.continue-cta')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('点击整卡或续播按钮都回传同一行断点对象', () => {
    const resumed: WatchHistoryRow[] = [];
    const target = row({ content_id: 'c-77' });
    const { node, card } = hostCard((entry) => resumed.push(entry));
    card.show([target]);

    (node.querySelector('.continue-card') as HTMLButtonElement).click();
    expect(resumed.length).toBe(1);
    expect(resumed[0]).toBe(target);
    expect(resumed[0].position_seconds).toBe(102);
    expect(resumed[0].last_episode_id).toBe(180);
  });

  it('时长为 0 的历史行仍然渲染：进度 0%，无 NaN', () => {
    const { node, card } = hostCard();
    card.show([row({ position_seconds: 0, duration_seconds: 0 })]);

    expect(node.querySelector('.continue-progress-fill')?.getAttribute('style')).toBe('width: 0%;');
    expect(node.querySelector('.continue-progress')?.getAttribute('aria-valuenow')).toBe('0');
    expect(node.textContent ?? '').not.toContain('NaN');
    expect(node.textContent ?? '').toContain('0:00');
  });

  it('封面缺失回落 Token 化占位；加载失败同样回落且不破图', () => {
    const { node, card } = hostCard();
    card.show([row({ cover_url: null })]);
    expect(node.querySelector('img')).toBeNull();
    expect(node.querySelector('.continue-thumb svg')).not.toBeNull();

    card.show([row()]);
    const img = node.querySelector('img.continue-cover') as HTMLImageElement;
    expect(img.loading).toBe('lazy');
    expect(img.getAttribute('src')).toBe('https://cdn.example/cover-1.jpg');
    img.dispatchEvent(new Event('error'));
    expect(node.querySelector('img')).toBeNull();
    expect(node.querySelector('.continue-thumb svg')).not.toBeNull();
  });

  it('无历史时整卡不渲染且容器隐藏（不占首屏）', () => {
    const { node, card } = hostCard();
    card.show([row()]);
    expect(node.querySelector('.continue-card')).not.toBeNull();
    expect(node.hasAttribute('hidden')).toBe(false);

    card.show([]);
    expect(node.querySelector('.continue-card')).toBeNull();
    expect(node.hasAttribute('hidden')).toBe(true);

    card.show([row()]);
    card.hide();
    expect(node.childElementCount).toBe(0);
    expect(node.hasAttribute('hidden')).toBe(true);
  });

  it('多行历史只渲染最近一部，重绘不叠加', () => {
    const { node, card } = hostCard();
    card.show([
      row({ content_id: 'a', updated_at: 1 }),
      row({ content_id: 'b', updated_at: 9, title: '凤逆天下' }),
      row({ content_id: 'c', updated_at: 5 })
    ]);
    expect(node.querySelectorAll('.continue-card').length).toBe(1);
    expect(node.querySelector('.continue-title')?.textContent).toBe('凤逆天下');
    expect(node.querySelector<HTMLElement>('.continue-card')?.dataset.contentId).toBe('b');

    card.show([row({ content_id: 'd' })]);
    expect(node.querySelectorAll('.continue-card').length).toBe(1);
  });

  it('destroy 清空容器并保持隐藏', () => {
    const { node, card } = hostCard();
    card.show([row()]);
    card.destroy();
    expect(node.childElementCount).toBe(0);
    expect(node.hasAttribute('hidden')).toBe(true);
  });
});
