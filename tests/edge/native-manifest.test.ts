import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseTitleAsset, titleAssetResponse } from '../../edge/src/library/title-asset';
import { createS1Provider } from '../../edge/src/search/providers/s1';
import { protectedData, resumeState } from '../../edge/src/search/providers/transport';
import { resolveS1AppMedia, resolveS1PlaybackApi } from '../../edge/src/search/providers/s1-native';
import type { DiscoveryCandidate, DiscoveryConfig } from '../../edge/src/search/discovery-provider';

vi.mock('../../edge/src/search/providers/s1-native', () => ({
  resolveS1AppMedia: vi.fn(), resolveS1PlaybackApi: vi.fn()
}));
const descriptor = { kind: 's1-cenc', videoId: '000123' };
const line = { providerId: 'provider_s1', mediaUrl: 'https://media.example/123.mp4', native: descriptor };
const secret = '0123456789abcdef0123456789abcdef';
const asset = (candidate: unknown = line) => ({
  workId: 'drama_s_10', title: '故事', channelId: 'drama', isPrivate: false, generatedAt: 100,
  episodes: [{ episodeNumber: 1, lines: [candidate] }]
});
const candidate: DiscoveryCandidate = {
  providerId: 'provider_s1', sourceItemId: '10', id: 'drama_s_10', title: '故事', channelId: 'drama'
};
const budget = { maxRequests: 32, timeoutMs: 1000 };
function fixture(count = 1, plain = false) {
  const calls: string[] = [];
  const config: DiscoveryConfig = {
    origin: 'https://api.example', originAllowlist: new Set(['https://api.example']),
    mediaAllowlist: new Set(['https://media.example']), coverAllowlist: new Set(['https://cover.example']),
    fetcher: async (raw) => {
      const url = new URL(raw); calls.push(url.pathname);
      const data = url.pathname === '/detail'
        ? { detail_page: { seriesDetail: { series_id_str: '10', series_title: '故事', episode_cnt: count,
          vid_list: Array.from({ length: count }, (_, i) => String(100 + i)) } } }
        : { player_page: { series_id: '10', vid: url.pathname.split('/').pop(),
          video_player_info: plain ? { main_url: 'https://media.example/plain.mp4' } : {} } };
      return new Response(JSON.stringify({ loaderData: data }));
    }
  };
  return { config, calls };
}

beforeEach(() => { vi.resetAllMocks(); });
describe('work manifest native identity, never playback keys', () => {
  it('accepts a native-only line without a fabricated media URL', () => {
    const identity = { providerId: 'provider_s1', native: descriptor };
    const parsed = parseTitleAsset(JSON.stringify(asset(identity)), 'drama_s_10');
    expect(parsed.ok && parsed.value.episodes[0].lines[0]).toEqual(identity);
    expect(parseTitleAsset(JSON.stringify(asset({ providerId: 'provider_m1' })), 'drama_s_10').ok).toBe(false);
  });
  it('serializes a key-free descriptor while preserving the source candidate', () => {
    const parsed = parseTitleAsset(JSON.stringify(asset()), 'drama_s_10');
    if (!parsed.ok) throw new Error('manifest rejected');
    const serialized = JSON.stringify(titleAssetResponse(parsed.value));
    expect(JSON.parse(serialized).episodes[0].lines[0]).toEqual(line);
    expect(serialized).not.toMatch(/key|spade|license/i);
  });
  it.each([
    null, [], {}, { ...descriptor, kind: 'cenc' }, { ...descriptor, videoId: 123 },
    { ...descriptor, videoId: '' }, { ...descriptor, videoId: '1'.repeat(33) },
    { ...descriptor, videoId: '12x' }, { ...descriptor, videoId: ' 123' },
    { ...descriptor, key: secret }, { ...descriptor, key: null },
    { ...descriptor, cencKeyHex: secret }, { ...descriptor, unknown: true }
  ])('rejects malformed or secret-bearing native descriptors: %j', (native) => {
    expect(parseTitleAsset(JSON.stringify(asset({ ...line, native })), 'drama_s_10').ok).toBe(false);
  });
  it('requires provider_s1 but leaves plain manifest behavior unchanged', () => {
    expect(parseTitleAsset(JSON.stringify(asset({ ...line, providerId: 'provider_m1' })), 'drama_s_10').ok).toBe(false);
    const plain = { providerId: 'provider_m1', mediaUrl: line.mediaUrl };
    const parsed = parseTitleAsset(JSON.stringify(asset(plain)), 'drama_s_10');
    expect(parsed.ok && parsed.value.episodes[0].lines[0]).toEqual(plain);
    const longest = { ...line, native: { ...descriptor, videoId: '1'.repeat(32) } };
    expect(parseTitleAsset(JSON.stringify(asset(longest)), 'drama_s_10').ok).toBe(true);
  });
  it.each(['app', 'backup'] as const)('%s CENC results store identity only', async (source) => {
    const media = { mediaUrl: line.mediaUrl, cencKeyHex: secret, encryptionScheme: 'cenc-aes-ctr' as const };
    vi.mocked(resolveS1AppMedia).mockResolvedValue(source === 'app' ? media : null);
    vi.mocked(resolveS1PlaybackApi).mockResolvedValue(media);
    const result = await createS1Provider(fixture().config).resolve(candidate, undefined, budget);
    if (result.status !== 'complete') throw new Error('resolution failed');
    expect(result.fact.episodes[0].lines[0]).toEqual({ ...line, native: { kind: 's1-cenc', videoId: '100' } });
    expect(JSON.stringify(result.fact)).not.toMatch(/cencKeyHex|encryptionScheme|spade|license|0123456789abcdef/);
    expect(protectedData(result.fact)).toBe(false);
    const parsed = parseTitleAsset(JSON.stringify(result.fact), candidate.id);
    expect(parsed.ok && titleAssetResponse(parsed.value).episodes[0].lines[0]).toEqual(result.fact.episodes[0].lines[0]);
  });
  it('does not spend a resume batch refreshing expired candidate URLs for native identities', async () => {
    vi.mocked(resolveS1AppMedia).mockImplementation(async (_config, vid) => ({
      mediaUrl: `https://media.example/${vid}.mp4`, cencKeyHex: secret
    }));
    const f = fixture(9), first = await createS1Provider(f.config).resolve(candidate, undefined, budget);
    if (first.status !== 'progress') throw new Error('expected checkpoint');
    const checkpoint = JSON.parse(first.cursor);
    checkpoint.fact.episodes.forEach((ep: { lines: { mediaUrl: string }[] }) => { ep.lines[0].mediaUrl += '?expires=1'; });
    vi.mocked(resolveS1AppMedia).mockClear();
    const result = await createS1Provider(f.config).resolve(candidate, checkpoint, budget);
    expect(result.status).toBe('complete');
    expect(resolveS1AppMedia).toHaveBeenCalledTimes(1);
    expect(vi.mocked(resolveS1AppMedia).mock.calls[0][1]).toBe('108');
  });
  it('preserves source-evidenced ongoing status across a resumable CENC series', async () => {
    vi.mocked(resolveS1AppMedia).mockImplementation(async (_config, vid) => ({ mediaUrl: `https://media.example/${vid}.mp4`, cencKeyHex: secret }));
    const f = fixture(9);
    const fetcher = f.config.fetcher!;
    f.config.fetcher = async (url, init) => {
      const response = await fetcher(url, init);
      if (!url.includes('/detail')) return response;
      const payload = await response.json() as { loaderData: { detail_page: { seriesDetail: Record<string, unknown> } } };
      payload.loaderData.detail_page.seriesDetail.release_status = 'ongoing';
      return new Response(JSON.stringify(payload));
    };
    const first = await createS1Provider(f.config).resolve(candidate, undefined, budget);
    if (first.status !== 'progress') throw new Error('expected progress');
    expect(first.state.fact.releaseStatus).toBe('ongoing');
    const resumed = await createS1Provider(f.config).resolve(candidate, first.cursor, budget);
    if (resumed.status !== 'complete') throw new Error('expected completed fact');
    expect(resumed.fact).toMatchObject({ releaseStatus: 'ongoing', lastSyncedEpisode: 9 });
  });
  it('does not mark unencrypted native or web media as CENC', async () => {
    vi.mocked(resolveS1AppMedia).mockResolvedValue({ mediaUrl: line.mediaUrl });
    for (const plain of [false, true]) {
      const result = await createS1Provider(fixture(1, plain).config).resolve(candidate, undefined, budget);
      if (result.status !== 'complete') throw new Error('resolution failed');
      expect(result.fact.episodes[0].lines[0]).not.toHaveProperty('native');
    }
  });
  it('preserves native identity across cursor/object resume and rejects tampered checkpoints before I/O', async () => {
    vi.mocked(resolveS1AppMedia).mockImplementation(async (_config, vid) => ({
      mediaUrl: `https://media.example/${vid}.mp4`, cencKeyHex: secret
    }));
    const f = fixture(9);
    const first = await createS1Provider(f.config).resolve(candidate, undefined, budget);
    if (first.status !== 'progress') throw new Error('expected checkpoint');
    expect(first.state.next).toBe(8);
    expect(first.cursor).not.toContain(secret);
    const restored = resumeState(first.cursor, candidate, f.config);
    expect(restored.fact.episodes[0].lines[0]).toHaveProperty('native', { kind: 's1-cenc', videoId: '100' });
    const before = f.calls.length;
    for (const native of [
      { kind: 's1-cenc', videoId: '999' }, { kind: 'other', videoId: '100' },
      { kind: 's1-cenc', videoId: 100 }, { kind: 's1-cenc', videoId: '100', key: secret },
      { kind: 's1-cenc', videoId: '100', key: null },
      { kind: 's1-cenc', videoId: '100', cencKeyHex: secret }
    ]) {
      const state = JSON.parse(first.cursor);
      state.fact.episodes[0].lines[0].native = native;
      expect((await createS1Provider(f.config).resolve(candidate, state, budget)).status).toBe('blocked');
    }
    const poisoned = JSON.parse(first.cursor);
    poisoned.fact.episodes[0].lines[0].key = secret;
    expect(protectedData(poisoned)).toBe(true);
    expect(() => resumeState(poisoned, candidate, f.config)).toThrow();
    expect(f.calls.length).toBe(before);
    for (const cursor of [first.cursor, restored]) {
      const result = await createS1Provider(f.config).resolve(candidate, cursor, budget);
      if (result.status !== 'complete') throw new Error('resume failed');
      expect(result.fact.episodes).toHaveLength(9);
      result.fact.episodes.forEach((ep, i) => expect(ep.lines[0]).toHaveProperty('native', {
        kind: 's1-cenc', videoId: String(100 + i)
      }));
      expect(JSON.stringify(result.fact)).not.toContain(secret);
    }
    expect(f.calls.filter((path) => path === '/detail')).toHaveLength(1);
  });
});
