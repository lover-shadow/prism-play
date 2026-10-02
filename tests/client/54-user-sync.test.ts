// @vitest-environment jsdom
/**
 * WP7 端云状态同步中枢（AC-30）：上报管道、待发队列、字段映射、私密拦截、拉取合并的单测真相源。
 *
 * 钉的是"契约形状 + 时序"而不是渲染：`keepalive` 是否真挂在 `RequestInit` 上、载荷是否先落盘再发、
 * 请求被掐断后条目是否仍在队列里并在下次冷启动先补传、私密断点是否做到零网络、合并是否只取较新者。
 * 历史/偏好替身见 `user-sync-harness.ts`——闸门用生产的 `assertWritable`，不在测试里另立一套判定。
 */
import { describe, expect, it } from 'vitest';
import { localInputOf, PENDING_QUEUE_KEY, USER_SYNC_PATH, wireHistoryOf, wireRequest } from '../../src/core/user-sync';
import { createPrivateVault } from '../../src/core/storage/private-vault';
import { bodyOf, breakpoint, fakeHistory, harness, MemoryPrefs, NOW, posted, queuedOf, row, settle, SYNC_URL, TOKEN } from './user-sync-harness';

describe('AC-30 端云同步：上报管道与字段映射', () => {
  it('AC-30 离场断点以 keepalive POST /api/user/sync 上报，并带上凭证域读出的 Bearer', async () => {
    const { sync, calls } = harness();
    expect(await sync.reportExit(breakpoint())).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(SYNC_URL);
    expect(USER_SYNC_PATH).toBe('/api/user/sync');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].keepalive).toBe(true);
    expect(calls[0].authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('AC-30 线上字段是 episodeNumber 而非 last_episode_number：三套命名只在一处映射', async () => {
    const { sync, calls } = harness();
    await sync.reportExit(breakpoint());
    expect(bodyOf(posted(calls)[0]).history).toEqual({ contentId: 'c1', episodeNumber: 12, positionSeconds: 145, durationSeconds: 300 });
    expect(posted(calls)[0].body).not.toContain('last_episode_number');
    expect(posted(calls)[0].body).not.toContain('episode_number');
    expect(wireHistoryOf(breakpoint({ episodeNumber: 7 }))).toMatchObject({ episodeNumber: 7 });
    // 内核还没定位到集（episodeNumber < 1）时降级为"只交画像"：云端 CHECK 会 400 掉 0 号集，毒队列永远补不完。
    expect(wireHistoryOf(breakpoint({ episodeNumber: 0 }))).toBeNull();
    expect(wireRequest(wireHistoryOf(breakpoint({ episodeNumber: 0 })), { genres: { 都市: -1, 古装: Number.NaN, 武侠: 3.5 }, totalPlays: 4.9 }))
      .toEqual({ history: null, preferences: { genres: { 武侠: 3.5 }, totalPlays: 4 } });
  });

  it('AC-30 载荷先落待发队列再发请求，成功回执后即出队（发不出去是常态，不是例外）', async () => {
    const { sync, ops, prefs } = harness();
    await sync.reportExit(breakpoint());
    expect(ops.slice(0, 2)).toEqual(['queue', 'post']);
    expect(prefs.keys()).toEqual([PENDING_QUEUE_KEY]);
    expect(queuedOf(prefs, PENDING_QUEUE_KEY)).toEqual([]);
  });

  it('AC-30 请求被掐断时条目留在队列，下次冷启动先补传再拉取', async () => {
    const dropped = harness([], undefined, { failPost: true });
    expect(await dropped.sync.reportExit(breakpoint())).toBe(false);
    expect(queuedOf(dropped.prefs, PENDING_QUEUE_KEY)).toHaveLength(1);
    expect(dropped.notices.join('|')).toContain('下次启动自动补传');

    const revived = harness([row()], undefined, { prefs: dropped.prefs });
    await revived.sync.pull();
    // 冷启动补传必须抢在拉取之前：否则云端的旧断点会先把没发出去的新进度盖掉。
    expect(revived.calls.map((call) => call.method)).toEqual(['POST', 'GET']);
    expect(bodyOf(posted(revived.calls)[0]).history).toMatchObject({ episodeNumber: 12, positionSeconds: 145 });
    expect(await revived.sync.replayPending()).toBe(0);
    expect(queuedOf(revived.prefs, PENDING_QUEUE_KEY)).toEqual([]);
  });

  it('AC-30 私密断点被 assertWritable 拦截：零网络调用、零落盘，并如实出声', async () => {
    const { sync, calls, ops, notices, prefs } = harness();
    expect(await sync.reportExit(breakpoint({ isPrivate: true }))).toBe(false);
    expect(await sync.reportExit(breakpoint({ channelId: 'private' }))).toBe(false);
    expect(calls).toHaveLength(0);
    expect(ops).toEqual([]);
    expect(prefs.keys()).toEqual([]);
    expect(notices.join('|')).toContain('个人探索的断点不会离开本机');
  });

  it('AC-30 访客设备（无 JWT）保持纯本地：既不上传也不拉取', async () => {
    const { sync, calls } = harness([], undefined, { token: null });
    expect(await sync.reportExit(breakpoint())).toBe(false);
    expect(await sync.pull()).toBeNull();
    expect(await sync.replayPending()).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('AC-30 播放期间零请求：无心跳无轮询，只有离场触发才产生调用', async () => {
    const { sync, calls } = harness([row()]);
    for (let index = 0; index < 40; index += 1) sync.onProgress(row({ position_seconds: 20 + index, updated_at: NOW + index }), { contentId: 'c1', channelId: 'drama' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toHaveLength(0);
    expect(sync.lastBreakpoint()).toMatchObject({ contentId: 'c1', positionSeconds: 59 });
    await sync.reportExit(sync.lastBreakpoint());
    expect(posted(calls)).toHaveLength(1);
  });

  it('AC-30 断点落库路由唯一：私密进内存域、公开进历史域，绝不双写', async () => {
    const vault = createPrivateVault();
    const history = fakeHistory();
    const sync = harness([], undefined, { token: null, history, privateVault: vault }).sync;
    sync.onProgress(row({ content_id: 'p1' }), { contentId: 'p1', isPrivate: true });
    sync.onProgress(row({ content_id: 'q1' }), { contentId: 'q1', channelId: 'drama' });
    await settle();
    expect(history.rows.has('p1')).toBe(false);
    expect(vault.getBreakpoint('p1')?.content_id).toBe('p1');
    expect(history.rows.get('q1')?.last_episode_number).toBe(12);
  });

  it('AC-30 队列按剧目幂等：同一剧只留最新断点，补传不会把旧进度盖回云端', async () => {
    const { sync, prefs } = harness([], undefined, { failPost: true });
    await sync.reportExit(breakpoint({ positionSeconds: 10 }));
    await sync.reportExit(breakpoint({ positionSeconds: 90 }));
    const entries = queuedOf(prefs, PENDING_QUEUE_KEY);
    expect(entries).toHaveLength(1);
    expect(entries[0].payload.history?.positionSeconds).toBe(90);
  });

  it('AC-30 解散后不再产生任何请求，队列原样留存待下次冷启动', async () => {
    const { sync, calls, prefs } = harness([], undefined, { failPost: true });
    await sync.reportExit(breakpoint());
    const before = calls.length;
    sync.dispose();
    expect(await sync.reportExit(breakpoint())).toBe(false);
    expect(calls).toHaveLength(before);
    expect(queuedOf(prefs, PENDING_QUEUE_KEY)).toHaveLength(1);
  });

  it('AC-30 挂起触发经宿主守卫：非原生宿主返回 no-op 解绑函数，Web 构建不崩也不发请求', async () => {
    const { sync, calls } = harness();
    const undo = await sync.observeBackground(() => void sync.reportExit(breakpoint()));
    expect(typeof undo).toBe('function');
    undo();
    await settle();
    expect(calls).toHaveLength(0);
  });
});

describe('AC-30 端云同步：拉取合并与画像继承', () => {
  const cloudNewer = { success: true, history: [{ contentId: 'c1', episodeNumber: 18, positionSeconds: 610, durationSeconds: 700, updatedAt: 2000 }], preferences: null };

  it('AC-30 云端较新则覆盖本机断点，本机较新则原样保留：updatedAt 取较新者', async () => {
    const cloud = harness([row({ updated_at: 1000 })], cloudNewer);
    expect((await cloud.sync.pull())?.merged).toBe(1);
    expect(cloud.history.rows.get('c1')).toMatchObject({ last_episode_number: 18, position_seconds: 610, updated_at: 2000 });

    const localWins = harness([row({ updated_at: 9000, position_seconds: 40 })], cloudNewer);
    expect((await localWins.sync.pull())?.merged).toBe(0);
    expect(localWins.history.rows.get('c1')).toMatchObject({ position_seconds: 40, updated_at: 9000 });
  });

  it('AC-30 云端陌生的剧目不虚构历史卡，只如实登记为未合并', async () => {
    const state = { success: true, history: [{ contentId: 'zz', episodeNumber: 3, positionSeconds: 10, durationSeconds: 60, updatedAt: 5000 }], preferences: null };
    const { sync, history } = harness([row()], state);
    const merged = await sync.pull();
    expect(merged?.merged).toBe(0);
    expect(merged?.unresolved).toEqual(['zz']);
    expect(history.rows.has('zz')).toBe(false);
  });

  it('AC-30 公开快照记为私密的云端行被闸门拒写，合并结果为 0 且不污染历史域', async () => {
    const { sync, history } = harness([row()], cloudNewer, { provenanceOf: () => ({ contentId: 'c1', isPrivate: true }) });
    const merged = await sync.pull();
    expect(merged?.merged).toBe(0);
    expect(merged?.unresolved).toEqual(['c1']);
    expect(history.rows.get('c1')?.last_episode_number).toBe(12);
  });

  it('AC-30 偏好画像随拉取交还推荐引擎，上报时按本地历史如实计数', async () => {
    const vector = { genres: { 古装: 12.5 }, totalPlays: 7, updatedAt: 4000 };
    const { sync, calls } = harness([row(), row({ content_id: 'c2', last_episode_id: 3 })], { success: true, history: [], preferences: vector });
    await sync.pull();
    expect(sync.preferences()).toEqual(vector);
    await sync.reportExit(breakpoint());
    expect(bodyOf(posted(calls)[0]).preferences).toEqual({ genres: { 都市: 1, 古装: 1 }, totalPlays: 2 });
  });

  it('AC-30 拉取只读 GET 且响应形状不符契约时按"云端无数据"处理，绝不半信合并', async () => {
    const { sync, calls, history } = harness([row()], { items: [], page: 1 });
    expect(await sync.pull()).toBeNull();
    expect(calls.map((call) => call.method)).toEqual(['GET']);
    expect(history.rows.get('c1')?.updated_at).toBe(1000);
  });

  it('AC-30 断网拉取静默失败：本机视图数据原样保留，不报错误也不覆盖', async () => {
    const { sync, history } = harness([row()], undefined, { failGet: true });
    expect(await sync.pull()).toBeNull();
    expect(history.rows.get('c1')?.position_seconds).toBe(145);
  });

  it('AC-30 合并写入形状由映射函数单一供给：episodeNumber → last_episode_number、updatedAt → updated_at', () => {
    const input = localInputOf({ contentId: 'c1', episodeNumber: 9, positionSeconds: 33, durationSeconds: 44, updatedAt: 55 }, row());
    expect(input).toMatchObject({ lastEpisodeNumber: 9, updatedAt: 55, positionSeconds: 33, title: '凤逆天下' });
    expect(wireRequest(null, { genres: {}, totalPlays: 0 })).toEqual({ history: null, preferences: { genres: {}, totalPlays: 0 } });
  });

  it('AC-30 待发队列只写偏好域的 prism.* 键，不借道历史域之外的任何落盘面', async () => {
    const prefs = new MemoryPrefs();
    expect(prefs.keys()).toEqual([]);
    await expect(prefs.set('bad.key', 'x')).rejects.toThrow('prism.');
    prefs.seed(PENDING_QUEUE_KEY, '[{"key":"stale"}]');
    const { sync } = harness([], undefined, { prefs, failPost: true });
    await sync.reportExit(breakpoint());
    expect(prefs.keys()).toEqual([PENDING_QUEUE_KEY]);
    expect(queuedOf(prefs, PENDING_QUEUE_KEY).map((entry) => entry.key)).toEqual(['c1']);
  });
});
