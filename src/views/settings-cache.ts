import { attempt, band, button, formatBytes, make, type CacheMeasurement, type CacheUsage } from './history-view';
export type SettingsCachePort = CacheUsage;
export function createSettingsCacheBand(cache?: SettingsCachePort) {
  const target = band('缓存管理', 'set-cache');
  let disposed = false, busy = false, measured: CacheMeasurement | null = null;
  const usage = make('p', 'pv-note'), status = make('p', 'pv-state'); usage.dataset.el = 'cache-usage';
  const clear = button('清理公开缓存', () => void clearCache(), { icon: 'trash', el: 'clear-cache' });
  target.body.append(usage, clear, status);
  function paint(state: 'ready' | 'error' | 'disabled' | 'loading', text: string): void {
    if (disposed) return;
    target.wrap.dataset.state = state; status.textContent = text;
    usage.textContent = measured ? `${formatBytes(measured.usedBytes)} / ${formatBytes(measured.limitBytes)}` : '缓存用量尚未读取。';
    clear.disabled = busy || !cache;
  }
  async function reload(): Promise<void> {
    if (disposed) return;
    if (!cache) return paint('disabled', '缓存端口尚未就绪，未执行任何清理。');
    const result = await attempt(() => cache.measure());
    if (result.ok) { measured = result.value; paint('ready', '只清公开目录与海报缓存；保留历史、收藏、偏好和授权凭证。'); }
    else paint('error', '缓存用量读取失败，保留上次用量，请重试。');
  }
  async function clearCache(): Promise<void> {
    if (disposed || busy || !cache) return;
    busy = true; paint('loading', '正在清理公开缓存…');
    const result = await attempt(() => cache.clearPublicCache()); busy = false;
    if (disposed) return;
    if (!result.ok) return paint('error', '缓存清理失败，保留上次用量，请重试。');
    if (result.value.domains.some(domain => domain !== 'public-cache')) return paint('error', '清理回报越出公开缓存域，无法确认安全清理。');
    const refreshed = await attempt(() => cache.measure());
    if (refreshed.ok) measured = refreshed.value;
    paint(refreshed.ok ? 'ready' : 'error', refreshed.ok ? `已清理 ${formatBytes(result.value.clearedBytes)} 公开缓存。` : '清理已完成，但用量刷新失败，保留上次用量。');
  }
  return { wrap: target.wrap, reload, destroy: () => { disposed = true; } };
}
