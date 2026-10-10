import { describe, it, expect } from 'vitest';
import {
  ExposureTracker, applyEeInterleave, RotationSession,
  buildTop10PredictiveCandidates, MAX_PREDICTIVE_CANDIDATES,
  MAX_PREDICTIVE_ITEM_BYTES
} from '../../src/core/content-rotation';
import type { ContentItem } from '../../edge/src/types/api';

function makeItem(id: string, title: string, hitsTotal = 100): ContentItem {
  return {
    id, channelId: 'drama', title, category: '都市', isPrivate: false, hitsTotal
  } as ContentItem;
}

describe('W5 内容轮换与曝光追踪 (ExposureTracker)', () => {
  it('正确记录曝光状态，并在 TTL 逾期后自动失效', () => {
    const tracker = new ExposureTracker(1000); // 1秒 TTL
    const t0 = 10000;

    tracker.record(['w1', 'w2'], t0);
    expect(tracker.isExposed('w1', t0)).toBe(true);
    expect(tracker.isExposed('w3', t0)).toBe(false);

    // 500ms 后依然有效
    expect(tracker.isExposed('w1', t0 + 500)).toBe(true);

    // 1500ms 后（超出 1000ms TTL）应已失效
    expect(tracker.isExposed('w1', t0 + 1500)).toBe(false);
  });
});

describe('W5 7:3 探索与利用交错 (applyEeInterleave)', () => {
  it('按 7:3 比例交错偏好利用候选与未曝光探索候选', () => {
    const exploit = Array.from({ length: 14 }, (_, i) => makeItem(`exploit_${i}`, `偏好${i}`));
    const explore = Array.from({ length: 6 }, (_, i) => makeItem(`explore_${i}`, `探索${i}`));

    const interleaved = applyEeInterleave(exploit, explore);
    expect(interleaved).toHaveLength(20);

    // 前 7 个来自 exploit
    for (let i = 0; i < 7; i++) {
      expect(interleaved[i].id).toBe(`exploit_${i}`);
    }
    // 接下来的 3 个来自 explore
    for (let i = 7; i < 10; i++) {
      expect(interleaved[i].id).toBe(`explore_${i - 7}`);
    }
    // 接下来的 7 个来自 exploit
    for (let i = 10; i < 17; i++) {
      expect(interleaved[i].id).toBe(`exploit_${i - 3}`);
    }
    // 接下来的 3 个来自 explore
    for (let i = 17; i < 20; i++) {
      expect(interleaved[i].id).toBe(`explore_${i - 14}`);
    }
  });

  it('自动过滤重复条目，不破坏稳定性', () => {
    const itemA = makeItem('dup_1', '重复作品');
    const exploit = [itemA, makeItem('b', '作品B')];
    const explore = [itemA, makeItem('c', '作品C')];

    const interleaved = applyEeInterleave(exploit, explore);
    expect(interleaved.filter((item) => item.id === 'dup_1')).toHaveLength(1);
  });
});

describe('W5 同轮稳定分页 (RotationSession)', () => {
  it('多次分页不重复不遗漏，重置后从头开始', () => {
    const items = Array.from({ length: 45 }, (_, i) => makeItem(`w_${i}`, `剧目${i}`));
    const session = new RotationSession(items, 20);

    const p1 = session.nextPage();
    expect(p1).toHaveLength(20);
    expect(p1[0].id).toBe('w_0');

    const p2 = session.nextPage();
    expect(p2).toHaveLength(20);
    expect(p2[0].id).toBe('w_20');

    const p3 = session.nextPage();
    expect(p3).toHaveLength(5);
    expect(p3[0].id).toBe('w_40');

    expect(session.nextPage()).toHaveLength(0);
    expect(session.hasMore()).toBe(false);

    session.reset();
    expect(session.hasMore()).toBe(true);
    expect(session.nextPage()).toHaveLength(20);
  });
});

describe('W5 预测 Top 10 队列 (buildTop10PredictiveCandidates)', () => {
  it('最多产生 10 部候选，排除当前播放，且遵守 32MiB 单片上限与 20% 总预算', () => {
    const candidates = Array.from({ length: 25 }, (_, i) => makeItem(`cand_${i}`, `候选剧${i}`, 100 - i));
    const totalQuotaBytes = 512 * 1024 * 1024; // 512 MiB 配额

    const top10 = buildTop10PredictiveCandidates({
      candidates,
      currentWorkId: 'cand_0', // 排除正在播放的 cand_0
      totalQuotaBytes
    });

    expect(top10.length).toBeLessThanOrEqual(MAX_PREDICTIVE_CANDIDATES);
    expect(top10.some((c) => c.workId === 'cand_0')).toBe(false);

    // 检查单片预算限制
    for (const c of top10) {
      expect(c.budgetBytes).toBeLessThanOrEqual(MAX_PREDICTIVE_ITEM_BYTES);
      expect(c.episodeNumber).toBe(1);
    }

    // 检查总预算不超过 20% (102.4 MiB)
    const totalAllocated = top10.reduce((acc, cur) => acc + cur.budgetBytes, 0);
    expect(totalAllocated).toBeLessThanOrEqual(totalQuotaBytes * 0.2);
  });
});
