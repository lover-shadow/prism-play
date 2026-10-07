import { describe, expect, it, vi } from 'vitest';
import { asD1, createInMemoryD1 } from '../support/sqlite-d1';
import { discoveryWorkId, validateDiscoveryFact } from '../../edge/src/search/discovery-facts';
import { publishDiscoveryFact, readDiscoveryFact, readDiscoveryCards, readDiscoveryChanges,
  withdrawDiscoveryFact, type DiscoveryContext } from '../../edge/src/search/discovery-store';
import { acquireDiscoveryLease, releaseDiscoveryLease, completeDiscoveryQuery, readDiscoveryQuery,
  discoveryQueryKey, consumeDiscoveryRate, pruneDiscoveryCoordination } from '../../edge/src/search/discovery-query';

async function fixture(sourceId = 'source-1') {
  const sqlite = createInMemoryD1(), DB = asD1(sqlite), objects = new Map<string, Uint8Array>();
  const workId = await discoveryWorkId('provider_s1', sourceId);
  const raw = { workId, title: '公共发现故事', channelId: 'drama', category: '故事', generatedAt: 0,
    enabled: true, isPrivate: false, shareable: true, episodeCount: 2,
    coverTargetUrl: 'https://cover.invalid/private-original.jpg',
    episodes: [1, 2].map((episodeNumber) => ({ episodeNumber,
      lines: [{ providerId: 'provider_s1', mediaUrl: `https://media.invalid/${episodeNumber}.mp4` }] })) };
  const get = vi.fn(async (key: string) => {
    const bytes = objects.get(key);
    return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } : null;
  });
  const put = vi.fn(async (key: string, value: Uint8Array) => {
    expect(sqlite.count('discovery_works')).toBe(0);
    objects.set(key, value.slice()); return { key };
  });
  const bucket = { get, put } as unknown as R2Bucket;
  const authority = vi.fn(async () => ({ authoritative: false as const }));
  let clock = 100;
  const context: DiscoveryContext = { bindings: { DB, DISCOVERY_BUCKET: bucket }, authority, nowSeconds: () => clock };
  const publish = () => publishDiscoveryFact(context, 'provider_s1', sourceId, raw, 100, 100);
  return { sqlite, DB, workId, raw, objects, bucket, put, get, authority, context, publish,
    setClock: (now: number) => { clock = now; } };
}

describe('private discovery ledger (all migrations, real SQLite)', () => {
  it('uploads before transactional index publication; cards and changes never expose targets', async () => {
    const f = await fixture();
    expect(await f.publish()).toEqual({ status: 'published', workId: f.workId });
    const read = await readDiscoveryFact(f.context, f.workId, 101);
    expect(read.status).toBe('ok');
    if (read.status === 'ok') {
      expect(read.fact.row.cover_url).toBe(f.raw.coverTargetUrl);
      expect(read.fact.asset.episodes).toHaveLength(2);
      expect(read.fact.shareable).toBe(true);
    }
    const cards = await readDiscoveryCards(f.context, [f.workId], 101);
    expect(cards[0].coverUrl).toBe(`/proxy/img/${f.workId}`);
    const changes = await readDiscoveryChanges(f.context, 0, 101);
    expect(changes).toMatchObject({ cursor: 1, hasMore: false, changes: [{ operation: 'upsert' }] });
    expect(JSON.stringify([cards, changes])).not.toMatch(/media\.invalid|cover\.invalid|coverTargetUrl/);
    expect(f.sqlite.selectAll('PRAGMA foreign_key_list(discovery_works)')).toEqual([]);
    expect(f.sqlite.count('content_items')).toBe(0);
  });
  it('fails closed on absent/public binding and never falls back to APK_BUCKET', async () => {
    const f = await fixture();
    f.context.bindings.APK_BUCKET = f.bucket;
    await expect(f.publish()).rejects.toThrow('Independent private');
    delete f.context.bindings.DISCOVERY_BUCKET;
    await expect(f.publish()).rejects.toThrow('Independent private');
    expect(f.put).not.toHaveBeenCalled();
  });
  it('failed upload and failed D1 transaction publish no pointer/change', async () => {
    const f = await fixture();
    f.put.mockRejectedValueOnce(new Error('offline'));
    await expect(f.publish()).rejects.toThrow('offline');
    expect(f.sqlite.count('discovery_works')).toBe(0);
    f.sqlite.handle.exec(`CREATE TRIGGER fail_publish BEFORE INSERT ON discovery_works BEGIN
      SELECT RAISE(ABORT, 'injected'); END;`);
    await expect(f.publish()).rejects.toThrow('injected');
    expect(f.objects.size).toBe(1); // Harmless private orphan, never a published pointer.
    expect(f.sqlite.count('discovery_changes')).toBe(0);
    expect(f.sqlite.count('discovery_leases')).toBe(0);
  });
  it.each(['private', 'encrypted', 'duplicate', 'gap', 'count', 'empty', 'http', 'loopback', 'credentials', 'oversize'])
    ('rejects invalid public fact: %s', async (mode) => {
      const f = await fixture(), raw: any = structuredClone(f.raw);
      if (mode === 'private') raw.isPrivate = true;
      if (mode === 'encrypted') raw.episodes[0].lines[0].encrypted = true;
      if (mode === 'duplicate') raw.episodes[1].episodeNumber = 1;
      if (mode === 'gap') raw.episodes[1].episodeNumber = 3;
      if (mode === 'count') raw.episodeCount = 1;
      if (mode === 'empty') raw.episodes[0].lines = [];
      if (mode === 'http') raw.episodes[0].lines[0].mediaUrl = 'http://media.invalid/a';
      if (mode === 'loopback') raw.episodes[0].lines[0].mediaUrl = 'https://127.0.0.1/a';
      if (mode === 'credentials') raw.coverTargetUrl = 'https://user:pass@cover.invalid/a';
      if (mode === 'oversize') raw.extra = 'x'.repeat(524288);
      expect(validateDiscoveryFact(raw, f.workId)).toBeNull();
      expect((await publishDiscoveryFact(f.context, 'provider_s1', 'source-1', raw, 100)).status).toBe('rejected');
      expect(f.put).not.toHaveBeenCalled();
    });
  it('verifies hashes, sizes, and full title shape on every read; repairs are not poisoned by caches', async () => {
    const f = await fixture(); await f.publish();
    const [key, bytes] = [...f.objects.entries()][0];
    f.objects.set(key, bytes.map((v, i) => i ? v : v ^ 1));
    expect((await readDiscoveryFact(f.context, f.workId, 101)).status).toBe('rejected');
    f.objects.set(key, bytes.slice(1));
    expect((await readDiscoveryFact(f.context, f.workId, 101)).status).toBe('rejected');
    f.objects.set(key, bytes);
    expect((await readDiscoveryFact(f.context, f.workId, 101)).status).toBe('ok');
  });
  it('baseline ownership takes precedence, including authoritative absent/private denial', async () => {
    const f = await fixture(); await f.publish();
    f.context.authority = async () => ({ authoritative: true, read: { status: 'absent' } });
    expect((await f.publish()).status).toBe('baseline');
    expect((await readDiscoveryFact(f.context, f.workId, 101)).status).toBe('absent');
    expect(await readDiscoveryCards(f.context, [f.workId], 101)).toEqual([]);
    expect((await readDiscoveryChanges(f.context, 0, 101)).changes[0]).not.toHaveProperty('card');
  });
  it('withdrawal and expiry append independent tombstones and never leak metadata', async () => {
    const f = await fixture(); await f.publish();
    expect(await withdrawDiscoveryFact(f.DB, f.workId, 110)).toBe(true);
    expect(await withdrawDiscoveryFact(f.DB, f.workId, 111)).toBe(false);
    expect((await readDiscoveryFact(f.context, f.workId, 111)).status).toBe('absent');
    const first = await readDiscoveryChanges(f.context, 0, 111, 1);
    expect(first).toMatchObject({ cursor: 1, hasMore: true, changes: [{ operation: 'withdraw' }] });
    expect((await readDiscoveryChanges(f.context, first.cursor, 111)).changes).toEqual([
      { seq: 2, workId: f.workId, operation: 'withdraw', updatedAt: 110 }
    ]);
    const e = await fixture(); await e.publish();
    expect((await readDiscoveryChanges(e.context, 1, 200)).changes[0].operation).toBe('withdraw');
  });
  it('expired/replaced owner cannot publish or release its successor after slow upload', async () => {
    const f = await fixture();
    let successor: Awaited<ReturnType<typeof acquireDiscoveryLease>>;
    f.put.mockImplementationOnce(async (key, bytes) => {
      f.objects.set(key, bytes); f.setClock(401);
      successor = await acquireDiscoveryLease(f.DB, `work:${f.workId}`, 401, 30);
      return { key };
    });
    expect((await f.publish()).status).toBe('superseded');
    expect(successor!).not.toBeNull();
    expect(f.sqlite.count('discovery_leases')).toBe(1);
    expect(f.sqlite.count('discovery_works')).toBe(0);
  });
  it('withdrawal during R2 read invalidates even a previously warm fact', async () => {
    const f = await fixture(); await f.publish();
    const original = f.get.getMockImplementation()!;
    f.get.mockImplementationOnce(async (key) => {
      const object = await original(key); await withdrawDiscoveryFact(f.DB, f.workId, 102); return object;
    });
    expect((await readDiscoveryFact(f.context, f.workId, 103)).status).toBe('absent');
  });
  it('normalizes query keys, atomically locks, caches success/empty, not network failures', async () => {
    const f = await fixture();
    const key = await discoveryQueryKey(' ＡＢＣ  故事 ');
    expect(key).toEqual(await discoveryQueryKey('abc 故事'));
    const leases = await Promise.all(Array.from({ length: 8 }, () => acquireDiscoveryLease(f.DB, `query:${key.qhash}`, 100)));
    expect(leases.filter(Boolean)).toHaveLength(1);
    const lease = leases.find(Boolean)!;
    expect(await releaseDiscoveryLease(f.DB, { ...lease, token: 'wrong' })).toBe(false);
    expect(await completeDiscoveryQuery(f.DB, key, lease, [], 101)).toBe(true);
    expect(await readDiscoveryQuery(f.DB, key, 102)).toMatchObject({ status: 'empty', ids: [], freshUntil: 131 });
    expect(await readDiscoveryQuery(f.DB, key, 131)).toBeNull();
    const next = (await acquireDiscoveryLease(f.DB, lease.key, 132))!;
    expect(await completeDiscoveryQuery(f.DB, key, next, [f.workId], 133)).toBe(true);
    expect(await readDiscoveryQuery(f.DB, key, 134)).toMatchObject({ status: 'success', ids: [f.workId] });
    const failed = await discoveryQueryKey('网络故障');
    const failedLease = (await acquireDiscoveryLease(f.DB, `query:${failed.qhash}`, 100))!;
    await releaseDiscoveryLease(f.DB, failedLease);
    expect(await readDiscoveryQuery(f.DB, failed, 101)).toBeNull();
  });
  it('expired query owner cannot complete or delete a renewed lease', async () => {
    const f = await fixture(), key = await discoveryQueryKey('故事');
    const a = (await acquireDiscoveryLease(f.DB, `query:${key.qhash}`, 100, 1))!;
    const b = (await acquireDiscoveryLease(f.DB, a.key, 101))!;
    expect(await completeDiscoveryQuery(f.DB, key, a, [], 102)).toBe(false);
    expect(await releaseDiscoveryLease(f.DB, a)).toBe(false);
    expect(await completeDiscoveryQuery(f.DB, key, b, [], 102)).toBe(true);
  });
  it('D1 fixed window cannot over-admit concurrent calls and cleans bounded coordination rows', async () => {
    const f = await fixture();
    const results = await Promise.all(Array.from({ length: 20 }, () => consumeDiscoveryRate(f.DB, "hash'--", 100, 3)));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    expect(results.find((r) => !r.allowed)?.retryAfter).toBe(20);
    expect((await consumeDiscoveryRate(f.DB, "hash'--", 120, 3)).allowed).toBe(true);
    await pruneDiscoveryCoordination(f.DB, 180);
    expect(f.sqlite.count('discovery_rate_windows')).toBe(0);
  });
});
