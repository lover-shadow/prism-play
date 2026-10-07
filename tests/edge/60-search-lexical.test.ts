import { describe, expect, it } from 'vitest';
import { indexTokenColumn } from '../../edge/src/core/tokens';
import { handleSearch } from '../../edge/src/routes/search';
import { MATCH_TYPES, type ErrorResponse, type MatchType, type SearchResponse } from '../../edge/src/types/api';
import { seedContent, seedStandardChannels } from '../support/seed';
import { seedPublishedWork, seedSearchRow } from '../support/seed-catalog';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';

/**
 * AC-16 / SPEC §12.1 item 2: the fixed query set (精确标题、拼音首字母、中文单字与双字、错字、题材、
 * 私密与撤片) run against `/api/search`. The corpus is deliberately adversarial: two works share one
 * title, one work is private, one is unpublished yet still present in the FTS table.
 */
const LONGWANG = '战神之龙王归来';

async function catalog(): Promise<PrismTestEnv> {
  const env = await createTestEnv();
  seedStandardChannels(env.db);
  // `content_aliases` is the only place pinyin lives, so the work-name pinyin rides on a title alias.
  seedPublishedWork(env.db, {
    id: 'd_longwang',
    title: LONGWANG,
    category: '战神',
    episodes: 3,
    aliases: [
      { alias: LONGWANG, pinyin: 'zhan shen zhi long wang gui lai', pinyinInitials: 'zsldlgl' },
      { alias: '龙王归来', pinyin: 'long wang gui lai', pinyinInitials: 'lwggl' }
    ],
    tags: ['战神', '逆袭', '热血']
  });
  seedPublishedWork(env.db, { id: 'm_longwang', channelId: 'movie', title: LONGWANG, category: '战神', tags: ['悬疑'] }, TEST_BASE_TIME_SECONDS + 60);
  seedPublishedWork(env.db, { id: 'd_sweet', title: '甜宠小娘子', category: '甜宠', tags: ['甜宠', '古装'] }, TEST_BASE_TIME_SECONDS + 120);
  seedPublishedWork(env.db, { id: 'd_urban', title: '都市逆袭之赘婿', category: '都市', tags: ['都市', '逆袭', '战神'] }, TEST_BASE_TIME_SECONDS + 180);
  // A private work: no change row and no index row by construction (SPEC §6 私密不进入公开 FTS).
  seedPublishedWork(env.db, { id: 'p_secret', channelId: 'private', isPrivate: 1, shareable: 0, title: '深夜私语的秘密', category: '热门推荐' });
  // Unpublished but still indexed: only the `content_items` predicate can hide this one.
  seedContent(env.db, { id: 'd_draft', channelId: 'drama', title: '龙之试炼场', category: '热血', enabled: 0 });
  seedSearchRow(env.db, { contentId: 'd_draft', title: '龙之试炼场', tags: ['热血'] });
  return env;
}

function searchRequest(query: string, extra = ''): Request {
  return new Request(`http://localhost:8787/api/search?q=${encodeURIComponent(query)}${extra}`);
}

async function search(env: PrismTestEnv, query: string, extra = ''): Promise<{ response: Response; text: string; body: SearchResponse }> {
  const response = await handleSearch(searchRequest(query, extra), env, env.clock);
  const text = await response.text();
  // A 400 from this endpoint carries no body at all, so parsing has to stay conditional.
  return { response, text, body: text === '' ? { items: [], page: 0 } : (JSON.parse(text) as SearchResponse) };
}

function idsOf(body: SearchResponse): string[] {
  return body.items.map((entry) => entry.item.id);
}

function matchTypeOf(body: SearchResponse, contentId: string): MatchType | undefined {
  return body.items.find((entry) => entry.item.id === contentId)?.matchType;
}

async function statusAndError(env: PrismTestEnv, query: string, extra = ''): Promise<{ status: number; body: ErrorResponse; text: string }> {
  const response = await handleSearch(searchRequest(query, extra), env, env.clock);
  const text = await response.text();
  const body = (text === '' ? { success: false, code: '', message: '' } : JSON.parse(text)) as ErrorResponse;
  return { status: response.status, body, text };
}

describe('GET /api/search — SPEC §12.1 fixed query set', () => {
  it('a single Han character hits through the pre-generated grams', async () => {
    const { body, response } = await search(await catalog(), '战');
    expect(response.status).toBe(200);
    expect(idsOf(body)).toContain('d_longwang');
    expect(matchTypeOf(body, 'd_longwang')).toBe('exact');
    expect(matchTypeOf(body, 'm_longwang')).toBe('exact');
    expect(matchTypeOf(body, 'd_urban')).toBe('related');
  });

  it('a two-character query hits the same works', async () => {
    const { body } = await search(await catalog(), '战神');
    expect(matchTypeOf(body, 'd_longwang')).toBe('exact');
    expect(matchTypeOf(body, 'd_urban')).toBe('related');
  });

  it('the full title is an exact hit and keeps same-title-different-work rows apart', async () => {
    const { body } = await search(await catalog(), LONGWANG);
    expect(matchTypeOf(body, 'd_longwang')).toBe('exact');
    expect(matchTypeOf(body, 'm_longwang')).toBe('exact');
    expect(new Set(idsOf(body)).size).toBe(idsOf(body).length);
    expect(body.items.find((entry) => entry.item.id === 'd_longwang')?.item.episodeCount).toBe(3);
  });

  it('a title substring takes priority over the same alias', async () => {
    const { body } = await search(await catalog(), '龙王归来');
    expect(matchTypeOf(body, 'd_longwang')).toBe('exact');
    expect(matchTypeOf(body, 'm_longwang')).toBe('exact');
  });

  it('pinyin initials and full pinyin both report `pinyin`', async () => {
    const initials = await search(await catalog(), 'zsldlgl');
    expect(matchTypeOf(initials.body, 'd_longwang')).toBe('pinyin');
    const full = await search(await catalog(), 'zhan shen zhi long wang gui lai');
    expect(matchTypeOf(full.body, 'd_longwang')).toBe('pinyin');
    const partial = await search(await catalog(), 'long wang');
    expect(matchTypeOf(partial.body, 'd_longwang')).toBe('pinyin');
  });

  it('a tag or category query returns the same-topic works', async () => {
    const { body } = await search(await catalog(), '逆袭');
    // 「逆袭」 is a tag of 战神之龙王归来 but a real substring of 都市逆袭之赘婿's name.
    expect(matchTypeOf(body, 'd_longwang')).toBe('related');
    expect(matchTypeOf(body, 'd_urban')).toBe('exact');
    expect(matchTypeOf(body, 'd_sweet')).toBeUndefined();
  });

  it('an unmatched query answers 200 with an empty page instead of an error', async () => {
    const { body, response } = await search(await catalog(), '火星殖民地');
    expect(response.status).toBe(200);
    expect(body).toEqual({ items: [], page: 1 });
  });
});

describe('GET /api/search — dedupe, ordering and filters', () => {
  it('a work matching two stages appears once, with the better matchType', async () => {
    const { body } = await search(await catalog(), '战神');
    const hits = body.items.filter((entry) => entry.item.id === 'd_longwang');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.matchType).toBe('exact');
  });

  it('the `channel` filter narrows to one public channel', async () => {
    const movie = await search(await catalog(), '战神', '&channel=movie');
    expect(idsOf(movie.body)).toEqual(['m_longwang']);
    const drama = await search(await catalog(), '战神', '&channel=drama');
    expect(idsOf(drama.body).sort()).toEqual(['d_longwang', 'd_urban']);
  });

  it('the `tag` filter is exact vocabulary matching, not a full-text match', async () => {
    const tagged = await search(await catalog(), '逆袭', '&tag=都市');
    expect(idsOf(tagged.body)).toEqual(['d_urban']);
    const untagged = await search(await catalog(), '战神', '&tag=不存在标签');
    expect(untagged.body.items).toEqual([]);
  });

  it('`channel=private` does not exist here, even though the node exists in D1', async () => {
    const denied = await statusAndError(await catalog(), '战神', '&channel=private');
    expect(denied.status).toBe(404);
    expect(denied.body.code).toBe('NOT_FOUND');
    expect(denied.text).not.toContain('个人探索');
    expect(denied.text.toLowerCase()).not.toContain('private');
  });

  it('an unknown channel id answers the same 404, so the filter is not an enumeration oracle', async () => {
    const env = await catalog();
    const unknown = await statusAndError(env, '战神', '&channel=not-a-channel');
    const privateChannel = await statusAndError(env, '战神', '&channel=private');
    expect(unknown.status).toBe(404);
    expect(unknown.text).toBe(privateChannel.text);
  });

  it('pages are deterministic inside a stage and the pageSize ceiling is 20', async () => {
    const env = await catalog();
    for (let index = 0; index < 25; index += 1) {
      const id = `d_edge${String(index).padStart(2, '0')}`;
      seedContent(env.db, { id, channelId: 'drama', title: `边缘用例第${index}部`, category: '都市' }, TEST_BASE_TIME_SECONDS + index);
      seedSearchRow(env.db, { contentId: id, title: `边缘用例第${index}部` });
    }
    const first = await search(env, '边缘', '&pageSize=100');
    expect(first.body.items).toHaveLength(20);
    expect(first.body.page).toBe(1);
    const second = await search(env, '边缘', '&page=2&pageSize=100');
    expect(second.body.items).toHaveLength(5);
    const overlap = idsOf(first.body).filter((id) => idsOf(second.body).includes(id));
    expect(overlap).toEqual([]);
  });
});

describe('GET /api/search — validation boundaries', () => {
  it('1 and 80 characters are accepted, 81 and empty are rejected with 400', async () => {
    const env = await catalog();
    expect((await search(env, '战')).response.status).toBe(200);
    expect((await search(env, '测'.repeat(80))).response.status).toBe(200);
    const tooLong = await statusAndError(env, '测'.repeat(81));
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe('VALIDATION_ERROR');
  });

  it('missing, empty and whitespace-only q all answer 400 with no body', async () => {
    const env = await catalog();
    for (const url of ['http://localhost:8787/api/search', 'http://localhost:8787/api/search?q=', 'http://localhost:8787/api/search?q=%20%20']) {
      const response = await handleSearch(new Request(url), env, env.clock);
      expect(response.status).toBe(400);
      expect(JSON.parse(await response.text())).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
    }
  });

  it('page and pageSize must be positive integers', async () => {
    const env = await catalog();
    expect((await search(env, '战神', '&page=0')).response.status).toBe(400);
    expect((await search(env, '战神', '&pageSize=-1')).response.status).toBe(400);
    expect((await search(env, '战神', '&page=abc')).response.status).toBe(400);
  });

  it('a match expression cannot escape its quotes into FTS5 syntax', async () => {
    const env = await catalog();
    const hostile = await search(env, '战神" OR "深夜');
    expect(hostile.response.status).toBe(200);
    expect(hostile.body.items).toEqual([]);
    expect(env.db.count('public_search_fts')).toBe(5);
  });
});

describe('GET /api/search — D1 is the authority, the index is not', () => {
  it('an unpublished work never surfaces, even with a live index row', async () => {
    const env = await catalog();
    const title = await search(env, '龙之试炼场');
    expect(title.body.items).toEqual([]);
    const partial = await search(env, '龙');
    expect(idsOf(partial.body)).not.toContain('d_draft');
    expect(env.db.selectOne('SELECT COUNT(*) AS n FROM public_search_fts WHERE content_id = ?', 'd_draft')?.n).toBe(1);
  });

  it('flipping `enabled` removes the work from the next request without touching the index', async () => {
    const env = await catalog();
    expect(idsOf((await search(env, '都市')).body)).toContain('d_urban');
    env.db.execute('UPDATE content_items SET enabled = 0 WHERE id = ?', 'd_urban');
    expect(idsOf((await search(env, '都市')).body)).not.toContain('d_urban');
  });

  it('a work flipped to private disappears too, and the filter is not the only fence', async () => {
    const env = await catalog();
    expect(idsOf((await search(env, '战神')).body)).toContain('m_longwang');
    env.db.execute("UPDATE content_items SET is_private = 1, shareable = 0, channel_id = 'private' WHERE id = ?", 'm_longwang');
    expect(idsOf((await search(env, '战神')).body)).not.toContain('m_longwang');
  });

  it('a private work is absent from every response body, including its own id and title', async () => {
    const env = await catalog();
    // Force the worst case: a stray index row for a private work. The SQL fences must still hide it.
    seedSearchRow(env.db, { contentId: 'p_secret', title: '深夜私语的秘密', tags: ['热门'] });
    for (const query of ['深夜', '深夜私语的秘密', '私语', '热门', 'zhe n ye']) {
      const { text, body } = await search(env, query);
      expect(idsOf(body)).not.toContain('p_secret');
      expect(text).not.toContain('p_secret');
      expect(text).not.toContain('深夜');
    }
    const leaked = env.db.selectOne(
      'SELECT COUNT(*) AS n FROM public_search_fts f JOIN content_items c ON c.id = f.content_id WHERE c.is_private = 1 OR c.channel_id = ?',
      'private'
    );
    expect(leaked?.n).toBe(1);
    const hidden = await search(env, '深夜', '&channel=private');
    expect(hidden.response.status).toBe(404);
  });

  it('the token column really is gram-expanded, which is why a single character matches', async () => {
    expect(indexTokenColumn(LONGWANG).split(' ')).toContain('战');
    expect(indexTokenColumn(LONGWANG).split(' ')).toContain('战神');
  });

  it('M-5 tripwire: no response ever reports a match class outside the closed lexical set', async () => {
    const env = await catalog();
    for (const query of ['战', '战神', 'zsldlgl', '龙王归来', '边缘']) {
      const { text, body } = await search(env, query);
      for (const entry of body.items) expect(MATCH_TYPES).toContain(entry.matchType);
      expect(text.toLowerCase().split(/[^a-z0-9]+/)).not.toContain('semantic');
    }
  });
});
