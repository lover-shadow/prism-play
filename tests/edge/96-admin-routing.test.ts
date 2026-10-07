import { describe, expect, it } from 'vitest';
import worker from '../../edge/src/index';
import { createTestEnv } from '../support/test-env';

const context = { waitUntil() {}, passThroughOnException() {} };

describe('worker admin boundary versus unchanged App routes', () => {
  it('fails closed for unconfigured admin APIs without reflecting CORS', async () => {
    const env = await createTestEnv();
    const response = await worker.fetch(new Request('https://play.prismos.org/api/admin/session', {
      headers: { Origin: 'https://other.test' }
    }), env, context);
    expect(response.status).toBe(503);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('preserves App preflight headers and excludes similar-but-not-admin paths', async () => {
    const env = await createTestEnv();
    for (const path of ['/api/redeem', '/api/administrator', '/proxy/media/test']) {
      const response = await worker.fetch(new Request(`https://play.prismos.org${path}`, {
        method: 'OPTIONS', headers: { Origin: 'capacitor://localhost' }
      }), env, context);
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe('capacitor://localhost');
      expect(response.headers.get('Access-Control-Allow-Headers')).toContain('X-Private-Session');
      expect(response.headers.get('Set-Cookie')).toBeNull();
    }
  });
});
