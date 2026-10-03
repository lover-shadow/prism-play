/**
 * 局域网大屏 DLNA 投屏的原生桥（SPEC §1.5.2，AC-24）。
 *
 * WebView 发不了 UDP 组播，也拿不到 `WifiManager.MulticastLock`，所以发现与 SOAP 控制都在
 * `PrismCastPlugin` 里；本模块只做三件事：调用原生、把回包**再校验一遍**、以及在非 Android 环境里
 * 明确说"不支持"。
 *
 * 为什么 JS 侧还要再校验一次 RFC1918：原生侧已经只把本机 SSDP 探测到的设备放进注册表，但那条记录要
 * 往返 WebView 一趟才回到 `castMedia`。H1 是对平台明文策略的一次**有意**绕开，其安全前提就是"目标只会
 * 是局域网私有地址"；把这条前提同时钉在发送端（Java）与提交端（TS），被篡改或被改错的中间层就无法把
 * 一个公网主机伪装成"扫描到的电视"。两侧口径必须一致，`verify_android_assets.py` 与协议单测都在守这个。
 *
 * NOTHING HERE HAS EVER RUN AGAINST A REAL RENDERER：jsdom 里没有 UDP，也没有大屏。
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { isNativeHost } from './platform-adapters';

/** 必须与 `PrismCastPlugin.PLUGIN_ID` 逐字一致（门禁第 6 条两侧对账）。 */
export const PRISM_CAST_PLUGIN = 'PrismCast';

export interface CastDevice {
  id: string;
  name: string;
  ip: string;
  port: number;
  controlUrl: string;
  location: string;
}

export interface DiscoveryReport {
  devices: CastDevice[];
  count: number;
  probesSent: number;
  multicastAvailable: boolean;
  /** AC-24 要求"组播锁已释放"是可证明的，而不是口头承诺：原生每轮扫描都把它回填上来。 */
  multicastLockReleased: boolean;
}

export type CastAction = 'play' | 'pause' | 'stop';

export interface CastStatePayload {
  deviceId: string;
  deviceName: string;
  state: 'playing' | 'paused' | 'stopped';
}

interface CastNativePlugin {
  startDiscovery(): Promise<DiscoveryReport>;
  stopDiscovery(): Promise<{ stopped: boolean; multicastLockReleased: boolean }>;
  castMedia(args: { deviceId: string; streamUrl: string; title?: string; mimeType?: string }): Promise<CastStatePayload>;
  controlMedia(args: { deviceId: string; action: CastAction }): Promise<CastStatePayload>;
}

/** 能力缺席与失败是两件事：本类型让 UI 能老实说"这台设备上没有投屏"。 */
export type CastSupport = 'native' | 'unsupported';

export class CastUnavailableError extends Error {
  readonly reason: 'unsupported-platform' | 'plugin-missing' | 'invalid-device' | 'invalid-stream';
  constructor(message: string, reason: CastUnavailableError['reason']) {
    super(message);
    this.name = 'CastUnavailableError';
    this.reason = reason;
  }
}

const plugin = registerPlugin<CastNativePlugin>(PRISM_CAST_PLUGIN);

/**
 * 只有 10/8、172.16/12、192.168/16 的点分十进制字面量算局域网主机。
 * 域名（DNS 可以指到任何地方）、IPv6、回环、链路本地一律拒绝——与 `LanAddressPolicy.isPrivateHost` 同口径。
 */
export function isRfc1918Host(host: string): boolean {
  if (typeof host !== 'string') return false;
  const literal = host.trim();
  if (literal === '' || literal.startsWith('[') || literal.includes(':')) return false;
  const parts = literal.split('.');
  if (parts.length !== 4) return false;
  const octet: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    // 前导零一律拒绝：部分解析器把 `010.` 读成八进制，那正好能把一个"看着被拒"的串变成 8.0.0.0。
    if (part.length > 1 && part.startsWith('0')) return false;
    const value = Number(part);
    if (value > 255) return false;
    octet.push(value);
  }
  if (octet[0] === 10) return true;
  if (octet[0] === 172) return octet[1] >= 16 && octet[1] <= 31;
  return octet[0] === 192 && octet[1] === 168;
}

/** 解析不出 http(s) 主机名时返回 null，而不是抛错——校验层不该让 UI 崩。 */
export function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * 一台"设备"必须同时满足：有名字、ip 是 RFC1918、controlUrl 也是 RFC1918 且与 ip 同一主机。
 * 任何一条不满足就当它不存在——列出一台控制不了的电视，比什么都不列更容易让用户判定是本项目坏了。
 */
export function isCastableDevice(value: unknown): value is CastDevice {
  if (value === null || typeof value !== 'object') return false;
  const raw = value as Record<string, unknown>;
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const ip = typeof raw.ip === 'string' ? raw.ip.trim() : '';
  const controlUrl = typeof raw.controlUrl === 'string' ? raw.controlUrl.trim() : '';
  const location = typeof raw.location === 'string' ? raw.location.trim() : '';
  if (id === '' || name === '' || ip === '' || controlUrl === '' || location === '') return false;
  if (!isRfc1918Host(ip)) return false;
  const controlHost = hostOf(controlUrl);
  const locationHost = hostOf(location);
  // hostOf 只认 http(s)，所以这两条同时也在断言控制通道是局域网 http 端点，不是别的协议。
  return controlHost === ip && locationHost === ip;
}

/**
 * 推给大屏的地址必须是**公网 https 直链**（SPEC-APP-REFACTOR A-7.5 之后的口径）：
 * 直连上游之后，`api.playback()` 的代理句柄只是回退链，清单里的 `mediaUrl` 才是主路径。
 * 三条拒绝条件一条都没松——明文（`https:` 之外一律拒）、局域网主机、内嵌凭据。
 *
 * 为什么明文可以留：手机根本不取这一条流，它只把地址交给电视；真正的明文只在局域网控制面（SOAP），
 * 那一侧的裸 socket 方案（H1）与本文件无关，`LanAddressPolicy.requirePublicStreamUrl` 也在原生侧同样把关。
 * 两侧必须同口径，否则"手机放行、原生拒绝"会变成一个只在真机出现的死角。
 */
export function requireCastableStreamUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CastUnavailableError('投屏地址不是合法 URL', 'invalid-stream');
  }
  if (parsed.protocol !== 'https:') {
    throw new CastUnavailableError('投屏地址必须为公网 https 流', 'invalid-stream');
  }
  if (isRfc1918Host(parsed.hostname) || parsed.username !== '' || parsed.password !== '') {
    throw new CastUnavailableError('投屏地址不得指向局域网或内嵌凭据', 'invalid-stream');
  }
  return parsed.toString();
}

/**
 * 不抛错的版本：投屏的取流口要先问"这条直连线路推得出去吗"，推不出去就退回代理句柄，
 * 而不是让状态机拿着一条注定被拒的地址去报错（源站给了 http 切片是常态，不是异常）。
 */
export function isCastableStreamUrl(value: string): boolean {
  try {
    requireCastableStreamUrl(value);
    return true;
  } catch {
    return false;
  }
}

/** 非 Android（含 jsdom / 桌面浏览器）返回 `unsupported`：不装样子、不假装扫得到设备。 */
export function castSupport(): CastSupport {
  if (!isNativeHost()) return 'unsupported';
  return Capacitor.isPluginAvailable(PRISM_CAST_PLUGIN) ? 'native' : 'unsupported';
}

export interface CastClient {
  readonly supported: boolean;
  discover(): Promise<DiscoveryReport>;
  stop(): Promise<void>;
  cast(device: CastDevice, stream: { url: string; title?: string; mimeType?: string }): Promise<CastStatePayload>;
  control(device: CastDevice, action: CastAction): Promise<CastStatePayload>;
}

function unavailable(): never {
  throw new CastUnavailableError('投屏需要在 Android 客户端内进行', 'unsupported-platform');
}

/**
 * 单一入口。Web 上拿到的是一个会明确抛错的对象，而不是一个"看起来能点、点了没反应"的空实现——
 * AGENTS.md 的"任何前端开关必有真实机制对应"在这里的落法就是：机制不在，就说不在这台设备上。
 */
export function createCastClient(): CastClient {
  if (castSupport() !== 'native') {
    return {
      supported: false,
      discover: async () => unavailable(),
      stop: async () => unavailable(),
      cast: async () => unavailable(),
      control: async () => unavailable()
    };
  }
  return {
    supported: true,
    async discover() {
      const report = await plugin.startDiscovery();
      const devices = Array.isArray(report?.devices) ? report.devices.filter(isCastableDevice) : [];
      return {
        devices,
        count: devices.length,
        probesSent: Number(report?.probesSent ?? 0),
        multicastAvailable: report?.multicastAvailable === true,
        multicastLockReleased: report?.multicastLockReleased === true
      };
    },
    async stop() {
      await plugin.stopDiscovery();
    },
    async cast(device, stream) {
      if (!isCastableDevice(device)) {
        throw new CastUnavailableError('该设备不在本机发现结果内，请重新扫描', 'invalid-device');
      }
      return await plugin.castMedia({
        deviceId: device.id,
        streamUrl: requireCastableStreamUrl(stream.url),
        title: stream.title,
        mimeType: stream.mimeType
      });
    },
    async control(device, action) {
      if (!isCastableDevice(device)) {
        throw new CastUnavailableError('该设备不在本机发现结果内，请重新扫描', 'invalid-device');
      }
      return await plugin.controlMedia({ deviceId: device.id, action });
    }
  };
}
