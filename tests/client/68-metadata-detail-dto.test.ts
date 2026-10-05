/**
 * HP-11 / HP-12 端侧详情 DTO 回归（SPEC-APP-REFACTOR §2.2、HOME-PLAYER-REPAIR §3.3）。
 *
 * 与 17b 的分工：17b 管目录整包灌入，本文件管 `/api/titles/{workId}` 投影出的那张兼容卡片。
 * 两侧都必须走 `edge/src/library/metadata-policy.mjs` 的同一口径——这里断言的不是 UI 夹具，
 * 而是「原料给的越界值在客户端 DTO 上物理不存在」。
 */
import { describe, expect, it } from 'vitest';
import {
  SYNOPSIS_MAX_CODE_POINTS, TAGS_MAX_ITEMS, SOURCE_TEXT_MAX_CODE_POINTS, PUBLIC_METADATA_FIELDS
} from '../../edge/src/library/metadata-policy.mjs';
import { adaptTitleDetail } from '../../src/core/api/title-detail';

const WORK = 'movie_m_9001';
const item = (extra: Record<string, unknown> = {}) => ({
  id: WORK, channelId: 'movie', title: '码头', category: '剧情', isPrivate: false, ...extra
});
const detail = (card: Record<string, unknown>) => ({
  workId: WORK, title: '码头', channelId: 'movie', isPrivate: false,
  episodes: [{ episodeNumber: 1, lines: [{ providerId: 'provider_m1', mediaUrl: 'https://cdn.example/a.m3u8' }] }],
  item: card
});

describe('HP-11 详情卡片元数据在端侧 DTO 的保真与丢弃', () => {
  it('合规的长摘要、年份、地区、语言与副标签原样抵达 DTO', () => {
    const parsed = adaptTitleDetail(detail(item({
      synopsis: '深夜的码头下着雨。'.repeat(40), releaseYear: 2019,
      region: '美国,英国,加拿大', language: '英语,法语', tags: ['剧情', '惊悚']
    })), WORK);
    expect([...parsed.item.synopsis as string]).toHaveLength(SYNOPSIS_MAX_CODE_POINTS);
    expect(parsed.item.releaseYear).toBe(2019);
    expect(parsed.item.region).toBe('美国,英国,加拿大');
    expect(parsed.item.language).toBe('英语,法语');
    expect(parsed.item.tags).toEqual(['剧情', '惊悚']);
    expect(JSON.stringify(parsed.item)).not.toMatch(/mediaUrl|providerId|episodes/);
  });

  it('旧 generation 详情缺全部新字段仍然可用，不因此拒绝整部剧', () => {
    const parsed = adaptTitleDetail(detail(item()), WORK);
    for (const key of PUBLIC_METADATA_FIELDS) expect(key in parsed.item).toBe(false);
    expect(parsed.episodes).toHaveLength(1);
  });

  it('读取侧按策略源就地消毒：越界丢弃、散文收敛到 240、HTML 归零而不牵连整部剧', () => {
    const parsed = adaptTitleDetail(detail(item({
      synopsis: '长'.repeat(SYNOPSIS_MAX_CODE_POINTS + 1),
      releaseYear: '2026–',
      region: `地${','.repeat(SOURCE_TEXT_MAX_CODE_POINTS)}区`,
      language: '<i>普通话</i>',
      tags: Array.from({ length: TAGS_MAX_ITEMS + 1 }, (_, index) => `题材${index}`)
    })), WORK);
    expect([...parsed.item.synopsis as string]).toHaveLength(SYNOPSIS_MAX_CODE_POINTS);
    expect(parsed.item.releaseYear).toBeUndefined();
    expect(parsed.item.region).toBeUndefined();
    expect(parsed.item.language).toBe('普通话');
    expect(parsed.item.tags).toHaveLength(TAGS_MAX_ITEMS);
    expect(parsed.item.title).toBe('码头');
    expect(parsed.episodes).toHaveLength(1);
  });

  it('消毒是纯函数：不改动传入响应体，也不把线路身份带进卡片', () => {
    const source = detail(item({ synopsis: '<b>真话</b>', tags: ['剧情'] }));
    const parsed = adaptTitleDetail(source, WORK);
    expect(source.item.synopsis).toBe('<b>真话</b>');
    expect(parsed.item.synopsis).toBe('真话');
    expect(JSON.stringify(parsed.item)).not.toMatch(/mediaUrl|providerId/);
  });

  it('HTML 原料穿不过 DTO：标签与实体被剥净，只留纯文本', () => {
    const parsed = adaptTitleDetail(detail(item({ synopsis: '<script>alert(1)</script>真正的一句简介', tags: ['<b>剧情</b>'] })), WORK);
    expect(parsed.item.synopsis).toBe('alert(1) 真正的一句简介');
    expect(parsed.item.synopsis).not.toMatch(/</);
    expect(parsed.item.tags).toEqual(['剧情']);
  });
});
