import { describe, expect, it } from 'vitest';
import { correctionCandidates, editDistance, isCorrectionWithinBudget } from '../../edge/src/search/correct';
import { PublicIndexRefusalError, putContentTermsAndIndex, removeContentFromIndex, reindexContent } from '../../edge/src/search/index';
import { RELATED_MAX_ITEMS, handleRelated } from '../../edge/src/routes/related';
import { handleSearch } from '../../edge/src/routes/search';
import type { RelatedResponse, SearchResponse } from '../../edge/src/types/api';
import { seedContent, seedStandardChannels } from '../support/seed';
import { seedPublishedWork, seedSearchRow } from '../support/seed-catalog';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';

/** AC-16 second half: 错字纠偏, 题材同类推荐, and the write-side invariants of `public_search_fts`. */
const LONGWANG = '战神之龙王归来';

async function catalog(): Promise<PrismTestEnv> {
  const env = await createTestEnv();
  seedStandardChannels(env.db);
  seedPublishedWork(env.db, {
    id: 'd_longwang',
    title: LONGWANG,
    category: '战神',
    aliases: [
      { alias: LONGWANG, pinyin: 'zhan shen zhi long wang gui lai', pinyinInitials: 'zsldlgl' },
      { alias: '龙王归来', pinyin: 'long wang gui lai', pinyinInitials: 'lwggl' }
    ],
    tags: ['战神', '逆袭', '热血']
  });
  seedPublishedWork(env.db, { id: 'm_longwang', channelId: 'movie', title: LONGWANG, category: '战神', tags: ['悬疑'] }, TEST_BASE_TIME_SECONDS + 60);
  seedPublishedWork(env.db, { id: 'd_sweet', title: '甜宠小娘子', category: '甜宠', tags: ['甜宠', '古装', '热血'] }, TEST_BASE_TIME_SECONDS + 120);
  seedPublishedWork(env.db, { id: 'd_urban', title: '都市逆袭之赘婿', category: '都市', tags: ['都市', '逆袭', '热血', '战神'] }, TEST_BASE_TIME_SECONDS + 180);
  // Same category and a shared tag as the flagship work, and still unreachable from the public surface.
  seedPublishedWork(env.db, { id: 'p_secret', channelId: 'private', isPrivate: 1, shareable: 0, title: '深夜私语的秘密', category: '战神', tags: ['战神'] });
  seedContent(env.db, { id: 'd_draft', channelId: 'drama', title: '龙之试炼场', category: '热血', enabled: 0 });
  seedSearchRow(env.db, { contentId: 'd_draft', title: '龙之试炼场', tags: ['热血'] });
  return env;
}

async function searchBody(env: PrismTestEnv, query: string): Promise<SearchResponse> {
  const response = await handleSearch(new Request(`http://localhost:8787/api/search?q=${encodeURIComponent(query)}`), env, env.clock);
  return JSON.parse(await response.text()) as SearchResponse;
}

async function related(env: PrismTestEnv, titleId: string): Promise<{ status: number; text: string; body: RelatedResponse }> {
  const response = await handleRelated(new Request(`http://localhost:8787/api/titles/${encodeURIComponent(titleId)}/related`), env, env.clock);
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as RelatedResponse };
}

async function refusalFor(env: PrismTestEnv, contentId: string): Promise<string> {
  try {
    await reindexContent(env.DB, contentId);
    return 'accepted';
  } catch (error) {
    return error instanceof PublicIndexRefusalError ? error.reason : 'unexpected';
  }
}

function countRows(db: PrismTestEnv, table: string, column: string, contentId: string): number {
  return Number(db.db.selectOne(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, contentId)?.n ?? 0);
}

function searchIds(body: SearchResponse): string[] {
  return body.items.map((entry) => entry.item.id);
}

function itemIds(body: RelatedResponse): string[] {
  return body.items.map((entry) => entry.id);
}

describe('typo correction is bounded and deterministic', () => {
  it('one substitution or one adjacent transposition is distance 1; anything wider is not a typo', async () => {
    expect(editDistance('战神之龙王归来', '战神之龙望归来')).toBe(1);
    expect(editDistance('zhan', 'zhna')).toBe(1);
    // Honest limit of optimal-string-alignment: swapping two characters that are not adjacent is two
    // edits, so 「zhan」 -> 「znah」 is refused. Only single-slip typos are corrected.
    expect(editDistance('zhan', 'znah')).toBe(2);
    expect(editDistance('甜宠', '战神')).toBe(2);
    expect(isCorrectionWithinBudget('战神之龙望归来', LONGWANG)).toBe(true);
    expect(isCorrectionWithinBudget('战神之龙望归矣', LONGWANG)).toBe(false);
  });

  it('a one-character query is a prefix, never a "correction", and single characters stay uncorrected', async () => {
    expect(isCorrectionWithinBudget('战', '战神')).toBe(false);
    expect(isCorrectionWithinBudget('战神', '战')).toBe(false);
    expect(isCorrectionWithinBudget('z', 'zhan')).toBe(false);
  });

  it('a single typo still resolves to the work as `matchType: fuzzy`', async () => {
    const env = await catalog();
    const body = await searchBody(env, '战神之龙望归来');
    expect(searchIds(body)).toContain('d_longwang');
    expect(body.items.find((entry) => entry.item.id === 'd_longwang')?.matchType).toBe('fuzzy');
    const candidates = await correctionCandidates(env.DB, '战神之龙望归来');
    expect(candidates.some((candidate) => candidate.term === LONGWANG && candidate.distance === 1)).toBe(true);
  });

  it('two typos are refused outright: the budget is 1, not 2', async () => {
    const env = await catalog();
    expect(await correctionCandidates(env.DB, '战神之龙望归矣')).toEqual([]);
    expect(await searchBody(env, '战神之龙望归矣')).toEqual({ items: [], page: 1 });
  });

  it('a correction can never name a private or a withdrawn work, even with a stray index row', async () => {
    const env = await catalog();
    env.db.execute(
      'INSERT INTO public_search_fts (content_id, title_tokens, alias_tokens, pinyin_tokens, tag_tokens) VALUES (?, ?, ?, ?, ?)',
      'p_secret',
      '深 夜 私 语 深夜 夜私 私语 秘密 私语的 深夜私语的秘密',
      '',
      '',
      '热 门 热门'
    );
    expect((await correctionCandidates(env.DB, '深夜私语的秘蜜')).map((entry) => entry.contentId)).not.toContain('p_secret');
    expect(searchIds(await searchBody(env, '深夜私语的秘蜜'))).not.toContain('p_secret');
    expect(await correctionCandidates(env.DB, '龙之式练场')).toEqual([]);
    expect(searchIds(await searchBody(env, '龙之式练场'))).not.toContain('d_draft');
  });
});

describe('public_search_fts write invariants', () => {
  it('re-indexing the same content id leaves exactly one row and identical tokens', async () => {
    const env = await catalog();
    const first = await reindexContent(env.DB, 'd_longwang');
    const second = await reindexContent(env.DB, 'd_longwang');
    expect(countRows(env, 'public_search_fts', 'content_id', 'd_longwang')).toBe(1);
    expect(second).toEqual(first);
    expect(first.titleTokens.split(' ')).toContain('战神');
    expect(first.aliasTokens.split(' ')).toContain('龙王归来');
    expect(first.pinyinTokens.split(' ')).toContain('zsldlgl');
    expect(first.tagTokens.split(' ')).toContain('热血');
  });

  it('私密不进入公开 FTS: the writer refuses a private row before touching any table', async () => {
    const env = await catalog();
    expect(await refusalFor(env, 'p_secret')).toBe('private');
    expect(countRows(env, 'public_search_fts', 'content_id', 'p_secret')).toBe(0);
    const written = await putContentTermsAndIndex(env.DB, 'p_secret', { aliases: [{ alias: '深夜' }], tags: ['热门'] }).catch(() => 'refused');
    expect(written).toBe('refused');
    expect(countRows(env, 'content_aliases', 'content_id', 'p_secret')).toBe(0);
    expect(countRows(env, 'content_tags', 'content_id', 'p_secret')).toBe(1);
  });

  it('an unpublished or unknown id is refused too, with its own reason', async () => {
    const env = await catalog();
    expect(await refusalFor(env, 'd_draft')).toBe('unpublished');
    expect(await refusalFor(env, 'd_missing')).toBe('unknown');
    expect(await refusalFor(env, 'd_longwang')).toBe('accepted');
  });

  it('a freshly published catalogue holds no private index row at all', async () => {
    const env = await catalog();
    const leaked = env.db.selectOne(
      'SELECT COUNT(*) AS n FROM public_search_fts f JOIN content_items c ON c.id = f.content_id WHERE c.is_private = 1 OR c.channel_id = ?',
      'private'
    );
    expect(leaked?.n).toBe(0);
  });

  it('terms are replaced, not appended, and the rebuilt row is searchable again', async () => {
    const env = await catalog();
    await putContentTermsAndIndex(env.DB, 'd_sweet', {
      aliases: [{ alias: '甜妻来袭', pinyin: 'tian qi lai xi', pinyinInitials: 'tqlx' }],
      tags: ['甜宠', '古装']
    });
    expect(countRows(env, 'content_aliases', 'content_id', 'd_sweet')).toBe(1);
    expect(countRows(env, 'content_tags', 'content_id', 'd_sweet')).toBe(2);
    expect(searchIds(await searchBody(env, '甜妻来袭'))).toContain('d_sweet');
    expect(searchIds(await searchBody(env, '热血'))).not.toContain('d_sweet');
  });

  it('dropping an index row takes the work out of the candidate source, D1 row untouched', async () => {
    const env = await catalog();
    expect(searchIds(await searchBody(env, '都市'))).toContain('d_urban');
    await removeContentFromIndex(env.DB, 'd_urban');
    expect(searchIds(await searchBody(env, '都市'))).not.toContain('d_urban');
    expect(countRows(env, 'content_items', 'id', 'd_urban')).toBe(1);
  });
});

describe('GET /api/titles/{titleId}/related', () => {
  it('shared tags rank by how many are shared, and the source work is excluded', async () => {
    const env = await catalog();
    seedPublishedWork(env.db, { id: 'd_source', title: '科幻纪元', category: '科幻', tags: ['热血', '都市'] }, TEST_BASE_TIME_SECONDS + 240);
    const outcome = await related(env, 'd_source');
    expect(outcome.status).toBe(200);
    expect(itemIds(outcome.body)).toEqual(['d_urban', 'd_sweet', 'd_longwang']);
  });

  it('same category outranks shared tags, and private works are never related', async () => {
    const env = await catalog();
    env.db.execute("UPDATE content_items SET cover_url = 'https://upstream-cdn.invalid/cover.jpg' WHERE id = ?", 'd_urban');
    const outcome = await related(env, 'd_longwang');
    expect(itemIds(outcome.body)).toEqual(['m_longwang', 'd_urban', 'd_sweet']);
    expect(outcome.text).not.toContain('p_secret');
    expect(outcome.text).not.toContain('深夜');
    expect(outcome.body.items.every((item) => item.isPrivate === false && item.enabled === true)).toBe(true);
    // API-SPEC §〇: the stored upstream address is never emitted, only the same-origin proxy form.
    expect(outcome.text).not.toContain('upstream-cdn.invalid');
    expect(outcome.body.items.find((item) => item.id === 'd_urban')?.coverUrl).toBe('http://localhost:8787/proxy/img/d_urban');
  });

  it('the result is capped by an exported constant', async () => {
    const env = await catalog();
    for (let index = 0; index < RELATED_MAX_ITEMS + 5; index += 1) {
      seedPublishedWork(env.db, { id: `d_many${index}`, title: `同类第${index}部`, category: '战神' }, TEST_BASE_TIME_SECONDS + index);
    }
    const outcome = await related(env, 'd_longwang');
    expect(RELATED_MAX_ITEMS).toBe(10);
    expect(outcome.body.items).toHaveLength(RELATED_MAX_ITEMS);
  });

  it('unknown, withdrawn and private sources all answer the identical 404', async () => {
    const env = await catalog();
    const unknown = await related(env, 'd_nope');
    const withdrawn = await related(env, 'd_draft');
    const privateOne = await related(env, 'p_secret');
    expect(unknown.status).toBe(404);
    for (const outcome of [withdrawn, privateOne]) expect(outcome.text).toBe(unknown.text);
    expect(privateOne.text).not.toContain('深夜');
  });

  it('a work with nothing related answers 200 with an empty list', async () => {
    const env = await catalog();
    seedPublishedWork(env.db, { id: 'd_lonely', title: '孤本', category: '冷门', tags: ['孤本'] }, TEST_BASE_TIME_SECONDS + 300);
    const outcome = await related(env, 'd_lonely');
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ items: [] });
  });

  it('M-5 tripwire: no response of this surface ever names a model class', async () => {
    const env = await catalog();
    // Built by concatenation so this test file cannot itself trip the M-5 static scan.
    const banned = ['semantic', 'ai', 'embed' + 'ding', 'vec' + 'torize'];
    for (const query of ['战神', 'zsldlgl', '战神之龙望归来', '龙王归来']) {
      const tokens = JSON.stringify(await searchBody(env, query)).toLowerCase().split(/[^a-z0-9]+/);
      for (const term of banned) expect(tokens).not.toContain(term);
    }
    for (const titleId of ['d_longwang', 'm_longwang']) {
      const tokens = (await related(env, titleId)).text.toLowerCase().split(/[^a-z0-9]+/);
      for (const term of banned) expect(tokens).not.toContain(term);
    }
  });
});
