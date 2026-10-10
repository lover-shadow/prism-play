import { describe, expect, it } from 'vitest';
import { asD1, createInMemoryD1 } from '../support/sqlite-d1';
import { acquireDiscoveryLease, discoveryQueryKey, renewDiscoveryLease } from '../../edge/src/search/discovery-query';
import { claimDiscoveryJob, initializeDiscoveryJobs, readDiscoveryJobs, renewDiscoveryJob } from '../../edge/src/search/discovery-jobs';

const candidate = { providerId: 'provider_s1' as const, sourceItemId: '10', id: 'drama_s_10', title: '故事', channelId: 'drama' as const };
describe('W3 刷新租约隔离', () => {
  it('续期要求原owner和未过期，过期不得复活', async () => {
    const sqlite = createInMemoryD1(), db = asD1(sqlite);
    const lease = (await acquireDiscoveryLease(db, 'query:test', 100))!;
    expect(await renewDiscoveryLease(db, lease, 110)).toBe(true);
    expect(sqlite.selectOne('SELECT expires_at FROM discovery_leases')?.expires_at).toBe(140);
    expect(await renewDiscoveryLease(db, lease, 140)).toBe(false);
    const replacement = (await acquireDiscoveryLease(db, lease.key, 140))!;
    expect(await renewDiscoveryLease(db, lease, 141)).toBe(false);
    expect(await renewDiscoveryLease(db, replacement, 141)).toBe(true);
  });
  it('older renewal sample cannot shorten expiry extended by a newer renewal', async () => {
    const sqlite = createInMemoryD1(), db = asD1(sqlite);
    const lease = (await acquireDiscoveryLease(db, 'query:test', 100))!;
    expect(await renewDiscoveryLease(db, lease, 120)).toBe(true);
    expect(await renewDiscoveryLease(db, lease, 110)).toBe(true);
    expect(sqlite.selectOne('SELECT expires_at FROM discovery_leases')?.expires_at).toBe(150);
  });
  it('job租约跟随query续期，旧进程失效三十秒可重领', async () => {
    const sqlite = createInMemoryD1(), db = asD1(sqlite), key = await discoveryQueryKey('故事');
    const lease = (await acquireDiscoveryLease(db, `query:${key.qhash}`, 100))!;
    await initializeDiscoveryJobs(db, key, lease, [{ candidate, workId: candidate.id }], false, false, 100);
    const job = (await readDiscoveryJobs(db, key.qhash))[0];
    expect(await claimDiscoveryJob(db, job, lease, 100)).toBe(true);
    expect(sqlite.selectOne('SELECT lease_until FROM discovery_jobs')?.lease_until).toBe(130);
    expect(await renewDiscoveryLease(db, lease, 110)).toBe(true);
    expect(await renewDiscoveryJob(db, job, lease, 110)).toBe(true);
    expect(sqlite.selectOne('SELECT lease_until FROM discovery_jobs')?.lease_until).toBe(140);
    expect(await renewDiscoveryJob(db, job, lease, 140)).toBe(false);
    const replacement = (await acquireDiscoveryLease(db, lease.key, 140))!;
    expect(await claimDiscoveryJob(db, job, replacement, 140)).toBe(true);
    expect(await renewDiscoveryJob(db, job, lease, 141)).toBe(false);
  });
});
