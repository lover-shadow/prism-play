import { describe, expect, it } from 'vitest';
import { handleSearchSuggestions } from '../../edge/src/routes/search-suggestions';
import { SEARCH_SUGGESTION_TYPES, type SearchSuggestion, type SuggestionsResponse } from '../../edge/src/types/api';
import { seedContent, seedStandardChannels } from '../support/seed';
import { seedPublishedWork, seedSearchRow } from '../support/seed-catalog';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';

/** Same adversarial corpus as the search suite: 4 public works, one private, one unpublished-but-indexed. */
const LONGWANG = '战神之龙王归来';

async function catalog(): Promise<PrismTestEnv> {
  const env = await createTestEnv();
  seedStandardChannels(env.db);
  seedPublishedWork(env.db, {
    id: 'd_longwang',
    title: LONGWANG,
    category: '战神',
    episodes: 2,
    aliases: [
      { alias: LONGWANG, pinyin: 'zhan shen zhi long wang gui lai', pinyinInitials: 'zsldlgl' },
      { alias: '龙王归来', pinyin: 'long wang gui lai', pinyinInitials: 'lwggl' }
    ],
    tags: ['战神', '逆袭', '热血']
  });
  seedPublishedWork(env.db, { id: 'm_longwang', channelId: 'movie', title: LONGWANG, category: '战神', tags: ['悬疑'] }, TEST_BASE_TIME_SECONDS + 60);
  seedPublishedWork(env.db, { id: 'd_sweet', title: '甜宠小娘子', category: '甜宠', tags: ['甜宠', '古装'] }, TEST_BASE_TIME_SECONDS + 120);
  seedPublishedWork(env.db, { id: 'd_urban', title: '都市逆袭之赘婿', category: '都市', tags: ['都市', '逆袭', '战神'] }, TEST_BASE_TIME_SECONDS + 180);
  seedPublishedWork(env.db, { id: 'p_secret', channelId: 'private', isPrivate: 1, shareable: 0, title: '深夜私语的秘密', category: '热门推荐' });
  seedContent(env.db, { id: 'd_draft', channelId: 'drama', title: '龙之试炼场', category: '热血', enabled: 0 });
  seedSearchRow(env.db, { contentId: 'd_draft', title: '龙之试炼场', tags: ['热血'] });
  return env;
}

interface SuggestionOutcome {
  status: number;
  text: string;
  body: SuggestionsResponse;
}

async function suggest(env: PrismTestEnv, query: string): Promise<SuggestionOutcome> {
  const response = await handleSearchSuggestions(
    new Request(`http://localhost:8787/api/search/suggestions?q=${encodeURIComponent(query)}`),
    env,
    env.clock
  );
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as SuggestionsResponse };
}

function typesOf(body: SuggestionsResponse): string[] {
  return body.suggestions.map((entry) => entry.type);
}

function find(body: SuggestionsResponse, type: string): SearchSuggestion | undefined {
  return body.suggestions.find((entry) => entry.type === type);
}

describe('GET /api/search/suggestions — contract shape', () => {
  it('answers {query, suggestions} with at most ten lexical candidates', async () => {
    const outcome = await suggest(await catalog(), '战');
    expect(outcome.status).toBe(200);
    expect(Object.keys(outcome.body).sort()).toEqual(['query', 'suggestions']);
    expect(outcome.body.query).toBe('战');
    expect(outcome.body.suggestions.length).toBeLessThanOrEqual(10);
    for (const entry of outcome.body.suggestions) expect(SEARCH_SUGGESTION_TYPES).toContain(entry.type);
  });

  it('work-level candidates carry a contentId, vocabulary candidates never do', async () => {
    const sweet = await suggest(await catalog(), '甜');
    expect(find(sweet.body, 'title')).toEqual({ text: '甜宠小娘子', type: 'title', contentId: 'd_sweet' });
    const vocabulary = find((await suggest(await catalog(), '战')).body, 'category');
    expect(vocabulary?.text).toBe('战神');
    expect(vocabulary?.contentId).toBeUndefined();
  });

  it('the same text is never offered twice', async () => {
    const outcome = await suggest(await catalog(), '战神');
    const keys = outcome.body.suggestions.map((entry) => entry.text.replace(/\s+/g, '').toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('GET /api/search/suggestions — prefix stages in contract order', () => {
  it('a shared title is offered once, and without an id that would pick a work (AC-16 同名异剧)', async () => {
    const outcome = await suggest(await catalog(), '战神');
    expect(outcome.body.suggestions[0]).toEqual({ text: LONGWANG, type: 'title' });
    expect(outcome.body.suggestions.filter((entry) => entry.type === 'title')).toHaveLength(1);
    expect(typesOf(outcome.body)).toContain('category');
  });

  it('full pinyin and initials both complete through the pinyin stage', async () => {
    const syllables = await suggest(await catalog(), 'zhan');
    expect(find(syllables.body, 'pinyin')?.text).toBe('zhan shen zhi long wang gui lai');
    expect(find(syllables.body, 'pinyin')?.contentId).toBe('d_longwang');
    const initials = await suggest(await catalog(), 'zsl');
    expect(find(initials.body, 'pinyin')?.text).toBe('zsldlgl');
  });

  it('an alias that literally starts with the query is offered as `alias`', async () => {
    const outcome = await suggest(await catalog(), '龙王');
    expect(find(outcome.body, 'alias')?.text).toBe('龙王归来');
    expect(find(outcome.body, 'alias')?.contentId).toBe('d_longwang');
    // The name stage still wins the list, and its text contains rather than prefixes the query.
    expect(outcome.body.suggestions[0]?.type).toBe('title');
  });

  it('a typo query offers the bounded correction candidate', async () => {
    const shared = await suggest(await catalog(), '战神之龙望归来');
    expect(shared.body.suggestions).toHaveLength(1);
    expect(shared.body.suggestions[0]).toEqual({ text: LONGWANG, type: 'correction' });
    // Same rule one step away: the corrected text maps to two works, so no id is claimed.
    const unique = await suggest(await catalog(), '甜宠小娘字');
    expect(unique.body.suggestions[0]).toEqual({ text: '甜宠小娘子', type: 'correction', contentId: 'd_sweet' });
  });

  it('ten rows is the hard ceiling', async () => {
    const env = await catalog();
    for (let index = 0; index < 25; index += 1) {
      const id = `d_edge${String(index).padStart(2, '0')}`;
      seedContent(env.db, { id, channelId: 'drama', title: `边缘用例第${index}部`, category: '都市' }, TEST_BASE_TIME_SECONDS + index);
      seedSearchRow(env.db, { contentId: id, title: `边缘用例第${index}部` });
    }
    const outcome = await suggest(env, '边缘');
    expect(outcome.body.suggestions).toHaveLength(10);
  });
});

describe('GET /api/search/suggestions — invisible content is not completable', () => {
  it('a private work never appears, not even as a full-title query', async () => {
    const env = await catalog();
    for (const query of ['深夜', '深夜私语的秘密', '私语', '热门推荐']) {
      const outcome = await suggest(env, query);
      // `{query}` echoes what was typed, so the leak check runs on the candidate list only.
      expect(outcome.body.suggestions).toEqual([]);
      expect(JSON.stringify(outcome.body.suggestions)).not.toContain('深夜');
      expect(outcome.text).not.toContain('p_secret');
    }
  });

  it('an unpublished work is absent while its index row is still in the table', async () => {
    const env = await catalog();
    const outcome = await suggest(env, '龙之试炼场');
    expect(outcome.body.suggestions).toEqual([]);
    expect(outcome.text).not.toContain('d_draft');
    expect(env.db.selectOne('SELECT COUNT(*) AS n FROM public_search_fts WHERE content_id = ?', 'd_draft')?.n).toBe(1);
  });

  it('flipping a live work to unpublished removes it from the next completion', async () => {
    const env = await catalog();
    expect((await suggest(env, '都市')).text).toContain('都市逆袭之赘婿');
    env.db.execute('UPDATE content_items SET enabled = 0 WHERE id = ?', 'd_urban');
    expect((await suggest(env, '都市')).text).not.toContain('都市逆袭之赘婿');
  });

  it('a vocabulary-only query still cannot reach the private channel through tags', async () => {
    const outcome = await suggest(await catalog(), '热门');
    expect(outcome.body.suggestions).toEqual([]);
  });
});

describe('GET /api/search/suggestions — input bounds and the M-5 tripwire', () => {
  it('missing, empty and over-long q are 400 with the closed-set code', async () => {
    const env = await catalog();
    const urls = [
      'http://localhost:8787/api/search/suggestions',
      'http://localhost:8787/api/search/suggestions?q=',
      'http://localhost:8787/api/search/suggestions?q=%09',
      `http://localhost:8787/api/search/suggestions?q=${encodeURIComponent('测'.repeat(81))}`
    ];
    for (const url of urls) {
      const response = await handleSearchSuggestions(new Request(url), env, env.clock);
      expect(response.status).toBe(400);
      expect(JSON.parse(await response.text())).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
    }
    expect((await suggest(env, '测'.repeat(80))).status).toBe(200);
  });

  it('no suggestion response ever names a model class', async () => {
    const env = await catalog();
    // Built by concatenation so this file cannot itself trip the M-5 static scan.
    const banned = ['semantic', 'ai', 'embed' + 'ding', 'vec' + 'torize'];
    for (const query of ['战', 'zsldlgl', '龙王', '战神之龙望归来', '边缘']) {
      const outcome = await suggest(env, query);
      const tokens = outcome.text.toLowerCase().split(/[^a-z0-9]+/);
      for (const term of banned) expect(tokens).not.toContain(term);
    }
  });
});
