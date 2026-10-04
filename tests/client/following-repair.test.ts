// @vitest-environment jsdom
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { createFollowingStore, FOLLOWING_TABLE } from '../../src/core/storage/following-store';
import { createHistoryStore, HISTORY_DATABASE, type SqliteLike } from '../../src/core/storage/history-store';
import { createHistoryView } from '../../src/views/history-view';
import type { WatchHistoryRow } from '../../src/core/storage/storage-domains';

const { DatabaseSync: Database } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSync };
function sqliteAt(path = ':memory:') {
  let db = new Database(path);
  let connected = true;
  const sqlite: SqliteLike = {
    isConnected: async () => connected,
    open: async () => { db = new Database(path); connected = true; },
    close: async () => { db.close(); connected = false; },
    executeSet: async (database, set, transaction) => {
      expect(database).toBe(HISTORY_DATABASE);
      if (transaction) db.exec('BEGIN');
      try {
        for (const entry of set) db.prepare(entry.statement).run(...entry.values);
        if (transaction) db.exec('COMMIT');
      } catch (error) { if (transaction) db.exec('ROLLBACK'); throw error; }
    },
    queryResult: async (_, sql, values) => db.prepare(sql).all(...values).map(row => ({ ...row })) as never
  };
  return { sqlite, exec: (sql: string) => db.exec(sql) };
}
const input = { contentId: 'public-a', title: '公开剧', coverUrl: '/poster/a', channelId: 'drama', isPrivate: false };
const watch = (id = 'public-a'): WatchHistoryRow => ({ content_id: id, title: id, cover_url: null, last_episode_id: 1, last_episode_number: 1, position_seconds: 10, duration_seconds: 100, total_episodes: 5, updated_at: 100 });

describe('R26-09 real SQLite following intent', () => {
  it('persists independent intent across actual database close/reopen and history/cache deletion', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'prism-follow-'));
    const adapter = sqliteAt(join(directory, 'prism_local.db'));
    try {
      const history = createHistoryStore({ sqlite: adapter.sqlite });
      const following = createFollowingStore({ sqlite: adapter.sqlite, nowSeconds: () => 123 });
      expect(await following.toggle(input)).toBe(true);
      await history.upsertWatch({ ...input, lastEpisodeId: 1, lastEpisodeNumber: 1, positionSeconds: 10, durationSeconds: 100 });
      adapter.exec("CREATE TABLE public_cache (id TEXT); INSERT INTO public_cache VALUES ('a')");
      await history.clearHistory();
      adapter.exec('DELETE FROM public_cache');
      await history.close();
      const restored = createFollowingStore({ sqlite: adapter.sqlite });
      expect(await restored.list()).toEqual([{ content_id: input.contentId, title: input.title, cover_url: input.coverUrl, created_at: 123 }]);
      expect(await restored.toggle(input)).toBe(false);
      expect(await restored.list()).toEqual([]);
      await restored.toggle(input);
      await restored.remove(input.contentId);
      await restored.remove(input.contentId);
      expect(await restored.list()).toEqual([]);
    } finally { await adapter.sqlite.close(HISTORY_DATABASE); rmSync(directory, { recursive: true, force: true }); }
  });
  it('blocks both privacy markers before any SQLite operation and validates shape', async () => {
    const adapter = sqliteAt();
    const open = vi.spyOn(adapter.sqlite, 'isConnected');
    const store = createFollowingStore({ sqlite: adapter.sqlite });
    await expect(store.toggle({ ...input, isPrivate: true })).rejects.toThrow(/禁止落盘/);
    await expect(store.toggle({ ...input, channelId: 'private' })).rejects.toThrow(/禁止落盘/);
    await expect(store.toggle({ ...input, title: ' ' })).rejects.toThrow();
    await expect(store.toggle({ ...input, contentId: ' ' })).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
    await adapter.sqlite.close(HISTORY_DATABASE);
  });
  it('serializes concurrent toggles; write/init failures reject instead of returning success', async () => {
    const adapter = sqliteAt();
    const store = createFollowingStore({ sqlite: adapter.sqlite });
    expect(await Promise.all([store.toggle(input), store.toggle(input)])).toEqual([true, false]);
    adapter.exec(`CREATE TRIGGER fail_follow BEFORE INSERT ON ${FOLLOWING_TABLE} BEGIN SELECT RAISE(ABORT, 'disk failure'); END`);
    await expect(store.toggle(input)).rejects.toThrow('disk failure');
    expect(await store.list()).toEqual([]);
    adapter.exec('DROP TRIGGER fail_follow');
    expect(await store.toggle(input)).toBe(true);
    adapter.exec(`CREATE TRIGGER fail_remove BEFORE DELETE ON ${FOLLOWING_TABLE} BEGIN SELECT RAISE(ABORT, 'delete failure'); END`);
    await expect(store.remove(input.contentId)).rejects.toThrow('delete failure');
    expect(await store.list()).toHaveLength(1);
    await adapter.sqlite.close(HISTORY_DATABASE);
    const failing = { ...adapter.sqlite, executeSet: vi.fn().mockRejectedValue(new Error('schema failure')) };
    await expect(createFollowingStore({ sqlite: failing }).init()).rejects.toThrow();
  });
});

function viewSetup(rows: WatchHistoryRow[], following?: ReturnType<typeof createFollowingStore>, clearError?: Error) {
  const root = document.createElement('main');
  document.body.replaceChildren(root);
  const cache = { measure: vi.fn(), clearPublicCache: vi.fn() };
  const onOpenTitle = vi.fn();
  const view = createHistoryView({ root, following, cache, onOpenTitle, onResume: vi.fn(),
    history: { list: async () => rows, clear: async () => { if (clearError) throw clearError; rows.splice(0); } },
    credentials: { readGrant: async () => null, clearGrant: vi.fn() },
    api: { related: async () => ({ items: [{ id: 'rec', title: '同类公开剧', channelId: 'drama', category: '剧情', isPrivate: false }] }) }
  });
  return { view, root, cache, onOpenTitle };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
describe('R26-09 history layout and honest following state', () => {
  it('caps first-screen watching cards, expands without displacing recommendations, has no cache management', async () => {
    const { root, view, cache } = viewSetup(Array.from({ length: 30 }, (_, i) => watch(`a${i}`)));
    await view.mount();
    expect(root.querySelectorAll('[data-el="resume-card"]')).toHaveLength(2);
    expect([...root.querySelectorAll('section')].map(node => node.dataset.el)).toEqual(['band-resume', 'band-related', 'band-finished']);
    expect(root.querySelector('[data-el="band-cache"]')).toBeNull();
    expect(cache.measure).not.toHaveBeenCalled();
    (root.querySelector('[data-el="expand-watching"]') as HTMLElement).click();
    expect(root.querySelectorAll('[data-el="resume-card"]')).toHaveLength(30);
    expect(root.querySelector('[data-el="band-related"]')).not.toBeNull();
  });
  it('shows saved unwatched titles, joins real progress, removes only intent and preserves it on history clear', async () => {
    const adapter = sqliteAt();
    const following = createFollowingStore({ sqlite: adapter.sqlite });
    await following.toggle(input);
    await following.toggle({ ...input, contentId: 'unwatched', title: '未看收藏' });
    const { root, view, onOpenTitle } = viewSetup([watch()], following);
    await view.mount();
    expect(root.querySelectorAll('[data-el="resume-card"]')).toHaveLength(1);
    expect(root.textContent).toContain('未看收藏');
    (root.querySelector('[data-el="following-card"]') as HTMLElement).click();
    expect(onOpenTitle).toHaveBeenCalledWith('unwatched');
    (root.querySelector('[data-el="clear-history"]') as HTMLElement).click();
    await tick();
    expect(await following.list()).toHaveLength(2);
    expect(root.textContent).toContain('未看收藏');
    (root.querySelector('[data-el="remove-following"]') as HTMLElement).click();
    await tick();
    expect(await following.list()).toHaveLength(1);
    await adapter.sqlite.close(HISTORY_DATABASE);
  });
  it('shows unavailable following as error rather than an empty saved list', async () => {
    const following = { list: vi.fn().mockRejectedValue(new Error('SQLite unavailable')), remove: vi.fn() };
    const root = document.createElement('main');
    const view = createHistoryView({ root, following, onOpenTitle: vi.fn(), onResume: vi.fn(),
      history: { list: async () => [], clear: vi.fn() },
      cache: { measure: vi.fn(), clearPublicCache: vi.fn() },
      credentials: { readGrant: async () => null, clearGrant: vi.fn() },
      api: { related: vi.fn() } });
    await view.mount();
    expect(root.dataset.state).toBe('error');
    expect(root.textContent).toContain('SQLite unavailable');
    view.destroy();
  });
  it('does not hide clear failure or claim following success when persistence fails', async () => {
    const adapter = sqliteAt();
    const following = createFollowingStore({ sqlite: adapter.sqlite });
    await following.toggle(input);
    adapter.exec(`CREATE TRIGGER fail_remove BEFORE DELETE ON ${FOLLOWING_TABLE} BEGIN SELECT RAISE(ABORT, 'write failure'); END`);
    const { root, view } = viewSetup([watch()], following, new Error('clear failure'));
    await view.mount();
    (root.querySelector('[data-el="remove-following"]') as HTMLElement).click();
    await tick();
    expect(root.textContent).toContain('write failure');
    expect(await following.list()).toHaveLength(1);
    (root.querySelector('[data-el="clear-history"]') as HTMLElement).click();
    await tick();
    expect(root.textContent).toContain('clear failure');
    await adapter.sqlite.close(HISTORY_DATABASE);
  });
});
