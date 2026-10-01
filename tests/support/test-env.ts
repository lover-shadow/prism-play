import { asD1, createInMemoryD1, type SqliteD1 } from './sqlite-d1';
import { MemoryKv } from './kv-mock';
import type { Env } from '../../edge/src/types/env';
import type { Clock } from '../../edge/src/core/clock';

/** Clock the suite can advance so expiry, rate windows and retry backoff become deterministic. */
export class TestClock implements Clock {
  constructor(private seconds: number) {}

  nowSeconds(): number {
    return this.seconds;
  }

  nowMillis(): number {
    return this.seconds * 1000;
  }

  advance(seconds: number): number {
    this.seconds += seconds;
    return this.seconds;
  }

  set(seconds: number): void {
    this.seconds = seconds;
  }
}

export interface PrismTestEnv extends Env {
  db: SqliteD1;
  kv: MemoryKv;
  clock: TestClock;
}

export const TEST_BASE_TIME_SECONDS = 1_767_225_600;

async function generateEd25519PrivateJwk(): Promise<string> {
  const generated = await crypto.subtle.generateKey({ name: 'Ed25519', namedCurve: 'Ed25519' }, true, [
    'sign',
    'verify'
  ]);
  const keyPair = generated as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  return JSON.stringify(jwk);
}

export async function createTestEnv(overrides?: Partial<Env>): Promise<PrismTestEnv> {
  const db = createInMemoryD1();
  const kv = new MemoryKv();
  return {
    DB: asD1(db),
    KV: kv as unknown as KVNamespace,
    JWT_PRIVATE_KEY_JWK: await generateEd25519PrivateJwk(),
    JWT_KID: 'p2026',
    PRIVATE_SESSION_SECRET: '544553542d414243442d454647482d30313233',
    PROXY_SIGNING_SECRET: '50524f58592d544553542d4b45592d30313233',
    clock: new TestClock(TEST_BASE_TIME_SECONDS),
    db,
    kv,
    ...overrides
  };
}

export function privateJwkToPublicJwk(privateJwkJson: string): string {
  const jwk = JSON.parse(privateJwkJson) as Record<string, unknown>;
  const { d: _d, ...publicParts } = jwk;
  return JSON.stringify(publicParts);
}
