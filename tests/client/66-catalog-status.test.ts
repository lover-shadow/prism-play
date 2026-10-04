// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createCatalogStatusBand } from '../../src/views/catalog-status';
import { createSettingsView, type SettingsViewDeps } from '../../src/views/settings-view';
import { createCatalogCacheService, type SyncOutcome } from '../../src/core/catalog-cache';
import { PrismApiClient } from '../../src/core/api/client';
import { MemoryCacheDisk, PublicCache } from '../../src/core/storage/public-cache';
import type { ContentItem } from '../../edge/src/types/api';

const NOW = 1_780_000_000;
const tick = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
const snapshot = { revision: 7, items: 1, channels: 1, partial: false };
const outcome: SyncOutcome = { revision: 7, appliedEntries: 0, full: false, offline: false };
const pick = (root: HTMLElement, name: string) => root.querySelector(`[data-el="${name}"]`) as HTMLElement;

async function realCatalog() {
  const cache = new PublicCache(new MemoryCacheDisk());
  const item = { id: 'drama_a', channelId: 'drama', title: '公开剧目', category: '都市', isPrivate: false } as ContentItem;
  await cache.importBundle({ revision: 7, channels: { version: 7, channels: [{ id: 'drama', name: '短剧精选', order: 1, requiresTier: [], categories: ['都市'] }] }, items: [item] });
  let nextRevision = 7, offline = false;
  const requests: URL[] = [];
  const client = new PrismApiClient({ baseUrl: 'https://catalog.test', fetchImpl: async (input) => {
    const url = new URL(input);
    requests.push(url);
    if (offline) throw new Error('断网');
    const changes = nextRevision === 7 ? [] : [{ revision: nextRevision, contentId: item.id, operation: 'upsert', item: { ...item, title: '更新剧目' } }];
    return { ok: true, status: 200, text: async () => JSON.stringify({ changes, nextRevision, hasMore: false }) } as Response;
  } });
  const catalog = createCatalogCacheService({ client, cache });
  return { catalog, cache, requests, update: () => { nextRevision = 8; }, disconnect: () => { offline = true; } };
}

function settingsDeps(root: HTMLElement): SettingsViewDeps {
  return {
    root, now: () => NOW,
    api: { monetization: async () => ({ activeTiers: [] } as never), version: vi.fn(), redeem: vi.fn(), openPrivateSession: vi.fn(), closePrivateSession: vi.fn() },
    prefs: { get: async () => null, set: async () => undefined },
    bridge: { setSecureScreen: async () => true } as unknown as SettingsViewDeps['bridge'],
    tokens: { read: () => null, write: () => undefined }, bridgeSourceOf: () => 'web-fallback'
  };
}

describe('内容库更新：真实快照与手动同步', () => {
  it('两个 optional 依赖缺任一个，设置页均不渲染假 UI', async () => {
    for (const extra of [{}, { catalogStatus: () => snapshot }, { checkCatalogUpdate: async () => outcome }]) {
      const root = document.createElement('div');
      const view = createSettingsView({ ...settingsDeps(root), ...extra });
      await view.mount();
      expect(root.querySelector('[data-el="set-catalog"]')).toBeNull();
      view.destroy();
    }
  });

  it('设置页使用真实 catalog：当前修订、无变更、更新后修订及离线旧快照', async () => {
    const h = await realCatalog();
    const root = document.createElement('div');
    const deps = settingsDeps(root);
    const check = vi.fn(() => h.catalog.syncIncremental());
    const view = createSettingsView({ ...deps, catalogStatus: () => h.catalog.snapshotState(), checkCatalogUpdate: check });
    await view.mount();
    expect(pick(root, 'catalog-local').textContent).toContain('本地修订 7 · 1 条');
    expect(h.requests).toHaveLength(0);
    expect(pick(root, 'catalog-result').textContent).toContain('尚未检查');
    pick(root, 'catalog-check').click(); await tick();
    expect(pick(root, 'catalog-result').textContent).toContain('已最新：本次无变更');
    expect(h.cache.snapshotRevision()).toBe(7);
    expect(h.requests[0]?.pathname).toBe('/api/catalog/changes');
    expect(h.requests[0]?.searchParams.get('after')).toBe('7');
    expect(pick(root, 'catalog-checked-at').dataset.timestamp).toBe(String(NOW));
    expect(deps.api.version).not.toHaveBeenCalled();
    h.update(); pick(root, 'catalog-check').click(); await tick();
    expect(h.cache.snapshotRevision()).toBe(8);
    expect(pick(root, 'catalog-local').textContent).toContain('本地修订 8 · 1 条');
    expect(pick(root, 'catalog-result').textContent).toContain('更新成功');
    h.disconnect(); pick(root, 'catalog-check').click(); await tick();
    expect(pick(root, 'set-catalog').dataset.state).toBe('offline');
    expect(pick(root, 'catalog-result').textContent).toContain('旧快照');
    expect(pick(root, 'catalog-result').textContent).toContain('NETWORK_ERROR');
    expect(h.cache.snapshotRevision()).toBe(8);
    await view.reload();
    expect(check).toHaveBeenCalledTimes(3);
    expect(pick(root, 'catalog-result').textContent).toContain('旧快照');
    view.destroy();
  });

  it('加载中禁重复，销毁后不重绘，且不启动后台检查', async () => {
    let resolve!: (value: SyncOutcome) => void;
    const check = vi.fn(() => new Promise<SyncOutcome>((done) => { resolve = done; }));
    const band = createCatalogStatusBand({ catalogStatus: () => snapshot, checkCatalogUpdate: check })!;
    expect(check).not.toHaveBeenCalled();
    const btn = pick(band.wrap, 'catalog-check') as HTMLButtonElement;
    btn.click(); btn.click(); btn.dispatchEvent(new MouseEvent('click'));
    expect(btn.disabled).toBe(true);
    expect(band.wrap.dataset.state).toBe('loading');
    expect(check).toHaveBeenCalledTimes(1);
    const before = band.wrap.textContent;
    band.destroy(); resolve(outcome); await tick();
    expect(band.wrap.textContent).toBe(before);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...outcome, reason: '缓存拒收（stale-revision）', expected: '内容更新失败', state: 'error' },
    { ...outcome, offline: true, reason: '离线原因', expected: '旧快照', state: 'offline' }
  ])('如实展示 outcome.reason：$state', async (value) => {
    const band = createCatalogStatusBand({ catalogStatus: () => snapshot, checkCatalogUpdate: async () => value, now: () => NOW })!;
    pick(band.wrap, 'catalog-check').click(); await tick();
    expect(band.wrap.dataset.state).toBe(value.state);
    expect(pick(band.wrap, 'catalog-result').textContent).toContain(value.expected);
    expect(pick(band.wrap, 'catalog-result').textContent).toContain(value.reason);
    expect((pick(band.wrap, 'catalog-check') as HTMLButtonElement).disabled).toBe(false);
  });

  it('没有快照不伪造修订或声称可沿用旧快照；异常允许重试', async () => {
    const check = vi.fn().mockRejectedValueOnce(new Error('磁盘不可读')).mockResolvedValueOnce({ ...outcome, offline: true, reason: '网络不可用' });
    const band = createCatalogStatusBand({ catalogStatus: () => null, checkCatalogUpdate: check })!;
    expect(pick(band.wrap, 'catalog-local').textContent).toContain('修订未知');
    pick(band.wrap, 'catalog-check').click(); await tick();
    expect(band.wrap.dataset.state).toBe('error');
    expect(band.wrap.textContent).toContain('磁盘不可读');
    pick(band.wrap, 'catalog-check').click(); await tick();
    expect(band.wrap.textContent).toContain('本地暂无可用快照');
    expect(band.wrap.textContent).not.toContain('沿用本地旧快照');
  });
});
