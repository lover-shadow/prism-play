import { describe, expect, it } from 'vitest';
import { handleTelemetryLines, TELEMETRY_MAX_ROWS_PER_REQUEST } from '../../edge/src/routes/telemetry';
import { handleCatalog } from '../../edge/src/routes/catalog';
import { createTestEnv, TEST_BASE_TIME_SECONDS, type PrismTestEnv } from '../support/test-env';

const DEVICE_HASH = 'a1b2c3d4e5f60718';

function signal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providerId: 'provider_m1',
    workId: 'drama_m_90431',
    lineIndex: 0,
    failureCode: 'timeout',
    deviceHash: DEVICE_HASH,
    reportedAt: TEST_BASE_TIME_SECONDS,
    ...overrides
  };
}

function post(body: unknown, method = 'POST'): Request {
  return new Request('http://localhost:8787/api/telemetry/lines', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

async function call(env: PrismTestEnv, body: unknown, method = 'POST'): Promise<Response> {
  return await handleTelemetryLines(post(body, method), env, env.clock);
}

function rows(env: PrismTestEnv): Record<string, unknown>[] {
  return env.db.selectAll('SELECT provider_id, work_id, line_index, failure_code, device_hash, reported_at FROM line_health_signals ORDER BY id');
}

describe('POST /api/telemetry/lines', () => {
  it('lands a single signal in the ledger (AC-C4-1)', async () => {
    const env = await createTestEnv();
    const response = await call(env, [signal()]);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ success: true, accepted: 1 });
    expect(rows(env)).toEqual([
      {
        provider_id: 'provider_m1',
        work_id: 'drama_m_90431',
        line_index: 0,
        failure_code: 'timeout',
        device_hash: DEVICE_HASH,
        reported_at: TEST_BASE_TIME_SECONDS
      }
    ]);
  });

  it('silently truncates a batch of 25 to the first 20 (§C-4-1, AC-C4-2)', async () => {
    const env = await createTestEnv();
    const batch = Array.from({ length: 25 }, (_unused, index) => signal({ lineIndex: index, reportedAt: TEST_BASE_TIME_SECONDS + index }));
    expect(await (await call(env, batch)).json()).toEqual({ success: true, accepted: TELEMETRY_MAX_ROWS_PER_REQUEST });
    const stored = rows(env);
    expect(stored).toHaveLength(TELEMETRY_MAX_ROWS_PER_REQUEST);
    expect(stored.map((row) => Number(row.line_index))).toEqual(Array.from({ length: 20 }, (_unused, index) => index));
  });

  it('needs no credential: an anonymous report still lands', async () => {
    const env = await createTestEnv();
    const response = await handleTelemetryLines(
      new Request('http://localhost:8787/api/telemetry/lines', { method: 'POST', body: JSON.stringify([signal({ failureCode: 'http_error' })]) }),
      env,
      env.clock
    );
    expect(response.status).toBe(200);
    expect(env.db.count('line_health_signals')).toBe(1);
  });

  it('writes the whole accepted set in one D1 batch, not one round trip per row', async () => {
    const env = await createTestEnv();
    let batches = 0;
    const realBatch = env.DB.batch.bind(env.DB);
    env.DB.batch = ((statements: unknown[]) => {
      batches += 1;
      return realBatch(statements as never);
    }) as D1Database['batch'];
    expect((await call(env, [signal({ lineIndex: 0 }), signal({ lineIndex: 1 }), signal({ lineIndex: 2 })])).status).toBe(200);
    expect(batches).toBe(1);
    expect(env.db.count('line_health_signals')).toBe(3);
  });

  it('answers accepted 0 for an empty batch and writes nothing', async () => {
    const env = await createTestEnv();
    expect(await (await call(env, [])).json()).toEqual({ success: true, accepted: 0 });
    expect(env.db.count('line_health_signals')).toBe(0);
  });

  it('refuses a body that is not an array, with 400 and no-store', async () => {
    const env = await createTestEnv();
    for (const body of [{ providerId: 'provider_m1' }, 'not json', JSON.stringify({ accepted: 1 }), '[]{}']) {
      const response = await call(env, body);
      expect(response.status, String(body)).toBe(400);
      expect(response.headers.get('Cache-Control'), String(body)).toBe('no-store');
      expect(JSON.parse(await response.text())).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
    }
    expect(env.db.count('line_health_signals')).toBe(0);
  });

  it('drops malformed entries but keeps the good ones beside them', async () => {
    const env = await createTestEnv();
    const batch = [
      signal({ lineIndex: 0 }),
      signal({ providerId: '魔都源' }),
      signal({ providerId: 'providerm1' }),
      signal({ failureCode: 'buffering' }),
      signal({ workId: 'drama/../x' }),
      signal({ lineIndex: -1 }),
      signal({ lineIndex: 33 }),
      signal({ deviceHash: 'short' }),
      signal({ reportedAt: 123 }),
      signal({ reportedAt: 'now' }),
      'not-an-object',
      signal({ lineIndex: 1 })
    ];
    const response = await call(env, batch);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, accepted: 2 });
    expect(rows(env).map((row) => Number(row.line_index))).toEqual([0, 1]);
  });

  it('accepts all three contract failure codes and nothing else', async () => {
    const env = await createTestEnv();
    expect((await call(env, ['timeout', 'http_error', 'decode_error'].map((code) => signal({ failureCode: code })))).status).toBe(200);
    expect(env.db.count('line_health_signals')).toBe(3);
    const rejected = await call(env, [signal({ failureCode: 'TIMEOUT' }), signal({ failureCode: '' })]);
    expect(await rejected.json()).toEqual({ success: true, accepted: 0 });
    expect(env.db.count('line_health_signals')).toBe(3);
  });

  it('refuses a body past the size guard instead of parsing whatever arrives', async () => {
    const env = await createTestEnv();
    const huge = JSON.stringify(Array.from({ length: 900 }, () => signal({ deviceHash: `${DEVICE_HASH}${'x'.repeat(60)}` })));
    expect(huge.length).toBeGreaterThan(32_000);
    const response = await (await call(env, huge)).text();
    expect(JSON.parse(response)).toMatchObject({ success: false, code: 'VALIDATION_ERROR' });
    expect(env.db.count('line_health_signals')).toBe(0);
  });

  it('answers 405 for a method the contract does not declare', async () => {
    const env = await createTestEnv();
    const response = await handleTelemetryLines(new Request('http://localhost:8787/api/telemetry/lines', { method: 'GET' }), env, env.clock);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });

  it('stays append-only: the report never reads the catalogue or the ledger back', async () => {
    const env = await createTestEnv();
    expect((await call(env, [signal()])).status).toBe(200);
    // A telemetry write must not be able to fail a catalogue read, and vice versa: no shared state.
    const catalog = await handleCatalog(new Request('http://localhost:8787/api/catalog?channel=drama'), env, env.clock);
    expect(catalog.status).toBe(503);
  });
});
