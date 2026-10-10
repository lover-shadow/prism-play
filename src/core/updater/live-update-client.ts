/**
 * W10: 客户端热更新宿主、健康检查探针与回退机制 (SPEC §6.5)。
 * 具备防降级、黑名单熔断、原子切换与 10 秒健康确认。
 */

export interface WebBundleManifest {
  releaseSequence: number;
  controlSequence: number;
  bundleVersion: string;
  sha256: string;
  byteLength: number;
  minNativeCode: number;
  downloadUrl: string;
  signature?: string;
  changelog?: string;
}

export interface LiveUpdateCheckResponse {
  updateAvailable: boolean;
  reason?: 'up_to_date' | 'native_incompatible' | 'no_release';
  manifest?: WebBundleManifest;
  minNativeCode?: number;
}

export interface LocalBundleState {
  activeSequence: number;
  activeVersion: string;
  pendingSequence: number | null;
  pendingVersion: string | null;
  healthy: boolean;
  failedSequences: number[];
}

export const INITIAL_BUNDLE_STATE: LocalBundleState = {
  activeSequence: 0,
  activeVersion: 'built-in',
  pendingSequence: null,
  pendingVersion: null,
  healthy: true,
  failedSequences: []
};

export interface LiveUpdateClientDeps {
  nativeCode: number;
  apiOrigin: string;
  fetchFn?: typeof fetch;
  loadState: () => Promise<LocalBundleState>;
  saveState: (state: LocalBundleState) => Promise<void>;
  downloadBundle?: (url: string, expectedSha256: string) => Promise<boolean>;
}

export class LiveUpdateClient {
  private state: LocalBundleState = { ...INITIAL_BUNDLE_STATE };
  private healthTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly deps: LiveUpdateClientDeps;

  constructor(deps: LiveUpdateClientDeps) {
    this.deps = deps;
  }

  async init(): Promise<void> {
    this.state = await this.deps.loadState();

    // 冷启动健康检查与回滚探测：如果当前活动版本尚未标记健康，说明上次启动遭遇了崩溃！
    if (!this.state.healthy && this.state.activeSequence > 0) {
      // 触发回滚：将该问题版本加入黑名单，回滚至内置包 (0)
      this.state.failedSequences.push(this.state.activeSequence);
      this.state.activeSequence = 0;
      this.state.activeVersion = 'built-in';
      this.state.pendingSequence = null;
      this.state.pendingVersion = null;
      this.state.healthy = true;
      await this.deps.saveState(this.state);
      return;
    }

    // 检查是否有等待激活的新版本
    if (this.state.pendingSequence !== null && this.state.pendingVersion !== null) {
      this.state.activeSequence = this.state.pendingSequence;
      this.state.activeVersion = this.state.pendingVersion;
      this.state.pendingSequence = null;
      this.state.pendingVersion = null;
      this.state.healthy = false; // 启动未确认健康状态，等待健康探针确认
      await this.deps.saveState(this.state);
      this.startHealthTimer();
    }
  }

  getState(): Readonly<LocalBundleState> {
    return { ...this.state };
  }

  markHealthy(): void {
    if (this.healthTimer !== null) {
      clearTimeout(this.healthTimer);
      this.healthTimer = null;
    }
    if (!this.state.healthy) {
      this.state.healthy = true;
      void this.deps.saveState(this.state);
    }
  }

  async checkForUpdate(): Promise<{ available: boolean; manifest?: WebBundleManifest; reason?: string }> {
    const fetcher = this.deps.fetchFn ?? fetch;
    const url = `${this.deps.apiOrigin}/api/updates/check?currentSequence=${this.state.activeSequence}&nativeCode=${this.deps.nativeCode}`;

    let json: LiveUpdateCheckResponse;
    try {
      const res = await fetcher(url);
      if (!res.ok) return { available: false, reason: 'http_error' };
      json = await res.json() as LiveUpdateCheckResponse;
    } catch (e) {
      return { available: false, reason: 'network_failed' };
    }

    if (!json.updateAvailable || !json.manifest) {
      return { available: false, reason: json.reason ?? 'up_to_date' };
    }

    const { manifest } = json;

    // 黑名单拦截：曾导致崩溃的版本不可重装
    if (this.state.failedSequences.includes(manifest.releaseSequence)) {
      return { available: false, reason: 'blacklisted_failure' };
    }

    // 防降版拦截
    if (manifest.releaseSequence <= this.state.activeSequence) {
      return { available: false, reason: 'older_or_same' };
    }

    return { available: true, manifest };
  }

  async downloadAndStage(manifest: WebBundleManifest): Promise<boolean> {
    // 再次核对黑名单
    if (this.state.failedSequences.includes(manifest.releaseSequence)) {
      return false;
    }

    if (this.deps.downloadBundle) {
      const ok = await this.deps.downloadBundle(manifest.downloadUrl, manifest.sha256);
      if (!ok) return false;
    }

    this.state.pendingSequence = manifest.releaseSequence;
    this.state.pendingVersion = manifest.bundleVersion;
    await this.deps.saveState(this.state);
    return true;
  }

  private startHealthTimer(): void {
    if (this.healthTimer !== null) clearTimeout(this.healthTimer);
    // 10秒后若未发生崩溃或主动汇报错误，自动确认为健康状态
    this.healthTimer = setTimeout(() => {
      this.markHealthy();
    }, 10000);
  }
}
