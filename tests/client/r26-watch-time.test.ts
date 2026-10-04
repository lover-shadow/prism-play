import { describe, it, expect, vi } from 'vitest';
import { createWatchTime, validMonetization } from '../../src/core/watch-time';
import { createPreferenceStore } from '../../src/core/native/platform-adapters';
import type { MonetizationConfig } from '../../edge/src/types/api';

export const config: MonetizationConfig = { activeTiers: [{ tier: 'A', name: '云档位', priceYuan: 19, durationDays: 30 }], nudgePolicy: { freeTrialSeconds: 2, stage1UntilSeconds: 5, stage2UntilSeconds: 9, stage1IntervalSeconds: 2, stage2IntervalSeconds: 3, stage3IntervalSeconds: 4, dialogTitle: '云标题', dialogBody: '云正文' } };
function fixture() {
  let now = 0;
  const data = new Map<string, string>();
  const writes: string[] = [];
  const prefs = { get: async (k: string) => data.get(k) ?? null, set: async (k: string, v: string) => { writes.push(k); data.set(k, v); } };
  return { prefs, data, writes, clock: () => now, advance: (ms: number) => { now += ms; } };
}

describe('R26-11 actual watch time', () => {
  it('uses the real monotonic clock and actual PreferenceStore', async () => {
    const data = new Map<string, string>();
    const prefs = createPreferenceStore({ platform: () => false, storage: { getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } } });
    const timer = await createWatchTime({ prefs, isAuthorized: () => false });
    timer.setScope('public'); timer.playing(true);
    const before = performance.now();
    while (performance.now() - before < 12) { /* real elapsed wall clock, no media position */ }
    await timer.suspend('pause');
    expect(timer.state().totalSeconds).toBeGreaterThanOrEqual(0.01);
    expect(Number(data.get('prism.watch_seconds_total'))).toBe(timer.state().persistedSeconds);
    await timer.suspend('ended');
    expect(timer.state().totalSeconds).toBe(timer.state().persistedSeconds);
  });
  it('requires first frame, excludes buffering/seek/unknown resume, counts replays once', async () => {
    const f = fixture(), timer = await createWatchTime({ ...f, isAuthorized: () => false });
    timer.setScope('public'); timer.playing(false); f.advance(5000);
    timer.playing(true); f.advance(1000); timer.playing(true); f.advance(1000);
    await timer.suspend('waiting'); f.advance(8000); timer.playing(true); f.advance(1000);
    await timer.suspend('seeking'); f.advance(9000); await timer.suspend('seeked');
    f.advance(1000); timer.playing(true); f.advance(1000); await timer.suspend('blur');
    f.advance(9000); await timer.suspend('resume'); f.advance(9000);
    timer.playing(true); f.advance(1000); await timer.suspend('error');
    await timer.destroy(); await timer.destroy(); timer.playing(true); f.advance(1000);
    expect(timer.state().totalSeconds).toBe(5);
    expect(f.writes.filter(k => k === 'prism.watch_seconds_total')).toHaveLength(4);
  });
  it('private never accrues or persists; scope changes settle public time', async () => {
    const f = fixture(), t = await createWatchTime({ ...f, isAuthorized: () => false });
    t.playing(true); f.advance(1000); await t.suspend('ended'); expect(f.writes).toEqual([]);
    t.setScope('public'); t.playing(true); f.advance(1000); await t.setScope('private');
    const count = f.writes.length; t.playing(true); f.advance(5000); await t.suspend('ended');
    expect(t.naturalBoundary(config)).toBeNull(); expect(t.state().totalSeconds).toBe(1); expect(f.writes).toHaveLength(count);
  });
  it('does not report failed persistence as saved, retries explicitly, hydrates scalars', async () => {
    const f = fixture(); let fail = true;
    const prefs = { get: f.prefs.get, set: async (k: string, v: string) => { if (fail) throw Error('disk'); await f.prefs.set(k, v); } };
    const t = await createWatchTime({ ...f, prefs, isAuthorized: () => false });
    t.setScope('public'); t.playing(true); f.advance(3000); await t.suspend('pause');
    expect(t.state()).toMatchObject({ totalSeconds: 3, persistedSeconds: 0, persistence: 'error' });
    fail = false; await t.flush(); expect(t.state()).toMatchObject({ persistedSeconds: 3, persistence: 'saved' });
    const restored = await createWatchTime({ prefs, isAuthorized: () => false }); expect(restored.state().totalSeconds).toBe(3);
    await expect(createWatchTime({ prefs: { get: async () => { throw Error('read'); }, set: f.prefs.set }, isAuthorized: () => false })).rejects.toThrow('read');
    f.data.set('prism.watch_seconds_total', 'NaN'); await expect(createWatchTime({ ...f, isAuthorized: () => false })).rejects.toThrow();
  });
  it('serializes writes while viewing continues; no stale completion claims', async () => {
    const f = fixture(); const releases: (() => void)[] = []; const values: string[] = [];
    const prefs = { get: f.prefs.get, set: async (_k: string, v: string) => { values.push(v); await new Promise<void>(r => releases.push(r)); } };
    const t = await createWatchTime({ ...f, prefs, isAuthorized: () => false }); t.setScope('public'); t.playing(true);
    f.advance(1000); const one = t.flush(); f.advance(1000); const two = t.flush();
    await vi.waitFor(() => expect(values).toEqual(['1'])); expect(t.state().persistence).toBe('pending');
    releases.shift()!(); await one; await Promise.resolve(); expect(values).toEqual(['1', '2']);
    releases.shift()!(); await two; expect(t.state().persistedSeconds).toBe(2);
  });
});

describe('R26-11 cloud reminders', () => {
  it('only offers at ended natural transitions, closes without repeat, respects grant', async () => {
    const f = fixture(); let authorized = false;
    const t = await createWatchTime({ ...f, isAuthorized: () => authorized }); t.setScope('public');
    t.playing(true); f.advance(2000); expect(t.naturalBoundary(config)).toBeNull(); await t.suspend('ended');
    expect(t.naturalBoundary(config)).toEqual(config); expect(t.naturalBoundary(config)).toBeNull();
    await t.dismissNudge(); expect(f.data.get('prism.watch_seconds_last_nudge')).toBe('2');
    t.playing(true); f.advance(1000); await t.suspend('ended'); expect(t.naturalBoundary(config)).toBeNull();
    t.playing(true); f.advance(1000); await t.suspend('ended'); expect(t.naturalBoundary(config)).toEqual(config); await t.dismissNudge();
    authorized = true; t.playing(true); f.advance(10000); await t.suspend('ended'); expect(t.naturalBoundary(config)).toBeNull();
  });
  it('uses each configured stage interval, fails closed on invalid or missing config', async () => {
    const f = fixture(), t = await createWatchTime({ ...f, isAuthorized: () => false }); t.setScope('public');
    for (const [delta, due] of [[2, true], [3, true], [2, false], [1, true], [1, false], [3, true]] as const) {
      t.playing(true); f.advance(delta * 1000); await t.suspend('ended');
      expect(t.naturalBoundary(config) !== null).toBe(due); if (due) await t.dismissNudge();
    }
    for (const candidate of [null, {}, { ...config, activeTiers: [] }, { ...config, nudgePolicy: { ...config.nudgePolicy, stage3IntervalSeconds: 0 } }, { ...config, nudgePolicy: { ...config.nudgePolicy, stage1UntilSeconds: 1 } }]) expect(validMonetization(candidate)).toBe(false);
    t.playing(true); f.advance(100000); await t.suspend('ended'); expect(t.naturalBoundary(null)).toBeNull();
  });
  it('discards invalid/reset clocks and manual switches cannot prompt', async () => {
    const f = fixture(); let now = 1000;
    const t = await createWatchTime({ prefs: f.prefs, clock: () => now, isAuthorized: () => false });
    await t.setScope('public'); t.playing(true); now = 500; await t.flush();
    now = 1500; await t.suspend('pause'); expect(t.state().totalSeconds).toBe(1);
    t.playing(true); now = NaN; await t.flush(); now = 100000; await t.suspend('ended');
    expect(t.state().totalSeconds).toBe(1); expect(t.naturalBoundary(config)).toBeNull();
    t.playing(true); now += 5000; await t.setScope('public'); expect(t.naturalBoundary(config)).toBeNull();
  });
  it('closing remains deduplicated in memory when lastNudge write fails', async () => {
    const f = fixture(); const prefs = { get: f.prefs.get, set: async (k: string, v: string) => { if (k.endsWith('last_nudge')) throw Error('disk'); await f.prefs.set(k, v); } };
    const t = await createWatchTime({ ...f, prefs, isAuthorized: () => false }); t.setScope('public'); t.playing(true); f.advance(2000); await t.suspend('ended');
    expect(t.naturalBoundary(config)).not.toBeNull(); await t.dismissNudge(); expect(t.state().persistence).toBe('error');
    await t.suspend('ended'); expect(t.naturalBoundary(config)).toBeNull();
  });
});
