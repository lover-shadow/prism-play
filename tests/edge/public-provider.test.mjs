import { test } from 'node:test';
import assert from 'node:assert/strict';
import { durationSeconds, buildTitleManifest, normalizeWork } from '../../edge/scripts/compute-hotscore.mjs';
import { parsePublicDetail, parsePublicCategory, parsePublicPlayer, publicGet, resolvePublicDetail } from '../../edge/scripts/public-provider.mjs';
const html = (page) => `<script>window._ROUTER_DATA=${JSON.stringify({ loaderData: page })};</script>`;
test('pacing completes before timeout creation, preserving the full network budget', async () => {
  const original = AbortSignal.timeout;
  let waiting = false, paced = false, timeoutMs, clock = 0, deadline;
  AbortSignal.timeout = (ms) => {
    assert.equal(waiting, false); assert.equal(paced, true); timeoutMs = ms; deadline = clock + ms;
    return new AbortController().signal;
  };
  // Reproduce the old 1500ms budget: 1200ms pacing + 400ms I/O would time out.
  assert.ok(1200 + 400 > 1500);
  try {
    await publicGet('/detail?series_id=123', async (_url, init) => {
      assert.equal(deadline - clock, 15000);
      clock += 400;
      assert.ok(clock < deadline);
      assert.equal(init.signal.aborted, false); return new Response('ok');
    }, { beforeRequest: async () => { waiting = true; clock += 1200; await Promise.resolve(); waiting = false; paced = true; } });
    assert.equal(timeoutMs, 15000);
  } finally { AbortSignal.timeout = original; }
});
test('detail cover safety and expiry evidence stay conservative', () => {
  const detail = { series_id: '123', series_name: '真实剧', episode_cnt: 1, vid_list: ['1'], series_cover: 'https://images.example/cover.jpg' };
  const parsed = parsePublicDetail(html({ detail_page: { seriesDetail: detail } }), '123');
  assert.equal(parsed.coverTargetUrl, detail.series_cover);
  for (const series_cover of ['http://images.example/1', 'https://user:secret@images.example/1']) {
    assert.throws(() => parsePublicDetail(html({ detail_page: { seriesDetail: { ...detail, series_cover } } }), '123'), /Unsafe public cover/);
  }
  for (const suffix of ['?expires=9999999999', '?expires=unknown', '?token=secret', '?expires=9999999999999']) {
    const body = html({ player_page: { series_id: '123', vid: '1', video_player_info: { main_url: `https://media.example/1.mp4${suffix}` } } });
    assert.equal(parsePublicPlayer(body, '123', '1').mediaValidation, 'url-only-not-playback-verified');
  }
  for (const suffix of ['?auth_key=1-0-0-secret', '?x-expires=1']) {
    assert.throws(() => parsePublicPlayer(html({ player_page: { series_id: '123', vid: '1', video_player_info: { main_url: `https://media.example/1.mp4${suffix}` } } }), '123', '1'), /Expired public media/);
  }
});
test('body timeouts remain request failures and cannot publish partial media', async () => {
  await assert.rejects(publicGet('/detail?series_id=123', async () => ({ ok: true, text: async () => { throw new DOMException('secret', 'TimeoutError'); } })), { name: 'TimeoutError' });
  await assert.rejects(publicGet('/detail?series_id=123', async () => ({ ok: true, text: async () => 'x'.repeat(4194305) })), /response too large/);
});
test('expired media is rejected without leaking signed URLs', () => {
  const body = html({ player_page: { series_id: '123', vid: '1', video_player_info: { main_url: 'https://media.example/1.mp4?expires=1&token=secret' } } });
  assert.throws(() => parsePublicPlayer(body, '123', '1'), /Expired public media/);
});
test('player failures retain safe reasons and scan all episodes without retries', async () => {
  const detail = parsePublicDetail(html({ detail_page: { seriesDetail: { series_id: '123', series_name: '真实剧', episode_cnt: 3, vid_list: ['1', '2', '3'] } } }), '123');
  let calls = 0;
  const result = await resolvePublicDetail(detail, { maxEpisodeRequests: 3, fetcher: async () => {
    calls++; if (calls === 1) return new Response('token=secret', { status: 403 });
    if (calls === 2) throw new DOMException('token=secret', 'TimeoutError');
    return new Response(html({ player_page: { series_id: '999', vid: '3' } }));
  } });
  assert.equal(calls, 3);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.failures.map((f) => f.reason), ['http', 'timeout', 'identity']);
  assert.equal(result.failures[0].httpStatus, 403);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});
test('unknown durations are omitted instead of fabricating 90 minutes or 120 seconds', () => {
  assert.equal(durationSeconds(undefined, 1, 1), undefined);
  assert.equal(durationSeconds('', 1, 10), undefined);
  const target = { provider: { id: 'provider_m1', shortCode: 'm' }, channelId: 'drama', typeId: 38 };
  const raw = { vod_id: 1, vod_name: '真实剧', vod_play_url: '第1集$https://media.invalid/1' };
  const title = buildTitleManifest(normalizeWork(target, raw, 1), raw, { revision: 2, generatedAt: 1 });
  assert.equal(Object.hasOwn(title.episodes[0], 'durationSeconds'), false);
});
test('public adapter preserves complete source identities, rejects mismatch, duplicates and truncated lists', () => {
  const detail = { series_id: '12345678901234567890', series_name: '真实剧', episode_cnt: 118,
    vid_list: Array.from({ length: 118 }, (_, i) => String(1000 + i)) };
  const parsed = parsePublicDetail(html({ detail_page: { seriesDetail: detail } }), detail.series_id);
  assert.equal(parsed.id, `drama_s_${detail.series_id}`);
  assert.equal(parsed.episodes.length, 118);
  assert.equal(parsed.episodes[117].sourceEpisodeId, '1117');
  assert.deepEqual(parsed.episodes[0].lines, []);
  assert.equal(parsed.providerId, 'provider_s1');
  for (const extra of [{ series_id: 'wrong' }, { vid_list: ['1', '1'] }, { vid_list: ['1', '2'] }]) {
    assert.throws(() => parsePublicDetail(html({ detail_page: { seriesDetail: { ...detail, ...extra } } }), detail.series_id));
  }
});
test('category pagination validates boundaries and rejects repeated or non-progressing pages', () => {
  const body = html({ category_page: { isSuccess: true, recommendList: [{ video_data: { series_id_str: '123', series_title: '真实剧', episode_cnt: '118' } }], pagination: { totalPages: 200 } } });
  const first = parsePublicCategory(body, 1);
  assert.equal(first.items[0].id, 'drama_s_123');
  assert.equal(first.totalPages, 200);
  assert.throws(() => parsePublicCategory(body, 2, first.signature), /repeated/);
  assert.throws(() => parsePublicCategory(body, 201));
});
test('public GET never follows redirects or accepts private upstreams', async () => {
  let calls = 0;
  const fetcher = async (_url, init) => { calls++; assert.equal(init.redirect, 'manual'); return new Response('', { status: 302 }); };
  await assert.rejects(publicGet('/category/ai-drama?page=1', fetcher), /HTTP 302/);
  await assert.rejects(publicGet('https://huangguoai.com/detail', fetcher));
  assert.equal(calls, 1);
});
test('observed empty detail_layout does not hide the identity-bound detail_page', () => {
  for (const [id, total] of [['7688375879554042904', 118], ['7687547133393652798', 149], ['7688405253909122073', 30]]) {
    const seriesDetail = { series_id_str: id, series_name: '回归测试剧', episode_cnt: total,
      vid_list: Array.from({ length: total }, (_, i) => String(1000 + i)) };
    const page = { seriesDetail };
    assert.equal(parsePublicDetail(html({ detail_layout: {}, detail_other: { seriesDetail: { ...seriesDetail, series_id_str: '999' } },
      detail_page: page }), id).episodes.length, total);
    assert.throws(() => parsePublicDetail(html({ detail_layout: {}, detail_page: page, detail_duplicate: page }), id), /Ambiguous/);
    assert.throws(() => parsePublicDetail(html({ detail_page: page }), '999'));
    assert.throws(() => parsePublicDetail(html({ detail_page: { seriesDetail: { ...seriesDetail, series_id_str: Number(id) } } }), id));
    for (const vid_list of [['1', '1'], ['1']]) {
      assert.throws(() => parsePublicDetail(html({ detail_layout: {}, detail_page: { seriesDetail: { ...seriesDetail, vid_list } } }), id));
    }
  }
});
test('category selects one data-bearing loader but still rejects duplicate pages', () => {
  const page = { isSuccess: true, recommendList: [], pagination: { totalPages: 1 } };
  assert.equal(parsePublicCategory(html({ category_layout: {}, category_page: page }), 1).totalPages, 1);
  assert.throws(() => parsePublicCategory(html({ category_page: page, category_other: page }), 1), /Ambiguous/);
  assert.throws(() => parsePublicCategory(html({ category_layout: {} }), 1));
});
test('player selection binds both IDs before checking media and never chooses first prefix', () => {
  const page = { series_id: '123', vid: '901', video_player_info: { encrypted: true } };
  const decoy = { ...page, vid: '902' };
  assert.throws(() => parsePublicPlayer(html({ player_layout: {}, player_other: decoy, player_page: page }), '123', '901'), /Encrypted/);
  assert.throws(() => parsePublicPlayer(html({ player_page: page, player_duplicate: page }), '123', '901'), /Ambiguous/);
  for (const altered of [{ ...page, series_id: '999' }, { ...page, vid: 901 }, decoy]) {
    assert.throws(() => parsePublicPlayer(html({ player_page: altered }), '123', '901'));
  }
  assert.throws(() => parsePublicPlayer(html({ player_layout: {}, player_page: { ...page, video_player_info: {} } }), '123', '901'), /Unavailable/);
});
