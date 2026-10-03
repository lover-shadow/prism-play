import { describe, expect, it } from 'vitest';
import worker from '../../edge/src/index';
import type { RequestContext } from '../../edge/src/types/env';
import { handleProxy } from '../../edge/src/routes/proxy';
import { publish, unpublish } from '../../edge/src/ingest/publish';
import { seedEpisodeSource, seedProvider, seedStandardChannels } from '../support/seed';
import { seedPublishedWork } from '../support/seed-catalog';
import type { PrismTestEnv } from '../support/test-env';
import { cardFixture, libraryEnv, seedLibraryAssets, type LibraryEnv } from './library-fixtures';

const ORIGIN = 'http://localhost:8787';
const UPSTREAM_HOST = 'cdn.invalid';
const MANIFEST_URL = `https://${UPSTREAM_HOST}/hls/master.m3u8`;
const SEGMENT_URL = `https://${UPSTREAM_HOST}/hls/seg-1.ts`;

const MASTER_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=1800000,RESOLUTION=1280x720',
  '720/index.m3u8',
  `#EXT-X-STREAM-INF:BANDWIDTH=420000,RESOLUTION=640x360,CLOSED-CAPTIONS=NONE`,
  `https://${UPSTREAM_HOST}/hls/low/index.m3u8`
].join('\n');

const MEDIA_PLAYLIST = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:10',
  '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.invalid/keys/row,a/key.bin",IV=0x00112233445566778899AABBCCDDEEFF',
  '#EXT-X-MAP:URI="init.mp4"',
  '#EXTINF:10.0,',
  'seg-1.ts',
  '#EXT-X-ENDLIST'
].join('\n');

const ctx: RequestContext = { waitUntil: () => undefined, passThroughOnException: () => undefined };

/**
 * `worker.fetch` runs on the system clock, so this suite anchors its rows to the real wall clock:
 * data stamped at the test base time is already 300+ days old and `/api/catalog/changes` is correct to
 * answer 410 for it. That distinction is the retention rule working, not a defect.
 */
const NOW = Math.floor(Date.now() / 1000);

/** The only upstream the edge may talk to, and it never leaves this file. */
const fakeUpstream = {
  async fetch(url: string, init?: RequestInit): Promise<Response> {
    const range = new Headers(init?.headers).get('Range');
    if (url === MANIFEST_URL) {
      return new Response(MASTER_PLAYLIST, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    }
    if (url === `https://${UPSTREAM_HOST}/hls/720/index.m3u8`) {
      return new Response(MEDIA_PLAYLIST, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
    }
    if (url === SEGMENT_URL || url === `https://${UPSTREAM_HOST}/hls/720/seg-1.ts`) {
      if (range !== null) {
        return new Response('bytes', {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-4/900', 'Content-Type': 'video/mp2t', 'Accept-Ranges': 'bytes' }
        });
      }
      return new Response('segment-bytes', { headers: { 'Content-Type': 'video/mp2t', 'Accept-Ranges': 'bytes' } });
    }
    if (url.startsWith(`https://${UPSTREAM_HOST}`)) {
      return new Response('child-payload', { headers: { 'Content-Type': 'application/octet-stream' } });
    }
    throw new Error(`the edge asked for a non-whitelisted origin: ${url}`);
  }
};

async function journeyFixture(): Promise<{ env: LibraryEnv; contentId: string; episodeId: number }> {
  const env = await libraryEnv();
  seedStandardChannels(env.db);
  const { episodeIds } = seedPublishedWork(
    env.db,
    { id: 'd_journey', channelId: 'drama', title: '战神之龙王归来', category: '逆袭', episodes: 1, tags: ['逆袭'] },
    NOW
  );
  // `seedPublishedWork` flips visibility directly; re-drive it through the production publisher so the
  // lexical index and the change log are written by the code path Stage 2 actually runs.
  const revision = await publish(env.DB, 'd_journey', NOW);
  expect(revision).toBeGreaterThan(0);
  // The browse path is CI-published R2 shards (§C-3), so the journey mirrors one publish: revision 1
  // carries the work with no cover — the same shape the old D1 reader produced for this row.
  await seedLibraryAssets({ kv: env.kv, r2: env.r2 }, {
    revision: 1,
    channels: { drama: [cardFixture('d_journey', { title: '战神之龙王归来', category: '逆袭', coverUrl: undefined, synopsis: undefined, episodeCount: 1 })] }
  });

  seedProvider(env.db, { id: 'provider_s1', channelId: 'drama', upstreamUrl: `https://${UPSTREAM_HOST}/catalog` });
  const episodeId = episodeIds[0] as number;
  seedEpisodeSource(env.db, { episodeId, providerId: 'provider_s1', upstreamMediaUrl: MANIFEST_URL });
  return { env, contentId: 'd_journey', episodeId };
}

async function get(env: PrismTestEnv, path: string, headers?: Record<string, string>): Promise<Response> {
  return worker.fetch(new Request(`${ORIGIN}${path}`, { headers }), env, ctx);
}

/** A failure must name the endpoint, the status and the body instead of dying inside JSON.parse. */
async function jsonOf<T>(response: Response, label: string): Promise<T> {
  const text = await response.text();
  if (response.status !== 200) throw new Error(`${label} -> ${response.status} | ${text.slice(0, 160)}`);
  return JSON.parse(text) as T;
}

describe('G2 journey: publish → catalogue → changes → search → playback → proxy', () => {
  it('a published work becomes listable, incremental, findable and playable without a second writer', async () => {
    const { env, contentId, episodeId } = await journeyFixture();

    const listed = await jsonOf<{ items: { id: string; coverUrl?: string }[]; revision: number }>(
      await get(env, '/api/catalog?channel=drama'),
      'catalog'
    );
    expect(listed.items.map((item) => item.id)).toEqual([contentId]);
    expect(listed.revision).toBeGreaterThan(0);
    expect(listed.items[0]?.coverUrl).toBeUndefined();

    const changes = await jsonOf<{ changes: { revision: number; contentId: string; operation: string }[]; nextRevision: number; hasMore: boolean }>(
      await get(env, '/api/catalog/changes?after=0'),
      'changes'
    );
    expect(changes.changes.some((entry) => entry.contentId === contentId && entry.operation === 'upsert')).toBe(true);
    expect(changes.hasMore).toBe(false);

    const found = await jsonOf<{ items: { item: { id: string }; matchType: string }[] }>(
      await get(env, '/api/search?q=%E6%88%98%E7%A5%9E'),
      'search'
    );
    expect(found.items.map((entry) => entry.item.id)).toContain(contentId);

    const playback = await get(env, `/api/episodes/${episodeId}/playback`);
    expect(playback.status).toBe(200);
    const info = await jsonOf<{ url: string; mimeType?: string; expiresInSeconds: number }>(playback, 'playback');
    expect(info.url.startsWith(`${ORIGIN}/proxy/media/e_${episodeId}.`)).toBe(true);
    expect(info.url).not.toContain(UPSTREAM_HOST);
    expect(info.expiresInSeconds).toBeGreaterThan(0);

    const manifest = await handleProxy(new Request(info.url), env, env.clock, { fetcher: fakeUpstream });
    expect(manifest.status).toBe(200);
    const rewritten = await manifest.text();
    expect(rewritten).not.toContain(UPSTREAM_HOST);
    expect(rewritten).toContain(`${ORIGIN}/proxy/media/`);
    // A manifest whose children could not be rewritten must never be relayed at all.
    expect(rewritten).toContain('#EXT-X-STREAM-INF');
    expect(rewritten.split('\n')).toHaveLength(MASTER_PLAYLIST.split('\n').length);
  });

  it('descends into the media playlist and relays every child through the same origin', async () => {
    const { env, episodeId } = await journeyFixture();
    const info = await jsonOf<{ url?: string }>(await get(env, `/api/episodes/${episodeId}/playback`), 'playback');

    const first = await handleProxy(new Request(info.url as string), env, env.clock, { fetcher: fakeUpstream });
    const childHref = (await first.text()).split('\n').find((line) => line.startsWith(`${ORIGIN}/proxy/media/`));
    expect(childHref).toBeDefined();

    const child = await handleProxy(new Request(childHref as string), env, env.clock, { fetcher: fakeUpstream });
    expect(child.status).toBe(200);
    const media = await child.text();
    expect(media).not.toContain(UPSTREAM_HOST);
    expect(media).toContain('#EXT-X-KEY');
    const keyHref = /URI="([^"]+)"/.exec(media)?.[1];
    expect(keyHref).toBeDefined();
    expect(String(keyHref).startsWith(ORIGIN)).toBe(true);

    // Children arrive in two shapes: bare segment lines and `URI="..."` attributes on EXT-X-KEY /
    // EXT-X-MAP, so the scan has to catch both. Three of them means key, init and media segment.
    const hrefs = media.match(/http:\/\/localhost:8787\/proxy\/media\/[^"\s,]+/g) ?? [];
    expect(hrefs.length).toBe(3);
    const payloads: string[] = [];
    for (const href of hrefs) {
      const relayed = await handleProxy(new Request(href), env, env.clock, { fetcher: fakeUpstream });
      expect(relayed.status, href).toBe(200);
      expect(relayed.headers.get('Cache-Control')).toBe('no-store');
      payloads.push(await relayed.text());
    }
    expect(payloads).toContain('segment-bytes');

    // A sealed handle hides its target, so the segment is identified by playlist position, not by name.
    const segmentHref = media.split('\n').at(media.split('\n').findIndex((line) => line === '#EXTINF:10.0,') + 1);
    expect(segmentHref).toBeDefined();
    expect(String(segmentHref).startsWith(ORIGIN)).toBe(true);
    const ranged = await handleProxy(new Request(segmentHref as string, { headers: { Range: 'bytes=0-4' } }), env, env.clock, {
      fetcher: fakeUpstream
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('Content-Range')).toBe('bytes 0-4/900');
  });

  it('a takedown kills the share page, the search result and the stream in the same request', async () => {
    const { env, contentId, episodeId } = await journeyFixture();

    const shareUrl = `/s/${contentId}?ep=1`;
    expect((await get(env, shareUrl)).status).toBe(200);

    const revision = await unpublish(env.DB, contentId, NOW);
    expect(revision).toBeGreaterThan(0);
    // The CI mirror of a takedown: revision 2 publishes the surviving card only.
    await seedLibraryAssets({ kv: env.kv, r2: env.r2 }, {
      revision: 2,
      channels: { drama: [cardFixture('d_other', { title: '另一部剧', category: '都市', coverUrl: undefined, synopsis: undefined })] }
    });

    // The change feed must now carry a delete tombstone with no metadata, and search must drop the row.
    const changes = await jsonOf<{ changes: { contentId: string; operation: string; item?: unknown }[] }>(
      await get(env, '/api/catalog/changes?after=1'),
      'changes-after-takedown'
    );
    const tombstone = changes.changes.filter((entry) => entry.contentId === contentId).at(-1);
    expect(tombstone?.operation).toBe('delete');
    expect(tombstone?.item).toBeUndefined();

    expect((await get(env, shareUrl)).status).toBe(404);
    const searched = await jsonOf<{ items: { item: { id: string } }[] }>(
      await get(env, '/api/search?q=%E6%88%98%E7%A5%9E'),
      'search-after-takedown'
    );
    expect(searched.items.map((entry) => entry.item.id)).not.toContain(contentId);

    const info = (await (await get(env, `/api/episodes/${episodeId}/playback`)).json()) as { url?: string };
    expect(info.url).toBeUndefined();
    const listing = await jsonOf<{ items: { id: string }[] }>(await get(env, '/api/catalog?channel=drama'), 'catalog-after-takedown');
    expect(listing.items.map((item) => item.id)).toEqual(['d_other']);
  });

  it('personal exploration never enters the public feed, index or share surface', async () => {
    const env = await libraryEnv();
    seedStandardChannels(env.db);
    seedPublishedWork(env.db, { id: 'p_secret', channelId: 'private', title: '私密探索剧', isPrivate: 1, shareable: 0 });
    // A publish that carries no public card at all: the private work has no shard to leak from.
    await seedLibraryAssets({ kv: env.kv, r2: env.r2 }, { revision: 1, channels: {} });

    const changes = await jsonOf<{ changes: unknown[] }>(await get(env, '/api/catalog/changes?after=0'), 'changes-private');
    expect(changes.changes).toEqual([]);
    const searched = await jsonOf<{ items: unknown[] }>(await get(env, '/api/search?q=%E7%A7%98%E5%AF%86'), 'search-private');
    expect(searched.items).toEqual([]);
    expect((await get(env, '/s/p_secret')).status).toBe(404);
    expect(env.db.count('public_search_fts')).toBe(0);

    const channels = await (await get(env, '/api/channels')).text();
    expect(channels).not.toContain('个人探索');
    expect(channels.toLowerCase()).not.toContain('private');
  });
});
