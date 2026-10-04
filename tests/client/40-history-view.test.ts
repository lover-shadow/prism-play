// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createHistoryView,
  formatBytes,
  type CacheUsage,
  type ClearCacheOutcome,
  type CredentialGrant,
  type CredentialWriter,
  type HistoryApi,
  type HistoryReader
} from '../../src/views/history-view';
import { ApiError } from '../../src/core/api/client';
import { POSTER_CACHE_LIMIT_BYTES, type WatchHistoryRow } from '../../src/core/storage/storage-domains';
import type { ContentItem, RelatedResponse } from '../../edge/src/types/api';

/** 断网文案里绝不能出现的「离线可播」类承诺。 */
const OFFLINE_PROMISES = ['无需联网', '不用联网', '离线播放', '离线观看', '断网可播', '免流量', '可直接播放'];
const NOW = 1_780_000_000;

function rowOf(overrides: Partial<WatchHistoryRow> = {}): WatchHistoryRow {
  return {
    content_id: 'd_longwang', title: '战神之龙王归来', cover_url: '/proxy/image/d_longwang', last_episode_id: 118,
    last_episode_number: 18, position_seconds: 102, duration_seconds: 135, total_episodes: 60, updated_at: NOW - 3_600, ...overrides
  };
}
function itemOf(id: string, overrides: Partial<ContentItem> = {}): ContentItem {
  return { id, channelId: 'drama', title: `剧目 ${id}`, category: '战神', isPrivate: false, coverUrl: `/proxy/image/${id}`, ...overrides };
}
function outcomeOf(domains: ClearCacheOutcome['domains'], clearedBytes = 3 * 1024 * 1024): ClearCacheOutcome {
  return { clearedBytes, domains };
}

interface Options {
  rows?: WatchHistoryRow[];
  rail?: RelatedResponse;
  relatedError?: unknown;
  listError?: unknown;
  available?: boolean;
  clearOutcome?: ClearCacheOutcome;
  measureError?: unknown;
  grant?: CredentialGrant | null;
}

function setup(options: Options = {}) {
  let cleared = false;
  const calls = { related: [] as string[], measure: 0, clearPublicCache: 0, clearGrant: 0, historyClear: 0, list: 0, channels: 0 };
  const api = {
    related: async (contentId: string): Promise<RelatedResponse> => {
      calls.related.push(contentId);
      if (options.relatedError !== undefined) throw options.relatedError;
      return options.rail ?? { items: [] };
    },
    channels: async () => { calls.channels += 1; throw new Error('追剧视图不得改用 /api/channels 判定可见性'); }
  } as unknown as HistoryApi & { channels(): Promise<never> };
  const history: HistoryReader = {
    available: async () => options.available ?? true,
    list: async () => { calls.list += 1; if (options.listError !== undefined) throw options.listError; return cleared ? [] : options.rows ?? []; },
    clear: async () => { calls.historyClear += 1; cleared = true; }
  };
  const cache: CacheUsage = {
    measure: async () => {
      calls.measure += 1;
      if (options.measureError !== undefined) throw options.measureError;
      return { usedBytes: 29_700_000, limitBytes: POSTER_CACHE_LIMIT_BYTES };
    },
    clearPublicCache: async () => { calls.clearPublicCache += 1; return options.clearOutcome ?? outcomeOf(['public-cache']); }
  };
  const credentials: CredentialWriter = {
    readGrant: async () => options.grant === undefined ? { tier: 'B', expiresAt: NOW + 5 * 86_400 } : options.grant,
    clearGrant: async () => { calls.clearGrant += 1; }
  };
  const resumed: WatchHistoryRow[] = [];
  const opened: string[] = [];
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const view = createHistoryView({ api, history, cache, credentials, root, now: () => NOW, onResume: (row) => void resumed.push(row), onOpenTitle: (id) => void opened.push(id) });
  return { view, root, calls, resumed, opened };
}
const pick = (root: HTMLElement, el: string): HTMLElement | null => root.querySelector(`[data-el="${el}"]`);
const bandState = (root: HTMLElement, el: string): string | undefined => root.querySelector(`[data-el="${el}"]`)?.getAttribute('data-state') ?? undefined;
const click = (node: Element | null): void => { (node as HTMLElement).click(); };
/** 过一到宏任务边界，把 `void asyncFn()` 的整条链跑完。 */
const tick = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)); };

describe('追剧视图：正在追 / 往期完播（AC-03）', () => {
  beforeEach(() => { document.body.replaceChildren(); });

  it('渲染三条带并按秒级断点展示进度与剩余秒数', async () => {
    const { view, root } = setup({ rows: [rowOf()] });
    await view.mount();
    expect(bandState(root, 'band-resume')).toBe('ready');
    expect(pick(root, 'band-cache')).toBeNull();
    expect(root.textContent).toContain('第 18 集 · 看到 01:42 / 02:15');
    expect(root.textContent).toContain('剩余 33 秒');
    expect(formatBytes(POSTER_CACHE_LIMIT_BYTES)).toBe('512.0 MiB');
  });

  it('续播按钮与卡片点击都带上原断点回调，完播条目重温时归零', async () => {
    const { view, root, resumed, opened } = setup({ rows: [rowOf(), rowOf({ content_id: 'd_done', last_episode_number: 8, total_episodes: 8, position_seconds: 100, duration_seconds: 102 })] });
    await view.mount();
    click(pick(root, 'resume-button'));
    expect(resumed[0]).toMatchObject({ content_id: 'd_longwang', position_seconds: 102 });
    const finishedRow = pick(root, 'band-finished')?.querySelector('[data-el="finished-row"]') as HTMLElement;
    click(finishedRow);
    expect(resumed.length).toBe(1);
    click(finishedRow.querySelector('button'));
    expect(resumed[1]).toMatchObject({ content_id: 'd_done', position_seconds: 0 });
    click(finishedRow.querySelectorAll('button')[1]);
    expect(opened).toEqual(['d_done']);
    click(pick(root, 'clear-history'));
    await tick();
    expect(bandState(root, 'band-finished')).toBe('empty');
    expect(resumed.length).toBe(2);
  });
});

describe('追剧视图：同类好剧召回（AC-18 公开域）', () => {
  it('用最近观看的剧目调 related，并与历史去重', async () => {
    const { view, root, calls } = setup({
      rows: [rowOf({ content_id: 'd_a' }), rowOf({ content_id: 'd_b' })],
      rail: { items: [itemOf('d_a'), itemOf('d_r1'), itemOf('d_r2')] }
    });
    await view.mount();
    expect(calls.related).toEqual(['d_a', 'd_b']);
    const ids = [...root.querySelectorAll('[data-el="related-card"]')].map((node) => (node as HTMLElement).dataset.contentId);
    expect(ids).toEqual(['d_r1', 'd_r2']);
  });

  it('召回结果里的私密条目绝不渲染', async () => {
    const { view, root } = setup({
      rows: [rowOf()],
      rail: { items: [itemOf('d_public'), itemOf('p_secret', { channelId: 'private', isPrivate: true, title: '深夜私语的秘密' }), itemOf('d_flagged', { isPrivate: true })] }
    });
    await view.mount();
    const ids = [...root.querySelectorAll('[data-el="related-card"]')].map((node) => (node as HTMLElement).dataset.contentId);
    expect(ids).toEqual(['d_public']);
    expect(root.innerHTML).not.toContain('p_secret');
    expect(root.innerHTML).not.toContain('深夜私语的秘密');
    expect(root.innerHTML).not.toContain('d_flagged');
  });

  it('没有观看记录时召回带进入 empty，不发请求', async () => {
    const { view, root, calls } = setup({ rows: [] });
    await view.mount();
    expect(bandState(root, 'band-related')).toBe('empty');
    expect(calls.related).toEqual([]);
  });

  it('related 网络失败时召回带显示 error 并提示需联网', async () => {
    const { view, root } = setup({ rows: [rowOf()], relatedError: new ApiError('NETWORK_ERROR', 0, '网络不可用') });
    await view.mount();
    expect(bandState(root, 'band-related')).toBe('error');
    expect(root.textContent).toContain('点播需联网');
  });
});

describe('追剧视图：缓存管理归我的（R26-09）', () => {
  it('不渲染缓存管理且不调用缓存或凭证删除接口', async () => {
    const { view, root, calls } = setup({ rows: [rowOf()] });
    await view.mount();
    expect(pick(root, 'clear-cache')).toBeNull();
    expect(pick(root, 'band-cache')).toBeNull();
    expect(calls.measure).toBe(0);
    expect(calls.clearPublicCache).toBe(0);
    expect(calls.clearGrant).toBe(0);
    expect(calls.historyClear).toBe(0);
  });

  it('缓存统计失败不影响追剧带，因为本页不读取缓存', async () => {
    const { view, root, calls } = setup({ rows: [rowOf()], measureError: new Error('磁盘不可读') });
    await view.mount();
    expect(calls.measure).toBe(0);
    expect(bandState(root, 'band-resume')).toBe('ready');
  });
});

describe('追剧视图：五态与断网边界', () => {
  it('loading → ready / empty / error / disabled 均可达', async () => {
    const ready = setup({ rows: [rowOf()] });
    const pending = ready.view.reload();
    expect(ready.root.dataset.state).toBe('loading');
    await pending;
    expect(ready.root.dataset.state).toBe('ready');

    const empty = setup({ rows: [] });
    await empty.view.mount();
    expect(empty.root.dataset.state).toBe('empty');

    const failed = setup({ listError: new ApiError('NETWORK_ERROR', 0, '网络不可用') });
    await failed.view.mount();
    expect(failed.root.dataset.state).toBe('error');
    expect(bandState(failed.root, 'band-resume')).toBe('error');

    const off = setup({ available: false });
    await off.view.mount();
    expect(off.root.dataset.state).toBe('disabled');
    expect(bandState(off.root, 'band-resume')).toBe('disabled');
  });

  it('断网提示「点播需联网」，且不含任何离线可播承诺', async () => {
    const { view, root } = setup({ rows: [rowOf()] });
    await view.mount();
    const offline = pick(root, 'offline-note');
    expect(offline?.textContent).toContain('点播需联网');
    for (const promise of OFFLINE_PROMISES) expect(root.textContent ?? '').not.toContain(promise);

    const dropped = setup({ listError: new ApiError('NETWORK_ERROR', 0, '网络不可用') });
    await dropped.view.mount();
    expect(pick(dropped.root, 'offline-note')?.textContent).toContain('点播需联网');
    for (const promise of OFFLINE_PROMISES) expect(dropped.root.textContent ?? '').not.toContain(promise);
  });

  it('destroy 清空 DOM 并冻结后续刷新', async () => {
    const { view, root, calls } = setup({ rows: [rowOf()] });
    await view.mount();
    view.destroy();
    expect(root.children.length).toBe(0);
    const before = calls.list;
    await view.reload();
    expect(calls.list).toBe(before);
  });

  it('不从 /api/channels 推断可见性，也不写任何存储域', async () => {
    const { view, root, calls } = setup({ rows: [rowOf()], rail: { items: [itemOf('d_r1')] } });
    await view.mount();
    click(pick(root, 'related-card'));
    expect(calls.channels).toBe(0);
    expect(calls.clearGrant).toBe(0);
    expect(calls.historyClear).toBe(0);
  });
});
