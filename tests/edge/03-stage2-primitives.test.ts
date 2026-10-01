import { describe, expect, it } from 'vitest';
import { createMediaHandleCodec } from '../../edge/src/core/media-handle';
import { indexTokenColumn, indexTokens, matchExpression } from '../../edge/src/core/tokens';
import {
  buildProxyUrl,
  episodeHandle,
  episodeIdFromHandle,
  isProxyKind,
  issueSignedProxyUrl,
  verifyProxySignature
} from '../../edge/src/core/proxy-signature';
import {
  findContentRow,
  findPlaybackCandidate,
  isPubliclyVisible,
  listAllowedUpstreamOrigins,
  listPublicContent,
  readPublicRevision
} from '../../edge/src/db/content-repo';
import { originOf, toContentItem } from '../../edge/src/http/serialize';
import { insert, seedEpisode, seedEpisodeSource, seedProvider, seedStandardChannels } from '../support/seed';
import { seedPublishedWork } from '../support/seed-catalog';
import { createTestEnv, TEST_BASE_TIME_SECONDS } from '../support/test-env';

const SECRET = '50524f58592d544553542d4b45592d30313233';

describe('FTS5 pre-tokenisation (SPEC §11 known trap)', () => {
  it('expands a Han title into single characters, adjacent bigrams and the whole run', () => {
    const tokens = indexTokens('战神之龙王归来');
    expect(tokens).toContain('战');
    expect(tokens).toContain('战神');
    expect(tokens).toContain('归来');
    expect(tokens).toContain('战神之龙王归来');
    expect(indexTokenColumn('战神之龙王归来').split(' ')).toEqual(expect.arrayContaining(['战', '神', '战神']));
  });

  it('keeps latin words whole and lowercases the run', () => {
    expect(indexTokens('Prism Play 剧场')).toEqual(expect.arrayContaining(['prism', 'play', '剧', '剧场']));
  });

  it('escapes FTS5 string literals so a query cannot inject operators', () => {
    const expression = matchExpression('战神 OR enabled');
    expect(expression).not.toBeNull();
    expect(String(expression)).toContain('"战神"');
    expect(String(expression)).not.toMatch(/\bOR enabled\b/);
    expect(matchExpression('   ')).toBeNull();
    expect(matchExpression('a"b')).toContain('"a""b"');
  });

  it('round-trips through the real FTS table: a single Han character and a bigram both hit', async () => {
    const env = await createTestEnv();
    seedStandardChannels(env.db);
    seedPublishedWork(env.db, { id: 'd_war', title: '战神之龙王归来', episodes: 1 });
    const hits = await env.DB.prepare(
      'SELECT content_id FROM public_search_fts WHERE public_search_fts MATCH ?'
    )
      .bind(matchExpression('龙王'))
      .all<{ content_id: string }>();
    expect(hits.results.map((row) => row.content_id)).toEqual(['d_war']);
  });
});

describe('proxy short-lived signatures (API-SPEC §六)', () => {
  it('accepts only an unmodified kind+handle+exp triple', async () => {
    const issued = await issueSignedProxyUrl('http://localhost:8787', SECRET, 'media', episodeHandle(10231), TEST_BASE_TIME_SECONDS, 7200);
    const url = new URL(issued.url);
    const exp = url.searchParams.get('exp');
    const sig = url.searchParams.get('sig');

    expect(await verifyProxySignature(SECRET, { kind: 'media', handle: 'e_10231', exp, sig }, TEST_BASE_TIME_SECONDS)).toBe('valid');
    expect(await verifyProxySignature(SECRET, { kind: 'media', handle: 'e_99999', exp, sig }, TEST_BASE_TIME_SECONDS)).toBe('invalid');
    expect(await verifyProxySignature(SECRET, { kind: 'img', handle: 'e_10231', exp, sig }, TEST_BASE_TIME_SECONDS)).toBe('invalid');
    expect(await verifyProxySignature(SECRET, { kind: 'media', handle: 'e_10231', exp, sig }, TEST_BASE_TIME_SECONDS + 7200)).toBe('expired');
    expect(await verifyProxySignature(SECRET, { kind: 'media', handle: 'e_10231', exp: null, sig }, TEST_BASE_TIME_SECONDS)).toBe('missing');
    expect(await verifyProxySignature(`x${SECRET}`, { kind: 'media', handle: 'e_10231', exp, sig }, TEST_BASE_TIME_SECONDS)).toBe('invalid');
  });

  it('builds same-origin URLs and parses opaque episode handles only', () => {
    expect(buildProxyUrl('https://play.prismos.org', 'img', 'd_8f31c2')).toBe('https://play.prismos.org/proxy/img/d_8f31c2');
    expect(episodeIdFromHandle(episodeHandle(42))).toBe(42);
    expect(episodeIdFromHandle('d_8f31c2')).toBeNull();
    expect(episodeIdFromHandle('e_')).toBeNull();
    expect(episodeIdFromHandle('e_9007199254740993')).toBeNull();
    expect(isProxyKind('img')).toBe(true);
    expect(isProxyKind('media;evil')).toBe(false);
  });

  it('never appends an unsigned exp/sig pair half-way', () => {
    expect(buildProxyUrl('https://play.prismos.org', 'media', 'e_1', { expSeconds: 123 })).toBe('https://play.prismos.org/proxy/media/e_1');
  });
});

describe('content catalogue access (SPEC §6 trusted directory)', () => {
  it('hides unpublished and private rows from the public listing', async () => {
    const env = await createTestEnv();
    seedStandardChannels(env.db);
    seedPublishedWork(env.db, { id: 'd_pub', title: '公开剧', episodes: 2, category: '逆袭' });
    seedPublishedWork(env.db, { id: 'd_priv', channelId: 'private', title: '私密剧', isPrivate: 1, shareable: 0 });
    insert(env.db, 'content_items', {
      id: 'd_draft',
      channel_id: 'drama',
      title: '未上架草稿',
      category: '逆袭',
      is_private: 0,
      shareable: 0,
      enabled: 0,
      created_at: TEST_BASE_TIME_SECONDS,
      updated_at: TEST_BASE_TIME_SECONDS
    });

    const page = await listPublicContent(env.DB, { channelId: 'drama', offset: 0, limit: 20 });
    expect(page.rows.map((row) => row.id)).toEqual(['d_pub']);
    expect(page.total).toBe(1);
    expect(page.rows[0]?.episode_count).toBe(2);

    const draft = await findContentRow(env.DB, 'd_draft');
    expect(draft).not.toBeNull();
    expect(isPubliclyVisible(draft as never)).toBe(false);
  });

  it('picks exactly one healthy lowest-latency source and never a disabled one', async () => {
    const env = await createTestEnv();
    seedStandardChannels(env.db);
    const { episodeIds } = seedPublishedWork(env.db, { id: 'd_play', title: '可播剧', episodes: 1 });
    seedProvider(env.db, { id: 'provider_s1', channelId: 'drama', latencyMs: 300 });
    seedProvider(env.db, { id: 'provider_s2', channelId: 'drama', latencyMs: 60 });
    seedProvider(env.db, { id: 'provider_s3', channelId: 'drama', latencyMs: 5, healthy: 0 });
    seedEpisodeSource(env.db, { episodeId: episodeIds[0] as number, providerId: 'provider_s1' });
    seedEpisodeSource(env.db, { episodeId: episodeIds[0] as number, providerId: 'provider_s3' });

    const slowest = await env.DB.prepare('SELECT id FROM content_episodes WHERE content_id = ?').bind('d_play').first<{ id: number }>();
    const candidate = await findPlaybackCandidate(env.DB, Number(slowest?.id));
    expect(candidate?.provider.id).toBe('provider_s1');
    expect(candidate?.upstreamMediaUrl).toContain('upstream.invalid');

    seedEpisodeSource(env.db, { episodeId: episodeIds[0] as number, providerId: 'provider_s2' });
    const improved = await findPlaybackCandidate(env.DB, Number(slowest?.id));
    expect(improved?.provider.id).toBe('provider_s2');

    const orphan = seedEpisode(env.db, 'd_play', 2);
    expect(await findPlaybackCandidate(env.DB, orphan)).toBeNull();
  });

  it('derives the proxy whitelist from configured providers only', async () => {
    const env = await createTestEnv();
    seedStandardChannels(env.db);
    seedProvider(env.db, { id: 'provider_s1', channelId: 'drama', upstreamUrl: 'https://upstream.invalid/catalog' });
    seedProvider(env.db, { id: 'provider_s9', channelId: 'drama', upstreamUrl: 'https://other.invalid/x', healthy: 0 });
    insert(env.db, 'source_providers', {
      id: 'provider_broken',
      name: '坏配置',
      channel_id: 'drama',
      upstream_url: 'not a url',
      priority: 9,
      latency_ms: 999,
      healthy: 1,
      last_checked_at: TEST_BASE_TIME_SECONDS,
      created_at: TEST_BASE_TIME_SECONDS,
      updated_at: TEST_BASE_TIME_SECONDS
    });
    const origins = await listAllowedUpstreamOrigins(env.DB);
    expect([...origins]).toEqual(['https://upstream.invalid']);
  });

  it('reports revision 0 on an empty change log and the newest revision otherwise', async () => {
    const env = await createTestEnv();
    seedStandardChannels(env.db);
    expect(await readPublicRevision(env.DB)).toBe(0);
    seedPublishedWork(env.db, { id: 'd_rev', title: '修订剧' });
    expect(await readPublicRevision(env.DB)).toBeGreaterThan(0);
  });

  it('maps rows onto the wire shape without null fields and never leaks the stored cover URL', () => {
    const origin = originOf(new Request('https://play.prismos.org/api/catalog'));
    expect(origin).toBe('https://play.prismos.org');
    const row = {
      id: 'd_1',
      channel_id: 'drama',
      title: '剧名示例',
      cover_url: 'https://upstream.invalid/cover.jpg',
      cover_version: null,
      synopsis: null,
      category: '逆袭',
      is_private: 0,
      shareable: 1,
      enabled: 1,
      first_published_at: TEST_BASE_TIME_SECONDS,
      updated_at: TEST_BASE_TIME_SECONDS,
      episode_count: 0
    };

    const mapped = toContentItem(row, { origin });
    expect(mapped.coverUrl).toBe('https://play.prismos.org/proxy/img/d_1');
    expect(mapped).toEqual({
      id: 'd_1',
      channelId: 'drama',
      title: '剧名示例',
      category: '逆袭',
      isPrivate: false,
      enabled: true,
      shareable: true,
      coverUrl: 'https://play.prismos.org/proxy/img/d_1',
      episodeCount: 0
    });
    expect(Object.keys(mapped)).not.toContain('synopsis');
    expect(Object.keys(mapped)).not.toContain('coverVersion');

    const signed = toContentItem(row, { origin, coverUrl: 'https://play.prismos.org/proxy/img/d_1?exp=1&sig=abc' });
    expect(signed.coverUrl).toBe('https://play.prismos.org/proxy/img/d_1?exp=1&sig=abc');

    expect(toContentItem({ ...row, cover_url: null }, { origin }).coverUrl).toBeUndefined();
  });
});

describe('sealed media handles (零上游地址暴露)', () => {
  it('round-trips an absolute target through AES-GCM without leaking it', async () => {
    const codec = await createMediaHandleCodec(SECRET);
    const handle = await codec.mint(10231, 'https://upstream.invalid/a/b/index.m3u8');
    expect(handle.startsWith('e_10231.')).toBe(true);
    expect(handle).not.toContain('upstream.invalid');
    const parsed = await codec.parse(handle);
    expect(parsed).toEqual({ episodeId: 10231, targetUrl: 'https://upstream.invalid/a/b/index.m3u8' });
  });

  it('refuses a tampered payload, a foreign key and a malformed handle identically', async () => {
    const codec = await createMediaHandleCodec(SECRET);
    const other = await createMediaHandleCodec(`x${SECRET}`);
    const handle = await codec.mint(7, 'https://upstream.invalid/seg-1.ts');

    const [, iv, sealed] = handle.split('.');
    expect(await codec.parse(`e_7.${iv}.${sealed?.slice(0, -2)}AA`)).toBeNull();
    expect(await other.parse(handle)).toBeNull();
    expect(await codec.parse('e_0.abc.def')).toBeNull();
    expect(await codec.parse('d_cover')).toBeNull();
    expect(await codec.parse('e_7.short')).toBeNull();
  });
});
