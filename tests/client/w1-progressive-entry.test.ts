// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { host } from './player-host-harness';
import { detailOf, settle } from './player-harness';
import type { ContentItem } from '../../edge/src/types/api';
import type { PlayerHostDeps, OpenCandidate } from '../../src/player-host';
import { publicOpenCandidate } from '../../src/player/open-candidate';
import { ApiError } from '../../src/core/api/client';

const item = (id: string, title: string): ContentItem => ({
  id, title, channelId: 'drama', isPrivate: false, category: '都市',
  synopsis: `${title}已有剧情`, coverUrl: 'https://play.prismos.org/proxy/img/demo', episodeCount: 3
});
const delayed = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
afterEach(() => document.body.replaceChildren());

describe('W1 真实打开语义：已知信息不等待详情与配置', () => {
  it('私密与身份不确定卡片不产生公开预填；错误返回时清除预填剧情与海报节点', async () => {
    const source = item('a', '已见公开信息');
    expect(publicOpenCandidate({ ...source, isPrivate: true })).toBeUndefined();
    expect(publicOpenCandidate({ ...source, channelId: 'private' })).toBeUndefined();
    const unknown = { ...source } as Partial<ContentItem>; delete unknown.isPrivate;
    expect(publicOpenCandidate(unknown as ContentItem)).toBeUndefined();
    const h = host({ titleError: new ApiError('NOT_FOUND', 404, '不存在') });
    expect(await h.player.open('a', undefined, { candidate: publicOpenCandidate(source) })).toBe(false);
    expect(h.mount.textContent).not.toContain(source.title);
    expect(h.mount.textContent).not.toContain(source.synopsis);
    expect(h.mount.querySelector('.prism-player-host__skeleton-cover')).toBeNull();
    expect(h.mount.querySelector('[data-el="host-preview"]')).toBeNull();
    h.player.close();
  });

  it('公开预填立即显示剧情分类和清晰海报，不编造选集/分享入口；迟到结果不会复活关闭层', async () => {
    const gate = delayed(), source = item('a', '公开卡片');
    const h = host({ titleGate: gate.promise });
    const candidate = { title: source.title, coverUrl: source.coverUrl, category: source.category,
      synopsis: source.synopsis, episodeCount: source.episodeCount } as OpenCandidate;
    const opening = h.player.open('a', undefined, { candidate });
    const shell = h.mount.querySelector('.prism-player-host')!;
    expect(shell.querySelector('.detail-main-title')?.textContent).toBe(source.title);
    expect(shell.querySelector('.detail-synopsis-text')?.textContent).toBe(source.synopsis);
    expect(shell.querySelector('.detail-meta-pill-row')?.textContent).toContain('都市');
    expect(shell.querySelector<HTMLImageElement>('.prism-player-host__skeleton-cover')?.src).toBe(source.coverUrl);
    expect(shell.querySelector('.ep-rail-btn')).toBeNull();
    expect(shell.querySelector('[data-action="following"]')).toBeNull();
    h.player.close(); gate.resolve(); expect(await opening).toBe(false);
    expect(h.mount.childElementCount).toBe(0);
  });

  it('A→B→A：切季首个await前带目标信息，返回A时慢runtime不挡已知信息且A详情只取一次', async () => {
    const a = item('s1', '故事第一季'), b = item('s2', '故事第二季');
    const gate = delayed(); let delay = false;
    const runtime = { refresh: vi.fn(async () => { if (delay) await gate.promise; }),
      watch: { setScope: async () => undefined, suspend: async () => undefined }, naturalBoundary: async () => null,
      destroy: async () => undefined } as unknown as PlayerHostDeps['runtime'];
    const h = host({ runtime, seriesItems: () => [a, b], respondTitle: async id => detailOf(id === a.id ? a : b) });
    await h.player.open(a.id);
    let select = h.mount.querySelector<HTMLSelectElement>('[data-prism-ui="season-switcher"] select')!;
    select.value = b.id; select.dispatchEvent(new Event('change'));
    expect(h.mount.querySelector('.prism-player-host__title')?.textContent).toBe(b.title);
    await settle();
    select = h.mount.querySelector<HTMLSelectElement>('[data-prism-ui="season-switcher"] select')!;
    delay = true; select.value = a.id; select.dispatchEvent(new Event('change'));
    expect(h.mount.querySelector('.detail-main-title')?.textContent).toBe(a.title);
    expect(h.mount.querySelector('.detail-synopsis-text')?.textContent).toBe(a.synopsis);
    await settle();
    expect(h.api.title.mock.calls.filter((call: any) => call[0] === a.id)).toHaveLength(1);
    gate.resolve(); await settle(); h.player.close();
  });

  it('无卡片数据重开已核验公开作品：同步复用暖详情字段，配置读取完成前不发重复title', async () => {
    const gate = delayed(); let delay = false;
    const runtime = { refresh: async () => { if (delay) await gate.promise; },
      watch: { setScope: async () => undefined, suspend: async () => undefined }, naturalBoundary: async () => null,
      destroy: async () => undefined } as unknown as PlayerHostDeps['runtime'];
    const source = item('a', '暖缓存作品');
    const h = host({ runtime, detail: detailOf(source) });
    await h.player.open('a'); h.player.close(); delay = true;
    const opening = h.player.open('a');
    expect(h.mount.querySelector('.detail-main-title')?.textContent).toBe(source.title);
    expect(h.mount.textContent).toContain(source.synopsis);
    expect(h.api.title).toHaveBeenCalledTimes(1);
    h.player.close(); gate.resolve(); expect(await opening).toBe(false);
  });

  it('两阶段起播：冷启动未缓存详情时优先消费 bootstrap 快速起播，不等待后台全量详情', async () => {
    const gate = delayed();
    const source = item('boot_1', '两阶段起播剧');
    const bootedEpisode = { episodeNumber: 1, title: '第1集', lines: [{ providerId: 'p1', mediaUrl: 'https://cdn.test/ep1.m3u8' }] };
    const bootstrapRaw = {
      schema: 1, workId: source.id, revision: 1, factVersion: 'abc',
      item: source, targetEpisode: bootedEpisode, catalogStatus: 'complete', persistenceStatus: 'stored'
    };
    const h = host({
      titleGate: gate.promise,
      respondTitle: async () => { await gate.promise; return detailOf(source); },
      api: { titleBootstrap: vi.fn(async () => bootstrapRaw) } as any
    });
    const openTask = h.player.open(source.id);
    await settle();
    expect(h.player.isOpen()).toBe(true);
    expect(h.player.state()?.episodeId).toBe(1);
    gate.resolve();
    expect(await openTask).toBe(true);
    h.player.close();
  });
});
