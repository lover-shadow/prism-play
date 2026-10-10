import { describe, it, expect, vi } from 'vitest';
import {
  LiveUpdateClient, INITIAL_BUNDLE_STATE,
  type LocalBundleState, type WebBundleManifest
} from '../../src/core/updater/live-update-client';

describe('W10: 客户端热更新宿主与健康回滚 (LiveUpdateClient)', () => {
  const sampleManifest: WebBundleManifest = {
    releaseSequence: 2,
    controlSequence: 1,
    bundleVersion: '2.6.8-hotfix',
    sha256: 'b'.repeat(64),
    byteLength: 2048,
    minNativeCode: 21607,
    downloadUrl: 'https://play.prismos.org/releases/web/bundle-2.zip'
  };

  it('初始状态为内置包，检查更新并成功暂存新版本', async () => {
    let savedState = { ...INITIAL_BUNDLE_STATE };
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ updateAvailable: true, manifest: sampleManifest })
    })) as any;

    const client = new LiveUpdateClient({
      nativeCode: 21607,
      apiOrigin: 'https://play.prismos.org',
      fetchFn: mockFetch,
      loadState: async () => ({ ...savedState }),
      saveState: async (s) => { savedState = { ...s }; },
      downloadBundle: async () => true
    });

    await client.init();
    expect(client.getState().activeSequence).toBe(0);

    const check = await client.checkForUpdate();
    expect(check.available).toBe(true);
    expect(check.manifest?.releaseSequence).toBe(2);

    const staged = await client.downloadAndStage(check.manifest!);
    expect(staged).toBe(true);
    expect(savedState.pendingSequence).toBe(2);
    expect(savedState.pendingVersion).toBe('2.6.8-hotfix');
  });

  it('冷启动原子切换至暂存版本，并等待健康确认', async () => {
    // 模拟已经暂存了版本 2 的状态
    let savedState: LocalBundleState = {
      activeSequence: 0,
      activeVersion: 'built-in',
      pendingSequence: 2,
      pendingVersion: '2.6.8-hotfix',
      healthy: true,
      failedSequences: []
    };

    const client = new LiveUpdateClient({
      nativeCode: 21607,
      apiOrigin: 'https://play.prismos.org',
      loadState: async () => ({ ...savedState }),
      saveState: async (s) => { savedState = { ...s }; }
    });

    await client.init();
    // 切换为 activeSequence 2，但 healthy 初始为 false（等待健康探针）
    expect(savedState.activeSequence).toBe(2);
    expect(savedState.activeVersion).toBe('2.6.8-hotfix');
    expect(savedState.pendingSequence).toBeNull();
    expect(savedState.healthy).toBe(false);

    // 探针健康确认
    client.markHealthy();
    expect(savedState.healthy).toBe(true);
  });

  it('崩溃自动回滚：若新版本未通过健康检查便崩溃退出，下次冷启动自动加入黑名单并回退内置包', async () => {
    // 模拟版本 2 在上次运行中未调用 markHealthy 便退出了（healthy: false）
    let savedState: LocalBundleState = {
      activeSequence: 2,
      activeVersion: '2.6.8-hotfix',
      pendingSequence: null,
      pendingVersion: null,
      healthy: false, // 崩溃未确认健康
      failedSequences: []
    };

    const client = new LiveUpdateClient({
      nativeCode: 21607,
      apiOrigin: 'https://play.prismos.org',
      loadState: async () => ({ ...savedState }),
      saveState: async (s) => { savedState = { ...s }; }
    });

    // 冷启动初始化，检测到 healthy: false，触发回滚
    await client.init();

    expect(savedState.activeSequence).toBe(0);
    expect(savedState.activeVersion).toBe('built-in');
    expect(savedState.failedSequences).toContain(2); // 版本 2 进入崩溃黑名单
    expect(savedState.healthy).toBe(true);

    // 再次检查更新时，黑名单拦截版本 2
    const mockFetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ updateAvailable: true, manifest: sampleManifest })
    })) as any;

    const client2 = new LiveUpdateClient({
      nativeCode: 21607,
      apiOrigin: 'https://play.prismos.org',
      fetchFn: mockFetch,
      loadState: async () => ({ ...savedState }),
      saveState: async (s) => { savedState = { ...s }; }
    });
    await client2.init();

    const check = await client2.checkForUpdate();
    expect(check.available).toBe(false);
    expect(check.reason).toBe('blacklisted_failure'); // 成功拦截黑名单故障版本
  });
});
