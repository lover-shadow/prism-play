import { describe, expect, it } from 'vitest';
import { asD1, createInMemoryD1 } from '../support/sqlite-d1';
import { acquireDiscoveryLease, releaseDiscoveryLease } from '../../edge/src/search/discovery-query';
import { publishDiscoveryFact, withdrawDiscoveryFact, type DiscoveryContext } from '../../edge/src/search/discovery-store';

function fixture() {
  const sqlite = createInMemoryD1(), DB = asD1(sqlite); let now = 100;
  const objects = new Map<string, Uint8Array>();
  let duringPut = async () => undefined as void;
  const bucket = { get: async (key: string) => {
    const bytes = objects.get(key); return bytes ? { size: bytes.length, arrayBuffer: async () => bytes.slice().buffer } : null;
  }, put: async (key: string, bytes: Uint8Array) => { await duringPut(); objects.set(key, bytes.slice()); return { key }; } };
  const context: DiscoveryContext = { bindings: { DB, DISCOVERY_BUCKET: bucket as unknown as R2Bucket },
    authority: async () => ({ authoritative: false }), nowSeconds: () => now };
  const fact = { workId: 'drama_m_10', title: '合法公开夹具', channelId: 'drama', generatedAt: 100,
    enabled: true, isPrivate: false, shareable: true, episodeCount: 1,
    episodes: [{ episodeNumber: 1, lines: [{ providerId: 'provider_m1', mediaUrl: 'https://media.invalid/one.mp4' }] }] };
  return { sqlite, DB, context, fact, objects, setNow: (value: number) => { now = value; },
    onPut: (fn: () => Promise<void>) => { duringPut = fn; } };
}

describe('W3 publication fenced by refresh owner', () => {
  it('prepared card publisher cannot resurrect a disabled fact after receiving a new work lease', async () => {
    const f = fixture();
    await publishDiscoveryFact(f.context, 'provider_m1', '10', f.fact, 100, 86400, 'drama_m_10');
    const candidate = { providerId: 'provider_m1', sourceItemId: '10', id: 'drama_m_10', title: '合法公开夹具', channelId: 'drama' };
    const candidateJson = JSON.stringify(candidate);
    f.sqlite.execute('INSERT INTO discovery_cards(work_id,provider_id,source_id,candidate_json,card_json,updated_at) VALUES (?,?,?,?,?,?)',
      'drama_m_10', 'provider_m1', '10', candidateJson, '{}', 100);
    await withdrawDiscoveryFact(f.DB, 'drama_m_10', 101); f.setNow(102);
    const changes = f.sqlite.count('discovery_changes');
    expect((await publishDiscoveryFact(f.context, 'provider_m1', '10', { ...f.fact, generatedAt: 102 }, 102, 86400,
      'drama_m_10', undefined, undefined, undefined, candidateJson)).status).toBe('superseded');
    expect(f.sqlite.selectOne('SELECT enabled FROM discovery_works WHERE work_id = ?', 'drama_m_10')?.enabled).toBe(0);
    expect(f.sqlite.count('discovery_changes')).toBe(changes);
  });
  it('expired parent owner cannot acquire publication rights or create pointers', async () => {
    const f = fixture(), parent = (await acquireDiscoveryLease(f.DB, 'query:fixture', 100, 30))!;
    f.setNow(131);
    const result = await publishDiscoveryFact(f.context, 'provider_m1', '10', f.fact, 131, 86400,
      'drama_m_10', undefined, undefined, parent);
    expect(result.status).toBe('superseded');
    expect(f.sqlite.count('discovery_works')).toBe(0); expect(f.objects.size).toBe(0);
  });
  it('parent lost during R2 write leaves only an orphan, never a pointer/change', async () => {
    const f = fixture(), parent = (await acquireDiscoveryLease(f.DB, 'query:fixture', 100, 30))!;
    f.onPut(async () => { await releaseDiscoveryLease(f.DB, parent); await acquireDiscoveryLease(f.DB, parent.key, 100, 30); });
    const result = await publishDiscoveryFact(f.context, 'provider_m1', '10', f.fact, 100, 86400,
      'drama_m_10', undefined, undefined, parent);
    expect(result.status).toBe('superseded'); expect(f.objects.size).toBe(1);
    expect(f.sqlite.count('discovery_works')).toBe(0); expect(f.sqlite.count('discovery_changes')).toBe(0);
  });
  it('natural parent expiry during object IO rejects without needing a successor', async () => {
    const f = fixture(), parent = (await acquireDiscoveryLease(f.DB, 'query:fixture', 100, 30))!;
    f.onPut(async () => { f.setNow(131); });
    expect((await publishDiscoveryFact(f.context, 'provider_m1', '10', f.fact, 100, 86400,
      'drama_m_10', undefined, undefined, parent)).status).toBe('superseded');
    expect(f.sqlite.count('discovery_works')).toBe(0);
  });
  it('thirty-second work expiry alone refuses publication', async () => {
    const f = fixture(); f.onPut(async () => { f.setNow(131); });
    expect((await publishDiscoveryFact(f.context, 'provider_m1', '10', f.fact, 100, 86400,
      'drama_m_10')).status).toBe('superseded');
    expect(f.sqlite.count('discovery_changes')).toBe(0);
  });
  it('lost parent also fences existing-row UPSERT and preserves original hash and changes', async () => {
    const f = fixture();
    expect((await publishDiscoveryFact(f.context, 'provider_m1', '10', f.fact, 100, 86400, 'drama_m_10')).status).toBe('published');
    const old = f.sqlite.selectOne('SELECT fact_hash, updated_at FROM discovery_works WHERE work_id = ?', 'drama_m_10')!;
    const changes = f.sqlite.count('discovery_changes');
    f.setNow(101); const parent = (await acquireDiscoveryLease(f.DB, 'query:fixture', 101, 30))!;
    f.onPut(async () => { await releaseDiscoveryLease(f.DB, parent); });
    const replacement = { ...f.fact, title: '新事实', generatedAt: 101 };
    expect((await publishDiscoveryFact(f.context, 'provider_m1', '10', replacement, 101, 86400,
      'drama_m_10', Number(old.updated_at), String(old.fact_hash), parent)).status).toBe('superseded');
    expect(f.sqlite.selectOne('SELECT fact_hash FROM discovery_works WHERE work_id = ?', 'drama_m_10')?.fact_hash).toBe(old.fact_hash);
    expect(f.sqlite.count('discovery_changes')).toBe(changes);
  });
  it('valid parent owner commits and parent lease is retained for its coordinator', async () => {
    const f = fixture(), parent = (await acquireDiscoveryLease(f.DB, 'query:fixture', 100, 30))!;
    expect((await publishDiscoveryFact(f.context, 'provider_m1', '10', f.fact, 100, 86400,
      'drama_m_10', undefined, undefined, parent)).status).toBe('published');
    expect(f.sqlite.selectOne('SELECT owner_token FROM discovery_leases WHERE lease_key = ?', parent.key)?.owner_token).toBe(parent.token);
  });
});
