/**
 * 客户端发布包核验证与发布工具（SPEC §6.3 / AC-OPT-11 / AC-OPT-12）
 * 默认 preflight 仅本地只读检查，不发网络请求、不改云端指针。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TOOLS = path.join(ROOT, 'build/android-tools');
const SIGNATURE = '8bc228b3d45e2afa0fba9f27676d13b60cd0dcfb0537121bf14766ffe5f4d29d';
function runTool(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error(`APK inspection failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
}
/** aapt badging 输出 → 版本元数据；包名或 probe 标记不符一律拒绝（AC-OPT-12 的实际元数据来源）。 */
export function parseAaptBadging(badging) {
  const info = /package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/.exec(badging);
  if (!info || info[1] !== 'org.prismos.play' || info[3].includes('probe')) throw new Error('APK package or probe identity mismatch');
  return { versionCode: Number(info[2]), versionName: info[3] };
}

export function inspectApk(apkPath, options = {}) {
  const buildTools = options.buildTools ?? path.join(TOOLS, 'sdk/build-tools/35.0.0');
  const aapt = path.join(buildTools, process.platform === 'win32' ? 'aapt.exe' : 'aapt');
  const badging = runTool(aapt, ['dump', 'badging', path.resolve(apkPath)]);
  const { versionCode, versionName } = parseAaptBadging(badging);
  const java = options.java ?? path.join(TOOLS, 'jdk-21.0.12.1+1/bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const cert = runTool(java, ['-jar', path.join(buildTools, 'lib/apksigner.jar'), 'verify', '--print-certs', path.resolve(apkPath)]);
  const signatures = [...cert.matchAll(/Signer #\d+ certificate SHA-256 digest: ([0-9a-f]+)/g)].map((m) => m[1]);
  if (signatures.length !== 1 || signatures[0] !== SIGNATURE) throw new Error('APK signing certificate mismatch');
  const seed = JSON.parse(runTool(options.python ?? 'python', ['-c',
    'import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); b=json.loads(z.read("assets/public/seed/catalog-bundle.json")); print(json.dumps({"revision":b["revision"],"items":len(b["items"]),"private":any(i.get("isPrivate") is not False or i.get("channelId") not in ["drama","movie","anime","documentary"] for i in b["items"])}))', path.resolve(apkPath)]));
  if (!Number.isSafeInteger(seed.revision) || seed.revision < 1 || seed.items < 1 || seed.private) throw new Error('APK public seed invalid');
  return { versionCode, versionName, signature: signatures[0], seed };
}

export function calculateApkChecksum(filePath) {
  const bytes = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  return {
    bytes: bytes.length,
    sha256: hash
  };
}

export function validateReleaseDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') throw new Error('描述对象无效');
  if (!Number.isSafeInteger(descriptor.versionCode) || descriptor.versionCode < 1) throw new Error('versionCode 无效');
  if (typeof descriptor.versionName !== 'string' || !descriptor.versionName.trim()) throw new Error('versionName 无效');
  if (descriptor.downloadUrl !== 'https://play.prismos.org/dl/latest/android') throw new Error('downloadUrl 必须固定为同源入口');
  if (!Number.isSafeInteger(descriptor.minVersionCode) || descriptor.minVersionCode < 0 || descriptor.minVersionCode > descriptor.versionCode) throw new Error('minVersionCode 越界');
  if (typeof descriptor.force !== 'boolean') throw new Error('force 必须为布尔值');
  const artifact = descriptor.artifact;
  if (!artifact || typeof artifact !== 'object') throw new Error('artifact 缺失');
  if (!/^[0-9a-f]{64}$/.test(artifact.sha256)) throw new Error('artifact.sha256 必须为64位十六进制哈希');
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) throw new Error('artifact.bytes 无效');
  const expectedKey = `releases/android/${descriptor.versionCode}/${artifact.sha256}.apk`;
  if (artifact.key !== expectedKey) throw new Error(`artifact.key 不符合不可变对象规范，期望: ${expectedKey}`);
  return true;
}

export function runPreflight(apkPath, options = {}) {
  if (typeof apkPath !== 'string' || !fs.existsSync(apkPath)) throw new Error('Specify an existing APK file path');
  const fileName = path.basename(apkPath);
  if (fileName.includes('.probe')) throw new Error('正式发布包严禁包含 .probe 调试标记');
  // 解析器可注入（隔离夹具/测试）；默认使用本机 Android 工具链解析真实 APK。
  const info = (options.inspect ?? inspectApk)(apkPath, options);
  if (options.versionCode !== undefined && options.versionCode !== info.versionCode) throw new Error('Expected versionCode does not match APK');
  if (options.versionName !== undefined && options.versionName !== info.versionName) throw new Error('Expected versionName does not match APK');
  if (options.previousVersionCode !== undefined && info.versionCode <= options.previousVersionCode) throw new Error('versionCode must increase for promotion');
  const checksum = calculateApkChecksum(apkPath);
  const { versionCode, versionName } = info;
  const changelog = options.changelog ?? '';

  const candidate = {
    versionCode,
    versionName,
    changelog,
    downloadUrl: 'https://play.prismos.org/dl/latest/android',
    minVersionCode: options.minVersionCode ?? 21110,
    force: options.force ?? false,
    artifact: {
      key: `releases/android/${versionCode}/${checksum.sha256}.apk`,
      bytes: checksum.bytes,
      sha256: checksum.sha256
    },
    publishedAt: Math.floor(Date.now() / 1000)
  };
  validateReleaseDescriptor(candidate);
  return candidate;
}

if (process.argv[1] && process.argv[1].endsWith('publish-client-release.mjs')) {
  const command = process.argv[2] ?? 'preflight';
  const apkPath = process.argv[3];
  if (command === 'preflight') {
    try {
      const candidate = runPreflight(apkPath);
      console.log('PREFLIGHT SUCCESS:', JSON.stringify(candidate, null, 2));
    } catch (err) {
      console.error('PREFLIGHT FAILED:', err.message);
      process.exit(1);
    }
  } else {
    console.error(`Unsupported command: ${command}; cloud publication is not implemented yet.`);
    process.exitCode = 1;
  }
}
