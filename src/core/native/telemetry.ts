/**
 * 线路健康遥测的端侧半边（SPEC-APP-REFACTOR A-8 / 云端 §C-4，`POST /api/telemetry/lines`）。
 *
 * 这条链路存在的唯一理由：视频改直连上游之后，云端再也看不见"哪条线路在失败"，而线路质量必须可度量，
 * 否则运营只能靠用户投诉发现某个源整个挂了。于是端侧把失败记成一条**极小**的信号，离场时批量静默送达。
 *
 * 四条纪律，缺一条这条链路就不该上线：
 *
 * 1. **信号里没有上游域名，也没有 URL**。字段闭集就是 §C-4 那五个：抽象 Provider 编号、剧目 id、线路序号、
 *    失败码、设备摘要（AGENTS.md 二.1 去平台化的机械落点——域名连进队列的资格都没有，谈不上被上报）。
 * 2. **个人探索零上报**。私密剧目的失败信号一旦离开本机，就等于把"用户看了什么"暴露给云端，
 *    所以 `pushLineSignal` 在任何入队动作之前按 `isPrivateSubject` 的同一口径拒收，且拒收不重试。
 * 3. **失败即弃**。队列只在内存里，发送失败不重排队、不落盘、不重试、不打扰用户：
 *    这是运营探针，不是用户数据，为它多花一次请求或一寸磁盘都不划算。
 * 4. **非会员同样上报**，而且这里刻意不带任何鉴权闸门——免费用户是探针主力（§C-4 路由本身即匿名接收）。
 *
 * 离场搭车点：`user-sync` 的两个节点（退出播放页 / `appStateChange` 挂起）都汇聚到 `reportExit()`，
 * 因此本模块只需被那一处调用 `flushLineTelemetry()` 即覆盖两个节点，无需另起定时器（零轮询纪律同 §1.9.3）。
 * 诚实边界：`keepalive` 只是"尽力送达"，Android 冻结渲染进程时请求仍可能被掐断，那批信号就丢了。
 */
import type { FetchLike } from '../api/client';
import { logger } from '../diagnostics';
import { SHARE_ORIGIN } from '../share';
import { createCredentialStore } from '../storage/credentials';
import { isPrivateSubject } from '../storage/storage-domains';
import { isNativeHost } from './platform-adapters';

/** 端点路径与队列上限：上限与 `edge/src/routes/telemetry.ts` 的 `TELEMETRY_MAX_ROWS_PER_REQUEST` 同值，超出部分服务端也是静默截断。 */
export const LINE_TELEMETRY_PATH = '/api/telemetry/lines';
export const LINE_TELEMETRY_QUEUE_LIMIT = 20;
/** §C-4 的失败码闭集：拼错的第四个码在云端会被整条丢弃，所以本模块先按同一闭集自校验。 */
export const LINE_FAILURE_CODES = ['timeout', 'http_error', 'decode_error'] as const;
export type LineFailureCode = (typeof LINE_FAILURE_CODES)[number];
/** 云端口径 `^provider_[A-Za-z0-9]{1,32}$` 的本地副本：客户端不 import edge 运行时代码（凭证域同此例）。 */
const PROVIDER_ID_PATTERN = /^provider_[A-Za-z0-9]{1,32}$/;
const LINE_INDEX_MAX = 32;

/** 一条线路失败的现场事实。`workId` 是剧目 id，不是地址；上游域名在这一层根本没有入口。 */
interface LineSignalFields {
  providerId: string;
  workId: string;
  lineIndex: number;
  failureCode: LineFailureCode;
}

/** 入队载荷：私密出处只服务于本机闸门，永远不出现在线上载荷里。 */
export interface LineSignalInput extends LineSignalFields {
  isPrivate?: boolean;
  channelId?: string;
}

/** §C-4 的线上形状：设备摘要与时间戳在发送那一刻才补齐。 */
export interface LineHealthSignal extends LineSignalFields {
  deviceHash: string;
  reportedAt: number;
}

export type LineTelemetrySink = (signals: LineHealthSignal[]) => Promise<unknown>;

interface QueuedSignal { providerId: string; workId: string; lineIndex: number; failureCode: LineFailureCode; at: number }

const queue: QueuedSignal[] = [];
let installedSink: LineTelemetrySink | null = null;
let draining = false;
let deviceHash: string | null = null;
/** 无凭证设备（从未核销过）也必须能被探针看见：进程内随机一个匿名摘要，冷启动即换，绝不落盘。 */
const anonymousDeviceSeed = (): string => `prism-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

/**
 * FNV-1a 的两轮拼接摘要。它不是安全边界，也不需要是：这条链路要的是"同一台设备的失败可以聚在一起看"，
 * 而不是身份认证——凭证域那份 deviceId 本身已是核销主键，这里只把它再折叠一次，避免把标识原样送出去。
 */
function fold(value: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul((b + code) ^ (b >>> 3), 0x811c9dc5) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

/** 凭证读不出来（Web 构建、Keystore 缺席、插件未就绪）就退回匿名摘要：探针不该因为拿不到身份而静默失效。 */
async function hashOfDevice(): Promise<string> {
  if (deviceHash !== null) return deviceHash;
  let resolved = anonymousDeviceSeed();
  try {
    const stored = await createCredentialStore().read('deviceId');
    if (stored !== null && stored !== '') resolved = `line-health:${stored}`;
  } catch (error) {
    logger.warn('telemetry', '设备标识不可读，本次线路遥测使用匿名摘要', error);
  }
  deviceHash = fold(resolved);
  return deviceHash;
}

/** 生产 sink：与分享/投屏同一个 edge 主域，匿名、`keepalive`、不带任何鉴权头。 */
function defaultSink(): LineTelemetrySink {
  const fetchImpl: FetchLike = (input, init) => fetch(input, init);
  const baseUrl = isNativeHost() ? SHARE_ORIGIN : '';
  return async (signals) => {
    await fetchImpl(`${baseUrl}${LINE_TELEMETRY_PATH}`, {
      method: 'POST',
      keepalive: true,
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(signals)
    });
  };
}

const isFailureCode = (value: string): value is LineFailureCode => (LINE_FAILURE_CODES as readonly string[]).includes(value);

/** 本地先按云端闭集自校验：一条永远发不出去的毒载荷留在队列里只会挤掉十九条好信号。 */
function acceptable(input: LineSignalInput): boolean {
  if (!PROVIDER_ID_PATTERN.test(input.providerId)) return false;
  if (typeof input.workId !== 'string' || input.workId === '' || input.workId.length > 120) return false;
  if (!Number.isInteger(input.lineIndex) || input.lineIndex < 0 || input.lineIndex > LINE_INDEX_MAX) return false;
  return isFailureCode(input.failureCode);
}

/**
 * 记一条失败。返回 `false` 表示"这条没进队列"（私密拒收 / 形状不合格 / 队列已满被丢弃最旧一条后被挤掉），
 * 调用方无需据此改变界面行为——界面已经有它自己的诚实错误态。
 */
export function pushLineSignal(input: LineSignalInput): boolean {
  if (isPrivateSubject({ contentId: input.workId, isPrivate: input.isPrivate, channelId: input.channelId })) {
    logger.info('telemetry', '个人探索剧目的线路失败不离开本机，未入队');
    return false;
  }
  if (!acceptable(input)) {
    logger.warn('telemetry', `线路遥测信号形状不合格，已丢弃：${input.providerId}`);
    return false;
  }
  // 满队列丢最旧：最新的失败才是运营当天要看的信号，五分钟前的那条已经不值得占位。
  if (queue.length >= LINE_TELEMETRY_QUEUE_LIMIT) queue.shift();
  queue.push({ providerId: input.providerId, workId: input.workId, lineIndex: input.lineIndex, failureCode: input.failureCode, at: Math.floor(Date.now() / 1000) });
  return true;
}

export function pendingLineSignals(): readonly QueuedSignal[] {
  return queue.slice();
}

/** 冷启动与单测的复位口：上一次进程的失败不该记在这一台设备的账上。 */
export function clearLineTelemetry(): void {
  queue.length = 0;
}

/** 注入发送出口（单测与组合根）；传 null 恢复默认的生产 sink。 */
export function installLineTelemetrySink(sink: LineTelemetrySink | null): void {
  installedSink = sink;
}

/** 队列里还有几条待发的信号。 */
export function pendingLineSignalCount(): number {
  return queue.length;
}

/**
 * 批量静默发送。返回真正交出去的行数；任何异常都被吞掉并如实记一条日志——
 * 离场路径不许因为探针失败而多卡用户一帧，也不许把失败升级成界面提示。
 */
export async function flushLineTelemetry(): Promise<number> {
  if (draining || queue.length === 0) return 0;
  const batch = queue.splice(0, LINE_TELEMETRY_QUEUE_LIMIT);
  draining = true;
  try {
    const hash = await hashOfDevice();
    const signals: LineHealthSignal[] = batch.map((entry) => ({
      providerId: entry.providerId,
      workId: entry.workId,
      lineIndex: entry.lineIndex,
      failureCode: entry.failureCode,
      deviceHash: hash,
      reportedAt: entry.at
    }));
    await (installedSink ?? defaultSink())(signals);
    return signals.length;
  } catch (error) {
    logger.warn('telemetry', `线路遥测未送达（已弃，不重试）：${batch.length} 条`, error);
    return 0;
  } finally {
    draining = false;
  }
}
