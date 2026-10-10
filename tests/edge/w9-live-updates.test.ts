import { describe, it, expect } from 'vitest';
import {
  handleLiveUpdateCheck, WEB_BUNDLE_RELEASE_KV_KEY,
  validateWebBundleManifest, type WebBundleManifest
} from '../../edge/src/routes/live-updates';
import { systemClock } from '../../edge/src/core/clock';

function makeEnv(kvStore: Map<string, string>): any {
  return {
    KV: {
      get: async (key: string) => kvStore.get(key) ?? null
    }
  };
}

describe('W9: Web Bundle 热更新包签名分发与防降版 (handleLiveUpdateCheck)', () => {
  const validManifest: WebBundleManifest = {
    releaseSequence: 10,
    controlSequence: 1,
    bundleVersion: '2.6.8-hotfix1',
    sha256: 'a'.repeat(64),
    byteLength: 1024 * 500,
    minNativeCode: 21607,
    downloadUrl: 'https://play.prismos.org/releases/web/bundle-10.zip'
  };

  it('校验 manifest 对象解析与字段有效性', () => {
    expect(validateWebBundleManifest(validManifest)).not.toBeNull();
    // 缺少必要字段拒绝
    expect(validateWebBundleManifest({ ...validManifest, sha256: 'invalid' })).toBeNull();
    expect(validateWebBundleManifest({ ...validManifest, releaseSequence: 0 })).toBeNull();
    expect(validateWebBundleManifest(null)).toBeNull();
  });

  it('未配置任何热更新时，如实返回 no_release', async () => {
    const env = makeEnv(new Map());
    const req = new Request('https://play.prismos.org/api/updates/check?currentSequence=1&nativeCode=21607');
    const res = await handleLiveUpdateCheck(req, env, systemClock);
    expect(res.status).toBe(200);
    const json = await res.json() as any;
    expect(json.updateAvailable).toBe(false);
    expect(json.reason).toBe('no_release');
  });

  it('原生底座版本不满足要求时拒绝更新，告知 native_incompatible', async () => {
    const kv = new Map<string, string>();
    kv.set(WEB_BUNDLE_RELEASE_KV_KEY, JSON.stringify(validManifest));
    const env = makeEnv(kv);

    // 本地 nativeCode 只有 20000，而 manifest 要求 21607
    const req = new Request('https://play.prismos.org/api/updates/check?currentSequence=1&nativeCode=20000');
    const res = await handleLiveUpdateCheck(req, env, systemClock);
    const json = await res.json() as any;
    expect(json.updateAvailable).toBe(false);
    expect(json.reason).toBe('native_incompatible');
    expect(json.minNativeCode).toBe(21607);
  });

  it('本地版本序号已大于等于最新发布时，防降版与防重复', async () => {
    const kv = new Map<string, string>();
    kv.set(WEB_BUNDLE_RELEASE_KV_KEY, JSON.stringify(validManifest));
    const env = makeEnv(kv);

    // 本地序号 10 等于最新序号 10
    const req = new Request('https://play.prismos.org/api/updates/check?currentSequence=10&nativeCode=21607');
    const res = await handleLiveUpdateCheck(req, env, systemClock);
    const json = await res.json() as any;
    expect(json.updateAvailable).toBe(false);
    expect(json.reason).toBe('up_to_date');
  });

  it('满足所有兼容条件且有新版本时，返回更新可用与完整 manifest', async () => {
    const kv = new Map<string, string>();
    kv.set(WEB_BUNDLE_RELEASE_KV_KEY, JSON.stringify(validManifest));
    const env = makeEnv(kv);

    // 本地序号 5 < 最新序号 10，原生底座 21607 符合要求
    const req = new Request('https://play.prismos.org/api/updates/check?currentSequence=5&nativeCode=21607');
    const res = await handleLiveUpdateCheck(req, env, systemClock);
    const json = await res.json() as any;
    expect(json.updateAvailable).toBe(true);
    expect(json.manifest.releaseSequence).toBe(10);
    expect(json.manifest.bundleVersion).toBe('2.6.8-hotfix1');
  });
});
