import { pinyin } from 'pinyin-pro';
import type { CatalogChange, ContentItem, MatchType } from '../../../edge/src/types/api';
import type { SqliteLike, SqliteStatement, SqliteValue } from './history-store';
import { isPrivateSubject } from './storage-domains';

/** 注入面与历史域同源：消费者不必知道 SQLite 类型住在哪个域文件里。 */
export type { SqliteLike, SqliteStatement, SqliteValue } from './history-store';

export const SEARCH_DATABASE = 'prism_search.db';
export const SEARCH_FTS_TABLE = 'local_search_fts';
export const SEARCH_DOC_TABLE = 'local_search_doc';
/** 默认索引查询50条；分页请求可扩展到实际文档数，门面单页最多50条。 */
export const SEARCH_RESULT_LIMIT = 50;
const RECALL_LIMIT = 120, WRITE_CHUNK = 60, QUERY_MAX_CHARS = 80, SYNOPSIS_INDEX_CHARS = 200;

/** §A-6.1 的逐字契约：列名与 `UNINDEXED` 的位置都写在规格里，实现不得改名或换序。 */
export const LOCAL_SEARCH_FTS_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS ${SEARCH_FTS_TABLE} USING fts5(content_id UNINDEXED, title, pinyin, initials, category, synopsis)`;
export const LOCAL_SEARCH_DOC_DDL = `CREATE TABLE IF NOT EXISTS ${SEARCH_DOC_TABLE} (
    content_id TEXT PRIMARY KEY,
    doc_id INTEGER NOT NULL UNIQUE,
    title TEXT NOT NULL,
    pinyin TEXT NOT NULL DEFAULT '',
    initials TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    synopsis TEXT NOT NULL DEFAULT ''
)`;
export const LOCAL_SEARCH_STATE_DDL = `CREATE TABLE IF NOT EXISTS local_search_state (
    id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, docs INTEGER NOT NULL, indexed_at INTEGER NOT NULL
)`;
const SCHEMA: SqliteStatement[] = [{ statement: LOCAL_SEARCH_FTS_DDL, values: [] }, { statement: LOCAL_SEARCH_DOC_DDL, values: [] }, { statement: LOCAL_SEARCH_STATE_DDL, values: [] }];
const DOC_COLUMNS = 'content_id, doc_id, title, pinyin, initials, category, synopsis';
const DOC_INSERT = `INSERT INTO ${SEARCH_DOC_TABLE} (${DOC_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`;
/** FTS 侧以 `doc_id` 作 rowid：删旧行了得干净，UNINDEXED 的 content_id 只用于把命中带回文档表。 */
const FTS_INSERT = `INSERT INTO ${SEARCH_FTS_TABLE} (rowid, content_id, title, pinyin, initials, category, synopsis) VALUES (?, ?, ?, ?, ?, ?, ?)`;
const FTS_DROP = `DELETE FROM ${SEARCH_FTS_TABLE} WHERE rowid = ?`;
const FTS_CLEAR = `DELETE FROM ${SEARCH_FTS_TABLE}`, DOC_CLEAR = `DELETE FROM ${SEARCH_DOC_TABLE}`;
const STATE_UPSERT = 'INSERT OR REPLACE INTO local_search_state (id, revision, docs, indexed_at) VALUES (1, ?, ?, ?)';
const STATE_SELECT = 'SELECT revision, docs, indexed_at FROM local_search_state WHERE id = 1';
const COUNT_SELECT = `SELECT COUNT(*) AS total FROM ${SEARCH_DOC_TABLE}`;
const NEXT_ID_SELECT = `SELECT MAX(doc_id) AS max_id FROM ${SEARCH_DOC_TABLE}`;
const EXACT_SELECT = `SELECT ${DOC_COLUMNS} FROM ${SEARCH_DOC_TABLE} WHERE lower(title) = ?`;
const PREFIX_SELECT = `SELECT ${DOC_COLUMNS} FROM ${SEARCH_DOC_TABLE} WHERE substr(lower(title), 1, length(?)) = ?`;
const DOC_BY_IDS = `SELECT ${DOC_COLUMNS} FROM ${SEARCH_DOC_TABLE} WHERE content_id IN`;
const DOC_ID_BY_IDS = `SELECT doc_id FROM ${SEARCH_DOC_TABLE} WHERE content_id IN`;
const DOC_DELETE_BY_IDS = `DELETE FROM ${SEARCH_DOC_TABLE} WHERE content_id IN`;
/** 列名进 MATCH 表达式本体（FTS5 列过滤语法），且只来自 FTS_STAGES 这张冻结表，绝不来自查询词。 */
const RECALL_SELECT = `SELECT content_id FROM ${SEARCH_FTS_TABLE} WHERE ${SEARCH_FTS_TABLE} MATCH ? ORDER BY rank LIMIT ?`;

type TextColumn = 'title' | 'pinyin' | 'initials' | 'category' | 'synopsis';
interface Stage { readonly column: TextColumn; readonly matchType: MatchType; readonly latinOnly?: boolean }
/** 命中优先级（§A-6.3）：精确剧名 → 剧名前缀 → 全拼/首字母 → 分类题材 → 简介文本。首字母列只收纯拉丁
 *  查询：汉字进首字母列等于整库召回，而覆盖校验拦不住这种命中，那是不诚实的结果。 */
const FTS_STAGES: readonly Stage[] = [
  { column: 'title', matchType: 'exact' },
  { column: 'pinyin', matchType: 'pinyin' },
  { column: 'initials', matchType: 'pinyin', latinOnly: true },
  { column: 'category', matchType: 'related' },
  { column: 'synopsis', matchType: 'fuzzy' }
];

export interface LocalSearchDoc { content_id: string; doc_id: number; title: string; pinyin: string; initials: string; category: string; synopsis: string }
export interface SearchHit { contentId: string; matchType: MatchType; title: string; category: string; initials: string }
/** §A-6.2 的数据流载荷：全量快照落地只给 `items`（重建），增量批次给 `changes`（按 content_id 幂等）。 */
export interface SnapshotFeed { items: readonly ContentItem[]; changes?: readonly CatalogChange[]; discoveries?: readonly ContentItem[]; revision: number; discovery?: boolean }
export interface IndexReport { indexed: number; removed: number; rejected: number; revision: number; replaced: boolean; skipped: boolean; error: string | null }
/** `available` 为假时调用方必须如实回落云端，而不是把"索引没就绪"冒充成"目录里没有"。 */
export interface SearchIndexStatus { available: boolean; docs: number; revision: number; indexedAt: number; error: string | null }
export interface SearchIndex {
  init(): Promise<void>;
  status(): SearchIndexStatus;
  /** 后台落地的写路径：失败只记状态、只回报文，绝不把异常抛回目录同步链路。 */
  sync(feed: SnapshotFeed): Promise<IndexReport>;
  search(query: string, limit?: number): Promise<SearchHit[]>;
  clear(): Promise<void>;
  close(): Promise<void>;
}
export interface SearchIndexDeps { sqlite: SqliteLike; nowSeconds?: () => number }

const CJK_RUN = /[㐀-䶿一-鿿豈-﫿]/;
const isCjk = (char: string): boolean => CJK_RUN.test(char);
/** 索引与门面共用这一条归一化口径，否则"视图放行的小写词"会在索引里换一种写法。 */
export const normalizeQuery = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
/** 逐字音节/首字母：不去重——`战神之龙王归来` 的首字母序列是 `zsdlgl`，去重会把它折成 `zslwg`。 */
const syllables = (run: string, toInitial: boolean): string[] => (toInitial
  ? pinyin(run, { toneType: 'none', pattern: 'first', type: 'array' })
  : pinyin(run, { toneType: 'none', type: 'array' })).map((entry) => normalizeQuery(entry)).filter((entry) => entry !== '');
/** 切成「汉字串 / 其余串」两类，空格是硬边界：把 `Chang An` 并成一串就没法按词命中了。 */
function runsOf(value: string): Array<{ cjk: boolean; run: string }> {
  const runs: Array<{ cjk: boolean; run: string }> = [];
  let split = false;
  for (const char of normalizeQuery(value)) {
    if (char === ' ') { split = true; continue; }
    const cjk = isCjk(char);
    const last = runs[runs.length - 1];
    if (!split && last !== undefined && last.cjk === cjk) last.run += char;
    else runs.push({ cjk, run: char });
    split = false;
  }
  return runs;
}
/** 按串展开的骨架：汉字串交给 `perRun`，其余串原样作一个 token。gram 与拼音共用这套去重口径。 */
function tokensOf(value: string, perRun: (run: string) => string[]): string[] {
  const tokens: string[] = [];
  for (const { cjk, run } of runsOf(value)) tokens.push(...(cjk ? perRun(run) : [run]));
  return [...new Set(tokens)];
}
const gramsOf = (run: string): string[] => {
  const chars = [...run];
  const grams = [...chars];
  for (let index = 0; index + 1 < chars.length; index += 1) grams.push(`${chars[index]}${chars[index + 1]}`);
  if (chars.length > 1) grams.push(run);
  return grams;
};
/** 与 `edge/src/core/tokens.ts` 同构的端侧实现：客户端不引边缘运行时依赖，只对齐分词口径。 */
export const indexTokens = (value: string): string[] => tokensOf(value, gramsOf);
/** 拼音列＝逐字音节/首字母 + 每串连写（`战神之龙王归来` → `zhan shen … zhanshenzhilongwangguilai` /
 *  `z s … zsdlgl`）；拉丁词原样保留，英文剧名也走这两列。文档列另存整标题首字母连写供补全回显。 */
const spelledOf = (toInitial: boolean) => (run: string): string[] => {
  const list = syllables(run, toInitial);
  return [...list, list.join('')];
};
const spelledColumn = (title: string, toInitial: boolean): string => tokensOf(title, spelledOf(toInitial)).join(' ');
const displayInitials = (title: string): string => runsOf(title).map(({ cjk, run }) => (cjk ? syllables(run, true).join('') : run)).join('');
const indexColumn = (value: string): string => indexTokens(value).join(' ');
const quoted = (term: string): string => `"${term.replaceAll('"', '""')}"`;
const matchExpression = (terms: readonly string[]): string | null =>
  terms.length === 0 ? null : terms.map((term) => (!isCjk(term.charAt(0) as string) && term.length >= 2 ? `${quoted(term)}*` : quoted(term))).join(' OR ');
/** 覆盖校验：查询的每个 gram 都必须在原文里真的出现（拉丁串允许前缀，故 `zhanshen` 找得到 `zhan shen`）。
 *  整串直通：`龙王归来` 这类四字以上连续片段在 gram 序列里未必是独立 token，但"原文含这一串"就是命中。 */
function covers(query: string, text: string): boolean {
  const grams = indexTokens(query), terms = indexTokens(text);
  if (grams.length === 0 || terms.length === 0) return false;
  if (normalizeQuery(text).includes(query)) return true;
  return grams.every((gram) => terms.some((term) => term === gram || (!isCjk(gram) && gram.length >= 2 && term.startsWith(gram))));
}

const inList = (sql: string, count: number): string => `${sql} (${Array.from({ length: Math.max(1, count) }, () => '?').join(', ')})`;
const textOf = (value: unknown, limit?: number): string => (typeof value === 'string' ? value.trim() : '').slice(0, limit ?? Number.MAX_SAFE_INTEGER);
const numOf = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0);
const NO_SQLITE = '本机无端侧 SQLite';
const describeError = (error: unknown): string => {
  const text = (error instanceof Error ? error.message : String(error)).slice(0, 160);
  return text.startsWith(NO_SQLITE) ? `${NO_SQLITE}：本地检索回落云端` : text;
};
const EMPTY_REPORT: IndexReport = { indexed: 0, removed: 0, rejected: 0, revision: 0, replaced: false, skipped: false, error: null };

export function createSearchIndex(deps: SearchIndexDeps): SearchIndex {
  const { sqlite } = deps;
  const now = deps.nowSeconds ?? ((): number => Math.floor(Date.now() / 1000));
  let ready = false, failure: string | null = null, nextDocId = 1;
  let state = { revision: 0, docs: 0, indexedAt: 0 };
  let pending: Promise<unknown> = Promise.resolve();
  /** 与历史域同款幂等建表：冷启动重复执行不报错，也不清掉上一进程已落地的索引行。 */
  async function ensureReady(): Promise<void> {
    if (ready) return;
    try {
      if (!(await sqlite.isConnected(SEARCH_DATABASE))) await sqlite.open(SEARCH_DATABASE);
      await sqlite.executeSet(SEARCH_DATABASE, SCHEMA, true);
      const [row] = await sqlite.queryResult<Record<string, unknown>>(SEARCH_DATABASE, STATE_SELECT, []);
      state = { revision: numOf(row?.revision), docs: numOf(row?.docs), indexedAt: numOf(row?.indexed_at) };
      const [max] = await sqlite.queryResult<{ max_id?: number }>(SEARCH_DATABASE, NEXT_ID_SELECT, []);
      nextDocId = numOf(max?.max_id) + 1;
      ready = true; failure = null;
    } catch (error) {
      ready = false; failure = describeError(error); throw error;
    }
  }
  /** 写入前的私密闸门与形态闸门：私密行与缺剧名的脏行都不进 SQL，数目留在报告里。 */
  const admitted = (items: readonly ContentItem[]): ContentItem[] =>
    items.filter((item) => item !== undefined && typeof item.id === 'string' && item.id !== '' && textOf(item.title) !== '' && !isPrivateSubject(item));
  const docOf = (item: ContentItem, docId: number): LocalSearchDoc => {
    const title = textOf(item.title);
    return { content_id: item.id, doc_id: docId, title, pinyin: spelledColumn(title, false), initials: displayInitials(title), category: textOf(item.category), synopsis: textOf(item.synopsis ?? '', SYNOPSIS_INDEX_CHARS) };
  };
  const statementsOf = (doc: LocalSearchDoc): SqliteStatement[] => [
    { statement: DOC_INSERT, values: [doc.content_id, doc.doc_id, doc.title, doc.pinyin, doc.initials, doc.category, doc.synopsis] },
    { statement: FTS_INSERT, values: [doc.doc_id, doc.content_id, indexColumn(doc.title), doc.pinyin, `${spelledColumn(doc.title, true)} ${doc.initials}`.trim(), indexColumn(doc.category), indexColumn(doc.synopsis)] }
  ];
  async function saveState(revision: number, docs: number): Promise<void> {
    state = { revision, docs, indexedAt: now() };
    await sqlite.executeSet(SEARCH_DATABASE, [{ statement: STATE_UPSERT, values: [revision, docs, state.indexedAt] }], true);
  }
  const countDocs = async (): Promise<number> => numOf((await sqlite.queryResult<{ total?: number }>(SEARCH_DATABASE, COUNT_SELECT, []))[0]?.total);
  /** 只认 DDL 能解释的行：id 为空的污染数据一律丢弃，而不是当成一条命中。 */
  async function rowsOf(sql: string, values: SqliteValue[]): Promise<LocalSearchDoc[]> {
    const rows = await sqlite.queryResult<Record<string, unknown>>(SEARCH_DATABASE, sql, values);
    return rows.map((row): LocalSearchDoc | null => (textOf(row.content_id) === '' ? null : {
      content_id: textOf(row.content_id), doc_id: numOf(row.doc_id), title: textOf(row.title), pinyin: textOf(row.pinyin),
      initials: textOf(row.initials), category: textOf(row.category), synopsis: textOf(row.synopsis)
    })).filter((doc): doc is LocalSearchDoc => doc !== null);
  }
  /** 先按 rowid 摘掉同一文档的旧 FTS 行与文档行，再写新行：重放同一个 upsert 既不会翻倍也不会残留。 */
  async function replaceStatements(dropIds: readonly string[], docs: LocalSearchDoc[]): Promise<SqliteStatement[]> {
    const ids = [...new Set([...dropIds, ...docs.map((doc) => doc.content_id)])];
    if (ids.length === 0) return [];
    const held = await sqlite.queryResult<{ doc_id?: number }>(SEARCH_DATABASE, inList(DOC_ID_BY_IDS, ids.length), [...ids]);
    const doomed = held.map((row): SqliteStatement => ({ statement: FTS_DROP, values: [numOf(row.doc_id)] }));
    return [...doomed, { statement: inList(DOC_DELETE_BY_IDS, ids.length), values: [...ids] }, ...docs.flatMap(statementsOf)];
  }
  /** 快照整体替换＝重建（§A-6.2）：同修订同条目数直接跳过，冷启动才真的需要重跑一次。 */
  async function rebuild(feed: SnapshotFeed): Promise<IndexReport> {
    const docs = admitted(feed.items);
    const rejected = feed.items.length - docs.length;
    if (state.revision === feed.revision && state.docs === docs.length) return { ...EMPTY_REPORT, rejected, revision: feed.revision, skipped: true };
    await sqlite.executeSet(SEARCH_DATABASE, [{ statement: FTS_CLEAR, values: [] }, { statement: DOC_CLEAR, values: [] }], true);
    const rows = docs.map((item, index) => docOf(item, index + 1));
    nextDocId = rows.length + 1;
    for (let start = 0; start < rows.length; start += WRITE_CHUNK) await sqlite.executeSet(SEARCH_DATABASE, rows.slice(start, start + WRITE_CHUNK).flatMap(statementsOf), true);
    await saveState(feed.revision, rows.length);
    return { ...EMPTY_REPORT, indexed: rows.length, rejected, revision: feed.revision, replaced: true };
  }
  /** 增量批次只碰这批条目：下架墓碑走删除，改写走幂等替换，其余索引行原样留着。 */
  async function applyChanges(changes: readonly CatalogChange[], revision: number, discovery = false): Promise<IndexReport> {
    if (!discovery && state.revision === revision) return { ...EMPTY_REPORT, revision, skipped: true };
    const docs = admitted(changes.filter((change) => change.operation === 'upsert').map((change) => change.item));
    const doomed = [...new Set(changes.filter((change) => change.operation === 'delete').map((change) => change.contentId))];
    const set = await replaceStatements(doomed, docs.map((item, index) => docOf(item, nextDocId + index)));
    nextDocId += docs.length;
    if (set.length > 0) await sqlite.executeSet(SEARCH_DATABASE, set, true);
    await saveState(revision, await countDocs());
    return { ...EMPTY_REPORT, indexed: docs.length, removed: doomed.length, rejected: changes.length - docs.length - doomed.length, revision };
  }
  async function sync(feed: SnapshotFeed): Promise<IndexReport> {
    const job = pending.then(async (): Promise<IndexReport> => {
      try {
        await ensureReady();
        if (feed.discoveries !== undefined) return await applyChanges(feed.discoveries.map((item) => ({ operation: 'upsert', contentId: item.id, item, revision: state.revision })), state.revision, true);
        return feed.changes === undefined ? await rebuild(feed) : await applyChanges(feed.changes, feed.revision, feed.discovery === true);
      } catch (error) {
        ready = false; failure = describeError(error);
        return { ...EMPTY_REPORT, revision: feed.revision, error: failure };
      }
    });
    pending = job.catch(() => undefined);
    return job;
  }
  async function search(query: string, limit = SEARCH_RESULT_LIMIT): Promise<SearchHit[]> {
    const asked = normalizeQuery(query);
    if (asked === '' || asked.length > QUERY_MAX_CHARS) return [];
    await pending.catch(() => undefined); // 等上一批落地，避免读到半截索引。
    try {
      await ensureReady();
    } catch {
      return []; // 本机没有可用 SQLite：空结果 + status() 里的实话，视图据此回落云端而不是冒充空目录。
    }
    const cap = Math.min(state.docs, Math.max(1, Math.floor(limit) || SEARCH_RESULT_LIMIT));
    const recallLimit = Math.min(state.docs, Math.max(RECALL_LIMIT, cap * 4));
    const terms = indexTokens(asked);
    const expression = matchExpression(terms);
    const latin = terms.every((term) => !isCjk(term));
    const hits: SearchHit[] = [];
    const seen = new Set<string>();
    const take = (matchType: MatchType, docs: LocalSearchDoc[]): void => {
      for (const doc of docs) {
        if (hits.length >= cap) return;
        if (seen.has(doc.content_id)) continue;
        seen.add(doc.content_id);
        hits.push({ contentId: doc.content_id, matchType, title: doc.title, category: doc.category, initials: doc.initials });
        if (hits.length >= cap) return;
      }
    };
    take('exact', await rowsOf(EXACT_SELECT, [asked]));
    take('exact', await rowsOf(PREFIX_SELECT, [asked, asked]));
    if (expression === null) return hits;
    for (const stage of FTS_STAGES) {
      if (hits.length >= cap) break;
      if (stage.latinOnly === true && (!latin || asked.replace(/\s+/g, '').length < 2)) continue;
      const recalled = await sqlite.queryResult<{ content_id?: string }>(SEARCH_DATABASE, RECALL_SELECT, [`${stage.column}: ${expression}`, recallLimit]);
      const ids = recalled.map((row) => textOf(row.content_id)).filter((id) => id !== '' && !seen.has(id));
      if (ids.length === 0) continue;
      const byId = new Map((await rowsOf(inList(DOC_BY_IDS, ids.length), [...ids])).map((doc) => [doc.content_id, doc]));
      // 召回不等于命中：逐条按原文覆盖校验，顺序仍沿 bm25 召回序，同一查询每次给出的次序才是一致的。
      take(stage.matchType, ids.map((id) => byId.get(id)).filter((doc): doc is LocalSearchDoc => doc !== undefined && covers(asked, String(doc[stage.column]))));
    }
    return hits;
  }
  /** 清缓存即清索引：本机 SQLite 不可用时只归零内存态，绝不让【清理缓存】因此失败。 */
  function clear(): Promise<void> {
    const job = pending.then(async () => {
      try {
        await ensureReady();
        await sqlite.executeSet(SEARCH_DATABASE, [{ statement: FTS_CLEAR, values: [] }, { statement: DOC_CLEAR, values: [] }, { statement: STATE_UPSERT, values: [0, 0, now()] }], true);
      } catch {
        ready = false;
      }
      state = { revision: 0, docs: 0, indexedAt: 0 };
      nextDocId = 1;
    });
    pending = job.catch(() => undefined);
    return job;
  }
  async function close(): Promise<void> {
    if (!ready) return;
    await sqlite.close(SEARCH_DATABASE); ready = false;
  }
  return { init: ensureReady, status: (): SearchIndexStatus => ({ available: ready && failure === null, docs: state.docs, revision: state.revision, indexedAt: state.indexedAt, error: failure }), sync, search, clear, close };
}
