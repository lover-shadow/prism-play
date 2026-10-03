// @vitest-environment jsdom
/**
 * A-8 线路健康遥测的端侧半边（SPEC-APP-REFACTOR A-8 / 云端 §C-4）。
 *
 * 三组断言按这条链路的三条风险排列：
 *   • **载荷形状**：线上就是 §C-4 那六个字段，且逐条过云端的正则闭集——本地先自校验，
 *     否则十九条好信号会被一条发不出去的毒载荷挤掉；域名与 URL 更是根本没有入口。
 *   • **私密零上报**：个人探索剧目的失败连队列都进不去（AC-02），这一条用的是真 `isPrivateSubject`。
 *   • **离场搭车**：flush 挂在 `user-sync` 的 `reportExit()` 第一行，两个离场节点都汇聚到那一句；
 *     未核销设备（无 JWT）也必须发得出信号——免费用户才是探针主力，这里没有会员闸门。
 * 网络出口一律注入替身：默认 sink 走真实 `fetch`，单测不许去打线上 edge。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  LINE_FAILURE_CODES, LINE_TELEMETRY_PATH, LINE_TELEMETRY_QUEUE_LIMIT,
  clearLineTelemetry, flushLineTelemetry, installLineTelemetrySink, pendingLineSignalCount, pendingLineSignals, pushLineSignal,
  type LineHealthSignal
} from '../../src/core/native/telemetry';
import { breakpoint, harness, settle } from './user-sync-harness';

/**
 * 只按源码文本对账，不在客户端测试里 import `edge/src/routes/telemetry`：那个模块的签名要 `Env` /
 * `D1Database`，根 `tsconfig` 没装 Workers 全局类型，一旦把它拖进客户端编译单元就是整仓 tsc 红。
 * 口径对账的本意是"两侧字符串不许各自漂移"，读正本比 import 正本更合适（同 `34-cast-protocol` 钉 Java 的做法）。
 */
const edgeRoute = readFileSync('edge/src/routes/telemetry.ts', 'utf8');

const signal = (over: Partial<Parameters<typeof pushLineSignal>[0]> = {}) => ({
  providerId: 'provider_s1', workId: 'w1', lineIndex: 0, failureCode: 'http_error' as const, ...over
});

/** 云端 `handleTelemetryLines` 的四道闸：逐字段比对，本地不发注定被丢弃的行。 */
const PROVIDER = /^provider_[A-Za-z0-9]{1,32}$/;
const DEVICE_HASH = /^[A-Za-z0-9_-]{8,128}$/;
/** §C-4 的线上字段闭集（排序后比对）：多一个字段就是多一个泄露面。 */
const WIRE_FIELDS = ['deviceHash', 'failureCode', 'lineIndex', 'providerId', 'reportedAt', 'workId'];

let sent: LineHealthSignal[][] = [];
let sink: ReturnType<typeof vi.fn>;

beforeEach(() => {
  clearLineTelemetry();
  sent = [];
  sink = vi.fn(async (rows: LineHealthSignal[]) => { sent.push(rows); return { success: true, accepted: rows.length }; });
  installLineTelemetrySink(sink);
});

describe('A-8 入队：闭集自校验与私密拒收', () => {
  it('AC-A8-1 一条失败即一条信号，字段与云端 §C-4 的闭集逐字对齐', () => {
    expect(pushLineSignal(signal())).toBe(true);
    expect(pendingLineSignals().map((entry) => entry.workId)).toEqual(['w1']);
    expect(pushLineSignal(signal({ failureCode: 'buffer_bloat' as never, lineIndex: 1 }))).toBe(false);
    expect(pushLineSignal(signal({ providerId: 'modu-cdn' }))).toBe(false);
    expect(pushLineSignal(signal({ providerId: 'provider_超长发发发发发发发发发发发发发发发发发发发发发发发发发发' }))).toBe(false);
    expect(pushLineSignal(signal({ workId: '' }))).toBe(false);
    expect(pushLineSignal(signal({ lineIndex: 99 }))).toBe(false);
    expect(pushLineSignal(signal({ lineIndex: 1.5 }))).toBe(false);
    expect(pendingLineSignalCount()).toBe(1);
    expect(LINE_FAILURE_CODES).toEqual(['timeout', 'http_error', 'decode_error']);
  });

  it('AC-02 个人探索剧目的失败不进队列：workId 一旦离开本机就等于说了用户看了什么', () => {
    expect(pushLineSignal(signal({ isPrivate: true }))).toBe(false);
    expect(pushLineSignal(signal({ channelId: 'private', workId: 'p2' }))).toBe(false);
    expect(pendingLineSignals()).toEqual([]);
    expect(pushLineSignal(signal({ channelId: 'drama' }))).toBe(true);
  });

  it('A-8 队列上限 20 且丢最旧：探针要的是刚才那批失败，不是五分钟前的', () => {
    for (let index = 0; index < LINE_TELEMETRY_QUEUE_LIMIT + 5; index += 1) expect(pushLineSignal(signal({ lineIndex: index % 4, workId: `w${index}` }))).toBe(true);
    expect(pendingLineSignalCount()).toBe(LINE_TELEMETRY_QUEUE_LIMIT);
    expect(pendingLineSignals().map((entry) => entry.workId)).toEqual(Array.from({ length: LINE_TELEMETRY_QUEUE_LIMIT }, (_x, index) => `w${index + 5}`));
  });
});

describe('A-8 发送：批量静默、失败即弃', () => {
  it('AC-A8-1 离场发出的是一个数组，六个字段、无域名无 URL', async () => {
    pushLineSignal(signal({ providerId: 'provider_m2', lineIndex: 1, failureCode: 'timeout' }));
    pushLineSignal(signal({ workId: 'w2', lineIndex: 2 }));
    expect(await flushLineTelemetry()).toBe(2);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(2);
    for (const row of sent[0]) {
      expect(Object.keys(row).sort()).toEqual(WIRE_FIELDS);
      expect(row.providerId).toMatch(PROVIDER);
      expect(row.deviceHash).toMatch(DEVICE_HASH);
      expect(row.reportedAt).toBeGreaterThanOrEqual(1_500_000_000);
      // 上游域名与 URL 在这条链路上根本没有入口：闭集字段之外一个字都不许多。
      // （不用 /http/ 这种粗匹配——失败码 `http_error` 自己就带着它。）
      const wire = JSON.stringify(row);
      expect(wire).not.toMatch(/https?:\/\//);
      expect(wire).not.toMatch(/(cdn|[.-](com|net|org|test)\b)/);
    }
    expect(sent[0][1]).toMatchObject({ workId: 'w2', lineIndex: 2, failureCode: 'http_error' });
  });

  it('A-8 发完即清：第二次 flush 是纯 no-op，绝不重发同一批', async () => {
    pushLineSignal(signal());
    expect(await flushLineTelemetry()).toBe(1);
    expect(pendingLineSignalCount()).toBe(0);
    expect(await flushLineTelemetry()).toBe(0);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('AC-A8-2 发送失败即弃：不重试、不回填队列、不阻塞退出', async () => {
    sink.mockRejectedValueOnce(new TypeError('fetch failed'));
    pushLineSignal(signal());
    expect(await flushLineTelemetry()).toBe(0);
    expect(pendingLineSignalCount()).toBe(0);
    expect(await flushLineTelemetry()).toBe(0);
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('A-8 空队列一次请求都不发（未出错的会话不该产生任何网络事件）', async () => {
    expect(await flushLineTelemetry()).toBe(0);
    expect(sink).not.toHaveBeenCalled();
  });

  it('A-8 同一台设备的 deviceHash 稳定：失败要能聚成一台设备的账', async () => {
    pushLineSignal(signal());
    await flushLineTelemetry();
    pushLineSignal(signal({ workId: 'w3' }));
    await flushLineTelemetry();
    expect(sent[0][0].deviceHash).toBe(sent[1][0].deviceHash);
  });

  it('A-8 并发 flush 不重入：在途期间的新信号留给下一个离场节点', async () => {
    let release: () => void = () => undefined;
    sink.mockImplementationOnce(() => new Promise<LineHealthSignal[]>((resolve) => { release = () => resolve([]); }));
    pushLineSignal(signal());
    const first = flushLineTelemetry();
    pushLineSignal(signal({ workId: 'w9' }));
    expect(await flushLineTelemetry()).toBe(0);
    release();
    expect(await first).toBe(1);
    expect(await flushLineTelemetry()).toBe(1);
    expect(pendingLineSignalCount()).toBe(0);
  });
});

describe('A-8 离场搭车点：user-sync 的两个节点', () => {
  it('AC-A8-1 节点 ①（退出播放页）：reportExit 携带断点时同批发出线路信号', async () => {
    const pipe = harness();
    pushLineSignal(signal());
    expect(await pipe.sync.reportExit(breakpoint())).toBe(true);
    await settle();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sent[0][0].workId).toBe('w1');
    // 两条链路各走各的门：断点仍走 /api/user/sync，遥测不混进那条带 JWT 的请求里。
    const urls = pipe.calls.map((call) => call.url);
    expect(urls.some((url) => url.endsWith('/api/user/sync'))).toBe(true);
    expect(urls.some((url) => url.endsWith(LINE_TELEMETRY_PATH))).toBe(false);
  });

  it('AC-A8-1 节点 ②（应用挂起）：lastBreakpoint 为空也照样 flush，挂起前那批失败不能烂在内存里', async () => {
    const pipe = harness();
    pushLineSignal(signal({ failureCode: 'decode_error' }));
    await pipe.sync.reportExit(pipe.sync.lastBreakpoint());
    expect(sent[0][0]).toMatchObject({ failureCode: 'decode_error' });
  });

  it('AC-A8-1 非会员同样上报：没有 JWT 时断点不发，线路信号照发', async () => {
    const pipe = harness([], undefined, { token: null });
    pushLineSignal(signal());
    expect(await pipe.sync.reportExit(breakpoint())).toBe(false);
    expect(pipe.calls).toHaveLength(0);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sent[0]).toHaveLength(1);
  });

  it('AC-A8-2 端点与闭集两侧一致：一次批量正好落在云端一请求的行数上限内', () => {
    // 路由在 `edge/src/index.ts` 按 `['api','telemetry','lines']` 三段注册，端侧这条字符串就是它的投影。
    expect(LINE_TELEMETRY_PATH.split('/').filter(Boolean)).toEqual(['api', 'telemetry', 'lines']);
    expect(LINE_TELEMETRY_QUEUE_LIMIT).toBe(20);
    // 与正本逐字对账：云端改了闭集而端侧没跟，症状是"信号静默消失"，是最难查的那类漂移。
    expect(edgeRoute).toContain("export const LINE_FAILURE_CODES = ['timeout', 'http_error', 'decode_error'] as const");
    expect(edgeRoute).toContain('export const TELEMETRY_MAX_ROWS_PER_REQUEST = 20');
    expect(edgeRoute).toContain("const PROVIDER_ID_PATTERN = /^provider_[A-Za-z0-9]{1,32}$/");
    for (const code of LINE_FAILURE_CODES) expect(edgeRoute).toContain(`'${code}'`);
  });
});
