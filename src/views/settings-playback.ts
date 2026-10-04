import type { PreferenceStore } from '../core/state/theme';
import { band, make, rowLine } from './history-view';

export const PLAYBACK_RATES = [1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const;
export const PLAYBACK_PREF_KEYS = { holdRate: 'prism.playback.holdRate', normalRate: 'prism.playback.normalRate' } as const;
export interface PlaybackRates { holdRate: number; normalRate: number; }
/** Local playback preferences only; never an authorization or commercial threshold. */
export async function readPlaybackRates(prefs: PreferenceStore): Promise<PlaybackRates> {
  const read = async (key: string, fallback: number): Promise<number> => {
    const value = await prefs.get(key);
    return PLAYBACK_RATES.find(rate => String(rate) === value) ?? fallback;
  };
  const [holdRate, normalRate] = await Promise.all([read(PLAYBACK_PREF_KEYS.holdRate, 2), read(PLAYBACK_PREF_KEYS.normalRate, 1)]);
  return { holdRate, normalRate };
}
export function createPlaybackPreferencesBand(prefs: PreferenceStore) {
  const target = band('播放倍率', 'set-rates');
  let values: PlaybackRates = { holdRate: 2, normalRate: 1 }, disposed = false;
  const note = make('p', 'pv-state');
  const selects = {} as Record<keyof PlaybackRates, HTMLSelectElement>;
  for (const [key, label, el] of [['normalRate', '常规播放倍率', 'normal-rate'], ['holdRate', '长按播放倍率', 'hold-rate']] as const) {
    const select = make('select', 'pv-input'); select.dataset.el = el; select.setAttribute('aria-label', label);
    for (const rate of PLAYBACK_RATES) { const option = make('option', undefined, `${rate}×`); option.value = String(rate); select.append(option); }
    selects[key] = select;
    select.addEventListener('change', () => void save(key));
    target.body.append(rowLine(`row-${el}`, label, '仅保存本地播放偏好，由播放器读取。', [select]));
  }
  target.body.append(note);
  function paint(state: 'ready' | 'error', text: string): void {
    target.wrap.dataset.state = state; note.textContent = text;
    for (const key of ['normalRate', 'holdRate'] as const) selects[key].value = String(values[key]);
  }
  async function save(key: keyof PlaybackRates): Promise<void> {
    if (disposed) return;
    const rate = PLAYBACK_RATES.find(rate => String(rate) === selects[key].value);
    if (rate === undefined) return paint('error', '倍率无效，未保存。');
    selects[key].disabled = true;
    try { await prefs.set(PLAYBACK_PREF_KEYS[key], String(rate)); if (!disposed) { values[key] = rate; paint('ready', '播放偏好已保存。'); } }
    catch { if (!disposed) paint('error', '偏好保存失败，保留上次倍率，请重试。'); }
    finally { selects[key].disabled = false; }
  }
  async function reload(): Promise<void> {
    try { const read = await readPlaybackRates(prefs); if (!disposed) { values = read; paint('ready', '长按默认 2×，常规默认 1×；仅为本地播放偏好。'); } }
    catch { if (!disposed) paint('error', '偏好暂时无法读取，保留当前倍率。'); }
  }
  return { wrap: target.wrap, reload, destroy: () => { disposed = true; } };
}
