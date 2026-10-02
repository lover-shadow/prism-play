import { describe, expect, it } from 'vitest';
import { createInMemoryD1 } from '../support/sqlite-d1';
import { insert, seedChannel, seedContent, seedStandardChannels } from '../support/seed';

describe('Stage 1 foundation: in-memory D1 stand-in', () => {
  it('applies the authoritative migration and reports the contract table count', async () => {
    const db = await createInMemoryD1();
    const tables = db
      .selectAll("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'")
      .map((row) => String(row.name));
    const ftsShadow = tables.filter((name) => /_(config|content|data|docsize|idx)$/.test(name));
    // 0001 的 20 张业务表 + 0002 增量迁移新增的 cloud_watch_history 与 cloud_user_profile。
    expect(tables.length - ftsShadow.length).toBe(22);
    expect(ftsShadow.length).toBe(5);
  });

  it('applies incremental migrations, not only 0001', async () => {
    const db = await createInMemoryD1();
    const columns = db
      .selectAll('SELECT name FROM pragma_table_info(\'content_items\')')
      .map((row) => String(row.name));
    // 客观标定列来自 0002；若测试库只建 0001，这些列会静默消失而其余断言仍全绿。
    for (const column of ['is_ai', 'is_hot', 'hot_score', 'hits_week', 'hits_total']) {
      expect(columns, `content_items 缺少列 ${column}`).toContain(column);
    }
  });

  it('enforces the private/shareable equality at the storage layer (AC-02 red line)', async () => {
    const db = await createInMemoryD1();
    seedChannel(db, { id: 'private', name: '个人探索', requiresTier: 'B,Y,S' });
    expect(() =>
      seedContent(db, { id: 'leak_1', channelId: 'private', title: '泄露测试', isPrivate: 0, shareable: 1 })
    ).toThrow();
    expect(() =>
      seedContent(db, { id: 'leak_2', channelId: 'private', title: '泄露测试', isPrivate: 1, shareable: 1 })
    ).toThrow();
    seedContent(db, { id: 'ok_1', channelId: 'private', title: '合法私密', isPrivate: 1, shareable: 0 });
    expect(db.count('content_items')).toBe(1);
  });

  it('runs batch() as one atomic unit and rolls every statement back on failure', async () => {
    const db = await createInMemoryD1();
    const statements = [
      db.prepare(
        "INSERT INTO channels (id, name, categories_json, created_at, updated_at) VALUES ('movie', '院线电影', '[]', 1, 1)"
      ),
      db.prepare(
        "INSERT INTO channels (id, name, categories_json, created_at, updated_at) VALUES ('movie', '重复主键', '[]', 1, 1)"
      ),
      db.prepare(
        "INSERT INTO channels (id, name, categories_json, created_at, updated_at) VALUES ('anime', '热血动漫', '[]', 1, 1)"
      )
    ];
    await expect(db.batch(statements)).rejects.toThrow();
    expect(db.count('channels')).toBe(0);
  });

  it('keeps the conditional coupon counter update single-statement and bounded', async () => {
    const db = await createInMemoryD1();
    insert(db, 'card_coupons', {
      code: 'GY-Q90D-A7F2-8899',
      tier: 'Q',
      tier_name: '季度畅享卡',
      duration_days: 90,
      status: 'ACTIVE',
      max_devices: 10,
      device_count: 9,
      created_at: 1,
      updated_at: 1
    });
    const claim = () =>
      db.prepare(
        "UPDATE card_coupons SET device_count = device_count + 1 WHERE code = ? AND status IN ('UNUSED','ACTIVE') AND device_count < max_devices"
      );

    const first = await claim().bind('GY-Q90D-A7F2-8899').run();
    expect(first.meta.changes).toBe(1);
    const second = await claim().bind('GY-Q90D-A7F2-8899').run();
    expect(second.meta.changes).toBe(0);
    expect(db.selectOne('SELECT device_count FROM card_coupons')?.device_count).toBe(10);
  });

  it('matches Chinese single and double character tokens through pre-generated FTS terms', async () => {
    const db = await createInMemoryD1();
    seedStandardChannels(db);
    seedContent(db, { id: 'd_warlord', channelId: 'drama', title: '战神之龙王归来' });
    await db
      .prepare('INSERT INTO public_search_fts (content_id, title_tokens) VALUES (?, ?)')
      .bind('d_warlord', '战 神 战神 之 龙王 归来 战神之龙王归来')
      .run();
    const single = await db
      .prepare('SELECT content_id FROM public_search_fts WHERE public_search_fts MATCH ?')
      .bind('战')
      .all<{ content_id: string }>();
    const doubled = await db
      .prepare('SELECT content_id FROM public_search_fts WHERE public_search_fts MATCH ?')
      .bind('龙王')
      .all<{ content_id: string }>();
    expect(single.results[0]?.content_id).toBe('d_warlord');
    expect(doubled.results[0]?.content_id).toBe('d_warlord');
  });
});
