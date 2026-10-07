import { describe, expect, it } from 'vitest';
import type { ContentItem } from '../../edge/src/types/api';
import { groupSeries } from '../../src/core/series';
const item = (id: string, title: string, channelId: ContentItem['channelId'] = 'drama'): ContentItem => ({
  id, title, channelId, category: '故事', isPrivate: false
});
describe('observed season grouping', () => {
  it('groups observed seasons in numeric order and retains every work identity', () => {
    const groups = groupSeries([item('s7', '持械入宋第七季'), item('single', '另一部剧'), item('s1', '持械入宋'), item('s2', '持械入宋第二季')]);
    expect(groups[0].title).toBe('持械入宋');
    expect(groups[0].items.map((entry) => entry.id)).toEqual(['s1', 's2', 's7']);
    expect(groups[1].items[0].id).toBe('single');
  });
  it('recognizes numeric suffixes without 第 and normalizes full-width season labels', () => {
    const groups = groupSeries([item('s1', '故事1季'), item('s2', '故事第２季')]);
    expect(groups).toHaveLength(1); expect(groups[0].items.map((entry) => entry.id)).toEqual(['s1', 's2']);
  });
  it('does not invent missing seasons or merge different channels', () => {
    const groups = groupSeries([item('s2', '故事第二季'), item('s7', '故事第七季'), item('movie', '故事', 'movie')]);
    expect(groups[0].items).toHaveLength(2); expect(groups[1].items[0].id).toBe('movie');
  });
  it('does not put an ambiguous unsuffixed title into two season-unit families', () => {
    const groups = groupSeries([item('base', '故事'), item('s2', '故事第二季'), item('part', '故事第三部')]);
    expect(groups.flatMap((group) => group.items.map((entry) => entry.id))).toEqual(['base', 's2', 'part']);
    expect(groups).toHaveLength(3);
  });
  it('keeps every same-name unsuffixed work independent when identity is ambiguous', () => {
    const groups = groupSeries([item('base-a', '故事'), item('base-b', '故事'), item('s2', '故事第二季')]);
    expect(groups).toHaveLength(3);
    expect(groups.flatMap((group) => group.items.map((entry) => entry.id))).toEqual(['base-a', 'base-b', 's2']);
  });
  it('does not guess a family when two works claim the same season number', () => {
    const groups = groupSeries([item('s1a', '故事第一季'), item('s1b', '故事第1季'), item('s2', '故事第二季')]);
    expect(groups).toHaveLength(3);
  });
  it('does not attach an unsuffixed work when an explicit first season already exists', () => {
    const groups = groupSeries([item('base', '故事'), item('s1', '故事第一季'), item('s2', '故事第二季')]);
    expect(groups).toHaveLength(2);
    expect(groups[0].items.map((entry) => entry.id)).toEqual(['base']);
    expect(groups[1].items.map((entry) => entry.id)).toEqual(['s1', 's2']);
  });
  it('keeps unsuffixed single works and does not merge season and part families', () => {
    expect(groupSeries([item('a', '故事'), item('b', '别的故事第二季')])).toHaveLength(2);
    expect(groupSeries([item('a', '故事第二季'), item('b', '故事第三部')])).toHaveLength(2);
  });
});
