import { describe, expect, it } from 'vitest';
import { handleAdminAnnouncementsWrite } from '../../edge/src/routes/admin-announcements';
import { createTestEnv } from '../support/test-env';
import type { Env } from '../../edge/src/types/env';
const origin = 'https://play.prismos.org';
const clock = { nowSeconds: () => 1000, nowMillis: () => 1000000 };
const req = () => new Request(origin + '/api/admin/announcements', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ requestId: 'minimal_0001', confirmed: true, document: { schema: 1, revision: 3, items: [] } }) });
describe('MIN-05 notice failure is not success', () => {
  it('does not publish when audit insertion fails', async () => {
    let writes = 0;
    const env = { DB: { prepare: () => ({ bind: () => ({ run: async () => { throw new Error('D1 down'); }, first: async () => null }) }) },
      KV: { put: async () => { writes++; } } } as unknown as Env;
    expect((await handleAdminAnnouncementsWrite(req(), env, clock)).status).toBe(503);
    expect(writes).toBe(0);
  });
  it('removes an unfinished audit claim after KV fails so the same request can retry', async () => {
    const env = await createTestEnv(); const put = env.KV.put.bind(env.KV); let fail = true;
    env.KV.put = async (...args) => { if (fail) throw new Error('KV down'); return put(...args); };
    expect((await handleAdminAnnouncementsWrite(req(), env, clock)).status).toBe(503);
    fail = false;
    expect((await handleAdminAnnouncementsWrite(req(), env, clock)).status).toBe(200);
  });
});
