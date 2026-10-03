// @vitest-environment jsdom
/**
 * AC-24 协议层断言（SPEC §1.5.2 与 §1.5.2.1 H1/H2/H3）。
 *
 * 这一组用例钉两类东西，且**不混淆二者**：
 *   • 可在 jsdom 里真实执行的：TS 侧的 RFC1918 复校、设备记录合法性校验、代理流地址闸门、Web 降级、
 *     插件名字面量两侧一致——这些是本包真的会跑的代码。
 *   • 只能做源码级钉住的：SSDP 报文字节、SOAP 信封字段、组播锁的获取/释放配对、清单明文策略。
 *     本机没有 JDK/SDK，Java 永不在此执行，所以对它们断言的是"源码里必须逐字出现这些口径"，
 *     真机同网段实测才是行为证据（见 verify_acceptance.py 的 AC-24 DEVICE_ONLY 条目）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  castSupport,
  createCastClient,
  hostOf,
  isCastableDevice,
  isCastableStreamUrl,
  isRfc1918Host,
  requireCastableStreamUrl,
  PRISM_CAST_PLUGIN
} from '../../src/core/native/cast';

const readSource = (relative: string): string => {
  let directory = process.cwd();
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      return readFileSync(join(directory, relative), 'utf8');
    } catch {
      directory = dirname(directory);
    }
  }
  throw new Error(`找不到正本 ${relative}`);
};

const NATIVE = 'android/app/src/main/java/org/prismos/play';
const ssdp = readSource(`${NATIVE}/SsdpDiscovery.java`);
const ssdpMessage = readSource(`${NATIVE}/SsdpMessage.java`);
const envelope = readSource(`${NATIVE}/SoapEnvelope.java`);
const transport = readSource(`${NATIVE}/SoapController.java`);
const policy = readSource(`${NATIVE}/LanAddressPolicy.java`);
const lockGuard = readSource(`${NATIVE}/MulticastLockGuard.java`);
const plugin = readSource(`${NATIVE}/PrismCastPlugin.java`);
const manifest = readSource('android/app/src/main/AndroidManifest.xml');
const securityConfig = readSource('android/app/src/main/res/xml/network_security_config.xml');
const description = readSource(`${NATIVE}/UpnpDescription.java`);

/** 只取方法体来断言：整文件比对会把解释性注释里的反例也算成正例（`ssdp:all` 就同时出现在两处）。 */
const methodBody = (source: string, signature: string): string => {
  const escaped = signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}[\\s\\S]*?\\n    }`).exec(source);
  if (match === null) throw new Error(`找不到方法体 ${signature}`);
  return match[0];
};

/** 一份真实感的 SSDP 回包与设备描述文档：TS 校验层吃的就是这两份东西的派生结果。 */
const SSDP_REPLY = 'HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1'
  + '\r\nUSN: uuid:3f6a2c1-2::urn:schemas-upnp-org:device:MediaRenderer:1\r\n'
  + 'LOCATION: http://192.168.31.88:49152/description.xml\r\nEXT:\r\n\r\n';
const DESCRIPTION = '<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1'
  + '</major><minor>0</minor></specVersion><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1'
  + '</deviceType><friendlyName>客厅的小米电视</friendlyName><serviceList><service>'
  + '<serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>'
  + '<controlURL>/upnp/control/renderctrl</controlURL></service><service>'
  + '<serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>'
  + '<controlURL>upnp/control/avtransport</controlURL></service></serviceList></device></root>';

const deviceOf = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'lan-1',
  name: '客厅的小米电视',
  ip: '192.168.31.88',
  port: 49152,
  controlUrl: 'http://192.168.31.88:49152/upnp/control/avtransport',
  location: 'http://192.168.31.88:49152/description.xml',
  ...over
});

describe('AC-24 SSDP 探测报文与设备发现口径', () => {
  it('AC-24 探测包必须是 M-SEARCH/239.255.255.250:1900/MediaRenderer:1 的 CRLF 报文', () => {
    // 报文口径断言读 `SsdpMessage.java`，socket 机制断言读 `SsdpDiscovery.java`：
    // 前者是电视固件会逐字评判的东西，后者只跟 Android 的组播与省电行为有关，两回事不混在一个正本里查。
    expect(ssdpMessage).toContain('"M-SEARCH * HTTP/1.1\\r\\n"');
    expect(ssdpMessage).toContain('"239.255.255.250"');
    expect(ssdpMessage).toContain('MULTICAST_PORT = 1900');
    expect(ssdpMessage).toContain('urn:schemas-upnp-org:device:MediaRenderer:1');
    expect(ssdpMessage).toContain('"MAN: \\"ssdp:discover\\"\\r\\n"');
    expect(ssdp).toContain('new MulticastSocket(');
    expect(ssdp).toContain('.joinGroup(');
    // ST 只问 MediaRenderer：ssdp:all 会把打印机与智能插座一起拖进面板。
    expect(methodBody(ssdpMessage, 'static String searchRequest()')).not.toContain('ssdp:all');
    expect(methodBody(ssdpMessage, 'static String searchRequest()')).toContain('ST: " + SEARCH_TARGET');
  });

  it('AC-24 回包解析以 LOCATION 为准，并按 USN 的 uuid 归并同一台电视', () => {
    expect(ssdp).toContain('headerOf(message, "location")');
    expect(ssdp).toContain('headerOf(message, "usn")');
    expect(transport).toContain('static String get(String url)');
    // 夹具本身：LOCATION 与 AVTransport 必须在同一台主机上，否则设备记录会被丢掉。
    expect(SSDP_REPLY).toMatch(/LOCATION: http:\/\/192\.168\.31\.88:49152\/description\.xml/i);
    expect(DESCRIPTION).toContain('<controlURL>upnp/control/avtransport</controlURL>');
    expect(description).toContain('Integer.toHexString(core.toLowerCase(Locale.ROOT).hashCode())');
    expect(description).toContain('"uuid:"');
  });

  it('AC-24 控制 URL 解析走相对路径补全，且只认 AVTransport 服务段', () => {
    expect(ssdp).toContain('UpnpDescription.controlUrlOf(description, location)');
    expect(description).toContain('"avtransport:1"');
    expect(description).toContain('"</service>"');
    expect(description).toContain('"friendlyname"');
    // 相对 controlURL 的三种写法都必须能补全：绝对 URL、根相对、同级相对。
    expect(description).toContain('"http://"');
    expect(description).toContain("path.charAt(0) == '/'");
    expect(description).toContain('directory.lastIndexOf(\'/\')');
  });
});

describe('AC-24 SOAP 控制信封的字节口径', () => {
  it('AC-24 SetAVTransportURI 带 InstanceID/CurrentURI/DIDL 元数据，Play 带 Speed', () => {
    expect(envelope).toContain('<u:" + ACTION_SET_URI + " xmlns:u=\\\"" + AVTRANSPORT_SERVICE');
    expect(envelope).toContain('<InstanceID>0</InstanceID>');
    expect(envelope).toContain('<CurrentURI>');
    expect(envelope).toContain('<CurrentURIMetaData>');
    expect(envelope).toContain('<Speed>1</Speed>');
    expect(envelope).toContain('urn:schemas-upnp-org:service:AVTransport:1');
    expect(envelope).toContain('object.item.videoItem');
    for (const action of ['"Play"', '"Pause"', '"Stop"']) expect(envelope).toContain(action);
  });

  it('AC-24 请求行是手写 HTTP/1.1：Content-Type、SOAPAction、Content-Length 缺一不可', () => {
    expect(transport).toContain('" HTTP/1.1\\r\\n"');
    expect(transport).toContain('Content-Type: text/xml; charset=\\"utf-8\\"');
    expect(transport).toContain('SOAPAction: \\"');
    expect(transport).toContain('"Content-Length: "');
    expect(transport).toContain('Connection: close');
    // H1 的落点：裸 java.net.Socket，而不是会被明文策略拦下的 HttpURLConnection。
    // H1 的落点：裸 java.net.Socket。断言用 API 调用记号而不是库名——库名只在注释里出现，
    // 那正是要说明"为什么不用它"的地方，拿它做负向断言会红得毫无道理。
    expect(transport).toContain('new Socket()');
    expect(transport).toContain('socket.connect(new InetSocketAddress(host, port)');
    expect(transport).not.toContain('openConnection(');
    expect(transport).not.toContain('import java.net.HttpURLConnection');
    expect(transport).not.toContain('import okhttp');
  });

  it('AC-24 指令动词是闭集：JS 传来的字符串不直接拼进 XML 元素名', () => {
    expect(envelope).toContain('ACTION_PLAY.equals(action) || ACTION_PAUSE.equals(action)');
    expect(envelope).toContain('不支持的投屏');
    expect(plugin).toContain('SoapEnvelope.actionOf(call.getString("action"))');
  });
});

describe('AC-24 目标地址闸门（RFC1918 复校 + 代理流约束）', () => {
  it('AC-24 只允许 10/8、172.16/12、192.168/16 的点分字面量', () => {
    for (const allowed of ['10.0.0.7', '172.16.0.1', '172.31.255.250', '192.168.1.1', '192.168.31.88']) {
      expect(isRfc1918Host(allowed)).toBe(true);
    }
    for (const refused of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.1.1', '127.0.0.1', '169.254.9.9',
      '0.0.0.1', '10.0.0', '10.0.0.256', '010.0.0.1', 'cast.lan', '[fe80::1%wlan0]', '', '  ']) {
      expect(isRfc1918Host(refused)).toBe(false);
    }
    // Java 侧同口径：172.16-31 的边界在源码里必须写成同一对数字。
    expect(policy).toContain('octet[1] >= 16 && octet[1] <= 31');
    expect(policy).toContain('octet[0] == 192 && octet[1] == 168');
  });

  it('AC-24 拒绝非本机的设备记录：主机与 ip 不同、或根本不是局域网地址就当它不存在', () => {
    expect(isCastableDevice(deviceOf())).toBe(true);
    expect(isCastableDevice(deviceOf({ ip: '8.8.8.8' }))).toBe(false);
    expect(isCastableDevice(deviceOf({ controlUrl: 'http://203.0.113.9:49152/upnp/control/avtransport' }))).toBe(false);
    expect(isCastableDevice(deviceOf({ controlUrl: 'http://192.168.31.90:49152/upnp/control/av' }))).toBe(false);
    expect(isCastableDevice(deviceOf({ name: '  ' }))).toBe(false);
    expect(isCastableDevice(deviceOf({ controlUrl: 'ftp://192.168.31.88/x' }))).toBe(false);
    expect(isCastableDevice(null)).toBe(false);
    expect(hostOf('http://192.168.31.88:49152/desc.xml')).toBe('192.168.31.88');
    expect(hostOf('not a url')).toBeNull();
  });

  it('AC-24 / A-7.5：推给大屏的只能是公网 https 流，明文、局域网与内嵌凭据依旧一律拒绝', () => {
    const proxy = 'https://play.prismos.org/proxy/media/h1?exp=1&sig=abc';
    expect(requireCastableStreamUrl(proxy)).toBe(proxy);
    expect(() => requireCastableStreamUrl('http://play.prismos.org/proxy/media/h1')).toThrow();
    expect(() => requireCastableStreamUrl('https://192.168.31.5/proxy/media/h1')).toThrow();
    expect(() => requireCastableStreamUrl('/proxy/media/h1')).toThrow();
    expect(() => requireCastableStreamUrl('https://user:pw@play.prismos.org/proxy/media/h1')).toThrow();
    // A-7.5：直连上游之后清单里的地址就是要推给电视的，"必须是 /proxy/ 路径"那条机械证明随代理转发一起退休。
    // 拒绝条件一条没少：协议仍是 https，主机仍不得是 RFC1918，仍不得内嵌凭据——原生侧同一口径再校一遍。
    expect(requireCastableStreamUrl('https://cdn.example-invalid.test/vod/x.m3u8')).toContain('x.m3u8');
    expect(isCastableStreamUrl('http://cdn.example-invalid.test/vod/x.m3u8')).toBe(false);
    expect(isCastableStreamUrl('https://192.168.31.9/x.m3u8')).toBe(false);
    expect(isCastableStreamUrl('not a url')).toBe(false);
    // Java 侧同样只放过 https 公网流（投屏不经过手机取流，明文只可能出现在这条手机不碰的地址上）。
    expect(policy).toContain('投屏地址必须为公网 https 代理流');
  });
});

describe('AC-24 组播锁的获取与释放必须成对（H2）', () => {
  it('AC-24 扫描用 try-with-resources 持锁，并在销毁与停止路径上强制释放', () => {
    expect(lockGuard).toContain('implements AutoCloseable');
    expect(lockGuard).toContain('setReferenceCounted(false)');
    expect(ssdp).toContain('try (MulticastLockGuard.Session hold = locks.acquire())');
    expect(ssdp).toContain('!hold.held()');
    expect(plugin).toContain('guard.forceRelease()');
    expect(plugin).toContain('protected void handleOnDestroy()');
    expect(manifest).toContain('android.permission.CHANGE_WIFI_MULTICAST_STATE');
  });
});

describe('AC-24 / A-7 明文策略的代价边界（2026-10-04 集成裁定：全链路 TLS-only）', () => {
  it('A-7.1 媒体直连不换取明文放宽：清单与 base-config 双侧 false，边缘域名钉扎依旧', () => {
    // 集成审计实测入库上游媒体零 http:// 切片（m3u8 与 TS 均 https），A-7 直连不需要放宽明文。
    // targetSdk 28+ 真正生效的是 network_security_config，所以两侧必须同口径，否则清单那一句就是假开关。
    expect(manifest).toContain('android:usesCleartextTraffic="false"');
    expect(securityConfig).toMatch(/<base-config cleartextTrafficPermitted="false"/);
    // 凭据面单独钉扎：JWT / X-Private-Session / /dl OTA 走不了明文，降级与门户改写都被 domain-config 挡住。
    expect(securityConfig).toContain('cleartextTrafficPermitted="false"');
    expect(securityConfig).toContain('play.prismos.org');
    // H3 依旧成立：Android 的 <domain> 不支持 CIDR，局域网白名单路线从未被采用（SOAP 走 H1 裸 socket）。
    expect(securityConfig).not.toMatch(/192\.168\.|10\.0\.0|cidr/i);
  });

  it('AC-24 插件名字面量在 TS 与 Java 两侧逐字一致', () => {
    expect(PRISM_CAST_PLUGIN).toBe('PrismCast');
    expect(plugin).toContain('static final String PLUGIN_ID = "PrismCast"');
    expect(plugin).toContain('@CapacitorPlugin(name = PrismCastPlugin.PLUGIN_ID)');
    expect(readSource('android/app/src/main/java/org/prismos/play/MainActivity.java'))
      .toContain('registerPlugin(PrismCastPlugin.class)');
  });

  it('AC-24 网页版明确不支持：不假装能扫描，也不假装投屏成功', async () => {
    expect(castSupport()).toBe('unsupported');
    const client = createCastClient();
    expect(client.supported).toBe(false);
    await expect(client.discover()).rejects.toThrow(/Android/);
    await expect(client.cast(deviceOf() as never, { url: 'https://play.prismos.org/proxy/media/h1' }))
      .rejects.toThrow(/投屏/);
    await expect(client.control(deviceOf() as never, 'pause')).rejects.toThrow(/投屏/);
  });
});
