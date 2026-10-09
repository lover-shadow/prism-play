import { describe, expect, it } from 'vitest';
import { handleCleanHls } from '../../edge/src/routes/hls-clean';
import { systemClock } from '../../edge/src/core/clock';
import type { Env } from '../../edge/src/types/env';

const ORIGIN = 'http://localhost:8787';
const AD_URL = 'https://play.modujx17.com/20260830/il7CWEiN/2000kb/hls/index.m3u8';
const HEAD = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4';
const D = '#EXT-X-DISCONTINUITY';
const content = (from: number, count: number): string =>
  Array.from({ length: count }, (_, i) => `#EXTINF:2.0,\nhttps://bf.modujx17.com/20260830/il7CWEiN/2000kb/hls/c${from + i}.ts`).join('\n');
const ads = (from: number, count: number): string =>
  Array.from({ length: count }, (_, i) => `#EXTINF:3.0,\n/20261009/Bjf6z0RU/10152kb/hls/ad${from + i}.ts`).join('\n');
const DIRTY = `${HEAD}\n${content(1, 60)}\n${D}\n${ads(1, 2)}\n${D}\n${content(61, 120)}\n${D}\n${ads(3, 2)}\n#EXT-X-ENDLIST`;
const PURE = `${HEAD}\n${content(1, 60)}\n#EXT-X-ENDLIST`;

interface PutRecord { key: string; value: string }

function makeEnv(overrides: Record<string, unknown> = {}): { env: Env; puts: PutRecord[] } {
  const puts: PutRecord[] = [];
  const env = {
    AD_STRIP_ENABLED: 'true',
    AD_STRIP_TARGET_HOSTS: 'play.modujx17.com,bf.modujx17.com',
    KV: { put: async (key: string, value: string) => { puts.push({ key, value }); } },
    ...overrides
  } as unknown as Env;
  return { env, puts };
}

function fetchRoute(map: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const hit = map[href];
    if (hit === undefined) throw new Error(`unexpected fetch ${href}`);
    return hit();
  }) as unknown as typeof fetch;
}

const cleanUrl = (target: string, work = 'drama_m_88837'): string =>
  `${ORIGIN}/proxy/hls/clean?target=${encodeURIComponent(target)}&work=${work}`;
const call = (url: string, env: Env, fetcher?: typeof fetch): Promise<Response> =>
  handleCleanHls(new Request(url), env, systemClock, fetcher === undefined ? {} : { fetcher });

describe('清洗入口安全边界', () => {
  it('非 GET 拒绝 405', async () => {
    const { env } = makeEnv();
    const res = await handleCleanHls(new Request(cleanUrl(AD_URL), { method: 'POST' }), env, systemClock);
    expect(res.status).toBe(405);
  });

  it('缺 target / 非 https / 非白名单主机一律 400（子串伪造主机同样拒绝）', async () => {
    const { env } = makeEnv();
    expect((await call(`${ORIGIN}/proxy/hls/clean`, env)).status).toBe(400);
    expect((await call(cleanUrl('http://play.modujx17.com/a.m3u8'), env)).status).toBe(400);
    expect((await call(cleanUrl('https://play.modujx17.com.evil.example/a.m3u8'), env)).status).toBe(400);
    expect((await call(cleanUrl('https://evil.example/a.m3u8'), env)).status).toBe(400);
  });

  it('总开关关闭：302 回目标地址，行为与未部署完全一致', async () => {
    const { env } = makeEnv({ AD_STRIP_ENABLED: 'false' });
    const res = await call(cleanUrl(AD_URL), env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toBe(AD_URL);
  });

  it('白名单内的重定向跟随一跳后正常清洗；越权重定向立即失败', async () => {
    const { env } = makeEnv();
    const inner = 'https://play.modujx17.com/20260830/il7CWEiN/2000kb/hls/simple.m3u8';
    const okFetch = fetchRoute({
      [AD_URL]: () => new Response(null, { status: 302, headers: { Location: inner } }),
      [inner]: () => new Response(PURE)
    });
    expect((await call(cleanUrl(AD_URL), env, okFetch)).status).toBe(200);
    const badFetch = fetchRoute({
      [AD_URL]: () => new Response(null, { status: 302, headers: { Location: 'https://evil.example/x.m3u8' } })
    });
    expect((await call(cleanUrl(AD_URL), env, badFetch)).status).toBe(502);
  });

  it('上游 404 / 网络异常 / 响应体超限：一律 502，绝不给半份内容', async () => {
    const { env } = makeEnv();
    const notFound = fetchRoute({ [AD_URL]: () => new Response('gone', { status: 404 }) });
    expect((await call(cleanUrl(AD_URL), env, notFound)).status).toBe(502);
    const boom = fetchRoute({ [AD_URL]: () => { throw new Error('network down'); } });
    expect((await call(cleanUrl(AD_URL), env, boom)).status).toBe(502);
    const { env: tinyEnv } = makeEnv({ AD_STRIP_CONFIG: '{"maxBytes":4096}' });
    const big = fetchRoute({ [AD_URL]: () => new Response(`${HEAD}\n${'#'.repeat(8192)}\n#EXT-X-ENDLIST`) });
    expect((await call(cleanUrl(AD_URL), tinyEnv, big)).status).toBe(502);
  });
});

describe('清洗入口端到端', () => {
  it('真实广告清单：切除全部广告块、诊断头齐备、审计入账', async () => {
    const { env, puts } = makeEnv();
    const fetcher = fetchRoute({ [AD_URL]: () => new Response(DIRTY) });
    const res = await call(cleanUrl(AD_URL), env, fetcher);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Ad-Strip-Mode')).toBe('cleaned');
    expect(res.headers.get('X-Ad-Strip-Blocks')).toBe('2');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    const text = await res.text();
    expect(text).not.toContain('Bjf6z0RU');
    expect(text).toContain('c1.ts');
    expect(puts).toHaveLength(1);
    expect(puts[0].key.startsWith('adstrip/audit/')).toBe(true);
    const record = JSON.parse(puts[0].value) as Record<string, unknown>;
    expect(record).toMatchObject({ workId: 'drama_m_88837', removedBlocks: 2, targetHost: 'play.modujx17.com' });
  });

  it('纯净清单：透传原字节、不写审计', async () => {
    const { env, puts } = makeEnv();
    const fetcher = fetchRoute({ [AD_URL]: () => new Response(PURE) });
    const res = await call(cleanUrl(AD_URL), env, fetcher);
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Ad-Strip-Mode')).toBe('unchanged');
    expect(await res.text()).toBe(PURE);
    expect(puts).toHaveLength(0);
  });

  it('非法 work 参数只影响审计归属，不影响清洗', async () => {
    const { env, puts } = makeEnv();
    const fetcher = fetchRoute({ [AD_URL]: () => new Response(DIRTY) });
    const res = await call(`${ORIGIN}/proxy/hls/clean?target=${encodeURIComponent(AD_URL)}&work=${'a'.repeat(200)}`, env, fetcher);
    expect(res.status).toBe(200);
    const record = JSON.parse(puts[0].value) as Record<string, unknown>;
    expect(record.workId).toBeNull();
  });
});
