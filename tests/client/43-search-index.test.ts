// @vitest-environment jsdom
/**
 * A-6 端侧检索索引验收（SPEC-APP-REFACTOR §A-6；AC-A6-1 断网秒出 / AC-A6-2 结果可起播 / AC-A6-3 增量可搜）。
 * 落盘用真实 `node:sqlite`（与 edge 套件同款取法），只包一层 `SqliteLike`：FTS5 虚表、列过滤 MATCH、bm25
 * 召回序与 gram 覆盖校验全在真 SQLite 上跑，假件冒充不了这套分词。私密零留痕直接查库证明。
 */
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import type { CatalogChange, ContentItem } from '../../edge/src/types/api';
import {
  createSearchIndex,
  indexTokens,
  LOCAL_SEARCH_FTS_DDL,
  normalizeQuery,
  SEARCH_DATABASE,
  SEARCH_DOC_TABLE,
  SEARCH_FTS_TABLE,
  type SnapshotFeed,
  type SqliteLike
} from '../../src/core/storage/search-index';

/** vite-node 会把 `node:sqlite` 重写成裸包名（内置表比模块旧），所以经 createRequire 取内置模块。 */
const requireFromHere = createRequire(import.meta.url);
const loaded = requireFromHere('node:sqlite') as { DatabaseSync: typeof DatabaseSync };
const openDatabase = (): DatabaseSync => new loaded.DatabaseSync(':memory:');
const NO_SQLITE_COPY = '本机无端侧 SQLite：追剧历史需 Android 宿主';
const FALLBACK_COPY = '本机无端侧 SQLite：本地检索回落云端';

function sqliteOf(db: DatabaseSync): SqliteLike {
  let opened = false;
  return {
    isConnected: async () => opened,
    open: async () => void (opened = true),
    close: async () => void (opened = false),
    executeSet: async (database, set, transaction) => {
      expect(database).toBe(SEARCH_DATABASE);
      if (transaction) db.exec('BEGIN');
      try {
        for (const statement of set) db.prepare(statement.statement).run(...statement.values);
        if (transaction) db.exec('COMMIT');
      } catch (error) {
        if (transaction) db.exec('ROLLBACK');
        throw error;
      }
    },
    queryResult: async (_database, statement, values) => db.prepare(statement).all(...values).map((row) => ({ ...row })) as never
  };
}
const deadSqlite = (): SqliteLike => ({
  isConnected: async () => false,
  open: async () => { throw new Error(NO_SQLITE_COPY); },
  close: async () => undefined,
  executeSet: async () => { throw new Error(NO_SQLITE_COPY); },
  queryResult: async () => { throw new Error(NO_SQLITE_COPY); }
});
const item = (id: string, title: string, over: Partial<ContentItem> = {}): ContentItem =>
  ({ id, channelId: 'drama', title, category: '都市', isPrivate: false, synopsis: '', ...over } as ContentItem);
const CORPUS: ContentItem[] = [
  item('d_longwang', '战神之龙王归来', { synopsis: '退伍归来守护家人' }),
  item('d_changan', '长安十二时辰', { category: '古装', synopsis: '大唐长安一日' }),
  item('d_niangzi', '甜宠小娘子', { category: '甜宠' }),
  item('d_mozu', '魔道祖师', { category: '热血' }),
  item('d_yiren', '一人之下 第二季', { category: '热血', channelId: 'anime' }),
  item('d_english', 'Chang An 2024', { category: '记录', channelId: 'documentary' })
];
const upsertChange = (at: number, entry: ContentItem): CatalogChange => ({ revision: at, contentId: entry.id, operation: 'upsert', item: entry });
const deleteChange = (at: number, contentId: string): CatalogChange => ({ revision: at, contentId, operation: 'delete' });
const ids = (hits: Array<{ contentId: string }>): string[] => hits.map((hit) => hit.contentId);
const docsIn = (db: DatabaseSync): number => Number((db.prepare(`SELECT COUNT(*) AS total FROM ${SEARCH_DOC_TABLE}`).get() as { total: number }).total);

describe('索引落盘：建表、重建与幂等（§A-6.1 / §A-6.2）', () => {
  it('虚表语句逐字对齐规格：六列与 content_id UNINDEXED 的位置都是契约', () => {
    expect(LOCAL_SEARCH_FTS_DDL).toBe('CREATE VIRTUAL TABLE IF NOT EXISTS local_search_fts USING fts5(content_id UNINDEXED, title, pinyin, initials, category, synopsis)');
  });

  it('全量快照落地即建索引；同一修订重放不再跑一遍写入', async () => {
    const db = openDatabase();
    const index = createSearchIndex({ sqlite: sqliteOf(db) });
    const feed: SnapshotFeed = { items: CORPUS, revision: 11 };
    expect(await index.sync(feed)).toMatchObject({ indexed: CORPUS.length, replaced: true, revision: 11 });
    expect(index.status()).toMatchObject({ available: true, docs: CORPUS.length, revision: 11 });
    expect(docsIn(db)).toBe(CORPUS.length);
    expect(Number((db.prepare(`SELECT COUNT(*) AS total FROM ${SEARCH_FTS_TABLE}`).get() as { total: number }).total)).toBe(CORPUS.length);
    expect(await index.sync(feed)).toMatchObject({ skipped: true, indexed: 0 });
  });

  it('私密条目一字节都不进磁盘：剧名在库里查不到，剔除数目如实回报', async () => {
    const db = openDatabase();
    const report = await createSearchIndex({ sqlite: sqliteOf(db) }).sync({
      items: [...CORPUS, item('p_secret', '深夜私语的秘密', { channelId: 'private', isPrivate: true })], revision: 12
    });
    expect(report).toMatchObject({ indexed: CORPUS.length, rejected: 1 });
    expect(docsIn(db)).toBe(CORPUS.length);
    expect(Number((db.prepare(`SELECT COUNT(*) AS total FROM ${SEARCH_DOC_TABLE} WHERE title LIKE ?`).get('%私语%') as { total: number }).total)).toBe(0);
    expect(await createSearchIndex({ sqlite: sqliteOf(db) }).search('深夜私语')).toEqual([]);
    expect(ids(await createSearchIndex({ sqlite: sqliteOf(db) }).search('深夜'))).not.toContain('p_secret');
  });

  it('增量批次走幂等 upsert 与墓碑删除；重放同一修订不重复写', async () => {
    const db = openDatabase();
    const index = createSearchIndex({ sqlite: sqliteOf(db) });
    await index.sync({ items: [CORPUS[0] as ContentItem, CORPUS[2] as ContentItem], revision: 20 });
    expect(ids(await index.search('甜宠'))).toEqual(['d_niangzi']);
    expect(await index.sync({
      items: [], revision: 21,
      changes: [upsertChange(21, item('d_new', '逆袭之路')), deleteChange(21, 'd_niangzi'), upsertChange(21, CORPUS[0] as ContentItem)]
    })).toMatchObject({ indexed: 2, removed: 1, rejected: 0, revision: 21 });
    expect(ids(await index.search('甜宠'))).toEqual([]);
    expect(ids(await index.search('逆袭'))).toEqual(['d_new']);
    expect(docsIn(db)).toBe(2); // 同 id 重写只留一行：FTS 侧按 rowid 先摘旧行
    expect(ids(await index.search('战神'))).toEqual(['d_longwang']);
    expect(await index.sync({ items: [], revision: 21, changes: [upsertChange(21, CORPUS[0] as ContentItem)] })).toMatchObject({ skipped: true });
  });

  it('清缓存即清索引；重开同一库读回落盘状态', async () => {
    const shared = sqliteOf(openDatabase());
    const first = createSearchIndex({ sqlite: shared });
    await first.sync({ items: CORPUS, revision: 30 });
    await first.clear();
    expect(first.status()).toMatchObject({ docs: 0, revision: 0 });
    expect(await first.search('长安')).toEqual([]);
    await first.sync({ items: CORPUS, revision: 31 });
    const reopened = createSearchIndex({ sqlite: shared });
    await reopened.init();
    expect(reopened.status()).toMatchObject({ available: true, docs: CORPUS.length, revision: 31 });
    expect(ids(await reopened.search('长安'))).toContain('d_changan');
    await reopened.close();
  });

  it('本机无 SQLite：search 返回空数组并把实话写进 status，不抛错也不冒充空目录', async () => {
    const index = createSearchIndex({ sqlite: deadSqlite() });
    expect(await index.sync({ items: CORPUS, revision: 5 })).toMatchObject({ indexed: 0, error: FALLBACK_COPY });
    expect(index.status()).toMatchObject({ available: false, error: FALLBACK_COPY });
    expect(await index.search('战神')).toEqual([]);
    await expect(index.clear()).resolves.toBeUndefined();
    await expect(index.close()).resolves.toBeUndefined();
  });
});

describe('检索排序与分词（§A-6.3；AC-A6-1）', () => {
  const seeded = async (revision: number): Promise<ReturnType<typeof createSearchIndex>> => {
    const index = createSearchIndex({ sqlite: sqliteOf(openDatabase()) });
    await index.sync({ items: CORPUS, revision });
    return index;
  };

  it('精确 > 前缀 > 拼音/首字母 > 分类题材：命中类型逐档对得上', async () => {
    const index = await seeded(40);
    expect(ids(await index.search('战神之龙王归来'))).toEqual(['d_longwang']);
    expect((await index.search('战神'))[0]).toMatchObject({ contentId: 'd_longwang', matchType: 'exact' });
    // 战(z) 神(s) 之(z) 龙(l) 王(w) 归(g) 来(l)：首字母连写按 pinyin-pro 的实际读音，不是手写猜想。
    expect((await index.search('zszlwgl'))[0]).toMatchObject({ contentId: 'd_longwang', matchType: 'pinyin', initials: 'zszlwgl' });
    expect((await index.search('zszl'))[0]).toMatchObject({ contentId: 'd_longwang', matchType: 'pinyin' });
    expect((await index.search('zhan shen'))[0]).toMatchObject({ contentId: 'd_longwang', matchType: 'pinyin' });
    const spelled = await index.search('chang an');
    expect(ids(spelled)).toEqual(expect.arrayContaining(['d_english', 'd_changan']));
    expect(spelled.find((hit) => hit.contentId === 'd_english')).toMatchObject({ matchType: 'exact' });
    expect(spelled.find((hit) => hit.contentId === 'd_changan')).toMatchObject({ matchType: 'pinyin' });
    expect((await index.search('古装'))[0]).toMatchObject({ contentId: 'd_changan', matchType: 'related', category: '古装' });
    expect(ids(await index.search('热血'))).toEqual(expect.arrayContaining(['d_mozu', 'd_yiren']));
    expect((await index.search('退伍归来'))[0]).toMatchObject({ contentId: 'd_longwang', matchType: 'fuzzy' });
  });

  it('覆盖校验拦住「只共享一个汉字」的假命中；未命中就是空，不是失败', async () => {
    const index = await seeded(41);
    expect(ids(await index.search('龙归'))).toEqual([]); // 龙与归分属两处，整串 gram 不在任何原文里
    expect(ids(await index.search('龙王'))).toEqual(['d_longwang']);
    expect(ids(await index.search('长安'))).toEqual(expect.arrayContaining(['d_changan']));
    expect(await index.search('')).toEqual([]);
    expect(await index.search('   ')).toEqual([]);
    expect(await index.search('不存在剧目名')).toEqual([]);
    expect(await index.search('长'.repeat(81))).toEqual([]);
  });

  it('结果上限 50 条，同一条只落在最好的一档，limit 可再收紧', async () => {
    const many = Array.from({ length: 70 }, (_, at) => item(`bulk_${at}`, `战神 bulk ${at}`));
    const index = createSearchIndex({ sqlite: sqliteOf(openDatabase()) });
    await index.sync({ items: many, revision: 42 });
    const hits = await index.search('战神');
    expect(hits.length).toBe(50);
    expect(new Set(ids(hits)).size).toBe(hits.length);
    expect(hits.every((hit) => hit.matchType === 'exact')).toBe(true);
    expect(await index.search('战神', 3)).toHaveLength(3);
  });

  it('gram 口径与 edge 分词器同构：汉字给单字与相邻二字与整串，拉丁词不拆', () => {
    expect(indexTokens('战神之')).toEqual(expect.arrayContaining(['战', '神', '之', '战神', '神之', '战神之']));
    expect(indexTokens('Chang An 2024')).toEqual(['chang', 'an', '2024']);
    expect(normalizeQuery('  战神 之 ')).toBe('战神 之');
  });
});
